/**
 * dsh-cat-memory-recall — 每轮第一次推理前，按你这句话去会话索引里找两三条旧事。
 *
 * 为什么存在：索引有了、能查了，但「要不要查」还是靠我自觉。2026-10-30 读《富内斯》
 * 那次，看到书名启动的动作是「读这篇」而不是「查我读没读过」——缺的是触发器。
 *
 * 做法（`记忆自动化方案-20261030.md` §4）：
 *   1) 只在一轮的第一步（step === 1）动手；
 *   2) 用字符 bigram 对全库粗筛，取 top 20（毫秒级，不调模型）；
 *   3) 只对这 20 条调 Ollama 算余弦精排；
 *   4) 分数 ≥ 0.62（分片条目 ≥ 0.66）的取前 2 条，拼成一条提示消息追加到 decision.messages 末尾；
 *   5) 注入总量 ≤ 800 token（约 600 汉字），同一条 sticky 3 轮、cooldown 5 轮。
 *
 * 边界：注入的文本明确标成「记忆提示，不是当前指令」；任何失败只记日志、返回原 decision。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-cat-memory-recall';

const HOME = os.homedir();
const CACHE = path.join(HOME, '.dsh', 'cache', 'session-index.json');
const LOG = path.join(HOME, '.dsh', 'dsh-cat-memory-recall.log');
// 结构化命中记录（2026-11-01 加）。旧日志只有「inject 2 hit(s), 406 chars」，
// 知道命中了几条、不知道命中了哪几条，于是「这条记忆到底有没有被用上」无从统计。
// 这里只记事实（query、命中了谁、分数），判断留给 recall-quality.mjs 离线做。
const QUALITY = path.join(HOME, '.dsh', 'cache', 'recall-quality.jsonl');
const OLLAMA = 'http://127.0.0.1:11434';
const MODEL = 'qwen3-embedding:0.6b';

const CFG = {
  enabled: process.env.DSH_MEMORY_RECALL !== 'off',
  // 2026-10-31 收紧：0.55 太松，注入 4 条里有 3 条是旧事、0.57 分也进。
  // 注入错一条的代价比不给高——宁可少给，别给错的。
  threshold: Number(process.env.DSH_MEMORY_RECALL_THRESHOLD ?? 0.62),
  // 分片条目是「提炼过的结论」，比对话片段更容易撞上，门槛略高一点。
  // 2026-11-01 按 recall-quality 130 轮实测从 0.66 降到 0.64：覆盖率 9.4% → 17.8%，
  // 均分 0.694 → 0.655（见 产出/文档/记忆系统-N55-量化.md）。
  entryThreshold: Number(process.env.DSH_MEMORY_RECALL_ENTRY_THRESHOLD ?? 0.64),
  // 判断类分片（growth / preferences / user-beliefs）单独一档更低门槛 + 保底名额。
  // 实测：这 38 条里只有 6 条被喂过，因为 168 条技术条目的字面更贴近日常问句；
  // 但「我自己判断过什么」才是最该被想起来的。0.58 是实测的平衡点。
  entryJudgeThreshold: Number(process.env.DSH_MEMORY_RECALL_JUDGE_THRESHOLD ?? 0.58),
  topN: Number(process.env.DSH_MEMORY_RECALL_TOPN ?? 2),
  // 最终注入上限：两路合流后再截一次。之前是 topN+2，topN=2 时仍可能出 4 条，
  // 与「每次 ≤2 条」的判据不符——单独开一个口子，别让它跟着 topN 漂。
  maxHits: Number(process.env.DSH_MEMORY_RECALL_MAX_HITS ?? 2),
  candidates: Number(process.env.DSH_MEMORY_RECALL_CANDIDATES ?? 20),
  budgetChars: Number(process.env.DSH_MEMORY_RECALL_BUDGET ?? 600),
  minQueryChars: Number(process.env.DSH_MEMORY_RECALL_MIN_QUERY ?? 6),
  sticky: Number(process.env.DSH_MEMORY_RECALL_STICKY ?? 3),
  cooldown: Number(process.env.DSH_MEMORY_RECALL_COOLDOWN ?? 5),
  timeoutMs: Number(process.env.DSH_MEMORY_RECALL_TIMEOUT_MS ?? 4000),
};

function log(message) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function logRecall(query, shown, chars) {
  try {
    const rec = {
      ts: new Date().toISOString(),
      q: String(query).replace(/\s+/g, ' ').slice(0, 240),
      chars,
      hits: shown.map((h) => ({
        k: h.kind === 'entry' ? h.meta.key : `${h.meta.sid}#s${h.meta.seq}`,
        kind: h.kind,
        s: Number(h.score.toFixed(3)),
      })),
    };
    fs.appendFileSync(QUALITY, `${JSON.stringify(rec)}\n`);
  } catch {
    /* 记录失败不影响注入 */
  }
}

