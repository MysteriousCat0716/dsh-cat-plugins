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

let hit = 0, dropped = 0, miss = 0, absent = 0
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
console.log(`命中 ${hit} / 落选 ${dropped} / 没进候选 ${miss} / 库里没有 ${absent}   共 ${CASES.length}`)
console.log(`取回率 ${(hit / CASES.length * 100).toFixed(1)}%`)
