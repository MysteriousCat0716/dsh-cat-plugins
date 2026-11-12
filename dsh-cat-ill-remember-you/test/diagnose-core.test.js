import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { retrieve, MAX_HITS } from '../lib/recall.js';
import { classify } from '../tools/diagnose-core.mjs';

// 单元测试不依赖本机 Ollama。
process.env.DSH_MEMORY_CORE_VECTOR = 'off';

function insertMemory(db, { summary, text, anchors = '[]', t }) {
  db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('decision', ?, ?, '[]', ?, '规则提炼：decision', 'active', ?)`,
  ).run(text, summary, anchors, t);
}

test('同一个 id 在前面的层留过落选记录，不会把那个原因当成弱匹配的', () => {
  // 真实数据里这种事会碰到：一条记忆在 L1 因为 no-share 记上榜，
  // 进了弱匹配又重新记一次 low-weak。只按 id 找第一条，就会报 no-share，
  // 把责任安到 L1 上，而 L1 根本没淘汰它。
  const trace = [
    { id: 7, layer: 'cache', source: 'memory', section: '', score: 0, reason: 'no-share' },
    { id: 7, layer: 'weak', source: 'memory', section: '', score: 0.35, reason: 'low-weak' },
  ];
  const got = classify({
    want: [7],
    picked: [],
    trace,
    layers: [{ name: 'weak', ran: true, terms: ['吃饭', '睡觉'] }],
    pool: [{ id: 7, text: '吃饭睡觉' }],
  });
  assert.equal(got.stage, 'DROPPED');
  assert.match(got.extra, /low-weak/, `应报弱匹配的原因，实际：${got.extra}`);
  assert.doesNotMatch(got.extra, /no-share/);
});

test('落选账带 layer：retrieve 的每一笔都标了来源层', async () => {
  const db = openStore(':memory:');
  insertMemory(db, { summary: '旧笔记', text: '关于缓存的一条笔记', anchors: '["lib/recall.js"]', t: 1001 });
  const hits = await retrieve(db, { text: 'lib/recall.js 的缓存', now: 9000 });
  for (const entry of hits.trace || []) {
    assert.ok(entry.layer, `落选记录缺 layer：${JSON.stringify(entry)}`);
  }
  db.close();
});

test('弱匹配被预算挡住时记 budget-full，诊断报 SKIPPED', async () => {
  const db = openStore(':memory:');
  // MAX_HITS 条共享同一锚点，L1/L2 一上来就把名额填满，轮不到弱匹配。
  for (let i = 1; i <= MAX_HITS; i += 1) {
    insertMemory(db, { summary: `笔记${i}`, text: `缓存的问题${i}`, anchors: '["lib/recall.js"]', t: 1000 + i });
  }
  const hits = await retrieve(db, { text: 'lib/recall.js 的缓存', now: 9000 });
  const weak = (hits.layers || []).find((l) => l.name === 'weak');
  assert.ok(weak && !weak.ran, `弱匹配应被跳过：${JSON.stringify(hits.layers)}`);
  assert.equal(weak.reason, 'budget-full');

  const got = classify({ want: [1], picked: [], trace: hits.trace || [], layers: hits.layers, pool: null });
  assert.equal(got.stage, 'SKIPPED');
  assert.match(got.extra, /budget-full/);
  db.close();
});

test('装盘阶段丢的不算弱匹配淘汰，但原因要带出来', async () => {
  // 目标进了弱匹配的池，弱匹配也没拒它，最后是装盘时预算满了丢的。
  // 归成 DROPPED 会把「预算满了」写成「被门槛拒」，两件事不同。
  const got = classify({
    want: [9],
    picked: [],
    trace: [{ id: 9, layer: 'pack', source: 'memory', section: 'weak', score: 0.6, reason: 'budget' }],
    layers: [{ name: 'weak', ran: true, status: 'completed', terms: ['笔记'] }],
    pool: [{ id: 9, text: '一条笔记' }],
  });
  assert.equal(got.stage, 'GATE');
  assert.match(got.extra, /budget/, `装盘的原因应带出来，实际：${got.extra}`);
});

test('每层都有同一个形状：name / ran / status', async () => {
  const db = openStore(':memory:');
  insertMemory(db, { summary: '笔记', text: '一条关于缓存的笔记', t: 1001 });
  const hits = await retrieve(db, { text: '缓存怎么办', now: 9000 });
  assert.ok((hits.layers || []).length > 0);
  for (const layer of hits.layers) {
    assert.equal(typeof layer.name, 'string');
    assert.equal(typeof layer.ran, 'boolean');
    assert.ok(layer.status, `层缺 status：${JSON.stringify(layer)}`);
  }
  db.close();
});

test('Ollama 连不上时向量层记 failed，不是 completed', async () => {
  const prevVector = process.env.DSH_MEMORY_CORE_VECTOR;
  const prevEndpoint = process.env.DSH_MEMORY_CORE_OLLAMA;
  process.env.DSH_MEMORY_CORE_VECTOR = 'on';
  // 端口 1 上不会有东西在听；endpointReady 会 settle 成 false。
  process.env.DSH_MEMORY_CORE_OLLAMA = 'http://127.0.0.1:1';
  try {
    const db = openStore(':memory:');
    insertMemory(db, { summary: '笔记', text: '一条关于缓存的笔记', t: 1001 });
    const hits = await retrieve(db, { text: '天气预报', now: 9000 });
    const v = (hits.layers || []).find((l) => l.name === 'vector');
    assert.ok(v, `应有向量层记录：${JSON.stringify(hits.layers)}`);
    assert.equal(v.ran, true, '轮到它了，ran 为真');
    assert.equal(v.status, 'failed', '没跑成不能记 completed');
    assert.ok(
      v.reason === 'endpoint-down' || v.reason === 'error',
      `失败原因要说清，实际：${v.reason}`,
    );
    db.close();
  } finally {
    if (prevVector === undefined) delete process.env.DSH_MEMORY_CORE_VECTOR;
    else process.env.DSH_MEMORY_CORE_VECTOR = prevVector;
    if (prevEndpoint === undefined) delete process.env.DSH_MEMORY_CORE_OLLAMA;
    else process.env.DSH_MEMORY_CORE_OLLAMA = prevEndpoint;
  }
});

test('没抽出有效词时记 no-terms，诊断报 SKIPPED', async () => {
  const db = openStore(':memory:');
  insertMemory(db, { summary: '笔记', text: '一条笔记', t: 1001 });
  // 「的了吗」每个三字窗口都夹着虚词，weakTerms 一条都抽不出来。
  const hits = await retrieve(db, { text: '的了吗', now: 9000 });
  const weak = (hits.layers || []).find((l) => l.name === 'weak');
  assert.ok(weak && !weak.ran, `弱匹配应被跳过：${JSON.stringify(hits.layers)}`);
  assert.equal(weak.reason, 'no-terms');

  const got = classify({ want: [1], picked: [], trace: hits.trace || [], layers: hits.layers, pool: null });
  assert.equal(got.stage, 'SKIPPED');
  assert.match(got.extra, /no-terms/);
  db.close();
});