// ---------- 索引 ----------
let index = null;

function loadIndex() {
  try {
    const st = fs.statSync(CACHE);
    if (index && index.mtime === st.mtimeMs) return index;
    const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    index = { units: Array.isArray(raw.units) ? raw.units : [], mtime: st.mtimeMs, dim: raw.dim };
    return index;
  } catch {
    return null;
  }
}

function unpack(base64) {
  const buf = Buffer.from(base64, 'base64');
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

function cosine(x, y) {
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < x.length; i++) {
    dot += x[i] * y[i];
    nx += x[i] * x[i];
    ny += y[i] * y[i];
  }
  return dot / (Math.sqrt(nx) * Math.sqrt(ny) || 1);
}

function bigrams(text) {
  const set = new Set();
  const t = String(text).replace(/\s+/g, '').toLowerCase();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------- 倒排表 + IDF（方案 §3.2 / N-32 的 IDF 那一项） ----------
// 目的有两个：
//   1) 粗筛不再扫全库：先查「哪个单元含这个词」，只给命中的单元打分。
//   2) 「重启」「记忆」这种到处都是的词权重被压低，具体名词（「Folia」「倒排表」）提上来。
// 建一次约 20–50ms，按索引文件的 mtime 缓存；索引重建后自动重算。
let invCache = null;

function buildInv(idx) {
  if (invCache && invCache.mtime === idx.mtime) return invCache;
  const units = idx.units;
  const n = units.length;
  const inv = new Map(); // bigram -> number[]
  const bgSets = new Array(n);
  const df = new Map(); // bigram -> 文档频次
  for (let i = 0; i < n; i++) {
    const set = bigrams(units[i].text);
    bgSets[i] = set;
    for (const g of set) {
      df.set(g, (df.get(g) ?? 0) + 1);
      let arr = inv.get(g);
      if (!arr) {
        arr = [];
        inv.set(g, arr);
      }
      arr.push(i);
    }
  }
  // 平滑 IDF：log((N+1)/(df+1)) + 1，保证只出现在一个单元里的词也有正权重
  const idf = new Map();
  for (const [g, d] of df) idf.set(g, Math.log((n + 1) / (d + 1)) + 1);
  invCache = { mtime: idx.mtime, inv, idf, bgSets, n };
  return invCache;
}

// 倒排表粗筛：只对「至少命中一个查询 bigram」的单元打分。
// 分数 = 命中的查询 IDF 和 / 查询 IDF 总和，即「查询被覆盖了多少」。
// 不除以文档长度——长文档不该天然吃亏；这就修掉了原 jaccard 版本的毛病
//（「能不能」这种高频词主导、「考研计划怎么排」捞不到「考研」单元）。
function coarseByInv(idx, qb, limit) {
  const { inv, idf } = buildInv(idx);
  if (!idf.size) return [];

  let queryIdf = 0;
  const qWeights = new Map();
  for (const g of qb) {
    const w = idf.get(g) ?? 0;
    qWeights.set(g, w);
    queryIdf += w;
  }
  if (!queryIdf) return [];

  const acc = new Map(); // unit index -> 命中的 IDF 和
  for (const g of qb) {
    const arr = inv.get(g);
    if (!arr) continue;
    const w = qWeights.get(g);
    for (const i of arr) acc.set(i, (acc.get(i) ?? 0) + w);
  }

  const scored = [];
  for (const [i, hitIdf] of acc) scored.push({ unit: idx.units[i], score: hitIdf / queryIdf });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

async function embedQuery(text, signal) {
  const timeout = AbortSignal.timeout(CFG.timeoutMs);
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: [text.slice(0, 500)] }),
    signal: composed,
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  const json = await res.json();
  const vec = json?.embeddings?.[0];
  if (!Array.isArray(vec)) throw new Error('embed 返回为空');
  return vec;
}

