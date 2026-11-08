import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { retrieve } from '../lib/recall.js';

const layerOf = (hits, name) => (hits.layers || []).find((layer) => layer.name === name);

// 这两条验证的是「正常跑完之后的状态和附加信息」：weak 层该带 terms、original
// 层该是 completed、两层都不在半路掉成别的状态。
// **记录发生在第几行，测试不证明**——正常路径上往后挪二十行，两条记录长得
// 一模一样；只有中途抛错才看得出差别，而那时 retrieve 会整个抛出去，调用方
// 拿不到 layers。时序靠代码位置审查，不靠这两条测试。

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
