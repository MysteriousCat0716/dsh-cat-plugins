import './isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { scoreOf } from '../lib/recall.js';

// 2026-11-20 渡彻查 W-02b 的回归：原文层（turn）与 memories 是两套自增 id。
// 同号不同物，按 id 去查记忆的使用记录/取代关系，会把一条记忆的「常被使用」
// 借给完全无关的旧原文。判据：同一段文本、同样的命中，turn 与 memory 同号时，
// turn 的分数不受 memory 的 used 记录影响。
function seedDb() {
  const db = openStore(':memory:');
  // memory #1：一条常被使用的记忆
  db.prepare(
    `INSERT INTO memories (kind, text, summary, anchors, why, t, tier)
     VALUES ('decision', '旧的决定', '旧的决定', '["nginx"]', 'x', 1000, 1)`,
  ).run();
  for (let i = 0; i < 10; i++) {
    db.prepare(
      `INSERT INTO recall_log (sid, turn, memory_id, why, used, t, section)
       VALUES ('s', 1, 1, 'test', 1, ?, 'recall')`,
    ).run(Date.now() - 60_000 - i); // usageOf 只统计 30 天窗口内的记录
  }
  // turns 表：id 会与 memory id 撞号（各自自增）
  return db;
}

const query = { anchors: ['nginx'], entities: [], text: 'nginx 那件事' };

test('L3 原文项不借记忆的 used 分数（同号不串）', () => {
  const db = seedDb();
  const turn = {
    source: 'turn',
    id: 1, // 与 memory #1 同号
    kind: 'user',
    text: 'nginx 那件事',
    anchors: ['nginx'],
    entities: [],
    t: Date.now(),
    mentions: 0,
    retention: 'auto',
    importance: 3,
  };
  const memory = { ...turn, source: 'memory' };
  const turnScore = scoreOf(turn, query, db);
  const memoryScore = scoreOf(memory, query, db);
  // 记忆项拿到 usedBoost（10 次全 used，u>=2 起评）；原文项不该拿到
  assert.ok(memoryScore > turnScore, `记忆应高于同号原文：memory=${memoryScore} turn=${turnScore}`);
  // 差值必须恰等于 usedBoost 的量级（>0.3），而不是 recency 之类带来的微小差异
  assert.ok(memoryScore - turnScore > 0.3, `差值过小，可能没真正隔离：${memoryScore - turnScore}`);
  db.close();
});

test('取代关系也只作用于记忆项', () => {
  const db = seedDb();
  // 让 memory #2 取代 #1，于是 supersededBy 里含 1
  db.prepare(
    `INSERT INTO memories (kind, text, summary, why, t, supersedes)
     VALUES ('decision', '新的决定', '新的决定', 'y', 1500, 1)`,
  ).run();
  const turn = {
    source: 'turn', id: 1, kind: 'user', text: 'nginx 那件事',
    anchors: ['nginx'], entities: [], t: Date.now(), mentions: 0,
    retention: 'auto', importance: 3,
  };
  const memory = { ...turn, source: 'memory' };
  // 原文项不该因为「memory #1 被取代」而 ×0.35
  const a = scoreOf(turn, query, db);
  const b = scoreOf(memory, query, db);
  assert.ok(a > b, `原文项被记忆的取代关系降权了：turn=${a} memory=${b}`);
  db.close();
});