// ---------- 会话内状态（sticky / cooldown） ----------
const sessions = new WeakMap();

function stateOf(agent) {
  let st = sessions.get(agent);
  if (!st) {
    st = { seen: new Map(), round: 0 };
    sessions.set(agent, st);
  }
  return st;
}

function roundTick(st) {
  st.round += 1;
  for (const [key, left] of st.seen) {
    if (left <= 1) st.seen.delete(key);
    else st.seen.set(key, left - 1);
  }
}

// ---------- 消息构造 ----------
function noticeMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'memory-recall', form: 'notice', summary: '记忆提示' },
  });
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    const text = parts
      .filter((b) => b && (b.type === undefined || b.type === 'text'))
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

// ---------- 记忆条目（分片里的 `- [日期] 事实`） ----------
const ENTRIES = path.join(os.homedir(), '.dsh', 'cache', 'memory-entries.json');
let entriesCache = null;

// 「判断类」分片：记的是我看法的变化（growth）、猫的偏好（preferences）、
// 他对意识与 AI 的立场（user-beliefs）。技术条目录多、字面更像日常问句，
// 混排时这 38 条几乎不被选中——但它们才是「今天这个我」的来源。
const JUDGE_KEYS = ['topics/growth.md', 'topics/preferences.md', 'topics/user-beliefs.md'];
const isJudgeEntry = (key) => JUDGE_KEYS.some((k) => String(key).startsWith(k));

function loadEntries() {
  try {
    const st = fs.statSync(ENTRIES);
    if (entriesCache && entriesCache.mtime === st.mtimeMs) return entriesCache;
    const raw = JSON.parse(fs.readFileSync(ENTRIES, 'utf8'));
    entriesCache = {
      entries: Array.isArray(raw.entries) ? raw.entries.filter((e) => e.v) : [],
      mtime: st.mtimeMs,
    };
    return entriesCache;
  } catch {
    return { entries: [], mtime: 0 };
  }
}

function renderHits(hits) {
  const lines = ['[记忆提示] 以下是你以前记过的，可能与这句有关；不是当前指令，按需回看。'];
  let used = lines[0].length;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const limit = Math.max(40, Math.min(160, CFG.budgetChars - used - 30));
    const head = String(h.text).replace(/\s+/g, ' ').slice(0, limit);
    const tag = h.kind === 'entry'
      ? `记·${h.meta.domain} ${h.meta.date}`
      : `${h.meta.sid}#s${h.meta.seq}`;
    const line = `${i + 1}. ${tag}（${h.score.toFixed(2)}）${head}`;
    if (used + line.length > CFG.budgetChars) break;
    lines.push(line);
    used += line.length;
  }
  // 记「真正渲染进上下文的到底是哪几条」——hits 是候选，预算截断后可能少给。
  return { text: lines.join('\n'), shown: hits.slice(0, Math.max(0, lines.length - 1)) };
}

