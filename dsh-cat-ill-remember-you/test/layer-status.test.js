import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { retrieve } from '../lib/recall.js';

const layerOf = (hits, name) => (hits.layers || []).find((layer) => layer.name === name);

// 这两条盯的是「completed 什么时候写」。汀的意思：查询成功不等于这一层
// 处理完了——查询之后还有评分、门槛筛选、排序、入列。原来 weak 和 original
// 都在查询一返回就记 completed，中途出错也会留下一条「跑成了」的记录。
// 现在两处都挪到本层最后一行。

test('weak 层：整层处理完之后才记 completed，且带上实际查询词', async () => {
  const db = openStore(':memory:');
  // 只和「今天」这种常见词重合，过不了「至少两个不同词窗」的门槛，
  // 会被 note 成 low-weak——评分确实跑到了，不是查到就返回。
  db.prepare(
    `INSERT INTO memories (kind, text, summary, why, t)
     VALUES ('fact', '今天天气不错，出门走了一圈', '天气', 'x', 1000)`,
  ).run();

  const hits = await retrieve(db, { text: '今天干活有点累', recent: [], now: 2000 });
  const weak = layerOf(hits, 'weak');

  assert.ok(weak, '弱匹配层没有留下记录');
  assert.equal(weak.ran, true);
  assert.equal(weak.status, 'completed');
  assert.ok(
    Array.isArray(weak.terms) && weak.terms.length > 0,
    `记录里没带上实际查询词，诊断脚本就没法照同一组词查候选池：${JSON.stringify(weak)}`,
  );
  db.close();
});

test('original 层：原文层整层处理完之后才记 completed', async () => {
  const db = openStore(':memory:');
  db.prepare(
    `INSERT INTO turns (sid, seq, role, origin, cwd, text, t)
     VALUES ('s1', 1, 'user', 'chat', '', '之前说的那件事就是换缓存', 900)`,
  ).run();

  // 「之前说的那件事」会触发 referral，原文层才有机会跑。
  const hits = await retrieve(db, { text: '之前说的那件事结论是什么', recent: [], now: 2000 });
  const original = layerOf(hits, 'original');

  assert.ok(original, '原文层没有留下记录');
  assert.equal(original.ran, true);
  assert.equal(original.status, 'completed');
  db.close();
});
