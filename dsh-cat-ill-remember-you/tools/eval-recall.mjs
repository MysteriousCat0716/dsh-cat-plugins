#!/usr/bin/env node
/**
 * 召回评测：拿真实账本回放「当时这一轮注入了什么」，看现在的检索还能不能
 * 把那些「后来确实用上了」的记忆找回来。
 *
 * 用法：
 *   node tools/eval-recall.mjs [--db <path>] [--limit 200] [--verbose]
 *
 * 数据来源（只读）：
 *   - `recall_log` 里 section='recall' 且 used=1 的行 = 正样本
 *     （used 是之后那一轮真的用到了它的回填标记）
 *   - 同 sid 下时间最近、且不晚于该轮的用户消息 = 当时的查询
 *
 * 注意：这是**回归基线**，不是绝对正确率。账本只记了「当时注入了什么」，
 * 没记「当时漏了什么」，所以它量的是「有没有丢掉曾经找到过的东西」。
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

import { retrieve } from '../lib/recall.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const dbFile = arg('db', path.join(os.homedir(), '.dsh', 'memory', 'core.db'));
const limit = Number(arg('limit', 200));
const verbose = process.argv.includes('--verbose');

const db = new DatabaseSync(dbFile, { readOnly: true });

// 1. 正样本：按 (sid, turn) 分组，只要「真用上过」的那些。
const rows = db
  .prepare(
    `SELECT sid, turn, memory_id, MIN(t) AS t
       FROM recall_log
      WHERE section = 'recall' AND used = 1 AND memory_id IS NOT NULL
      GROUP BY sid, turn
      ORDER BY MIN(t) DESC
      LIMIT ?`,
  )
  .all(limit);

if (rows.length === 0) {
  console.error('没有可用样本：recall_log 里没有 used=1 的记录。');
  process.exit(1);
}

// 2. 每个 (sid, turn) 找回当时的用户原话。
const turnStmt = db.prepare(
  `SELECT id, text, t, cwd FROM turns
    WHERE sid = ? AND role = 'user' AND t <= ?
    ORDER BY t DESC LIMIT 1`,
);
const memoryStmt = db.prepare('SELECT summary FROM memories WHERE id = ?');

let judged = 0;
let hit = 0;
let skipped = 0;
const bySection = new Map();
const misses = [];

for (const [index, row] of rows.entries()) {
  const positive = db
    .prepare(
      `SELECT memory_id FROM recall_log
        WHERE sid = ? AND turn = ? AND section = 'recall' AND used = 1`,
    )
    .all(row.sid, row.turn)
    .map((item) => Number(item.memory_id));
  if (positive.length === 0) continue;

  const turn = turnStmt.get(row.sid, row.t);
  if (!turn || !turn.text) {
    skipped += 1;
    continue;
  }

  // sid/turn 故意用假的：评测不该被「这一轮已经给过」的抑制影响。
  const hits = await retrieve(db, {
    text: String(turn.text),
    cwd: String(turn.cwd ?? ''),
    sid: `eval-${index}`,
    turn: 0,
    recent: [],
    now: Number(row.t) || Date.now(),
  });

  judged += 1;
  // persona 是常驻、不占召回槽，统计时单独剔掉——否则每轮都有几十条，
  // 「实际给」会全被它占满，看不出检索层到底给了什么。
  const recalled = hits.slice(Number(hits.personaCount ?? 0));
  const got = new Set(recalled.filter((item) => item.source === 'memory').map((item) => Number(item.id)));
  const found = positive.filter((id) => got.has(id));
  if (found.length) {
    hit += 1;
    for (const item of recalled) {
      const section = item.section || 'other';
      bySection.set(section, (bySection.get(section) ?? 0) + 1);
    }
  } else if (verbose) {
    misses.push({
      sid: row.sid.slice(-8),
      query: String(turn.text).slice(0, 60),
      wanted: positive.map((id) => memoryStmt.get(id)?.summary?.slice(0, 40) ?? id),
      got: recalled.map((item) => `${item.section}:${String(item.summary ?? '').slice(0, 30)}`),
    });
  }
}

console.log(`样本 ${judged}（跳过 ${skipped} 条找不到原话的）`);
console.log(`命中 ${hit} → ${(judged ? (hit / judged) * 100 : 0).toFixed(1)}%`);
if (bySection.size) {
  console.log('命中时的层分布：');
  for (const [section, count] of [...bySection.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${section.padEnd(8)} ${count}`);
  }
}
if (verbose && misses.length) {
  console.log(`\n未命中 ${misses.length} 例（前 10）：`);
  for (const miss of misses.slice(0, 10)) {
    console.log(`\n[${miss.sid}] ${miss.query}`);
    console.log(`  想召回：${JSON.stringify(miss.wanted)}`);
    console.log(`  实际给：${JSON.stringify(miss.got)}`);
  }
}
db.close();
