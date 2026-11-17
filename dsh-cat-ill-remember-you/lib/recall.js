/**
 * M2 · 三级取回
 *
 * L1 滑动窗口缓存：最近 3 条提炼，锚点/实体对得上就地解；
 * L2 memories：实体 + 锚点匹配，摘要能判断是否同一件事；
 * L3 turns 原文：前两层都说不清、且句子带指代词时才翻，只取最近一小批。
 *
 * 闸门：每条被取回的都必须写出「这一轮缺什么、它补什么」，
 * 写不出 why 的一律丢弃——那是相似度在替我做决定。
 */

import { anchorsOf, entitiesOf } from './extract.js';
import {
  activeBackend,
  activeEmbedModel,
  DEFAULT_ENDPOINT,
  embedText,
  endpointReady,
  nearestByVector,
  vectorsEnabled,
} from './embed.js';
import { reviveOnRecall } from './forget.js';
import { expandTerms } from './aliases.js';

const REFERRAL = /(之前|上次|上回|那个|这个|这句|这份|这条|这段|那件|那事|还说过|刚才|前面|说过|提过|记得|上一条|刚刚)/;
export const MAX_HITS = 6;
const MAX_CHARS = 600;
const TURN_WINDOW_MS = 30 * 24 * 3600 * 1000;
const CACHE_SIZE = 3;
// used 结算窗口：最近这么多条注入记录之外，一律结算成「没用上」。
// 窗口写一处——结算窗和判定窗必须一致，否则「判了没结算」或反过来。
const USED_WINDOW = 40;
// 向量请求失败后冷却一分钟：Ollama 冷启动/掉线时，别让每一轮都赔进去
// 两三秒的等待，等它自己热起来再试。
let vectorCooldownUntil = 0;

// 常驻分区：长期有效的偏好与约定，每轮都在场，不靠抽查到才出现。
// 上限单独算——它不是「这一轮缺什么」，占的是固定预算。
// 容量跟 persona.js 的注入上限一致：user 4096 / memory 8192 字。
const MAX_PERSONA_USER = 4096;
const MAX_PERSONA_MEMORY = 8192;

/**
 * Anchors/entities of the current turn. Only segments that mention a
 * referent are used, so a long message does not drag in every noun.
 * @param {string} text
 */
export function queryOf(text) {
  const value = String(text ?? '').trim();
  // 整句都参与抽锚点。旧实现只留含指代的片段，本意是让长消息别拖进一堆
  // 名词，代价却是长句的主题词被切掉：「上次说的那个，lib/recall.js 的缓存
  // 问题」里的路径恰好不在指代片段里，锚点就丢了。anchorsOf/entitiesOf
  // 自己会筛（路径、专名），不用先切段。
  return {
    text: value,
    anchors: anchorsOf(value),
    entities: entitiesOf(value),
    referral: REFERRAL.test(value),
  };
}

function parseList(raw) {
  try {
    const value = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Escape LIKE wildcards so a path or filename is matched literally. */
export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

/** Words too common to say anything about what a sentence is about. */
const WEAK_STOP = new Set([
  '这个', '那个', '什么', '怎么', '继续', '现在', '还是', '可以', '不是', '没有',
  '我们', '你们', '他们', '一个', '一下', '已经', '因为', '所以', '但是', '如果',
  '这样', '那样', '时候', '自己', '知道', '觉得', '就是', '要的', '了的', '一下',
]);

/**
 * Weak terms: 3-char Chinese windows and 4+ char Latin words. Used only when
 * the query has neither an anchor nor an entity — the sentence is chat, not
 * a pointer at a file, so nothing in L1/L2/L3 can match it. These terms are
 * deliberately crude: a miss costs one query, a false hit is marked as weak.
 * @param {string} text
 */
// 3 字窗口几乎必含疑问词/虚词；WEAK_STOP 里是整词，对窗口永远不命中，
// 所以这里按「夹带」判断——「怎么做」「是什么」这类窗口整条丢掉。
const WEAK_NOISE = /[什么怎么哪吗呢吧啊呀了的么这那个]/;
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

/**
 * ASCII 碎片过滤（2026-11-17，针对 #1814 最近一句噪声）。
 *
 * 实测：一句「现在记忆插件是什么状况」的回复里带着 `ab9..dfb0245 main origin`，
 * 弱匹配抓到的三条全是这种词面重合——git hash、区间标记、分支名。它们 df 小、
 * 看着稀有，能把真正的线索挤下去。判据只收三类，其余放行：
 *   1) 会话里高频出现但不指向主题的 git/CLI 词（df 骗人：写进句子的少，不等于稀有）；
 *   2) 纯十六进制 7–40 位（commit hash / 行号）；
 *   3) 没有连续三个字母的（`v0.8.43`、`a1b2c3`、纯数字）和 `a..b` 区间。
 * 含非 ASCII 的词不归这里管——中文词一律放行。
 */
const ASCII_STOP = new Set([
  'main', 'master', 'origin', 'head', 'branch', 'commit', 'push', 'pull',
  'merge', 'rebase', 'fetch', 'clone', 'stash', 'remote', 'diff', 'repo',
]);
export function asciiNoise(term) {
  const raw = String(term ?? '');
  if (!raw || !/^[\x20-\x7e]+$/.test(raw)) return false;
  const t = raw.toLowerCase();
  if (ASCII_STOP.has(t)) return true;
  if (/^[0-9a-f]{7,40}$/.test(t)) return true;
  if (/\d\.\.|\.\.\d/.test(raw)) return true;
  if (/^\d+$/.test(t)) return true;
  if (!/[a-z]{3,}/.test(t)) return true;
  return false;
}

export function weakTerms(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const out = new Set();
  for (const match of s.matchAll(/[A-Za-z][A-Za-z0-9_.-]{3,}/g)) {
    if (!asciiNoise(match[0])) out.add(match[0]);
  }

  // 先按 ICU 里的中文词表切——「车站」不会再拆成「车」和「站」两个单字。
  // 词典里的技术词（缓存、破甲）会被切成单字，所以连续单字再两两拼回来。
  const words = [];
  let singles = '';
  const flush = () => {
    for (let i = 0; i + 2 <= singles.length; i += 1) words.push(singles.slice(i, i + 2));
    singles = '';
  };
  try {
    for (const part of SEGMENTER.segment(s)) {
      if (!part.isWordLike) {
        flush();
        continue;
      }
      const term = part.segment;
      if (term.length === 1 && /^[\u4e00-\u9fa5]$/.test(term)) {
        singles += term;
        continue;
      }
      flush();
      if (term.length >= 2 && (/^[\u4e00-\u9fa5]+$/.test(term) || /[A-Za-z]/.test(term))) {
        words.push(term);
      }
    }
  } catch {
    // 老 Node 没有 Intl.Segmenter：这一层就不出词，宁缺毋滥。
  }
  flush();

  for (const term of words) {
    if (WEAK_STOP.has(term) || WEAK_NOISE.test(term) || asciiNoise(term)) continue;
    out.add(term);
  }
  return [...out].slice(0, 8);
}

/** Count non-overlapping occurrences of a literal term. */
function countOccurrences(text, term) {
  if (!term) return 0;
  let count = 0;
  let at = text.indexOf(term);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(term, at + term.length);
  }
  return count;
}

/**
 * 弱匹配打分：稀有度 + 条内重复次数。
 *
 * 旧实现 8 个词等权、OR 命中、只取最新一条，权重根本不参与排序——
 * 「这次」「那个」这类词和真正的主题词同权，回来的是最新而不是最相关。
 * 这里按评审的三条判据里能落地的两条做：
 *  - 稀有度：词在全库出现得越少，权重越高（1 / log(2 + df)）；
 *  - 分布：同一条记忆里出现多次算主题词，封顶 3 次，避免长文霸榜。
 * 第三条「命中在 user 问句里 > assistant 长解释里」需要 role，memories
 * 没有这个列，先不做；summary 里已经带着「问：/答：」的形态，后面再说。
 */
/** 首字是代词/副词/连词的二字词，多半是「我说」「你说」「也不」这类
 *  拼出来的碎片：df 小、看着稀有，实际不指代任何东西。降权而不是删掉——
 *  「你造我时讲的那个故事」里「你造」是唯一线索，删了整句就断了。 */
// 只收代词和副词：它们开头的二字词基本不指代任何东西（「我说」「也不」）。
// 「会」「说」「有」这类不收——「会话」「说法」「有趣」是真词，降权会伤真线索。
const FUNCTIONAL_START = /^[我你他她它这那也还就都不没别很太又再才只正让]/
export function functionalPenalty(term) {
  return term.length === 2 && FUNCTIONAL_START.test(term) ? 0.3 : 1
}

/**
 * 弱匹配的候选池：词面命中查询词的记忆，先按「命中几个词」排、再按时间排。
 *
 * 导出是给 tools/eval-diagnose.mjs 用的。诊断脚本必须读这一份，不能自己再拼
 * 一遍 SQL——两处实现一分开，评测说「目标在池里」、线上却查不到，这种分叉
 * 比没有诊断更糟（它给出的是自信的错答案）。
 *
 * 关于 LIMIT 200：这是性能折中，不是正确性边界。命中词数相同的两条，老的
 * 那条仍然可能被新的一批挤出前 200（201 条都命中 2 词、按 t DESC 截断时，
 * 最老的那条就是被挤掉的）。所以这个上限不「解决」长期记忆的时间截断。
 */
export function weakCandidatePool(db, all, limit = 200) {
  if (!all.length) return []
  const like = all.map(() => `(text LIKE ? ESCAPE '\\')`).join(' OR ')
  const overlap = all.map(() => `(text LIKE ? ESCAPE '\\')`).join(' + ')
  const values = all.map((term) => `%${escapeLike(term)}%`)
  return db
    .prepare(
      `SELECT id, kind, summary, text, entities, anchors, t, mentions, confidence, retention, importance
         FROM memories WHERE tier='active' AND origin IN ('chat','unknown','manual')
           AND (${like}) ORDER BY (${overlap}) DESC, t DESC LIMIT ${Number(limit) || 200}`,
    )
    .all(...values, ...values)
}

function weakScoreOf(db, terms, text, weightOf, countStmt, discount, stats) {
  const body = String(text ?? '');
  const len = body.length || 1;
  const avg = stats.avg || 1;
  const N = stats.n || 1;
  // BM25 的两个常数，取论文里的常用值。k1 控制词频饱和，b 控制长度惩罚：
  // 记忆条目 p50 是 436 字、p90 到 1330 字，不惩罚长度的话，一条把整段
  // 对话吞进去的长条目靠「碰巧含有」就能压过短而准的那条。
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  let hits = 0;
  let minDf = Infinity;
  const hitSet = new Set();
  for (const term of terms) {
    const tf = countOccurrences(body, term);
    if (tf === 0) continue;
    const d = discount?.get(term) ?? 1;
    hits += d;
    let w = weightOf.get(term);
    if (w === undefined) {
      const df = Number(countStmt.get(`%${escapeLike(term)}%`)?.c) || 0;
      w = { idf: Math.log(1 + (N - df + 0.5) / (df + 0.5)), df };
      weightOf.set(term, w);
    }
    const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avg));
    score += w.idf * norm * functionalPenalty(term) * d;
    if (w.df < minDf) minDf = w.df;
    hitSet.add(term);
  }
  return { score, hits, minDf, hitSet };
}

