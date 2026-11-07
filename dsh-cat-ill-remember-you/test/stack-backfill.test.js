import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { backfillStack, stackSize } from '../lib/context-stack.js';

function seedTurns(db, n) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO turns (sid, seq, role, origin, text, t) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < n; i += 1) insert.run('s1', i + 1, 'user', 'chat', `第 ${i} 句话`, 1000 + i);
}

test('backfillStack: 中途失败整批回滚，不留半满的栈', () => {
  const db = openStore(':memory:');
  try {
    seedTurns(db, 5);
    // 第 2 次写栈时抛错，模拟铺到一半断了。
    const orig = db.prepare.bind(db);
    let inserts = 0;
    db.prepare = (sql) => {
      if (String(sql).includes('INSERT OR IGNORE INTO context_stack')) {
        inserts += 1;
        if (inserts === 2) throw new Error('boom');
      }
      return orig(sql);
    };
    assert.throws(() => backfillStack(db), /boom/);
    db.prepare = orig;
    assert.equal(stackSize(db), 0, '回滚后栈应为空，下次打开还能重试');
  } finally {
    db.close();
  }
});

test('backfillStack: 外层已有事务时用 savepoint 嵌套，不炸', () => {
  const db = openStore(':memory:');
  try {
    seedTurns(db, 3);
    db.exec('BEGIN');
    const filled = backfillStack(db);
    db.exec('COMMIT');
    assert.equal(filled, 3);
    assert.equal(stackSize(db), 3);
  } finally {
    db.close();
  }
});

test('backfillStack: 栈非空时不再铺，返回 0', () => {
  const db = openStore(':memory:');
  try {
    seedTurns(db, 3);
    assert.equal(backfillStack(db), 3);
    assert.equal(backfillStack(db), 0);
    assert.equal(stackSize(db), 3);
  } finally {
    db.close();
  }
});
