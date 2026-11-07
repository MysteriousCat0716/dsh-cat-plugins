#!/usr/bin/env node
/**
 * 一次性迁移：mnemon 的 an / default 两个空间 → 插件 core.db。
 *
 * 只做「搬运 + 去重」：insertMemory 里已有的 sameTopic 合并与改口链照常生效，
 * 所以重复条目不会被插第二遍。默认 dry-run：VACUUM INTO 一份临时副本，在副本上
 * 跑完整流程，原库不动。确认条数后再加 --write 落库。
 *
 * 用法：
 *   node tools/migrate-mnemon.mjs            # 预览：inserted / merged 统计，不改库
 *   node tools/migrate-mnemon.mjs --write    # 真写
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DB_FILE, openStore } from '../lib/db.js';
import { insertMemory, anchorsOf, entitiesOf, retentionOf } from '../lib/extract.js';

// 默认必须是 dry-run：这个脚本会往 core.db 写几百条记忆，误跑一次的代价比多打一个
// --write 大得多。
const DRY = !process.argv.includes('--write');
const MNEMON_ROOT = join(homedir(), '.mnemon', 'data');

function summaryOf(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const cut = s.search(/[。！？!?]/);
  const first = cut >= 0 ? s.slice(0, cut + 1) : s;
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

function timeOf(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

const rows = [];
for (const space of ['an', 'default']) {
  const src = new DatabaseSync(join(MNEMON_ROOT, space, 'mnemon.db'), { readOnly: true });
  const list = src
    .prepare('SELECT id, content, category, importance, entities, stored_at FROM insights WHERE deleted_at IS NULL')
    .all();
  for (const row of list) rows.push({ space, ...row });
  src.close();
}

// dry-run 不能只靠事务回滚：openStore() 自己就会建表、补列、建索引，这些
// DDL 在 BEGIN 之前已经写进库了。所以预览走副本：VACUUM INTO 一份临时库，
// 在副本上跑完整流程，原库一个字节都不动。
let scratchDir = '';
let db;
if (DRY) {
  if (!existsSync(DEFAULT_DB_FILE)) {
    console.error(`没有可预览的库：${DEFAULT_DB_FILE}`);
    process.exit(1);
  }
  scratchDir = mkdtempSync(join(tmpdir(), 'dsh-migrate-dry-'));
  const copy = join(scratchDir, 'core.db');
  const live = new DatabaseSync(DEFAULT_DB_FILE, { readOnly: true });
  live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  live.close();
  db = openStore(copy);
} else {
  db = openStore();
}
if (DRY) db.exec('BEGIN');
const stats = { total: rows.length, inserted: 0, merged: 0, skipped: 0, chars: 0 };
try {
  for (const row of rows) {
    const text = String(row.content ?? '').trim();
    if (!text) {
      stats.skipped += 1;
      continue;
    }
    const kind = row.category === 'context' ? 'fact' : (row.category ?? 'general');
    let entities;
    try {
      entities = JSON.parse(row.entities ?? '[]');
    } catch {
      entities = entitiesOf(text);
    }
    const item = {
      kind,
      text,
      summary: summaryOf(text),
      entities: Array.isArray(entities) ? entities : entitiesOf(text),
      anchors: anchorsOf(text),
      why: '',
      tier: 'active',
      retention: retentionOf(kind),
      t: timeOf(row.stored_at),
      source_sid: `mnemon:${row.space}:${String(row.id).slice(0, 8)}`,
      source_seq: 0,
      confidence: 'explicit',
      origin: 'mnemon',
    };
    const result = insertMemory(db, item);
    if (result.inserted) {
      stats.inserted += 1;
      stats.chars += text.length;
    } else {
      stats.merged += 1;
    }
  }
  if (DRY) db.exec('ROLLBACK');
} catch (error) {
  if (DRY) db.exec('ROLLBACK');
  db.close();
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  throw error;
}
db.close();
if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
console.log(JSON.stringify({ ...stats, dry: DRY }, null, 2));
