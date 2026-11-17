import './isolate-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { pruneStack } from '../lib/context-stack.js';

test('pruneStack 只删很老的，每个会话保留最近 N 条', () => {
  const db = openStore(':memory:');
  const ins = db.prepare('INSERT INTO context_stack (sid, seq, t) VALUES (?, ?, ?)');
  const old = Date.now() - 40 * 86400000;
  for (let i = 0; i < 300; i += 1) ins.run('main', i, old + i * 1000);
  // 新的一条不该被删——它不在 keepDays 之外。
  ins.run('main', 999, Date.now());

  const deleted = pruneStack(db, { keepPerSession: 200 });
  const left = Number(db.prepare('SELECT count(*) AS n FROM context_stack').get().n);
  assert.equal(left, 200, `每个会话留 200 条，实际剩 ${left}`);
  assert.equal(deleted, 101);

  const newest = db.prepare('SELECT seq FROM context_stack ORDER BY t DESC LIMIT 1').get();
  assert.equal(newest.seq, 999, '最新的那条必须还在');
  db.close();
});
