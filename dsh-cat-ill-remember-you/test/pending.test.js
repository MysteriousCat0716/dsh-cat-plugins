import test from 'node:test';
import assert from 'node:assert/strict';

import { insertTurn, openStore, pendingCount, pendingTurns } from '../lib/db.js';

test('pendingTurns: IM 通道的 turn 不蒸馏（召回层不读 IM，炼了也是死数据）', () => {
  const db = openStore(':memory:');
  try {
    insertTurn(db, { sid: 's1', seq: 1, role: 'user', text: '微信里说的', origin: 'im', t: 1000 });
    insertTurn(db, { sid: 's2', seq: 1, role: 'user', text: '聊天里说的', origin: 'chat', t: 2000 });

    const rows = pendingTurns(db, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, '聊天里说的');
    assert.equal(pendingCount(db), 1);
  } finally {
    db.close();
  }
});

test('pendingTurns: 来源不明（unknown）的旧数据仍然蒸馏', () => {
  const db = openStore(':memory:');
  try {
    insertTurn(db, { sid: 's3', seq: 1, role: 'user', text: '老版本留下的', origin: 'unknown', t: 1000 });
    assert.equal(pendingTurns(db, 10).length, 1);
  } finally {
    db.close();
  }
});