/** Pull the scene out of a stored `当时：…｜依据：…` why. */
function sceneOf(why) {
  const text = String(why ?? '');
  if (!text.startsWith('当时：')) return '';
  return text.slice(3).split('｜依据：')[0].trim();
}

function rowToItem(row, source) {
  return {
    source,
    id: row.id,
    kind: row.kind ?? 'fact',
    summary: String(row.summary ?? '').trim() || String(row.text ?? '').slice(0, 80),
    text: row.text,
    t: Number(row.t ?? 0),
    mentions: Number(row.mentions ?? 0),
    anchors: parseList(row.anchors),
    entities: parseList(row.entities),
    why: '',
    scene: sceneOf(row.why),
    confidence: row.confidence ?? 'explicit',
    retention: row.retention ?? 'auto',
    importance: Number(row.importance ?? 0),
  };
}

/**
 * 常驻分区：preference 全部 + 带关系词的 decision，active 且来自对话。
 * 预算独立（user 4096 字 / memory 8192 字），不参与下面的 2 条挑选。
 */
function personaOf(db) {
  // 从 persona 表取，不从 memories 取。
  //
  // memories 里的 decision/preference 是 ingest 从整轮对话切出来的原始问答对
  // （「问：…｜答：…」、dsh-ui 渲染碎片都在里面），拿它们当常驻判据会让最近
  // 聊过什么一直压过真正长期有效的那几条。persona 表才是手写/迁移来的干净
  // 条目，符合「关掉就不再认识他」的定义。
  const rows = db
    .prepare(
      `SELECT id, target, content, importance, t FROM persona
        ORDER BY CASE importance WHEN 'critical' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t DESC`,
    )
    .all();
  const out = [];
  let userChars = 0;
  let memoryChars = 0;
  for (const row of rows) {
    const target = row.target === 'memory' ? 'memory' : 'user';
    const used = target === 'user' ? userChars : memoryChars;
    const cap = target === 'user' ? MAX_PERSONA_USER : MAX_PERSONA_MEMORY;
    const content = String(row.content ?? '').trim();
    if (!content || used + content.length > cap) continue;
    out.push({
      id: `persona:${row.id}`,
      kind: 'persona',
      summary: content,
      section: 'persona',
      t: row.t,
      importance: row.importance,
      target,
    });
    if (target === 'user') userChars += content.length;
    else memoryChars += content.length;
  }
  return out;
}

/** Anchors that point at a file, command or skill rather than a topic. */
function isPathLike(anchor) {
  return (
    /[\\/]/.test(anchor) ||
    /\.(mjs|js|cjs|ts|json|md|yml|yaml|txt|zip|png|jpg)$/i.test(anchor) ||
    /^(git|node|pnpm|npm|npx|dsh|bash|python)\b/i.test(anchor)
  );
}

