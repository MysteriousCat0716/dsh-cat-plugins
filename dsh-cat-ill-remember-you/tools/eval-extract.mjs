#!/usr/bin/env node
/**
 * 评测集候选抽取（只读）。
 *
 * 11-08 那 12 条全是单跳、want 是「任意一条命中」。要建 40 条四类集子，先得把
 * 素材摊开：真实提问从 turns 里抽，多跳从 supersedes 链里找，边界冲突找字面
 * 相近的，失败反推从 recall_log 里 used=0 的捞。
 *
 * 这个脚本只出候选，不判定对错。哪条进集子、want 填什么，人工来。
 * 输出 evals/work/candidates.json，读 core.db 不加写——跑它不会动记忆库。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DB_FILE = path.join(os.homedir(), '.dsh', 'memory', 'core.db');
const OUT_DIR = path.join(import.meta.dirname, '..', 'evals', 'work');
const OUT_FILE = path.join(OUT_DIR, 'candidates.json');

const db = new DatabaseSync(DB_FILE, { readOnly: true });

/** 纯语气/纯应答，不是可评测的提问。 */
const NOISE = /^(好|嗯|行|对|可以|继续|爱你|在吗|醒了|睡了|晚安|早|午安|好饿|抱抱|要抱抱|好累|困了|我去|等下|你继续|没事)[，。！？!?\s~]*$/u;

function pickText(t) {
  return String(t ?? '').replace(/\s+/g, ' ').trim();
}

// ── 1. 真实历史提问 ────────────────────────────────────────────
// 12–200 字、像一句真话的，倒序取前 400 条再过滤噪声，最多留 120 条候选。
const historyRows = db
  .prepare(
    `SELECT sid, seq, t, text FROM turns
      WHERE role = 'user' AND length(text) BETWEEN 12 AND 200
      ORDER BY t DESC LIMIT 600`,
  )
  .all();

const history = [];
const seenText = new Set();
for (const r of historyRows) {
  const text = pickText(r.text);
  if (!text || NOISE.test(text) || seenText.has(text)) continue;
  seenText.add(text);
  history.push({ sid: r.sid, seq: r.seq, at: new Date(Number(r.t) || 0).toISOString(), text });
  if (history.length >= 120) break;
}

// ── 2. 多跳链：supersedes 指着的旧条目 ──────────────────────────
const chainRows = db
  .prepare(
    `SELECT n.id AS newId, n.text AS newText, o.id AS oldId, o.text AS oldText
       FROM memories n JOIN memories o ON n.supersedes = o.id
      ORDER BY n.id DESC LIMIT 40`,
  )
  .all();

const chains = chainRows.map((r) => ({
  newId: r.newId,
  newText: pickText(r.newText).slice(0, 200),
  oldId: r.oldId,
  oldText: pickText(r.oldText).slice(0, 200),
}));

// ── 3. 边界冲突：字面相近但未必同话题 ──────────────────────────
// 中文 2-gram 的 Jaccard；取 0.35–0.75 这段——太像的是重复，太不像的没意义。
function grams(s, n = 2) {
  const set = new Set();
  const t = s.replace(/\s+/g, '');
  for (let i = 0; i + n <= t.length; i += 1) set.add(t.slice(i, i + n));
  return set;
}
function jaccard(a, b) {
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const memRows = db
  .prepare(
    `SELECT id, kind, text FROM memories
      WHERE length(text) BETWEEN 20 AND 140 AND kind IN ('fact','decision','preference')
      ORDER BY t DESC LIMIT 700`,
  )
  .all()
  .map((r) => ({ id: r.id, kind: r.kind, text: pickText(r.text), g: grams(r.text) }));

// 寒暄句之间永远相似，但那是重复不是冲突，先排掉。
const SOFT = /好梦|爱你|抱抱|晚安|明天见|睡吧|早见/u;

const conflicts = [];
const seenPair = new Set();
for (let i = 0; i < memRows.length; i += 1) {
  for (let j = i + 1; j < memRows.length; j += 1) {
    const a = memRows[i];
    const b = memRows[j];
    if (SOFT.test(a.text) && SOFT.test(b.text)) continue;
    const score = jaccard(a.g, b.g);
    if (score < 0.25 || score > 0.85) continue;
    const key = `${a.id}-${b.id}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    conflicts.push({
      a: { id: a.id, kind: a.kind, text: a.text.slice(0, 160) },
      b: { id: b.id, kind: b.kind, text: b.text.slice(0, 160) },
      jaccard: Number(score.toFixed(3)),
    });
  }
}
conflicts.sort((x, y) => y.jaccard - x.jaccard);
conflicts.splice(40);

// ── 4. 失败反推：被取回但没用上的 ──────────────────────────────
const missRows = db
  .prepare(
    `SELECT l.memory_id AS id, l.why, l.score, l.sid, l.t
       FROM recall_log l WHERE l.used = 0
      ORDER BY l.t DESC LIMIT 200`,
  )
  .all();

const missMap = new Map();
for (const r of missRows) {
  if (!missMap.has(r.id)) missMap.set(r.id, r);
}
const misses = [];
for (const r of missMap.values()) {
  const m = db.prepare('SELECT text FROM memories WHERE id = ?').get(r.id);
  if (!m) continue;
  misses.push({
    id: r.id,
    why: r.why,
    score: r.score,
    at: new Date(Number(r.t) || 0).toISOString(),
    text: pickText(m.text).slice(0, 200),
  });
  if (misses.length >= 40) break;
}

// ── 落盘 ────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const payload = {
  generatedAt: new Date().toISOString(),
  db: DB_FILE,
  stats: {
    memories: db.prepare('SELECT count(*) c FROM memories').get().c,
    turns: db.prepare('SELECT count(*) c FROM turns').get().c,
    userTurns: db.prepare("SELECT count(*) c FROM turns WHERE role='user'").get().c,
    historyCandidates: history.length,
    chains: chains.length,
    conflicts: conflicts.length,
    misses: misses.length,
  },
  history,
  chains,
  conflicts,
  misses,
};
fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8');
console.log(JSON.stringify(payload.stats, null, 2));
console.log('→', OUT_FILE);
