import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isSpillPath, spillPathOf } from '../lib/originals.js';

test('spillPathOf: 认宿主临时目录下的 dsh-spill-* 路径', () => {
  const good = join(tmpdir(), 'dsh-spill-a1b2c3', 'session-x', 'r1-bash.txt');
  const text = `(1200 bytes omitted. Full formatted result stored at: ${good}. Use read with offset/limit, ...)`;
  assert.equal(spillPathOf(text), good);
  assert.equal(isSpillPath(good), true);
});

test('spillPathOf: 伪造的临时目录外路径不认', () => {
  const bad = join(tmpdir(), 'somewhere-else', 'x.txt');
  const text = `Full formatted result stored at: ${bad}. Use read`;
  assert.equal(spillPathOf(text), '');
  assert.equal(isSpillPath(bad), false);
});

test('spillPathOf: 相对路径和逃逸路径不认', () => {
  assert.equal(spillPathOf('Full formatted result stored at: ..\\..\\secret.txt. Use read'), '');
  assert.equal(spillPathOf('Full formatted result stored at: /etc/passwd. Use read'), '');
});

test('isSpillPath: 数据库、家目录、脱敏占位符都不算', () => {
  assert.equal(isSpillPath('C:\\Users\\54048\\.dsh\\memory\\core.db'), false);
  assert.equal(isSpillPath('<path>'), false);
  assert.equal(spillPathOf('Full formatted result stored at: <path>. Use read'), '');
});
