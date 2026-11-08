import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { retrieve, weakCandidatePool, escapeLike } from '../lib/recall.js';

// 单元测试不依赖本机 Ollama。
process.env.DSH_MEMORY_CORE_VECTOR = 'off';

function insertMemory(db, { summary, text, t }) {
  db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t)
     VALUES ('decision', ?, ?, '[]', '[]', '规则提炼：decision', 'active', ?)`,
  ).run(text, summary, t);
}

const CORPUS = "tier='active' AND origin IN ('chat','unknown')";

test('weak 层的 df 永远不大于 N', async () => {
  const db = openStore(':memory:');
  for (let i = 1; i <= 5; i += 1) {
    insertMemory(db, { summary: `记忆 ${i}`, text: `关于记忆的第 ${i} 条笔记`, t: 1000 + i });
  }
  const hits = await retrieve(db, { text: '记忆 笔记 怎么改', recent: [], now: 9000 });
  const weak = (hits.layers || []).find((l) => l.name === 'weak');
  assert.ok(weak && weak.ran, `weak 层应执行过：${JSON.stringify(hits.layers)}`);

  const n = db.prepare(`SELECT count(*) AS n FROM memories WHERE ${CORPUS}`).get().n;
  const countStmt = db.prepare(`SELECT count(*) AS c FROM memories WHERE ${CORPUS} AND text LIKE ? ESCAPE '\\'`);
  for (const term of weak.terms) {
    const df = Number(countStmt.get(`%${escapeLike(term)}%`).c);
    assert.ok(df <= n, `「${term}」df=${df} 大于 N=${n}，IDF 会变负，本该召回的条目会被丢掉`);
  }
  db.close();
});

test('候选池 200 条是性能折中：命中数相同时最老的一条会被挤出', () => {
  const db = openStore(':memory:');
  // 201 条都命中同样两个词，t 递增。命中词数完全相等，第二排序键就是 t DESC，
  // 于是最老的那条被 200 条上限挤掉——这是已知限制，不是「解决了时间截断」。
  for (let i = 0; i < 201; i += 1) {
    insertMemory(db, { summary: `记忆 ${i}`, text: `记忆 笔记 ${i}`, t: 1000 + i });
  }
  const pool = weakCandidatePool(db, ['记忆', '笔记']);
  assert.equal(pool.length, 200, '上限就是 200');

  const ids = new Set(pool.map((row) => Number(row.id)));
  const oldest = db.prepare(`SELECT id, t FROM memories WHERE ${CORPUS} ORDER BY t ASC LIMIT 1`).get();
  const newest = db.prepare(`SELECT id, t FROM memories WHERE ${CORPUS} ORDER BY t DESC LIMIT 1`).get();
  assert.ok(ids.has(Number(newest.id)), '最新的那条应在池里');
  assert.ok(!ids.has(Number(oldest.id)), '最老的一条被挤出——这正是不该宣称已解决的时间截断');
  db.close();
});
