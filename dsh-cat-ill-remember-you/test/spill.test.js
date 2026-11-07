import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isSpillPath, spillPathOf } from '../lib/originals.js';

function spillDir() {
  // 宿主真实的目录形态就是 `dsh-spill-` + 6 位 alnum；多一段 `-tag` 反而不匹配
  // SPILL_ROOT_PATTERN，测的就不是真路径了。
  return mkdtempSync(join(tmpdir(), 'dsh-spill-'));
}

test('spillPathOf: 认宿主临时目录下的 dsh-spill-* 路径', () => {
  const dir = spillDir();
  const good = join(dir, 'session-x', 'r1-bash.txt');
  mkdirSync(join(dir, 'session-x'), { recursive: true });
  writeFileSync(good, '原文');
  try {
    const text = `(1200 bytes omitted. Full formatted result stored at: ${good}. Use read with offset/limit, ...)`;
    assert.equal(spillPathOf(text), good);
    assert.equal(isSpillPath(good), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('isSpillPath: realpath 失败时失败关闭（文件不存在不算通过）', () => {
  const dir = spillDir();
  try {
    const missing = join(dir, 'session-x', 'gone.txt');
    // 字面在 spill 根下，但文件不在——校验做不完时判不可读，不当成合法路径。
    assert.equal(isSpillPath(missing), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isSpillPath: 软链指到 spill 根外不认', (t) => {
  const dir = spillDir();
  const outsideDir = mkdtempSync(join(tmpdir(), 'not-a-spill-'));
  const linkDir = join(dir, 'session-x');
  try {
    mkdirSync(linkDir, { recursive: true });
    writeFileSync(join(dir, 'session-x', 'real.txt'), '本目录内的文件');
    writeFileSync(join(outsideDir, 'secret.txt'), '不该被读到');
    try {
      symlinkSync(outsideDir, join(linkDir, 'out'), 'junction');
    } catch (error) {
      t.skip(`本机无法创建目录链接（${error?.code ?? error}），跳过`);
      return;
    }
    // 字面路径在根下，但真实位置经链接到了根外。
    assert.equal(isSpillPath(join(linkDir, 'out', 'secret.txt')), false);
    // 同目录下的普通文件仍然认。
    assert.equal(isSpillPath(join(linkDir, 'real.txt')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
