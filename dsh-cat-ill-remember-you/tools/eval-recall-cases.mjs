/**
 * 跑 eval-cases.mjs 里的用例，报四种结局：
 *   HIT     取回了（并报第几位）
 *   DROPPED 进了候选、被评分/门槛丢掉了
 *   MISS    根本没进候选池
 *   ABSENT  这条记忆在库里找不到（不是召回问题，是没存下）
 */
import { DatabaseSync } from 'node:sqlite'
import { retrieve } from '../lib/recall.js'
import { CASES } from './eval-cases.mjs'

const DB = process.env.DSH_MEMORY_CORE_DB || 'C:/Users/54048/.dsh/memory/core.db'
const db = new DatabaseSync(DB, { readOnly: true })

const has = db.prepare('SELECT id FROM memories WHERE id = ?')

let hit = 0, dropped = 0, miss = 0, absent = 0, p1 = 0, p2num = 0, p2den = 0
const rows = []

for (const c of CASES) {
  const present = c.want.filter((id) => has.get(id))
  if (!present.length) {
    absent += 1
    rows.push({ id: c.id, out: 'ABSENT', rank: '-', detail: c.want.join(',') + ' 都不在库' })
    continue
  }
  const hits = await retrieve(db, { text: c.q, sid: 'eval-' + c.id, turn: 1 })
  const picked = hits.filter((h) => h.section !== 'persona')
  // Precision@K：want 是「可接受集合」，不在里面的不一定无关（比如同一件事
  // 的另一种说法），所以这个数只会偏低，不会偏高。
  const top2 = picked.slice(0, 2)
  for (const h of top2) {
    p2den += 1
    if (present.includes(Number(h.id))) p2num += 1
  }
  if (top2.length && present.includes(Number(top2[0].id))) p1 += 1
  const rank = picked.findIndex((h) => present.includes(Number(h.id)))
  const trace = hits.trace || []
  if (rank >= 0) {
    hit += 1
    rows.push({ id: c.id, out: 'HIT', rank: rank + 1, detail: `#${picked[rank].id}` })
  } else if (trace.some((t) => present.includes(Number(t.id)))) {
    dropped += 1
    const t = trace.find((t) => present.includes(Number(t.id)))
    rows.push({ id: c.id, out: 'DROPPED', rank: '-', detail: `#${t.id} ${t.section} ${t.reason}` })
  } else {
    miss += 1
    rows.push({ id: c.id, out: 'MISS', rank: '-', detail: picked.map((h) => '#' + h.id).join(' ') || '空' })
  }
}

const pad = (s, n) => String(s).padEnd(n)
for (const r of rows) console.log(pad(r.id, 4), pad(r.out, 8), pad(r.rank, 5), r.detail)
console.log('')
const stored = CASES.length - absent
console.log(`命中 ${hit} / 落选 ${dropped} / 没进候选 ${miss} / 库里没有 ${absent}   共 ${CASES.length}`)
console.log(`存储覆盖率 ${(stored / CASES.length * 100).toFixed(1)}%（${stored}/${CASES.length}）`)
console.log(`条件召回率 ${stored ? (hit / stored * 100).toFixed(1) : '-'}%（${hit}/${stored}）`)
console.log(`端到端 ${(hit / CASES.length * 100).toFixed(1)}%（${hit}/${CASES.length}）`)
console.log(`Precision@1 ${(p1 / CASES.length * 100).toFixed(1)}%（${p1}/${CASES.length}）`)
console.log(`Precision@2 ${p2den ? (p2num / p2den * 100).toFixed(1) : '-'}%（${p2num}/${p2den} 条取回里是目标）`)
