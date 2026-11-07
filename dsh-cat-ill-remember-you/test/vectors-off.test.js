import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { retrieve } from '../lib/recall.js';
import { vectorsEnabled } from '../lib/embed.js';

function withEnv(value, run) {
  const previous = process.env.DSH_MEMORY_CORE_VECTOR;
  try {
    if (value === undefined) delete process.env.DSH_MEMORY_CORE_VECTOR;
    else process.env.DSH_MEMORY_CORE_VECTOR = value;
    return run();
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_VECTOR;
    else process.env.DSH_MEMORY_CORE_VECTOR = previous;
  }
}

test('vectors: 默认关，只有显式 on 才开', () => {
  withEnv(undefined, () => assert.equal(vectorsEnabled(), false));
  withEnv('off', () => assert.equal(vectorsEnabled(), false));
  withEnv('', () => assert.equal(vectorsEnabled(), false));
  withEnv('1', () => assert.equal(vectorsEnabled(), false));
  withEnv('on', () => assert.equal(vectorsEnabled(), true));
});

test('retrieve: 默认不跑向量层——只有向量相似的旧事不会被取回', async () => {
  const db = openStore(':memory:');
  db.prepare(
    `INSERT INTO memories (kind, text, summary, anchors, why, t)
     VALUES ('decision', 'lib/recall.js 先读再改', '先读再改', '["lib/recall.js"]', 'x', 1000)`,
  ).run();
  const info = db
    .prepare(
      `INSERT INTO memories (kind, text, summary, why, t)
       VALUES ('decision', '换缓存之前先量一下命中率', '量完再换', 'y', 900)`,
    )
    .run();
  const id = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO embeddings (memory_id, model, dim, vec, t)
     VALUES (?, 'qwen3-embedding:0.6b', 3, ?, 900)`,
  ).run(id, Buffer.from(new Float32Array([1, 0, 0]).buffer));

  const hits = await withEnv(undefined, () =>
    retrieve(db, { text: 'lib/recall.js 这个文件现在怎么改', recent: [], now: 2000 }),
  );

  assert.equal(
    hits.some((hit) => hit.id === id),
    false,
    `默认关时向量层仍取回了那条：${JSON.stringify(hits.map((hit) => [hit.id, hit.section]))}`,
  );
  assert.equal(hits.some((hit) => hit.section === 'vector'), false);
  db.close();
});
