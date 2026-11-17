import './isolate-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { recencyOf, retrieve } from '../lib/recall.js';

// 单元测试不依赖本机 Ollama：向量路径关闭，只验排序。
process.env.DSH_MEMORY_CORE_VECTOR = 'off';

const DAY = 24 * 3600 * 1000;

test('recencyOf: 今天的记忆不衰减', () => {
  const now = Date.now();
  assert.ok(recencyOf({ t: now }, now) > 0.99);
  assert.equal(recencyOf({ t: now, retention: 'permanent' }, now), 1);
});

test('recencyOf: 7 天掉到一半，30 天落在地板上', () => {
  const now = Date.now();
  const week = recencyOf({ t: now - 7 * DAY }, now);
  assert.ok(week > 0.66 && week < 0.69, `7 天应约 0.675，实际 ${week}`);
  const month = recencyOf({ t: now - 30 * DAY }, now);
  assert.ok(month >= 0.35 && month < 0.39, `30 天应约 0.38，实际 ${month}`);
});

test('recencyOf: permanent 不随时间衰减', () => {
  const now = Date.now();
  assert.equal(recencyOf({ t: now - 300 * DAY, retention: 'permanent' }, now), 1);
  assert.ok(recencyOf({ t: now - 300 * DAY, retention: 'auto' }, now) < 0.4);
});

test('recencyOf: 没有 t 的旧行按不衰减处理，不能算成零点', () => {
  assert.equal(recencyOf({}, Date.now()), 1);
});

test('retrieve: 同一锚点命中，昨天的压过上个月有两倍锚点的', async () => {
  const db = openStore(':memory:');
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('fact', ?, ?, '[]', ?, '规则提炼：fact', 'active', ?)`,
  );
  // 旧条：一个月前，命中两个锚点。
  insert.run(
    'lib/a.js 和 lib/b.js 都改过。',
    '两个文件都改过（一个月前）',
    JSON.stringify(['lib/a.js', 'lib/b.js']),
    now - 30 * DAY,
  );
  // 新条：昨天，只命中一个锚点。不加近因时旧条分更高。
  insert.run(
    'lib/a.js 的缓存昨天换了。',
    'a.js 缓存昨天换了',
    JSON.stringify(['lib/a.js']),
    now - DAY,
  );
  const hits = await retrieve(db, {
    text: 'lib/a.js 和 lib/b.js 现在什么情况',
    recent: [],
    now,
  });
  assert.equal(hits.length > 0, true);
  assert.ok(
    hits[0].summary.includes('昨天换了'),
    `近的那条应排前，实际第一条是：${hits[0].summary}`,
  );
  db.close();
});

test('retrieve: 近因不会让一个锚点压过三个锚点', async () => {
  const db = openStore(':memory:');
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('fact', ?, ?, '[]', ?, '规则提炼：fact', 'active', ?)`,
  );
  insert.run(
    'lib/a.js lib/b.js lib/c.js 三处同改。',
    '三个文件同改（一个月前）',
    JSON.stringify(['lib/a.js', 'lib/b.js', 'lib/c.js']),
    now - 30 * DAY,
  );
  insert.run(
    'lib/a.js 的缓存昨天换了。',
    'a.js 缓存昨天换了',
    JSON.stringify(['lib/a.js']),
    now - DAY,
  );
  const hits = await retrieve(db, {
    text: 'lib/a.js lib/b.js lib/c.js 一起改',
    recent: [],
    now,
  });
  assert.ok(
    hits[0].summary.includes('三个文件同改'),
    `相关度更高的一条仍应排前，实际：${hits[0].summary}`,
  );
  db.close();
});
