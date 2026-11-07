import test from 'node:test';
import assert from 'node:assert/strict';

import { recentSurfaceSeqs } from '../lib/index.js';

test('recentSurfaceSeqs: 数字数组直接认', () => {
  assert.deepEqual(recentSurfaceSeqs({ surface: { nodes: [3, 7, 11] } }), [3, 7, 11]);
});

test('recentSurfaceSeqs: { seq } 对象数组也认', () => {
  assert.deepEqual(recentSurfaceSeqs({ surface: { nodes: [{ seq: 3 }, { seq: 7 }] } }), [3, 7]);
});

test('recentSurfaceSeqs: 数字和对象混着来', () => {
  assert.deepEqual(recentSurfaceSeqs({ surface: { nodes: [3, { seq: 7 }, '11'] } }), [3, 7, 11]);
});

test('recentSurfaceSeqs: 只取最近 6 条', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => i + 1);
  assert.deepEqual(recentSurfaceSeqs({ surface: { nodes } }), [5, 6, 7, 8, 9, 10]);
  assert.deepEqual(recentSurfaceSeqs({ surface: { nodes } }, 2), [9, 10]);
});

test('recentSurfaceSeqs: 零和负数不算序号，跳过但不判未知', () => {
  assert.deepEqual(recentSurfaceSeqs({ surface: { nodes: [0, 3, -2, 7] } }), [3, 7]);
});

test('recentSurfaceSeqs: 没有 surface 是合法空数组', () => {
  assert.deepEqual(recentSurfaceSeqs({}), []);
  assert.deepEqual(recentSurfaceSeqs({ surface: {} }), []);
  assert.deepEqual(recentSurfaceSeqs(null), []);
  assert.deepEqual(recentSurfaceSeqs({ surface: { nodes: [] } }), []);
});

test('recentSurfaceSeqs: 未知结构返回 null，不能伪装成空数组', () => {
  // 认不出当前窗口时返回 null，调用方跳过栈注入；返回 [] 会让 excludeSeqs 空掉，
  // 当前窗口已经有的行被重复注入。
  assert.equal(recentSurfaceSeqs({ surface: { nodes: [{ id: 3 }] } }), null);
  assert.equal(recentSurfaceSeqs({ surface: { nodes: [3, {}] } }), null);
  assert.equal(recentSurfaceSeqs({ surface: { nodes: [null] } }), null);
  assert.equal(recentSurfaceSeqs({ surface: { nodes: [undefined] } }), null);
  assert.equal(recentSurfaceSeqs({ surface: { nodes: [{ seq: null }] } }), null);
  assert.equal(recentSurfaceSeqs({ surface: { nodes: ['abc'] } }), null);
  assert.equal(recentSurfaceSeqs({ surface: { nodes: { 0: 3 } } }), null, '不是数组');
});
