import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore, insertTurn } from '../lib/db.js';
import { groupTurns, refine } from '../lib/extract.js';

function turn(over = {}) {
  return { id: 1, sid: 's1', seq: 1, role: 'user', text: '你好', t: 1000, ...over };
}

test('groupTurns: 块按第一条 turn 的原始位置排回全局顺序', () => {
  const blocks = groupTurns([
    turn({ id: 1, sid: 'main', seq: 1, role: 'user', text: '主问一' }),
    turn({ id: 2, sid: 'sub', seq: 1, role: 'user', text: '子问' }),
    turn({ id: 3, sid: 'main', seq: 2, role: 'user', text: '主问二' }),
    turn({ id: 4, sid: 'sub', seq: 2, role: 'assistant', text: '子答' }),
    turn({ id: 5, sid: 'main', seq: 3, role: 'assistant', text: '主答一' }),
    turn({ id: 6, sid: 'main', seq: 4, role: 'assistant', text: '主答二' }),
  ]);
  // 按 sid 分组时输出是 main1、main2、sub1；排回来该是 1、2、3 的提问顺序。
  assert.deepEqual(
    blocks.map((block) => block.turns[0].id),
    [1, 2, 3],
  );
  assert.deepEqual(
    blocks.map((block) => block.at),
    [0, 1, 2],
  );
});

test('groupTurns: 单会话、空输入、缺时间戳都不改变顺序契约', () => {
  const one = groupTurns([
    turn({ id: 1, role: 'user', text: '一问' }),
    turn({ id: 2, role: 'assistant', text: '一答' }),
    turn({ id: 3, role: 'user', text: '二问' }),
    turn({ id: 4, role: 'assistant', text: '二答' }),
  ]);
  assert.deepEqual(
    one.map((block) => block.turns[0].id),
    [1, 3],
  );

  assert.deepEqual(groupTurns([]), []);

  // t 缺失或相同，排序只看 at，不依赖时间戳。
  const noT = groupTurns([
    turn({ id: 1, sid: 'a', role: 'user', text: '甲' }),
    turn({ id: 2, sid: 'b', role: 'user', text: '乙' }),
    turn({ id: 3, sid: 'a', role: 'assistant', text: '甲答' }),
    turn({ id: 4, sid: 'b', role: 'assistant', text: '乙答' }),
  ]);
  assert.deepEqual(
    noT.map((block) => block.turns[0].id),
    [1, 2],
  );
});

test('refine: 交错写库时，同主题合并仍按提问先后（不看回答时间）', () => {
  const db = openStore(':memory:');
  // main 先问，但回答最后才落；sub 后问、先答完。按 candidate.t 排会让 sub 先插，
  // 合并后保留的就是 sub 那条——所以这里钉住「按提问位置」这个契约。
  insertTurn(db, {
    sid: 'main',
    seq: 1,
    role: 'user',
    text: '以后 Ollama 只用来算向量，不做生成。',
    t: 1000,
  });
  insertTurn(db, {
    sid: 'sub',
    seq: 1,
    role: 'user',
    text: '以后 Ollama 只用来算向量，不做生成。',
    t: 2000,
  });
  insertTurn(db, { sid: 'sub', seq: 2, role: 'assistant', text: '可以。', t: 3000 });
  insertTurn(db, { sid: 'main', seq: 2, role: 'assistant', text: '好。', t: 4000 });
  refine(db);

  const rows = db.prepare('SELECT text, mentions FROM memories').all();
  assert.equal(rows.length, 1, '同一话题只留一条');
  assert.equal(Number(rows[0].mentions), 2, '两条都记进票数');
  assert.match(String(rows[0].text), /好。/, '保留的是先提问那一块的正文');
  db.close();
});

test('refine: 改口链按提问位置挂，回答早到晚到都不影响', () => {
  const db = openStore(':memory:');
  // 旧说法先问、后答；新说法后问、先答。按 at 排，旧条先入库，新条才挂得上链。
  insertTurn(db, {
    sid: 'main',
    seq: 1,
    role: 'user',
    text: '以后 Ollama 只用来算向量，不做生成。',
    t: 1000,
  });
  insertTurn(db, {
    sid: 'main',
    seq: 2,
    role: 'user',
    text: '其实不改了，改成用 Ollama 生成。',
    t: 2000,
  });
  insertTurn(db, { sid: 'main', seq: 3, role: 'assistant', text: '行。', t: 3000 });
  insertTurn(db, { sid: 'main', seq: 4, role: 'assistant', text: '好。', t: 6000 });
  refine(db);

  const rows = db.prepare('SELECT id, text, supersedes FROM memories ORDER BY id').all();
  assert.equal(rows.length, 2, '改口插新条，不并进旧条');
  const old = rows.find((row) => /只用来算向量/.test(String(row.text)));
  const newer = rows.find((row) => /改成用 Ollama 生成/.test(String(row.text)));
  assert.ok(old && newer);
  assert.equal(Number(newer.supersedes), Number(old.id), '新条指回旧条');
  assert.equal(old.supersedes, null);
  db.close();
});

test('refine: 块的实体统计按处理顺序累加', () => {
  const db = openStore(':memory:');
  insertTurn(db, { sid: 'main', seq: 1, role: 'user', text: '以后 Ollama 只用来算向量，不做生成。', t: 1000 });
  insertTurn(db, { sid: 'sub', seq: 1, role: 'user', text: 'Ollama 的端口是 11434。', t: 2000 });
  insertTurn(db, { sid: 'sub', seq: 2, role: 'assistant', text: '记下了。', t: 3000 });
  insertTurn(db, { sid: 'main', seq: 2, role: 'assistant', text: '好。', t: 4000 });
  refine(db);

  const row = db.prepare("SELECT mentions FROM entities WHERE name = 'Ollama'").get();
  assert.ok(row, '实体落库');
  assert.equal(Number(row.mentions), 2, '两块各记一次提及');
  db.close();
});
