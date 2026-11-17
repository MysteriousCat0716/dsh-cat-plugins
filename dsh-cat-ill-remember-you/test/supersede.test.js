import './isolate-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../lib/db.js';
import { scoreOf } from '../lib/recall.js';

// 单元测试不依赖本机 Ollama。
process.env.DSH_MEMORY_CORE_VECTOR = 'off';

test('被取代的旧条降权：同样的命中，分数低于现在还成立的那条', () => {
  const db = openStore(':memory:');
  const ins = db.prepare(
    `INSERT INTO memories (kind, text, summary, entities, anchors, why, tier, t, supersedes)
     VALUES ('decision', ?, ?, '[]', '["记忆"]', '规则提炼：decision', 'active', 1000, ?)`,
  );
  const oldId = Number(ins.run('记忆检索先命中锚点。', '记忆检索先命中锚点', null).lastInsertRowid);
  const newId = Number(ins.run('记忆检索改成命中实体。', '记忆检索改成命中实体', oldId).lastInsertRowid);

  // 两条的命中完全一样，唯一差别就是 oldId 被 newId 取代过。
  const item = (id) => ({ id, anchors: ['记忆'], entities: [], retention: 'auto', t: 1000 });
  const query = { anchors: ['记忆'], entities: [] };
  const oldScore = scoreOf(item(oldId), query, db, 2000);
  const newScore = scoreOf(item(newId), query, db, 2000);

  assert.ok(oldScore > 0, '旧条不是被排除，是降权');
  assert.ok(
    oldScore < newScore,
    `被取代的旧条分数应更低：旧 ${oldScore.toFixed(3)} / 新 ${newScore.toFixed(3)}`,
  );
  assert.ok(oldScore / newScore > 0.3 && oldScore / newScore < 0.4, '降权幅度是 0.35');
  db.close();
});
