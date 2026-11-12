/**
 * M4 · 遗忘
 *
 * 只降 tier，不删行。判据是可数的时间，不是模型判断：
 *   active --21 天没被用过--> dormant --再 32 天--> cold
 * 每降一级，下一段间隔乘 1.5（21, 32, 47, 71, 106, 159），最多撑到 159 天。
 * 这是「越久没想起，越可能真的忘」的近似：刚放下的 21 天就会沉，沉过之后
 * 反而能睡更久。旧实现是固定的 30/90 天，一条记忆在第 30 天被一刀切掉，
 * 跟它之前被想起过几次无关。
 *
 * decision / preference 不参与自动降级：这两类变化慢，误降一次就要重新学。
 * 每次降级写 forget_log，tier 可以手动改回去——遗忘是可回退的降级，不是删除。
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export const TIER_ACTIVE = 'active';
export const TIER_DORMANT = 'dormant';
export const TIER_COLD = 'cold';

/** Kinds that stay active until verified obsolete by hand. */
const STICKY_KINDS = new Set(['decision', 'preference']);

/** retention='ephemeral' 的短曲线：7 天没碰就沉，再 7 天进 cold。 */
export const EPHEMERAL_DORMANT_MS = 7 * DAY_MS;
export const EPHEMERAL_COLD_MS = 7 * DAY_MS;

/** 衰减曲线：第 n 次降级要等多少天（n 从 0 起，封顶 159 天）。 */
export function intervalDays(n) {
  const k = Math.max(0, Math.min(5, Math.floor(Number(n) || 0)));
  return Math.round(21 * 1.5 ** k);
}

/**
 * 「真的用上了」才算活着。
 *
 * 误沉的代价比看起来小：dormant 仍在取回池里，reviveOnRecall 会把它升回 active，
 * 所以降级是「排序压一段时间」，不是失忆——这个自愈路径就是这条判据的兜底。
 *
 * 旧判据是「被取回过」：取回一次 age 就重置，一条从没被用到的记忆可以靠
 * 反复被取回一直活着。人不是这样——想起来了但没用上，等于没想起来。
 * 现在只用 recall_log 里 used=1 的最近时间；没有就退回写入时间。
 *
 * forget_at 是上一次降级的时刻：它保证每降一级就重新计时，否则 age 一直从
 * 写入时间算，刚进 dormant 的记忆会立刻满足下一级条件。
 */
function lastEffective(row, usedAt) {
  const used = usedAt.get(Number(row.id)) ?? 0;
  const written = Number(row.t ?? 0);
  const demoted = Number(row.forget_at) || 0;
  return Math.max(used, written, demoted);
}

/**
 * Sweep one store: demote old, unused memories.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?: number, dormantAfterMs?: number, coldAfterMs?: number}} [opts]
 *   dormantAfterMs / coldAfterMs 是 0.9.x 的旧参数，只在显式传入时覆盖默认
 *   曲线；不传就走 intervalDays。
 * @returns {{demoted: number, dormant: number, cold: number}}
 */
