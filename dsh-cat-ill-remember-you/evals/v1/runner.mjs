/**
 * Eval v1 · 三层判分（第一、二层）
 *
 * 汀 2026-11-11 定的口径，不合并成分数：
 *   第一层 候选覆盖率   evidence 有没有进 picked（retrieve 的返回值）
 *   第二层 注入覆盖率   picked 有没有真的进最终上下文
 *   第三层 证据利用率   模型有没有用上（要旁路审计，本文件先留接口）
 *
 * 指标：
 *   EvidenceRecall@K         每题 |evidence ∩ picked| / |evidence| 的平均
 *   CompleteCoverage@K       全部 evidence 都进了候选的题占比
 *   InjectionRecall          同上，但看注入后的清单
 *   ConditionalUtilization   分母只算证据完整注入的样本，第三层填
 *
 * 辅助指标（不进必需分母，只报）：
 *   SupportingHit            supporting 里的辅助背景有没有顺带进候选
 *   RelatedIntrusion         related（字面像但不是答案）有没有被误当答案捞进来
 *
 * 目前发现（2026-11-12）：renderHint 不截断，picked 全部进提示词。
 * 所以第二层与第一层数值相同——记下来，不装作测了两层。
 * 候选池大小（条数、字符数、token 估）同时报，这是「剪短」的基线。
 */
import { DatabaseSync } from 'node:sqlite'
import { retrieve, renderHint } from '../../lib/recall.js'
import { CASES } from '../work/cases-v1.mjs'

const DB = process.env.DSH_MEMORY_CORE_DB || 'C:/Users/54048/.dsh/memory/core.db'
const db = new DatabaseSync(DB, { readOnly: true })

const has = db.prepare('SELECT id FROM memories WHERE id = ?')
const pad = (s, n) => String(s).padEnd(n)
const pct = (a, b) => (b ? `${(a / b * 100).toFixed(1)}%` : '-')

const rows = []
let answerable = 0, complete = 0, sumRecall = 0
let candCount = 0, candChars = 0
let supportHit = 0, supportTotal = 0
let relatedIn = 0, relatedRisk = 0
const absent = []

for (const c of CASES) {
  const evidence = (c.evidence || []).filter((id) => has.get(id))
  const supporting = (c.supporting || []).filter((id) => has.get(id))
  const related = (c.related || []).filter((id) => has.get(id))

  const hits = await retrieve(db, { text: c.question, sid: 'eval-' + c.id, turn: 1 })
  const picked = hits.filter((h) => h.section !== 'persona')
  const pickedIds = new Set(picked.map((h) => Number(h.id)))

  // 不可答题：不混进召回分母，单独看它有没有被硬塞答案
  if (!c.answerable) {
    rows.push({
      id: c.id, type: c.type, out: 'NO-ANSWER:' + (c.abstention || '?'),
      recall: '-', complete: '-', cand: picked.length,
      chars: renderHint(hits).length,
      support: '-', related: '-',
      detail: picked.length ? picked.map((h) => '#' + h.id).join(' ') : '空',
    })
    continue
  }

  answerable += 1
  const found = evidence.filter((id) => pickedIds.has(id))
  const recall = evidence.length ? found.length / evidence.length : 1
  const isComplete = evidence.length ? found.length === evidence.length : true
  sumRecall += recall
  if (isComplete) complete += 1

  const hint = renderHint(hits)
  candCount += picked.length
  candChars += hint.length

  // 辅助背景命中（只报，不进分母）
  for (const id of supporting) {
    supportTotal += 1
    if (pickedIds.has(id)) supportHit += 1
  }
  // 字面像但不是答案的东西被捞进来没有
  const intruded = related.filter((id) => pickedIds.has(id))
  relatedIn += intruded.length
  // 更危险的情形：related 进了、证据没进全 → 可能拿错东西当答案
  const risk = intruded.length > 0 && !isComplete

  const missing = evidence.filter((id) => !pickedIds.has(id))
  const dropped = missing.length
    ? (hits.trace || []).filter((t) => missing.includes(Number(t.id)))
    : []
  if (missing.length) absent.push({ id: c.id, missing })

  rows.push({
    id: c.id, type: c.type,
    out: (isComplete ? 'COVER' : found.length ? 'PART' : 'MISS') + (risk ? '+RISK' : ''),
    recall: recall.toFixed(2),
    complete: isComplete ? 'Y' : 'N',
    cand: picked.length,
    chars: hint.length,
    support: supporting.length ? `${supportHit ? '' : ''}` : '-',
    related: intruded.length ? intruded.join(',') : '',
    detail: missing.length
      ? '缺 ' + missing.join(',') + (dropped.length ? ' [' + dropped.map((t) => `#${t.id} ${t.reason}`).join('; ') + ']' : '')
      : (risk ? 'related 先进了但证据没齐' : ''),
  })
  if (risk) relatedRisk += 1
}

console.log(pad('id', 5), pad('type', 18), pad('out', 16), pad('recall', 7), pad('cand', 5), pad('chars', 6), 'detail')
for (const r of rows) {
  console.log(pad(r.id, 5), pad(r.type, 18), pad(r.out, 16), pad(r.recall, 7), pad(r.cand, 5), pad(r.chars, 6), r.detail)
}

const byType = {}
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]
  if (r.out.startsWith('NO-ANSWER')) continue
  const c = CASES.find((x) => x.id === r.id)
  // 汀：冲突类按三个子类分开报，不合并
  const t = c.type
  const bucket = (byType[t] ||= { n: 0, recall: 0, complete: 0 })
  bucket.n += 1
  bucket.recall += Number(r.recall)
  if (r.complete === 'Y') bucket.complete += 1
}

const noAnswer = rows.filter((r) => r.out.startsWith('NO-ANSWER'))
console.log('')
console.log(`可回答题 ${answerable} / 共 ${CASES.length}（不可答 ${noAnswer.length}）`)
for (const [t, v] of Object.entries(byType)) {
  console.log(`  ${pad(t, 18)} EvidenceRecall ${pct(v.recall, v.n)}  CompleteCoverage ${pct(v.complete, v.n)}（${v.complete}/${v.n}）`)
}
console.log(`总计 EvidenceRecall ${pct(sumRecall, answerable)}  CompleteCoverage ${pct(complete, answerable)}（${complete}/${answerable}）`)
console.log(`候选池平均 ${(candCount / answerable).toFixed(1)} 条 / ${(candChars / answerable).toFixed(0)} 字符（≈${(candChars / answerable / 2).toFixed(0)} token 粗估）`)
console.log(`辅助背景命中 ${supportHit}/${supportTotal}；related 误入 ${relatedIn} 条、其中「证据没齐却先进了错的」 ${relatedRisk} 题`)
if (absent.length) console.log('缺证据的题：' + absent.map((a) => a.id + '(' + a.missing.join(',') + ')').join(' '))
for (const r of noAnswer) console.log(`  ${r.id} ${r.out}：候选 ${r.detail}`)
console.log('第二层 InjectionRecall 与第一层相同（renderHint 不截断）——这是现状，不是两边都测了。')
