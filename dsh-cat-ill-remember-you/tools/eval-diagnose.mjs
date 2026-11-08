#!/usr/bin/env node
/**
 * 每条例子的完整诊断：目标记忆卡在哪一段。
 *
 *   库里没有 → 提炼层漏了
 *   词面零重叠 → 索引/切词阶段断了（query 的词一个都不在目标记忆里）
 *   进候选被丢 → 评分或门槛的问题
 *   进了没进最终 → 截断位置的问题
 *   取回        → 通了
 */
import { DatabaseSync } from 'node:sqlite'
import { retrieve, weakTerms } from '../lib/recall.js'
import { CASES } from './eval-cases.mjs'

const DB = process.env.DSH_MEMORY_CORE_DB || 'C:/Users/54048/.dsh/memory/core.db'
const db = new DatabaseSync(DB, { readOnly: true })
const byId = db.prepare('SELECT id, text, summary FROM memories WHERE id = ?')

const only = process.argv[2]
const tally = new Map()

for (const c of CASES) {
  if (only && !c.id.startsWith(only)) continue
  const rows = c.want.map((id) => byId.get(id)).filter(Boolean)
  const terms = weakTerms(c.q)
  const hits = await retrieve(db, { text: c.q, sid: 'diag-' + c.id, turn: 1 })
  const picked = hits.filter((h) => h.section !== 'persona')
  const trace = hits.trace || []

  const overlap = rows.map((r) => {
    const body = `${r.summary || ''} ${r.text || ''}`
    return { id: r.id, got: terms.filter((w) => body.includes(w)) }
  })
  const best = overlap.reduce((a, b) => (b.got.length > a.got.length ? b : a), { got: [] })

  const at = picked.findIndex((h) => c.want.includes(Number(h.id)))
  const tr = trace.find((t) => c.want.includes(Number(t.id)))

  let stage
  if (!rows.length) stage = '库里没有'
  else if (at >= 0) stage = `取回（第 ${at + 1} 位）`
  else if (tr) stage = `进候选被丢（${tr.reason}，${tr.score}）`
  else if (best.got.length === 0) stage = '词面零重叠'
  else stage = '进池但没进最终'

  tally.set(stage, (tally.get(stage) || 0) + 1)
  console.log(`${c.id.padEnd(3)} ${stage}`)
  console.log(`    「${c.q}」→ ${terms.length} 词：${terms.join(' ') || '（空）'}`)
  for (const o of overlap) {
    console.log(`    #${o.id} 重叠 ${o.got.length}：${o.got.join(' ') || '（无）'}`)
  }
}

console.log('')
for (const [k, v] of tally) console.log(`${k}: ${v}`)

// 第二段：看某个用例的候选与落选账
if (process.env.DETAIL) {
  for (const c of CASES) {
    if (c.id !== process.env.DETAIL) continue
    const hits = await retrieve(db, { text: c.q, sid: 'diag-' + c.id, turn: 1 })
    console.log('\n=== ' + c.id + ' 最终 ===')
    for (const h of hits) console.log(' ', h.section, '#' + h.id, Math.round((h.score || 0) * 1000) / 1000)
    console.log('--- 落选账 ---')
    for (const t of hits.trace || []) console.log(' ', t.section, '#' + t.id, t.score, t.reason)
  }
}
