#!/usr/bin/env node
/**
 * 逐条诊断：目标记忆卡在流水线的哪一段。
 *
 * 不靠 recall.js 的落选账反推——那一本最多记 12 条，目标排在 13 位以后
 * 就会被误判成「词面零重叠」。这里直接重跑候选池查询，看目标在不在池里、
 * 排第几，再跟最终结果对。
 *
 *   ABSENT   库里没有这条（提炼层漏了）
 *   POOL     候选池（前 200）里没有它 → 索引/切词阶段断了
 *   GATE     在池里，但没进最终，也没留下落选记录（被门槛或截断丢掉）
 *   DROPPED  在池里，被门槛丢，落选账记了原因
 *   PICKED   进了最终结果
 */
import { DatabaseSync } from 'node:sqlite'
import { retrieve, weakTerms } from '../lib/recall.js'
import { expandTerms } from '../lib/aliases.js'
import { CASES } from './eval-cases.mjs'

const DB = process.env.DSH_MEMORY_CORE_DB || 'C:/Users/54048/.dsh/memory/core.db'
const db = new DatabaseSync(DB, { readOnly: true })
const byId = db.prepare('SELECT id, kind, text FROM memories WHERE id = ?')

const only = process.argv[2]
const tally = new Map()
const bump = (k) => tally.set(k, (tally.get(k) || 0) + 1)

for (const c of CASES) {
  if (only && !c.id.startsWith(only)) continue
  const rows = c.want.map((id) => byId.get(id)).filter(Boolean)
  const terms = weakTerms(c.q)
  const { all } = expandTerms(terms)

  // 重跑候选池：与 recall.js 的 SQL 保持一致的形状
  let pool = []
  if (all.length) {
    const like = all.map(() => `(text LIKE ? ESCAPE '\\')`).join(' OR ')
    const overlap = all.map(() => `(text LIKE ? ESCAPE '\\')`).join(' + ')
    const values = all.map((t) => `%${t}%`)
    pool = db
      .prepare(
        `SELECT id FROM memories WHERE tier='active' AND origin IN ('chat','unknown')
           AND (${like}) ORDER BY (${overlap}) DESC, t DESC LIMIT 200`,
      )
      .all(...values, ...values)
      .map((r) => Number(r.id))
  }
  const poolAt = pool.findIndex((id) => c.want.includes(id))

  const hits = await retrieve(db, { text: c.q, sid: 'diag-' + c.id, turn: 1 })
  const picked = hits.filter((h) => h.section !== 'persona')
  const at = picked.findIndex((h) => c.want.includes(Number(h.id)))
  const tr = (hits.trace || []).find((t) => c.want.includes(Number(t.id)))

  let stage
  if (!rows.length) stage = 'ABSENT'
  else if (at >= 0) stage = 'PICKED'
  else if (poolAt < 0) stage = 'POOL'
  else if (tr) stage = 'DROPPED'
  else stage = 'GATE'
  bump(stage)

  let extra = ''
  if (stage === 'PICKED') extra = `第 ${at + 1} 位`
  else if (stage === 'POOL') extra = `候选池 ${pool.length} 条，目标不在里面`
  else if (stage === 'DROPPED') extra = `${tr.reason} @${tr.score}`
  else if (stage === 'GATE') extra = `候选池第 ${poolAt + 1} 位，未进最终`

  console.log(`${c.id.padEnd(3)} ${stage.padEnd(8)} ${extra}`)
  console.log(`    「${c.q}」→ ${terms.length} 词：${terms.join(' ') || '（空）'}`)
  for (const r of rows) {
    const got = terms.filter((w) => (r.text || '').includes(w))
    console.log(`    #${r.id} 词面重叠 ${got.length}：${got.join(' ') || '（无）'}`)
  }
}

console.log('')
for (const [k, v] of tally) console.log(`${k}: ${v}`)