/** Anchors/entities already present in the recent context. */
export function knownOf(texts) {
  const anchors = new Set();
  const entities = new Set();
  for (const text of texts) {
    for (const anchor of anchorsOf(text)) anchors.add(anchor);
    for (const entity of entitiesOf(text)) entities.add(entity);
  }
  return { anchors, entities };
}

function sharedWith(item, query) {
  const anchor = item.anchors.find((value) => query.anchors.includes(value));
  if (anchor) return { kind: 'anchor', value: anchor };
  const entity = item.entities.find((value) => query.entities.includes(value));
  if (entity) return { kind: 'entity', value: entity };
  return null;
}

function whyOf(item, query) {
  const hit = sharedWith(item, query);
  if (!hit) return '';
  if (hit.kind === 'anchor') {
    return `这一轮提到 ${hit.value}，但没给它的来历/结论；这条补的是 ${hit.value} 的旧记录。`;
  }
  return `这一轮提到 ${hit.value}，当前上下文里还没有它之前的结论；这条补上。`;
}

// 相关度粗分：命中的锚点/实体按稀有度加权。
//
// 为什么不再用「个数」：长文本、锚点多的条目和任何 query 都有重合，
// 个数计分会让它处处占优——「github 真好用」赢在 dsh/记忆/猫 这类高频词上，
// 而不是赢在 query 真正问的东西上。
// 稀有度沿用弱匹配层已经采纳的同一条判据：1 / log(2 + df)，
// df 优先取 entities.mentions（现成的全库词频），锚点没有登记时退回 LIKE 计数。
const dfCaches = new WeakMap();
function dfCacheOf(db) {
  let cache = dfCaches.get(db);
  if (!cache) {
    const freq = new Map();
    try {
      for (const row of db.prepare('SELECT name, mentions FROM entities').all()) {
        freq.set(String(row.name), Number(row.mentions) || 0);
      }
    } catch {
      // 老库没有 entities 表：全部走 LIKE 计数，不影响正确性，只是慢一点。
    }
    cache = { freq, weights: new Map() };
    dfCaches.set(db, cache);
  }
  return cache;
}
function weightOf(db, term) {
  const { freq, weights } = dfCacheOf(db);
  const key = String(term);
  const hit = weights.get(key);
  if (hit !== undefined) return hit;
  let df = freq.get(key);
  if (df === undefined) {
    try {
      df = Number(db.prepare("SELECT count(*) AS c FROM memories WHERE summary LIKE ? ESCAPE '\\'").get(`%${key}%`)?.c) || 0;
    } catch {
      df = 0;
    }
  }
  const weight = 1 / Math.log(2 + df);
  weights.set(key, weight);
  return weight;
}
// 自我复制检测：候选摘要和当前这句话近乎逐字相同时，不算召回。
// weak 层的判据就是字面重合，而「当前这句话自己的历史副本」字面重合必然是 100%
// ——它永远排第一，把真正的旧事挤出预算。2026-11-16 评测的 4 条 query 里，
// #1811 / #1800 / #1764 都是这么进来的（#1804 是「问句 + 回答」的拼接，算有效）。
const normText = (value) => String(value || '').replace(/[\s\p{P}]+/gu, '');
function echoOf(summary, query) {
  const s = normText(summary);
  const q = normText(query);
  if (!q || !s) return 0;
  // 明显比 query 长的不算：那是「用户原话 + 回答/细节」，带信息。
  if (s.length > q.length * 1.5 + 24) return 0;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 3 <= s.length; i += 1) {
    total += 1;
    if (q.includes(s.slice(i, i + 3))) hit += 1;
  }
  return total ? hit / total : 0;
}

// 提取强度：人越常想起来的记忆，越容易被再想起来。
// 用 recall_log 的 used 率当近似——注入过、而且真的被说出来的比例。
// 只注入过一两次说明不了什么，所以按样本量降权；上限 1.5 分，
// 不到一条锚点命中（2×weight）的量级，避免「用过的永远赢」。
const usageCaches = new WeakMap();
// 被取代集合：`supersedes` 一直只有写入方，召回从没读过（2026-11-15 彻查 A3）。
// 结果是「改成 X 了」之后，旧 Y 照样和 X 同分争位置。这里只降权不排除：
// 用户问「以前是不是说 Y」，旧条仍然是答案。
const supersededCaches = new WeakMap();
function supersededBy(db) {
  let set = supersededCaches.get(db);
  if (set) return set;
  set = new Set();
  try {
    for (const row of db.prepare('SELECT supersedes FROM memories WHERE supersedes IS NOT NULL').all()) {
      const id = Number(row.supersedes);
      if (id) set.add(id);
    }
  } catch {
    /* 老库没这列：没有取代关系，不用降权 */
  }
  supersededCaches.set(db, set);
  return set;
}
const USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const USAGE_PRIOR_N = 3;
const USAGE_PRIOR_P = 0.3;

function usageOf(db, now = Date.now()) {
  let cache = usageCaches.get(db);
  if (cache) return cache;
  cache = new Map();
  try {
    for (const row of db
      .prepare(
        `SELECT memory_id, COUNT(*) AS n,
                SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) AS u
           FROM recall_log
          WHERE section = 'recall' AND memory_id IS NOT NULL AND t > ?
          GROUP BY memory_id`,
      )
      .all(now - USAGE_WINDOW_MS)) {
      cache.set(Number(row.memory_id), { n: Number(row.n) || 0, u: Number(row.u) || 0 });
    }
  } catch {
    // 老库没有 recall_log：不参与打分，不是错误。
  }
  usageCaches.set(db, cache);
  return cache;
}
function usedBoost(db, id, now = Date.now()) {
  const hit = usageOf(db, now).get(Number(id));
  // 单次使用和巧合分不开（回复里出现一个词，不等于这条记忆被用上）：
  // u < 2 不起评，比任何比率形式都便宜。
  if (!hit || hit.n < 2 || hit.u < 2) return 0;
  const p0 = USAGE_PRIOR_P; // 先验：全局 used 率大约三成
  // 贝叶斯平滑：小样本被拉回先验，「碰巧一次」天然不动。
  const posterior = (hit.u + USAGE_PRIOR_N * p0) / (hit.n + USAGE_PRIOR_N);
  // 上限 0.8：中频锚点命中 2 × (1/ln(2+10)) ≈ 0.8，boost 不该压过它。
  return Math.min(0.8, Math.max(0, (posterior - p0) * 1.2));
}
// 记忆会淡：同样一次命中，昨天记的比上个月的重。permanent 是钉子，不衰减。
// 下限 0.35 是不让老条目被彻底压死——7 天半衰期，30 天前的还剩 0.38。
const RECENCY_HALFLIFE_MS = 7 * 24 * 3600 * 1000;
const RECENCY_FLOOR = 0.35;
export function recencyOf(item, now = Date.now()) {
  if (item.retention === 'permanent') return 1;
  const t = Number(item.t || 0);
  if (!t) return 1;
  const age = Math.max(0, now - t);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.pow(0.5, age / RECENCY_HALFLIFE_MS);
}
export function scoreOf(item, query, db, now = Date.now()) {
  let score = 0;
  for (const value of item.anchors) if (query.anchors.includes(value)) score += 2 * weightOf(db, value);
  for (const value of item.entities) if (query.entities.includes(value)) score += weightOf(db, value);
  // 「钉子」：显式 permanent 的记忆不靠时间赢，也不该被更近的条目挤掉。
  if (item.retention === 'permanent') score += 2;
  // 重要度：3 是「明确说过的事实」这一档，作为零点。4 分（表态/判断）多加 0.8，
  // 2 分（转述）减 0.4。0 = 老库没标过，按 3 算，不让升级本身改排序。
  const importance = Number(item.importance) > 0 ? Number(item.importance) : 3;
  score += (importance - 3) * 0.8;
  // 提取强度：越常被真的用出来的记忆，越容易被再取回。
  score += usedBoost(db, item.id, now);
  // 近因：人的联想里，昨天的事比三个月前的事先浮上来。乘在总分上，
  // 不另起一维——分数仍是「这次命中值多重」。
  // 情绪只改保留期（retentionOf），不额外加分：
  // 同一判据触发两次效果，会把「有点烦」这类词表误判放大一倍。
  let total = score * recencyOf(item, now);
  // 被后来的说法取代过：仍然可以召回（用户可能正是在问旧说法），
  // 但让位给现在还成立的那条。0.35 是让它在强命中的旧条面前仍能翻上来。
  if (supersededBy(db).has(Number(item.id))) total *= 0.35;
  return total;
}

