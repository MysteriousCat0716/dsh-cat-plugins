import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '../lib/db.js';

/** 一个干净的空目录，测试结束由调用方或不清理（系统临时目录）。 */
function tempStoreFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ill-remember-migration-'));
  return path.join(dir, 'old.db');
}

/**
 * 模拟 2026-10 的旧库：turns 没有 cwd / scanned_at，shadow_v2 没有
 * applied / cwd / token_keep。这正是从备份恢复出来的样子。
 */
function makeOldStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sid TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
  text TEXT NOT NULL, t INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (sid, seq, role)
);
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'fact',
  text TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  entities TEXT NOT NULL DEFAULT '[]', anchors TEXT NOT NULL DEFAULT '[]',
  why TEXT NOT NULL DEFAULT '', tier TEXT NOT NULL DEFAULT 'active',
  t INTEGER NOT NULL, last_used INTEGER, verified INTEGER,
  source_sid TEXT, source_seq INTEGER,
  mentions INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE shadow_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, turn INTEGER NOT NULL DEFAULT 0,
  t INTEGER NOT NULL, range_start INTEGER NOT NULL, range_end INTEGER NOT NULL,
  seqs TEXT NOT NULL, text TEXT NOT NULL, chars_before INTEGER NOT NULL,
  chars_after INTEGER NOT NULL, kept INTEGER NOT NULL DEFAULT 0,
  lost_ratio REAL NOT NULL DEFAULT 0, dangling INTEGER NOT NULL DEFAULT 0
);
`);
  db.close();
}

test('旧库缺 cwd/applied 列时能打开，不卡在 CREATE INDEX', () => {
  const file = tempStoreFile();
  makeOldStore(file);

  // 回归：索引曾经写在 SCHEMA 里、先于 ALTER 执行，抛 `no such column: cwd`，
  // 整个 store 打不开——从备份恢复时会直接起不来。
  const db = openStore(file);
  try {
    const columns = (table) =>
      db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    assert.ok(columns('turns').includes('cwd'));
    assert.ok(columns('turns').includes('scanned_at'));
    assert.ok(columns('shadow_v2').includes('applied'));
    assert.ok(columns('shadow_v2').includes('cwd'));
    assert.ok(columns('shadow_v2').includes('token_keep'));
    assert.ok(columns('memories').includes('origin'));

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name);
    assert.ok(indexes.includes('idx_turns_cwd_t'), 'turns(cwd,t) 索引应在补列之后建好');
    assert.ok(indexes.includes('idx_shadow_v2_sid'), 'shadow_v2(sid,applied) 索引应在补列之后建好');
  } finally {
    db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('新库同样建出这两个后加列索引', () => {
  const db = openStore(':memory:');
  try {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name);
    assert.ok(indexes.includes('idx_turns_cwd_t'));
    assert.ok(indexes.includes('idx_shadow_v2_sid'));
  } finally {
    db.close();
  }
});

test('同一文件重复打开幂等，不重复报错', () => {
  const file = tempStoreFile();
  makeOldStore(file);
  try {
    openStore(file).close();
    const db = openStore(file);
    db.close();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
