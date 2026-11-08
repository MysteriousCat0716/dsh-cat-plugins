/**
 * 诊断归因：目标记忆卡在流水线的哪一段。
 *
 * 抽成纯函数是为了能测。这里只用调用方喂进来的账：
 *   picked  最终取回（已去掉常驻段）
 *   trace   recall 的落选账（每条带 layer）
 *   layers  层的执行账
 *   pool    弱匹配候选池（没执行时传 null）
 *
 * 归因的分界线是 layer：同一个 id 可能先在 L1 记一笔 no-share，又在弱匹配
 * 记一笔 low-weak。只按 id 找第一条，会把 L1 的因当成弱匹配的因。
 */
export function classify({ want, picked = [], trace = [], layers = [], pool = null }) {
  const ids = new Set(want.map(Number))

  const at = picked.findIndex((h) => ids.has(Number(h.id)))
  if (at >= 0) return { stage: 'PICKED', extra: `第 ${at + 1} 位`, terms: [] }

  const weak = (layers || []).find((l) => l.name === 'weak')
  if (!weak || !weak.ran) {
    return { stage: 'SKIPPED', extra: `弱匹配未执行（${weak ? weak.reason : '无记录'}）`, terms: [] }
  }

  const terms = weak.terms || []

  if (pool) {
    const poolAt = pool.findIndex((r) => ids.has(Number(r.id)))
    if (poolAt < 0) {
      return { stage: 'POOL', extra: `候选池 ${pool.length} 条，目标不在里面`, terms }
    }
    const tr = (trace || []).find((t) => t.layer === 'weak' && ids.has(Number(t.id)))
    if (tr) return { stage: 'DROPPED', extra: `${tr.reason} @${tr.score}`, terms }
    return { stage: 'GATE', extra: `候选池第 ${poolAt + 1} 位，未进最终`, terms }
  }

  const tr = (trace || []).find((t) => t.layer === 'weak' && ids.has(Number(t.id)))
  if (tr) return { stage: 'DROPPED', extra: `${tr.reason} @${tr.score}`, terms }
  return { stage: 'GATE', extra: '候选池未提供，无法定位', terms }
}
