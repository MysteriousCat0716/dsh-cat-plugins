/**
 * 跑 eval-cases.mjs 里的用例，报四种结局：
 *   HIT     取回了（并报第几位）
 *   DROPPED 进了候选、被评分/门槛丢掉了
 *   MISS    根本没进候选池
 *   ABSENT  这条记忆在库里找不到（不是召回问题，是没存下）
 *
 * 指标口径（2026-11-08 汀第七轮评审后改名）：
 *   TargetHit@1    已有返回的用例里，第 1 条是不是已标注目标。
 *   TargetRatio@2  前 2 条返回结果里，已标注目标占几条。
 *
 * 这两个都不是标准 Precision@K。want 只是「可接受集合」，不在 want 里的
 * 不一定无关（可能是同一件事的另一种说法）；真正的 Precision@K 要先把每条
 * 用例的相关记忆标注完整才谈得上。名字不改就会让人以为它代表了没验证的东西。
 */
import { DatabaseSync } from 'node:sqlite'
import { retrieve } from '../lib/recall.js'
import { CASES } from './eval-cases.mjs'

const DB = process.env.DSH_MEMORY_CORE_DB || 'C:/Users/54048/.dsh/memory/core.db'
const db = new DatabaseSync(DB, { readOnly: true })

const has = db.prepare('SELECT id FROM memories WHERE id = ?')

let hit = 0, dropped = 0, miss = 0, absent = 0
let t1num = 0, t1den = 0, t2num = 0, t2den = 0
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
  // 分母只算真的跑过检索的用例：库里有没这条记忆，跟「第一条取得准不准」
  // 是两件事，ABSENT 塞进 TargetHit@1 的分母会把召回问题算成排序问题。
  const top2 = picked.slice(0, 2)
  t1den += 1
  if (top2.length && present.includes(Number(top2[0].id))) t1num += 1
  for (const h of top2) {
    t2den += 1
    if (present.includes(Number(h.id))) t2num += 1
  }
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
console.log(
  `TargetHit@1 ${t1den ? (t1num / t1den * 100).toFixed(1) : '-'}%（${t1num}/${t1den} 个跑过检索的用例）`,
)
console.log(
  `TargetRatio@2 ${t2den ? (t2num / t2den * 100).toFixed(1) : '-'}%（${t2num}/${t2den} 条取回里是目标）`,
)
