/**
 * Embedding index layer.
 *
 * Stores one float32 vector per memory in the `embeddings` table so a later
 * version can add similarity as a *candidate* signal. Retrieval still goes
 * through the anchor/entity gate: a vector never becomes the only reason to
 * recall a memory.
 *
 * The layer is optional by design — Ollama may be closed, the model may be
 * missing, or the machine may be offline. Every failure is thrown to the
 * caller, which logs and moves on; nothing here may block the pre-step path.
 */

import net from 'node:net';
import { embedTextCloudflare, CLOUDFLARE_MODEL, cloudflareReady } from './embed-cf.js';

export const DEFAULT_MODEL = 'qwen3-embedding:0.6b';
// 向量输入：摘要打头 + 正文，空行让 bge-m3 先看到「这条讲什么」。
export function embedInput(row) {
  const summary = String(row.summary ?? '').trim();
  const text = String(row.text ?? '').trim();
  if (!text) return summary;
  if (!summary) return text;
  return `${summary}\n\n${text}`;
}

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
export const DEFAULT_BATCH = 16;
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 当前生效的向量后端：显式 `DSH_MEMORY_CORE_EMBED_BACKEND` 优先；没设时，
 * 只要 ~/.dsh/memory/cloudflare.json 配好了就走 cloudflare，否则退回 ollama。
 *
 * 为什么不默认 'ollama'：本机 Ollama 已不常驻（curl 127.0.0.1:11434 直接
 * EXIT=7），而 setx 写进注册表的环境变量不会推给已经在跑的 DSH 进程——配好
 * 了云端、重启后向量层却还是关着，这条链路就是这么空了一个多星期。默认值
 * 不能取决于用户有没有注销重登 Windows。
 */
export function activeBackend() {
  const explicit = process.env.DSH_MEMORY_CORE_EMBED_BACKEND;
  if (explicit) return explicit;
  return cloudflareReady() ? 'cloudflare' : 'ollama';
}

/**
 * 向量层要不要用。显式 `off` 关、显式 `on` 开；没设时跟着 activeBackend()
 * 走——云端后端是纯 HTTP、不需要常驻进程，配好了就该默认开着。
 *
 * 这条闸门只防「没配任何后端却每轮去探 Ollama 端口」。真正的失败处理在
 * recall.js 的 try/catch 与 embedRetryAt 退避里，不靠这里关掉整层。
 */
export function vectorsEnabled() {
  const explicit = process.env.DSH_MEMORY_CORE_VECTOR;
  if (explicit === 'off') return false;
  if (explicit === 'on') return true;
  return activeBackend() === 'cloudflare';
}

/**
 * 当前后端的模型名：显式 override > DSH_MEMORY_CORE_EMBED_MODEL > 后端默认。
 *
 * 这层存在是因为 recall.js 曾经直接拿 DEFAULT_MODEL 兜底：只把
 * BACKEND 切成 cloudflare、没设 MODEL 时，会把 `qwen3-embedding:0.6b`
 * 发给 Cloudflare，必然失败，而且失败信息看不出是模型名错了。
 * 所有「用哪个模型查/存」的地方都走这里，免得再写死一次。
 */