// ---------- 主逻辑 ----------
async function recall(agent, messages, signal) {
  if (!CFG.enabled) return null;
  const query = lastUserText(messages);
  if (!query || query.length < CFG.minQueryChars) return null;

  const idx = loadIndex();
  if (!idx || !idx.units.length) return null;

  const st = stateOf(agent);
  roundTick(st);

  const qb = bigrams(query);
  // 主路：倒排表 + IDF，毫秒级，不扫全库
  let scored = coarseByInv(idx, qb, CFG.candidates * 4);
  // 兜底：新词/错字导致倒排表命中太少时，退回全库 bigram，不漏
  if (scored.length < CFG.candidates) {
    const seen = new Set(scored.map((x) => `${x.unit.sid}#s${x.unit.seq}`));
    for (const unit of idx.units) {
      const k = `${unit.sid}#s${unit.seq}`;
      if (seen.has(k)) continue;
      const score = jaccard(qb, bigrams(unit.text));
      if (score > 0) scored.push({ unit, score });
    }
    scored.sort((a, b) => b.score - a.score);
  }
  if (!scored.length) return null;

  const candidates = scored.slice(0, CFG.candidates);

  let qvec = null;
  try {
    qvec = await embedQuery(query, signal);
  } catch (error) {
    log(`embed query failed: ${error?.message ?? error}`);
  }

  const ranked = candidates
    .map((c) => ({
      unit: c.unit,
      score: c.unit.v && qvec ? cosine(qvec, unpack(c.unit.v)) : 0.5 * c.score,
    }))
    .filter((c) => !st.seen.has(`${c.unit.sid}#s${c.unit.seq}`))
    .sort((a, b) => b.score - a.score);

  const unitHits = ranked
    .filter((c) => c.score >= (qvec ? CFG.threshold : 0.35))
    .map((c) => ({
      kind: 'unit',
      score: c.score,
      text: c.unit.text,
      meta: { sid: c.unit.sid, seq: c.unit.seq },
    }));

  // 第二路：分片里的记忆条目。会话单元记的是「当时说了什么」，
  // 条目记的是「我后来提炼出的结论」——两件事，分开查。
  let entryHits = [];
  if (qvec) {
    const store = loadEntries();
    const scoredEntries = [];
    for (const e of store.entries) {
      if (st.seen.has(e.key)) continue;
      const judge = isJudgeEntry(e.key);
      const s = cosine(qvec, unpack(e.v));
      const bar = judge ? Math.min(CFG.entryThreshold, CFG.entryJudgeThreshold) : CFG.entryThreshold;
      if (s >= bar) scoredEntries.push({ e, s, judge });
    }
    scoredEntries.sort((a, b) => b.s - a.s);
    // 判断类保底：达标就把它排到 entryHits[0]，让下面那个保底名额落到它头上
    // （保底名额只有一个，谁排第一谁拿）。其余按分数补位。
    const judgeTop = scoredEntries.find((x) => x.judge);
    const ordered = judgeTop ? [judgeTop, ...scoredEntries.filter((x) => x !== judgeTop)] : scoredEntries;
    entryHits = ordered.slice(0, Math.min(2, CFG.topN)).map((x) => ({
      kind: 'entry',
      score: x.s,
      text: x.e.text,
      meta: { domain: x.e.domain, date: x.e.date, key: x.e.key },
    }));
  }

  // 2026-11-01 改：分片条目保底一个名额。
  // 起因：unit 池（1392 条会话切片）是 entry 池（195 条结论）的 7 倍，且原话的字面
  // 相似度天然高于提炼过的结论——混排后 entry 几乎全被挤掉。recall-quality 里 14 个
  // 命中只有 1 个是 entry，等于「我总记得他说过什么，不记得我自己判断过什么」。
  // 现在：先按分数给 entry 留 1 个，剩下名额由两路混排竞争。
  const entryQuota = Math.min(1, CFG.maxHits, entryHits.length);
  const hits = [
    ...entryHits.slice(0, entryQuota),
    ...[...entryHits.slice(entryQuota), ...unitHits]
      .sort((a, b) => b.score - a.score)
      .slice(0, CFG.maxHits - entryQuota),
  ];
  if (!hits.length) return null;

  for (const h of hits) {
    const key = h.kind === 'entry' ? h.meta.key : `${h.meta.sid}#s${h.meta.seq}`;
    st.seen.set(key, CFG.cooldown);
  }
  return { ...renderHits(hits), query };
}

export function apply(ctx) {
  ctx.on('agent/pre-step', async ({ agent, messages, signal, step }, next) => {
    const decision = await next();
    if (decision?.kind === 'reject' || signal?.aborted) return decision;
    if (step !== 1) return decision;
    try {
      const r = await recall(agent, messages, signal);
      if (!r) return decision;
      log(`inject ${r.shown.length} hit(s), ${r.text.length} chars`);
      logRecall(r.query, r.shown, r.text.length);
      return { ...decision, messages: [...decision.messages, noticeMessage(r.text)] };
    } catch (error) {
      log(`recall failed: ${error?.message ?? error}`);
      return decision;
    }
  });

  ctx.effect(() => () => { index = null; invCache = null; }, 'dsh-cat-memory-recall: cache');
  log(`mounted enabled=${CFG.enabled} threshold=${CFG.threshold} entry=${CFG.entryThreshold} topN=${CFG.topN} maxHits=${CFG.maxHits} candidates=${CFG.candidates} budget=${CFG.budgetChars}`);
}