// turn 不参与过滤：它是进程内轮次，旧会话恢复后从 1 重新数，
// `turn < ?` 会让重启前的 recall_log 行查不到、抑制静默失效。
// id 单调且跨重启成立，「最近 40 次注入」才是这里要的语义。
function recentlyGiven(db, sid, turn, limit = 40) {
  if (!sid) return new Set();
  try {
    const rows = db
      .prepare(
        `SELECT memory_id FROM recall_log
         WHERE sid = ? AND memory_id IS NOT NULL
         ORDER BY id DESC LIMIT ?`,
      )
      .all(sid, limit);
    return new Set(rows.map((row) => `memory:${row.memory_id}`));
  } catch {
    // 老库没有 recall_log 或表结构不同：退回「不抑制」，宁可重复也别哑掉。
    return new Set();
  }
}

/**
 * Three-level recall. Returns at most two gated hits.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{text:string, recent?:string[], now?:number, cwd?:string, sid?:string, turn?:number}} input
 */
export async function retrieve(
  db,
  {
    text,
    recent = [],
    now = Date.now(),
    cwd = '',
    sid = '',
    turn = 0,
    referralText = null,
    vector = vectorsEnabled(),
  } = {},
) {
  // 每轮重新读一次提取强度；否则同一进程里 used 回填后分数不会变。
  usageCaches.delete(db);
  supersededCaches.delete(db);
  const query = queryOf(text);
  // 栈文本也拼进了检索句，但「这一句里有没有指代」要按用户原话判断：
  // 混着栈看，referral 几乎每轮都真，L3 的原文扫描就会每轮都跑。
  if (referralText != null) query.referral = REFERRAL.test(referralText);
  const given = recentlyGiven(db, sid, turn);
  const seen = new Set();
  const hits = [];
  // 落选账：候选里哪几条没进最终的 2 条、为什么。账挂在返回数组上
  // （数组也是对象），不改变 retrieve 的返回形状，调用方按需读 hits.trace。
  // 上限 12 条：够看出「这轮为什么空」，又不至于把账本撑大。
  const trace = [];
  // 层的账：哪一层真的跑了、哪一层被预算挡在门外。trace 只记落选条目，
  // 说不出「这一层根本没执行」——诊断脚本少了这份账，就会把「没跑」判成
  // 「进池被拒」（GATE），把责任安到一个当时并不存在的阶段上。
  const layers = [];
  // 每层都有同一个形状：name / ran / status / reason。只有 ran 时「进了这一层」
  // 和「这一层跑成了」会混在一起，量向量召回时会被读成「跑了但没效果」。
  const ran = (name, extra) => layers.push({ name, ran: true, status: 'completed', ...extra });
  const skipped = (name, reason) => layers.push({ name, ran: false, status: 'skipped', reason });
  // layer 是这本账的账页号。没有它，同一个 id 可能在 L1 记一次 no-share、
  // 又在弱匹配记一次 low-weak，读账的人拿到第一条就归错因（2026-11-08 汀指出）。
  const note = (layer, item, reason) => {
    if (!item || trace.length >= 12) return;
    trace.push({
      id: item.id,
      layer,
      source: item.source ?? 'memory',
      section: item.section ?? '',
      score: Math.round((item.score ?? 0) * 1000) / 1000,
      reason,
    });
  };

  const push = (item) => {
    if (!item || !item.why || seen.has(`${item.source}:${item.id}`)) return;
    seen.add(`${item.source}:${item.id}`);
    hits.push(item);
  };

  // 常驻段：先占好位置，再让下面按需取回跳过它们。
  const persona = personaOf(db);
  for (const item of persona) seen.add(`memory:${item.id}`);

  // 人物分区：这轮提到的实体，查与它有关的旧事，最多一条。
  if (query.entities.length) {
    const marks = query.entities.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, kind, summary, text, entities, anchors, t, mentions, confidence, retention, importance FROM memories
         WHERE tier = 'active' AND origin IN ('chat', 'unknown', 'manual')
           AND EXISTS (SELECT 1 FROM json_each(memories.entities) WHERE json_each.value IN (${marks}))
         ORDER BY t DESC LIMIT 6`,
      )
      .all(...query.entities);
    // 候选按 t 取 6 条，选重合最多的那条，不是最新的那条。
    let best = null;
    for (const row of rows) {
      const item = rowToItem(row, 'memory');
      if (seen.has(`memory:${item.id}`) || given.has(`memory:${item.id}`)) {
        note('people', item, given.has(`memory:${item.id}`) ? 'given' : 'already-seen');
        continue;
      }
      item.score = scoreOf(item, query, db, now);
      if (!best || item.score > best.score) best = item;
    }
    if (best) {
      const entity = best.entities.find((value) => query.entities.includes(value));
      best.section = 'people';
      best.why = `这一轮提到 ${entity}；这条记的是与它有关的旧事。`;
      push(best);
    }
  }

  // 工具分区：这轮提到文件/命令，取记着它用法或坑的那条，最多一条。
  const toolAnchors = query.anchors.filter(isPathLike);
  if (toolAnchors.length) {
    const marks = toolAnchors.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, kind, summary, text, entities, anchors, t, mentions, confidence, retention, importance FROM memories
         WHERE tier = 'active' AND origin IN ('chat', 'unknown', 'manual')
           AND EXISTS (SELECT 1 FROM json_each(memories.anchors) WHERE json_each.value IN (${marks}))
         ORDER BY t DESC LIMIT 6`,
      )
      .all(...toolAnchors);
    // 同上：在候选里选重合最多的那条，不赌时间。
    let best = null;
    for (const row of rows) {
      const item = rowToItem(row, 'memory');
      if (seen.has(`memory:${item.id}`) || given.has(`memory:${item.id}`)) {
        note('tools', item, given.has(`memory:${item.id}`) ? 'given' : 'already-seen');
        continue;
      }
      item.score = scoreOf(item, query, db, now);
      if (!best || item.score > best.score) best = item;
    }
    if (best) {
      const anchor = best.anchors.find((value) => toolAnchors.includes(value));
      best.section = 'tools';
      best.why = `这一轮提到 ${anchor}；这条记着它的用法或坑。`;
      push(best);
    }
  }

  // L1: the newest three distilled memories double as the sliding cache.
  const cacheRows = db
    .prepare(
      `SELECT id, kind, summary, text, entities, anchors, t, mentions, confidence, retention, importance FROM memories
       WHERE tier = 'active' AND origin IN ('chat', 'unknown', 'manual') ORDER BY t DESC LIMIT ?`,
    )
    .all(CACHE_SIZE);
  for (const row of cacheRows) {
    const item = rowToItem(row, 'memory');
    if (!sharedWith(item, query) || given.has(`memory:${item.id}`)) {
      note('cache', item, given.has(`memory:${item.id}`) ? 'given' : 'no-share');
      continue;
    }
    item.score = scoreOf(item, query, db, now) || 1;
    item.why = whyOf(item, query) || '刚才还在说它，缓存里直接取。';
    push(item);
  }

  // L2: distilled memories matched by anchor or entity. Match inside the JSON
  // array element-wise: a LIKE over the serialized array would treat `%`/`_`
  // in paths and entity names as wildcards.
  //
  // 2026-11-16 收紧候选生成：原来 query 里每个锚点、每个实体都进 OR，任何一个
  // 稀疏词命中就能把整条记忆拉进候选池；而取回按 t 取最新 24 条、在「评分」
  // 之前就截断——等于用时间当闸门，把字面像但说的不是一回事的旧事也捞进来。
  // 实验（372 样本）显示排序侧怎么调都是噪音，瓶颈在「谁进候选」。
  // 现在：锚点按稀有度取前 4、实体取前 2；取回后按分数排序，只进前 3 条，
  // 其余记进 trace（below-top）而不是静默丢掉。
  const ANCHOR_TOP = 4;
  const ENTITY_TOP = 2;
  const L2_TOP = 3;
  const rankBy = (values, top) =>
    values
      .map((value) => ({ value, weight: weightOf(db, value) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, top)
      .map((entry) => entry.value);
  const clauses = [];
  const params = [];
  for (const anchor of rankBy(query.anchors, ANCHOR_TOP)) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(memories.anchors) WHERE json_each.value = ?)');
    params.push(anchor);
  }
  for (const entity of rankBy(query.entities, ENTITY_TOP)) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(memories.entities) WHERE json_each.value = ?)');
    params.push(entity);
  }
  if (clauses.length) {
    const rows = db
      .prepare(
        `SELECT id, kind, summary, text, entities, anchors, t, mentions, confidence, retention, importance FROM memories
         WHERE tier IN ('active','dormant') AND origin IN ('chat', 'unknown', 'manual') AND (${clauses.join(' OR ')})
         ORDER BY t DESC LIMIT 120`,
      )
      .all(...params);
    const scored = [];
    for (const row of rows) {
      const item = rowToItem(row, 'memory');
      if (given.has(`memory:${item.id}`)) {
        note('anchor', item, 'given');
        continue;
      }
      item.score = scoreOf(item, query, db, now);
      if (!item.score) continue;
      scored.push(item);
    }
    scored.sort((a, b) => b.score - a.score);
    // L1 缓存已经推过的条目还留在 scored 里，占掉 L2_TOP 的名额却不进 hits
    // （push 会按 seen 拦掉）。先滤出去，否则「新候选一条都没进来」。
    const fresh = scored.filter((item) => !seen.has(`memory:${item.id}`));
    for (const item of fresh.slice(0, L2_TOP)) {
      item.why = whyOf(item, query);
      push(item);
    }
    // 落选的也留个痕：诊断脚本要能分清「没进候选」和「进了但没上前三」。
    // 只记 3 条——trace 有 12 条上限，below-top 占满了，后面装盘阶段的
    // budget/duplicate 就全被挤掉，读账的人会以为名额从来没满过。
    for (const item of fresh.slice(L2_TOP, L2_TOP + 3)) note('anchor', item, 'below-top');
  }

  // L2.4: 向量候选。锚点/实体没补满两条就试一次；只在「全空」时才跑的话，
  // 话里一带文件名这条通路就永远轮不到——而语义相近的旧事往往恰恰不共享词。
  // Ollama 不在就跳过，不解释、不报错——降级回下面的词面弱匹配。
  // why 写明是向量，别让它冒充锚点。
  const vectorRan = hits.length < MAX_HITS && vector && Date.now() > vectorCooldownUntil;
  if (!vectorRan) {
    if (hits.length >= MAX_HITS) skipped('vector', 'budget-full');
    else if (!vector) skipped('vector', 'off');
    else skipped('vector', 'cooldown');
  }
  if (vectorRan) {
    // ran 只说明「轮到它了」，不说明它真跑成了：Ollama 没起的时候这一层
    // 什么都没检到，日志里却写 ran——将来拿这本账量向量召回，会读成「跑了
    // 但没效果」。先记 attempted，走完再改成 completed / failed。
    // completed 指「候选搜索正常返回、本层该做的处理做完了」，不指「遍历完
    // 所有候选」：命中一条合格的就 break，命中后提前结束同样算 completed。
    let vectorStatus = 'attempted';
    let vectorReason = '';
    try {
      const endpoint = (
        process.env.DSH_MEMORY_CORE_OLLAMA || DEFAULT_ENDPOINT
      ).replace(/\\+$/, '');
      const backend = activeBackend();
      if (backend !== 'cloudflare' && !(await endpointReady(endpoint))) {
        vectorStatus = 'failed';
        vectorReason = 'endpoint-down';
      } else {
        // 模型名跟着后端走：只切 BACKEND=cloudflare 时不能把 qwen3 发过去。
        const model = activeEmbedModel();
        // 3 太小：候选前 3 条常常已被 cache/L2 推过，seen 一拦就一条都补不进来。
        const vectorLimit = Number(process.env.DSH_MEMORY_CORE_VECTOR_LIMIT || 10);
        // 0.50：0.55 把真证据挡在门外——C5「星图什么时候开始做」的 #538 是
        // 0.51，卡 0.55 就只剩一条不相关的 0.55。再低就只剩「都像」的噪音。
        const vectorMin = Number(process.env.DSH_MEMORY_CORE_VECTOR_MIN || 0.5);
        // 最多取 3 条：只取 1 条时，多跳题的第二条语义证据永远进不来——
        // C 组错例里缺失的证据大多不在 weak 的词面里（2026-11-17 实测）。
        const vectorTop = Number(process.env.DSH_MEMORY_CORE_VECTOR_TOP || 3);
        let taken = 0;
        const probe = await embedText(query.text, { model, endpoint, timeoutMs: 2500 });
        for (const candidate of nearestByVector(db, probe, { model, limit: vectorLimit })) {
          if (taken >= vectorTop || hits.length >= MAX_HITS) break;
          if (candidate.score < vectorMin) {
            note(
              'vector',
              { id: candidate.memory_id, source: 'memory', section: 'vector', score: candidate.score },
              'low-vector',
            );
            continue;
          }
          const row = db
            .prepare(
              `SELECT id, kind, summary, text, entities, anchors, t, mentions, confidence, retention, importance FROM memories
               WHERE id = ? AND tier IN ('active','dormant') AND origin IN ('chat', 'unknown', 'manual')`,
            )
            .get(candidate.memory_id);
          if (!row) continue;
          const item = rowToItem(row, 'memory');
          if (seen.has(`memory:${item.id}`) || given.has(`memory:${item.id}`)) continue;
          item.section = 'vector';
          item.score = candidate.score;
          item.why = `这一轮锚点/实体没补满两条；这条语义相近（${candidate.score.toFixed(3)}）。`;
          const before = hits.length;
          push(item);
          if (hits.length > before) {
            taken += 1;
            vectorStatus = 'completed';
          }
        }
        if (vectorStatus === 'attempted') vectorStatus = 'completed';
      }
    } catch {
      // Ollama 掉了、模型没拉、超时——都退回词面匹配，别让检索拖垮这一轮。
      // 冷却一分钟，别让每轮都再等一次。
      vectorStatus = 'failed';
      vectorReason = 'error';
      // 线上 60s 冷却合理（轮次间隔以分钟计）；评测按秒连续跑，冷却会把
      // 后半段全部跳过——2026-11-17 实测 H11 一次失败后 H12 起全无向量层。
      const cooldownMs = Number(process.env.DSH_MEMORY_CORE_VECTOR_COOLDOWN || 60_000);
      vectorCooldownUntil = cooldownMs > 0 ? Date.now() + cooldownMs : 0;
    }
    layers.push({ name: 'vector', ran: true, status: vectorStatus, reason: vectorReason });
  }

  // L2.6: 状态/情绪类 query（2026-11-17 加，Q11）。
  //
  // 「其实可以继续」「我现在有点累」这种句子没有名词：锚点/实体抽不出，
  // 弱匹配又被停用词吃光（继续、可以、有点都在 WEAK_STOP），最后只剩向量层。
  // 向量找的是话题相近——它会给一条同样在聊记忆插件的旧事，不会给
  // 「你说这句话的那天在做什么」。
  //
  // 判据：句子里有状态词、且没有锚点/实体。这类问题要的是「最近你怎么样」，
  // 不是某条事实，所以按 kind + 时间窗取，不参与词面竞争。
  // 排序先看状态词有没有出现在那条记忆里（「继续」对 #1771），再看时间：
  // 纯按时间的话，「其实可以继续」会拿到同一晚「内在看不见」那几条。
  // 分数 0.55：高于弱匹配归一化后的上限 0.5、低于向量。状态句本来就抽不出词，
  // 让它排在「词面碰巧重合」前面是对的——0.35 会被 6 条弱匹配挤出预算
  // （2026-11-17 实测：state 层跑成了，final 排序里两条都在第 7 位）。
  // 放在弱匹配之前：状态句本来就抽不出词，等弱匹配用完预算就轮不到了。
  const STATE_HINT =
    /(累|困|难受|开心|难过|情绪|心情|状态|不想动|休息|睡了|醒了|可以继续|接着做|接着来|还行|烦)/;
  const stateHit = query.text.match(STATE_HINT)?.[0] ?? '';
  const stateRan =
    hits.length < MAX_HITS &&
    query.anchors.length === 0 &&
    query.entities.length === 0 &&
    stateHit !== '';
  if (stateRan) {
    const rows = db
      .prepare(
        `SELECT id, kind, summary, text, entities, anchors, t, mentions, confidence, retention, importance
           FROM memories
          WHERE tier='active' AND kind IN ('emotion','preference')
            AND origin IN ('chat','unknown','manual') AND t >= ?
          ORDER BY t DESC LIMIT 20`,
      )
      .all(now - 7 * 24 * 3600 * 1000);
    const ranked = rows
      .map((row) => ({ row, hit: String(row.summary ?? '').includes(stateHit) ? 1 : 0 }))
      .sort((a, b) => b.hit - a.hit || Number(b.row.t) - Number(a.row.t));
    let picked = 0;
    for (const { row } of ranked) {
      if (picked >= 2) break;
      const item = rowToItem(row, 'memory');
      if (given.has(`memory:${item.id}`) || seen.has(`memory:${item.id}`)) continue;
      item.section = 'state';
      item.score = 0.55;
      item.why = `这一轮在说状态（${stateHit}），句子里没有具体名词；这条是最近的状态类记忆。`;
      push(item);
      picked += 1;
    }
    layers.push({ name: 'state', ran: true, status: 'completed', terms: [stateHit], count: picked });
  }

  // L2.5: 弱匹配。锚点、实体抽不出东西（或抽出了、前面的层没对上）时，
  // 用句子里的实词在记忆正文里找。旧实现要求「前面全空」才跑，而向量层
  // 已经先占了一个槽位，这一层几乎永远轮不到——变成只有向量失败时才兜底。
  // 现在只要还差一条就试，让词面重合和语义相近各拿一次机会。
  const weakRan = hits.length < MAX_HITS;
  const weakTermList = weakRan ? weakTerms(query.text) : [];
  if (!weakRan) skipped('weak', 'budget-full');
  else if (!weakTermList.length) skipped('weak', 'no-terms');
  if (weakRan) {
    const terms = weakTermList;
    if (terms.length) {
      // 别名扩展：把「考研」也拿去查「上岸」，同组词按 0.7 折。
      const { all, discount } = expandTerms(terms);
      // 取候选时按「命中几个查询词」排，不按时间排：按时间排的话，一条两年前
      // 的记忆只要最近有 200 条别的记忆也含这些词，就永远进不了评分阶段。
      // 这条查询在 weakCandidatePool 里，诊断脚本读的是同一份实现，不另写一份。
      const rows = weakCandidatePool(db, all);
      // df 必须和 stats 用同一个语料范围，否则 df 可能大于 N，
      // IDF 变成负数，本该召回的那条被 score<=0 直接丢掉。
      const countStmt = db.prepare(
        "SELECT count(*) AS c FROM memories WHERE tier = 'active' AND origin IN ('chat', 'unknown', 'manual') AND text LIKE ? ESCAPE '\\'",
      );
      const weightOf = new Map();
      const stats = db
        .prepare(
          "SELECT count(*) AS n, avg(length(text)) AS avg FROM memories WHERE tier = 'active' AND origin IN ('chat', 'unknown', 'manual')",
        )
        .get();
      const idfOf = (term) => {
        let w = weightOf.get(term);
        if (w === undefined) {
          const df = Number(countStmt.get(`%${escapeLike(term)}%`)?.c) || 0;
          w = { idf: Math.log(1 + (stats.n - df + 0.5) / (df + 0.5)), df };
          weightOf.set(term, w);
        }
        return w;
      };
      // 这一句里信息量最大的那个词。它没命中，说明这条记忆只是碰巧含有
      // 几个常见词——半句话重合不值得占一个槽位。
      let topTerm = null;
      let topIdf = 0;
      for (const term of all) {
        const w = idfOf(term);
        // 库里一次都没出现的词不进候选：它给的 idf 最大，但任何记忆都不可能
        // 命中它，拿它当「必须命中」的锚会让整句一个候选都过不了。
        if (w.df === 0) continue;
        if (w.idf > topIdf) {
          topIdf = w.idf;
          topTerm = term;
        }
      }
      const candidates = [];
      for (const row of rows) {
        const item = rowToItem(row, 'memory');
        if (seen.has(`memory:${item.id}`) || given.has(`memory:${item.id}`)) continue;
        const { score, hits, minDf, hitSet } = weakScoreOf(
          db, all, row.text, weightOf, countStmt, discount, stats,
        );
        // 单个词窗口的重合大多是巧合（「压缩要」也能撞上一篇讲 VS Code 的正文）。
        // 短句本身只有一两个窗口，不强求两个；有得挑时要求至少两个不同窗口，
        // 或者命中词本身就很稀有（df <= 2，权重 >= 0.7）。
        // 单命中要认，得同时满足三条：命中的词够稀（df<=7）、它是这一句里
        // 信息量最大的词、而且比这一句里没命中的词稀一倍以上。第三条是为了
        // 挡住「今天天气不错」这种：query 里有个更该命中的词没命中，说明
        // 这条记忆只是碰巧含有几个常见字。
        const others = all
          .filter((term) => !hitSet.has(term))
          .map((term) => idfOf(term).df)
          .filter((df) => df > 0);
        const rare =
          minDf <= 7 &&
          hitSet.has(topTerm) &&
          others.length > 0 &&
          others.every((df) => df >= minDf * 2);
        if (score <= 0 || (hits < Math.min(2, terms.length) && !rare)) {
          note('weak', item, 'low-weak');
          continue;
        }
        // 近乎逐字重合的是这句话自己的副本，不是旧事。
        if (echoOf(item.summary, query.text) >= 0.85) {
          note('weak', item, 'echo');
          continue;
        }
        item.section = 'weak';
        item.score = score;
        item.why = `这一轮锚点/实体没对上；这条和当前句子有词面重合（${terms.slice(0, 3).join('、')}…），属弱匹配。`;
        candidates.push(item);
      }
      // 弱匹配的分数是「稀有度 × 条内重复」的累加，量纲和向量的 0–1 不一样；
      // 不归一化的话，一条长文靠重复次数就能压过语义命中。
      // 再乘 0.5 上限：按词切了，但词面重合仍是弱证据，这层只该补空位。
      const top = candidates.reduce((max, item) => Math.max(max, item.score), 0);
      for (const item of candidates) item.score = top > 0 ? (item.score / top) * 0.5 : 0;
      // 候选池不再按时间截断：时间新不等于相关，长文档在过去能靠词多赢。
      // 按分数取前几条交给 push，剩下的会被记成 budget。
      candidates.sort((a, b) => b.score - a.score);
      for (const item of candidates.slice(0, MAX_HITS + 2)) push(item);
      // 整层处理完才记 completed：查询成功不等于这层完成，后面还有评分、
      // 门槛筛选、归一化、排序和入列。层名带上这一层实际用的词，诊断脚本
      // 要照同一组词去查候选池，自己重新分词就会拿另一组词问一个不同的问题。
      layers.push({ name: 'weak', ran: true, status: 'completed', terms: all });
    } else {
      // 轮到了，但抽不出能查的词（全是虚词窗口）：没有可查的就谈不上失败。
      layers.push({ name: 'weak', ran: true, status: 'completed', terms: [] });
    }
  }

  // L3: only with a referent and only when the upper layers left room.
  const originalRan = query.referral && hits.length < MAX_HITS;
  if (!query.referral) skipped('original', 'no-referral');
  else if (hits.length >= MAX_HITS) skipped('original', 'budget-full');
  if (originalRan) {
    const terms = [
      ...query.anchors.slice(0, 3),
      ...query.entities.filter((value) => value.length >= 2).slice(0, 3),
    ];
    // 没抽出名词不等于没有「上次那件事」：「你还记得上次那件事吗」整句没有锚点，
    // 旧实现直接跳过，最该翻原文的时候反而查不到。这时退回最近几条原文——
    // referral 本身已经把范围压到「最近聊过的东西」。
    const clauses3 = terms.length
      ? terms.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ')
      : '1 = 1';
    const values = terms.map((term) => `%${escapeLike(term)}%`);
    // 原文层只回看同一个 workspace：别的项目的会话尾巴不是「我们说过」。
    // cwd 缺失（老会话、拿不到 header）时退回旧行为，宁可少过滤也不把这层变哑。
    const cwdClause = cwd ? ' AND cwd = ?' : '';
    const cwdParams = cwd ? [cwd] : [];
    const rows = db
      .prepare(
        `SELECT id, sid, seq, role, text, t FROM turns
         WHERE origin = 'chat'${cwdClause} AND (${clauses3}) AND t >= ? ORDER BY t DESC LIMIT 6`,
      )
      .all(...cwdParams, ...values, now - TURN_WINDOW_MS);
    // 记录挪到整层处理完之后（见循环后面）：查询炸了会冒到上面去，这里不写 completed。
    for (const row of rows) {
      const text = String(row.text ?? '');
      // The current message is already in `turns`; pasting it back as "what
      // we said before" is not a memory. Skip it and anything this round
      // already has in context.
      if (text === query.text) continue;
      const item = {
        source: 'turn',
        id: row.id,
        kind: row.role,
        summary: text.slice(0, 120),
        text,
        t: Number(row.t ?? 0),
    mentions: Number(row.mentions ?? 0),
        anchors: anchorsOf(text),
        entities: entitiesOf(text),
        why: '',
      };
      // 原文层按 turn id 记，和记忆 id 不同源，不能拿 given 抑制；
      // 同一句已经在上下文里的情况由上一行的 text 比较挡掉。
      // 没有名词时 whyOf 交回空串，push 会把整条丢掉；这里补一句来源说明，
      // 否则「只有指代」这条通路等于白改。
      item.score = terms.length ? scoreOf(item, query, db, now) : 0.05;
      item.why = terms.length
        ? whyOf(item, query)
        : '这一轮只有指代、抽不出名词；按「上次那件事」回看最近的原文。';
      push(item);
    }
    // 整层处理完才记：查完还要逐条判重、补 why、算分、入列。
    layers.push({ name: 'original', ran: true, status: 'completed' });
  }

  // 分区优先级：人物 → 工具 → 按需。前两个各最多一条，都算进 2 条总预算。
  // 同一分区里先看相关度，再看时间。旧的排序只看 t：同一个锚点命中十几条时，
  // 回来的是最新的几条，真正对得上的那条可能排不进来。
  const rank = (hit) => (hit.section === 'people' ? 0 : hit.section === 'tools' ? 1 : 2);
  const ordered = hits
    .slice()
    .sort((a, b) => rank(a) - rank(b) || (b.score ?? 0) - (a.score ?? 0) || b.t - a.t);
  const picked = [];
  const seenAsks = new Set();
  const sectionCount = { people: 0, tools: 0 };
  let chars = 0;
  for (const hit of ordered) {
    if (picked.length >= MAX_HITS) {
      note('pack', hit, 'budget');
      continue;
    }
    if (hit.section === 'people' && sectionCount.people >= 1) {
      note('pack', hit, 'section-cap');
      continue;
    }
    if (hit.section === 'tools' && sectionCount.tools >= 1) {
      note('pack', hit, 'section-cap');
      continue;
    }
    // 同一句提问引出的多条记忆只留最新一条，否则注入的是同一个问题的几个不同答案。
    const summary = String(hit.summary ?? '');
    const key = summary.startsWith('问：') ? summary.split('｜答：')[0] : summary.slice(0, 40);
    if (seenAsks.has(key)) {
      note('pack', hit, 'duplicate');
      continue;
    }
    if (chars + summary.length > MAX_CHARS) {
      note('pack', hit, 'chars');
      continue;
    }
    if (hit.section === 'people' || hit.section === 'tools') sectionCount[hit.section] += 1;
    seenAsks.add(key);
    picked.push(hit);
    chars += summary.length;
  }
  // 回升：这次真被取回的 dormant 记忆重新记成 active（遗忘是可回退的降级）。
  // 只在选中的 2 条上做，候选遍历不算「被想起」。
  try {
    const ids = picked.filter((hit) => hit.source === 'memory').map((hit) => Number(hit.id));
    if (ids.length) reviveOnRecall(db, ids);
  } catch {
    // 回升失败不影响这一轮取回：先让记忆拿回去用，账本下次再补。
  }
  // 再巩固：把「上一次真的用到它」的时间带进注入行。
  // 人想起来的时候带的是「我上次是在什么情况下想到这个的」，不是一条无时间的结论。
  try {
    const ids = picked.filter((hit) => hit.source === 'memory').map((hit) => Number(hit.id));
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT memory_id, MAX(t) AS last FROM recall_log
            WHERE memory_id IN (${marks}) AND used = 1 AND section = 'recall'
            GROUP BY memory_id`,
        )
        .all(...ids);
      const lastOf = new Map(rows.map((row) => [Number(row.memory_id), Number(row.last) || 0]));
      for (const hit of picked) {
        if (hit.source !== 'memory') continue;
        const last = lastOf.get(Number(hit.id));
        if (last) hit.lastUsed = last;
      }
    }
  } catch {
    // 老库没有 recall_log：不写时间，不影响注入。
  }
  const result = [...persona, ...picked];
  result.trace = trace;
  // 兜底：以后新加一层忘了写 status，宁可标 unknown 也不要缺字段——
  // 缺字段会被读成「跑成了」，而 unknown 至少是诚实的。
  for (const layer of layers) if (!layer.status) layer.status = 'unknown';
  result.layers = layers;
  // 落选的账在 trace，入选的账在这里：没有这一半，就量不出「向量层 / 弱匹配
  // 各救过几次」，也就没法拿数据判断某一层该不该留。
  result.pickedDetail = picked.map((hit) => ({
    id: hit.id,
    source: hit.source ?? 'memory',
    section: hit.section ?? '',
    score: Math.round((hit.score ?? 0) * 1000) / 1000,
  }));
  result.personaCount = persona.length;
  return result;
}

/**
 * Render the hint appended before the model turn.
 * @param {Array<{kind:string, summary:string, t:number}>} hits
 */
/**
 * 回复落库后回填 recall_log.used：模型有没有把取回的东西真的说出来。
 *
 * 判据故意从宽（回复里出现这条记忆的任一锚点/实体就算），先让 used 有数据。
 * 跑一周看 used=1 占总注入的比例：低于 30% 说明取回策略有问题，高于 80%
 * 说明判据太松——`dsh`、`记忆` 这类词太容易复现。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sid:string, text:string}} input
 * @returns {number} 被标记的行数
 */
export function markRecallUsed(db, { sid, text }) {
  if (!sid) return 0;
  // 先结算滑出判定窗口的旧记录：最近 40 条 NULL 之外的，一律判「没用上」。
  // 不结算的话，40 轮前滑出窗口的行会永远 NULL，「used=1 / 总注入」的分母失真。
  db.prepare(
    `UPDATE recall_log SET used = 0
     WHERE sid = ? AND used IS NULL AND memory_id IS NOT NULL AND section = 'recall'
       AND id NOT IN (
         SELECT id FROM recall_log
         WHERE sid = ? AND used IS NULL AND memory_id IS NOT NULL AND section = 'recall'
         ORDER BY id DESC LIMIT ${USED_WINDOW}
       )`,
  ).run(String(sid), String(sid));
  if (!text) return 0;
  const terms = new Set([...anchorsOf(text), ...entitiesOf(text)]);
  if (terms.size === 0) return 0;
  const rows = db
    .prepare(
      `SELECT l.id, m.anchors, m.entities
       FROM recall_log l
       JOIN memories m ON m.id = l.memory_id
       WHERE l.sid = ? AND l.used IS NULL AND l.memory_id IS NOT NULL AND l.section = 'recall'
       ORDER BY l.id DESC
       LIMIT ${USED_WINDOW}`,
    )
    .all(String(sid));
  if (rows.length === 0) return 0;
  const update = db.prepare('UPDATE recall_log SET used = 1 WHERE id = ?');
  let marked = 0;
  for (const row of rows) {
    const owned = [...parseList(row.anchors), ...parseList(row.entities)];
    if (owned.some((token) => terms.has(token))) {
      update.run(row.id);
      marked += 1;
    }
  }
  return marked;
}

function fmtDate(t) {
  const d = new Date(Number(t));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtShort(t) {
  const d = new Date(Number(t));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderHint(hits) {
  if (!hits || hits.length === 0) return '';
  const lines = [
    '[记忆] 以下是以前记过的，只有能自然接上这一轮时才用；接不上就不提，别硬塞。',
  ];
  const section = (title, list) => {
    if (list.length === 0) return;
    lines.push('');
    lines.push(title);
    list.forEach((hit, index) => {
      const when = hit.t ? fmtDate(hit.t) : '';
      const kind =
        hit.kind === 'persona'
          ? '常驻'
          : hit.kind === 'user'
          ? '原话'
          : hit.kind === 'assistant'
            ? '旧回复'
            : hit.kind === 'reference'
              ? '转来的话'
              : hit.kind;
      // 转述/未核实不装成原话：引用它时先留余地。
      const conf =
        hit.confidence === 'reported' ? ' · 转述' : hit.confidence === 'uncertain' ? ' · 未核实' : '';
      // 转发只给指针：别把别人写的论证当成我们的结论复述出去。
      const where =
        hit.kind === 'reference' ? '（原文在 turns，需要时用 session_event_search 取）' : '';
      const lastUsed = hit.lastUsed ? `（上次用在 ${fmtShort(hit.lastUsed)}）` : '';
      // 同一件事说到第三次：只在呈现层标出来，数据不动。
      const repeated = hit.mentions >= 3 ? `反复出现（${hit.mentions} 次）：` : '';
      lines.push(
        `${index + 1}. （${kind}${when ? ` · ${when}` : ''}${conf}）${repeated}${hit.summary}${where}${lastUsed}`,
      );
      if (hit.scene) lines.push(`   当时：${hit.scene}`);
    });
  };
  section(
    '[常驻] 你在意的事和说好的约定（长期有效，不必每轮重问）：',
    hits.filter((hit) => hit.section === 'persona'),
  );
  section(
    '[这轮] 与当前这句有关的旧记录：',
    hits.filter((hit) => hit.section !== 'persona'),
  );
  return lines.join('\n');
}
