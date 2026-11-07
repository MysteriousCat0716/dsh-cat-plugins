import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expandTerms } from '../lib/aliases.js';

function withFile(content, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-alias-'));
  const file = path.join(dir, 'aliases.json');
  if (content !== null) fs.writeFileSync(file, content);
  const previous = process.env.DSH_MEMORY_CORE_ALIASES;
  process.env.DSH_MEMORY_CORE_ALIASES = file;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE_ALIASES;
    else process.env.DSH_MEMORY_CORE_ALIASES = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('aliases: 没有命中别名组时原样返回', () => {
  const { all, discount } = withFile(null, () => expandTerms(['缓存', '命中率']));
  assert.deepEqual(all, ['缓存', '命中率']);
  assert.equal(discount.size, 0);
});

test('aliases: 命中内置组时带出同组词，扩展词打 0.7', () => {
  const { all, discount } = withFile(null, () => expandTerms(['考研']));
  assert.ok(all.includes('考研'));
  assert.ok(all.includes('上岸'), `没带出别名：${JSON.stringify(all)}`);
  assert.equal(discount.get('上岸'), 0.7);
  assert.equal(discount.has('考研'), false);
});

test('aliases: 组内任一词出现都触发扩展', () => {
  const { all } = withFile(null, () => expandTerms(['illrememberyou']));
  assert.ok(all.includes('记忆核心'), `没带出别名：${JSON.stringify(all)}`);
});

test('aliases: 用户文件整组覆盖同名内置组', () => {
  const { all, discount } = withFile(JSON.stringify({ 考研: ['自学考试'] }), () =>
    expandTerms(['考研']),
  );
  assert.ok(all.includes('自学考试'));
  assert.equal(all.includes('上岸'), false, '内置组没被覆盖');
  assert.equal(discount.get('自学考试'), 0.7);
});

test('aliases: 用户文件坏了退回内置，不抛', () => {
  const { all } = withFile('{ 这不是 json', () => expandTerms(['考研']));
  assert.ok(all.includes('上岸'));
});
