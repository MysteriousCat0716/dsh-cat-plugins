import './isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { pendingMemoryRows } from '../lib/embed.js';

const MODEL = 'qwen3-embedding:0.6b';

function seed() {
  const db = openStore(':memory:');
  const insert = db.prepare(
    `INSERT INTO memories (kind, text, summary, why, t, tier, embed_fails)
     VALUES ('decision', ?, ?, 'x', 1000, 'active', ?)`,
  );
  insert.run('第一次就成功', '第一次就成功', 0);
  insert.run('永久失败三次', '永久失败三次', 3);
  const done = insert.run('已有向量', '已有向量', 0);
  db.prepare(
    `INSERT INTO embeddings (memory_id, model, dim, vec, t)
     VALUES (?, ?, 3, ?, 1000)`,
  ).run(Number(done.lastInsertRowid), MODEL, Buffer.from(new Float32Array([1, 0, 0]).buffer));
  return db;
}

test('pendingMemoryRows：失败满 3 次的条目不再进回填队列', () => {
  const db = seed();
  const rows = pendingMemoryRows(db, MODEL, 16);
  const texts = rows.map((row) => row.text);
  assert.deepEqual(texts, ['第一次就成功']);
  db.close();
});

test('pendingMemoryRows：已有向量的条目不在队列里', () => {
  const db = seed();
  const rows = pendingMemoryRows(db, MODEL, 16);
  assert.equal(rows.some((row) => row.text === '已有向量'), false);
  db.close();
});

test('pendingMemoryRows：失败计数带回 rows，供成功时清零', () => {
  const db = openStore(':memory:');
  db.prepare(
    `INSERT INTO memories (kind, text, summary, why, t, tier, embed_fails)
     VALUES ('decision', '失败过一次', '失败过一次', 'x', 1000, 'active', 1)`,
  ).run();
  const rows = pendingMemoryRows(db, MODEL, 16);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fails, 1);
  db.close();
});