export function activeEmbedModel(override) {
  if (override) return override;
  const fromEnv = process.env.DSH_MEMORY_CORE_EMBED_MODEL;
  if (fromEnv) return fromEnv;
  const backend = activeBackend();
  return backend === 'cloudflare' ? CLOUDFLARE_MODEL : DEFAULT_MODEL;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function toBlob(vector) {
  const floats = new Float32Array(vector);
  return new Uint8Array(floats.buffer);
}

/**
 * Embed up to `limit` memories that have no vector for `model` yet.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{model?:string, endpoint?:string, limit?:number, timeoutMs?:number, now?:number}} [options]
 * @returns {Promise<{embedded:number, model:string, dim?:number}>}
 */
export async function embedPending(db, options = {}) {
  const model = activeEmbedModel(options.model);
  const backend = activeBackend();
  const endpoint = (
    options.endpoint ||
    process.env.DSH_MEMORY_CORE_OLLAMA ||
    DEFAULT_ENDPOINT
  ).replace(/\/+$/, '');
  const limit = positive(options.limit ?? process.env.DSH_MEMORY_CORE_EMBED_BATCH, DEFAULT_BATCH);
  const timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  const rows = db
    .prepare(
      `SELECT m.id, m.summary, m.text FROM memories m
       LEFT JOIN embeddings e ON e.memory_id = m.id AND e.model = ?
       WHERE e.id IS NULL AND m.tier IN ('active','dormant')
       ORDER BY m.t DESC LIMIT ?`,
    )
    .all(model, limit);
  if (rows.length === 0) return { embedded: 0, model };

  let vectors;
  let failed = 0;
  if (backend === 'cloudflare') {
    // bge-m3 的 Workers AI 接口按条返回；一次失败不该把整批打回，逐条取。
    // 单条超时/限流就记 null 跳过，下一轮回填还会再遇到它——整批抛错的话，
    // 已经成功的那十几条也一起白费了（2026-11-15 回填就是这样停在 688/1580）。
    vectors = [];
    for (const row of rows) {
      try {
        vectors.push(
          // 摘要 + 全文：摘要只有 80 字符，正文平均 551（80% 的条目摘要不到
          // 正文一半）。只喂摘要，正文后半段对语义完全不可见——C3 的 #1412
          // 讲的遗忘曲线在正文里，向量里根本没有（2026-11-17 实测）。
          await embedTextCloudflare(embedInput(row), {
            model,
            timeoutMs: Math.min(timeoutMs, 10_000),
          }),
        );
      } catch {
        failed += 1;
        vectors.push(null);
      }
    }
  } else {
    const response = await fetch(`${endpoint}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        input: rows.map((row) => embedInput(row)),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`ollama /api/embed ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    vectors = Array.isArray(payload?.embeddings) ? payload.embeddings : null;
  }
  if (!vectors || vectors.length !== rows.length) {
    throw new Error(
      `${backend} returned ${vectors ? vectors.length : 'no'} vectors for ${rows.length} inputs`,
    );
  }

  // Validate every vector before opening the transaction: a half-written batch
  // would need a manual cleanup, and the next sweep would skip those rows.
  // null 是这一轮没取到的条目，跳过但不中止整批。
  const good = vectors.filter((vector) => vector !== null && vector !== undefined);
  for (const vector of good) {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(`${backend} returned an empty vector`);
    }
  }
  if (good.length === 0) {
    throw new Error(`${backend} returned no usable vector for ${rows.length} inputs`);
  }
  const dim = good[0].length;
  if (good.some((vector) => vector.length !== dim)) {
    throw new Error(`${backend} returned vectors of different dimensions`);
  }

  const insert = db.prepare(
    `INSERT OR REPLACE INTO embeddings (memory_id, model, dim, vec, t)
     VALUES (?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    for (let i = 0; i < rows.length; i += 1) {
      if (!vectors[i]) continue;
      insert.run(rows[i].id, model, dim, toBlob(vectors[i]), now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { embedded: rows.length - failed, failed, model, dim };
}

/** How many memories (active + dormant) still have no vector for the active model. */
export function pendingEmbeddings(db, model = activeEmbedModel()) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM memories m
       LEFT JOIN embeddings e ON e.memory_id = m.id AND e.model = ?
       WHERE e.id IS NULL AND m.tier IN ('active','dormant')`,
    )
    .get(model);
  return Number(row?.n ?? 0);
}

/**
 * One vector for a free-text query. Throws on any failure — the caller is
 * expected to catch and fall back to lexical recall; an embedding outage may
 * never break the pre-step path.
 * @param {string} text
 * @param {{model?:string, endpoint?:string, timeoutMs?:number}} [options]
 * @returns {Promise<number[]>}
 */
export async function embedText(text, options = {}) {
  const backend = activeBackend();
  const model = activeEmbedModel(options.model);
  if (backend === 'cloudflare') {
    return embedTextCloudflare(text, { model, timeoutMs: options.timeoutMs });
  }
  const endpoint = (
    options.endpoint ||
    process.env.DSH_MEMORY_CORE_OLLAMA ||
    DEFAULT_ENDPOINT
  ).replace(/\/+$/, '');
  // A cold Ollama has to load the model before the first vector; 4s covers
  // that once, and keep_alive below keeps it from happening every turn.
  const timeoutMs = positive(options.timeoutMs, 4000);
  const response = await fetch(`${endpoint}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [String(text ?? '')],
      keep_alive: options.keepAlive || '30m',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`ollama /api/embed ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  const vector = Array.isArray(payload?.embeddings) ? payload.embeddings[0] : null;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('ollama /api/embed returned no vector');
  }
  return vector;
}

/**
 * Fast TCP probe. A closed Ollama must cost the turn ~300ms at most, not a
 * full HTTP timeout on every single message.
 * @param {string} [endpoint]
 * @param {number} [timeoutMs]
 */
export function endpointReady(endpoint = DEFAULT_ENDPOINT, timeoutMs = 300) {
  const url = new URL(endpoint.replace(/\/+$/, '') || DEFAULT_ENDPOINT);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname, port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Cosine similarity; both vectors must have the same dimension. */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function readVector(blob) {
  const bytes = new Uint8Array(blob);
  const aligned = bytes.slice().buffer;
  return new Float32Array(aligned);
}

/**
 * Nearest stored memories to one query vector, best first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} vector
 * @param {{model?:string, limit?:number}} [options]
 */
export function nearestByVector(db, vector, options = {}) {
  const model = activeEmbedModel(options.model);
  const limit = positive(options.limit, 3);
  const rows = db
    .prepare('SELECT memory_id, vec FROM embeddings WHERE model = ?')
    .all(model);
  const scored = [];
  for (const row of rows) {
    const other = readVector(row.vec);
    if (other.length !== vector.length) continue;
    scored.push({ memory_id: row.memory_id, score: cosine(vector, other) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Fire-and-forget: load the embedding model now, so the first recall of the
 * session does not pay the cold-start cost on the turn path.
 * @param {{model?:string, endpoint?:string, timeoutMs?:number}} [options]
 */
export async function warmVector(options = {}) {
  try {
    await embedText('预热', { ...options, timeoutMs: options.timeoutMs ?? 8000 });
    return true;
  } catch {
    return false;
  }
}
