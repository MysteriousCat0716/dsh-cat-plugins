#!/usr/bin/env node
/**
 * 逐条诊断：目标记忆卡在流水线的哪一段。
 *
 * 不靠 recall.js 的落选账反推——那一本最多记 12 条，目标排在 13 位以后
 * 就会被误判成「词面零重叠」。也不自己重写候选池 SQL：分词（weakTerms +
 * expandTerms）和候选池查询（weakCandidatePool）都取生产代码那一份，
 * 层的执行/跳过由 recall.js 的 layers 账交代。诊断只负责读和统计；
 * 归因规则在 diagnose-core.mjs，那部分有测试。
 *
 *   ABSENT   库里没有这条（提炼层漏了）
 *   SKIPPED  弱匹配层这一轮没执行（前面已填满两条 / 没抽出词）→ 无法归因
 *   POOL     弱匹配执行了，但目标不在前 200 条候选池 → 索引/切词阶段断了
 *   GATE     在池里，但没进最终，也没留下弱匹配层的落选记录
 *   DROPPED  在池里，被弱匹配层的门槛丢，落选账记了原因
 *   PICKED   进了最终结果
 */
import { DatabaseSync } from 'node:sqlite'
import { retrieve, weakCandidatePool } from '../lib/recall.js'
import { CASES } from './eval-cases.mjs'
import { classify } from './diagnose-core.mjs'

const DB = process.env.DSH_MEMORY_CORE_DB || 'C:/Users/54048/.dsh/memory/core.db'
const db = new DatabaseSync(DB, { readOnly: true })
const byId = db.prepare('SELECT id, kind, text FROM memories WHERE id = ?')

const only = process.argv[2]
const tally = new Map()
const bump = (k) => tally.set(k, (tally.get(k) || 0) + 1)

for (const c of CASES) {
  if (only && !c.id.startsWith(only)) continue
  const rows = c.want.map((id) => byId.get(id)).filter(Boolean)

  if (!rows.length) {
    bump('ABSENT')
    console.log(`${c.id.padEnd(3)} ${'ABSENT'.padEnd(8)} ${c.want.join(',')} 都不在库`)
    continue
  }

  const hits = await retrieve(db, { text: c.q, sid: 'diag-' + c.id, turn: 1 })
  const picked = hits.filter((h) => h.section !== 'persona')
  const layers = hits.layers || []
  const weak = layers.find((l) => l.name === 'weak')

  // 弱匹配没跑就不要去查池：那等于替一个没发生的阶段编一条证据。
  const pool = weak && weak.ran ? weakCandidatePool(db, weak.terms || []) : null

  const { stage, extra, terms } = classify({
    want: c.want,
    picked,
    trace: hits.trace || [],
    layers,
    pool,
  })
  bump(stage)

  console.log(`${c.id.padEnd(3)} ${stage.padEnd(8)} ${extra}`)
  console.log(`    「${c.q}」`)
  console.log(`    弱匹配词 ${terms.length}：${terms.join(' ') || '（无）'}`)
  console.log(
    `    层：${layers.map((l) => `${l.name}:${l.ran ? 'run' + (l.status ? '/' + l.status : '') : 'skip(' + l.reason + ')'}`).join(' ') || '（无记录）'}`,
  )
  for (const r of rows) {
    const got = terms.filter((w) => (r.text || '').includes(w))
    console.log(`    #${r.id} 词面重叠 ${got.length}：${got.join(' ') || '（无）'}`)
  }
}

console.log('')
for (const [k, v] of tally) console.log(`${k}: ${v}`)