export function forgetSweep(db, opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const fixedDormant = Number.isFinite(opts.dormantAfterMs) ? Number(opts.dormantAfterMs) : null;
  const fixedCold = Number.isFinite(opts.coldAfterMs) ? Number(opts.coldAfterMs) : null;

  const rows = db
    .prepare(
      `SELECT id, kind, tier, retention, t, last_used, forget_n, forget_at
         FROM memories WHERE tier IN ('active','dormant')`,
    )
    .all();

  // 预算一次：哪些记忆真的被用上了，最近一次是什么时候。
  // 老库没有 recall_log 时退回时间曲线，不让整轮 sweep 抛错。
  const usedAt = new Map();
  try {
    for (const row of db
      .prepare(
        `SELECT memory_id, MAX(t) AS last FROM recall_log
          WHERE used = 1 AND section = 'recall' AND memory_id IS NOT NULL
          GROUP BY memory_id`,
      )
      .all()) {
      usedAt.set(Number(row.memory_id), Number(row.last) || 0);
    }
  } catch {
    // 没有 recall_log：usedAt 空着，下面自动退回写入时间。
  }

  const markDormant = db.prepare("UPDATE memories SET tier = 'dormant' WHERE id = ?");
  const markCold = db.prepare("UPDATE memories SET tier = 'cold' WHERE id = ?");
  const stamp = db.prepare('UPDATE memories SET forget_n = ?, forget_at = ? WHERE id = ?');
  const log = db.prepare(
    'INSERT INTO forget_log (memory_id, at, reason, tier_before, tier_after) VALUES (?, ?, ?, ?, ?)',
  );

  let dormant = 0;
  let cold = 0;
  // The tier change and its forget_log line must commit together: a failure
  // halfway would leave a row demoted with no audit trail.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      // 显式 permanent 永不降级；ephemeral 走短曲线；auto 走递增曲线。
      if (row.retention === 'permanent') continue;
      const ephemeral = row.retention === 'ephemeral';
      if (!ephemeral && STICKY_KINDS.has(row.kind)) continue;

      const n = Number(row.forget_n) || 0;
      const age = now - lastEffective(row, usedAt);
      let gapMs;
      if (ephemeral) {
        gapMs = row.tier === TIER_ACTIVE ? EPHEMERAL_DORMANT_MS : EPHEMERAL_COLD_MS;
      } else if (row.tier === TIER_ACTIVE && fixedDormant !== null) {
        gapMs = fixedDormant;
      } else if (row.tier === TIER_DORMANT && fixedCold !== null) {
        gapMs = fixedCold;
      } else {
        gapMs = intervalDays(n) * DAY_MS;
      }

      if (row.tier === TIER_ACTIVE && age >= gapMs) {
        markDormant.run(row.id);
        stamp.run(n + 1, now, row.id);
        log.run(
          row.id,
          now,
          `${ephemeral ? 'ephemeral ' : ''}active ${Math.floor(age / DAY_MS)}d unused`,
          TIER_ACTIVE,
          TIER_DORMANT,
        );
        dormant += 1;
      } else if (row.tier === TIER_DORMANT && age >= gapMs) {
        markCold.run(row.id);
        stamp.run(n + 1, now, row.id);
        log.run(
          row.id,
          now,
          `${ephemeral ? 'ephemeral ' : ''}dormant ${Math.floor(age / DAY_MS)}d unused`,
          TIER_DORMANT,
          TIER_COLD,
        );
        cold += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* transaction may already be closed */
    }
    throw error;
  }

  return { demoted: dormant + cold, dormant, cold };
}

/**
 * 回升：一次真被取回的 dormant 记忆重新记成 active。
 *
 * 遗忘是可回退的降级，不是删除——但旧实现只有降没有升，沉下去的记忆
 * 就再也浮不上来（召回又只查 active，等于单向门）。
 * 只处理 dormant：cold 是「几乎不再想起」，要回来得靠手动。
 *
 * 回升同时把 forget_n 减一：被想起一次，下次的间隔就退回去一档，
 * 相当于「这条还没忘干净」。减到 0 为止，不会变成负数。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} ids
 * @returns {number} 回升条数
 */
export function reviveOnRecall(db, ids) {
  const unique = [...new Set((ids ?? []).map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  if (unique.length === 0) return 0;
  const placeholders = unique.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id FROM memories WHERE tier = 'dormant' AND id IN (${placeholders})`)
    .all(...unique);
  if (rows.length === 0) return 0;
  const now = Date.now();
  const revive = db.prepare(
    `UPDATE memories
        SET tier = 'active', last_used = ?,
            forget_n = CASE WHEN forget_n > 0 THEN forget_n - 1 ELSE 0 END,
            forget_at = ?
      WHERE id = ?`,
  );
  const log = db.prepare(
    'INSERT INTO forget_log (memory_id, at, reason, tier_before, tier_after) VALUES (?, ?, ?, ?, ?)',
  );
  // 状态和审计行一起提交：只改 tier 不写 forget_log 的话，事后没法解释
  // 一条记忆为什么又活了。
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      revive.run(now, now, row.id);
      log.run(row.id, now, 'recalled', 'dormant', 'active');
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* transaction may already be closed */
    }
    throw error;
  }
  return rows.length;
}
