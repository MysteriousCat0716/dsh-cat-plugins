import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldRun } from '../lib/index.js';

// 三个条件：开关、空闲够久、距上次跑够远。任何一条写反都不会报错——
// 表现只是「在对话中跑全量索引」或「永远不跑」，所以用测试守。
const base = {
  enabled: true,
  running: false,
  disposed: false,
  now: 1_000_000,
  lastTurnEnd: 0,
  lastRun: 0,
  idleMs: 300_000,
  minGapMs: 600_000,
};

test('空闲够久且间隔够：跑', () => {
  assert.equal(shouldRun(base), true);
});

test('刚有活动：不跑（这一条挡住「对话中跑全量索引」）', () => {
  assert.equal(shouldRun({ ...base, lastTurnEnd: base.now - 60_000 }), false);
});

test('距上次跑太近：不跑', () => {
  assert.equal(shouldRun({ ...base, lastRun: base.now - 60_000 }), false);
});

test('正在跑：不重入', () => {
  assert.equal(shouldRun({ ...base, running: true }), false);
});

test('开关关掉或已释放：不跑', () => {
  assert.equal(shouldRun({ ...base, enabled: false }), false);
  assert.equal(shouldRun({ ...base, disposed: true }), false);
});

test('边界：刚好等于阈值时跑', () => {
  assert.equal(shouldRun({ ...base, lastTurnEnd: base.now - 300_000 }), true);
  assert.equal(shouldRun({ ...base, lastRun: base.now - 600_000 }), true);
});
