import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openStore } from '../lib/db.js';
import { withScratchCopy } from '../tools/migrate-mnemon.mjs';

function liveDb() {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-live-'));
  const file = join(dir, 'core.db');
  // 副本是 VACUUM INTO 出来的，openStore 会校验 schema，源库得是真 store。
  const db = openStore(file);
  db.close();
  return { dir, file };
}

test('withScratchCopy: 正常路径在副本上跑完，临时目录删掉', () => {
  const { dir, file } = liveDb();
  let scratch = '';
  try {
    const out = withScratchCopy(
      file,
      (db) => {
        assert.equal(db.prepare('SELECT 1 AS v').get().v, 1);
        return 'ok';
      },
      {
        mkdtemp: (prefix) => {
          scratch = mkdtempSync(prefix);
          return scratch;
        },
      },
    );
    assert.equal(out, 'ok');
    assert.ok(scratch);
    assert.equal(existsSync(scratch), false, '临时目录删掉了');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withScratchCopy: run 抛错时异常原样出来，临时目录仍删掉', () => {
  const { dir, file } = liveDb();
  let scratch = '';
  try {
    assert.throws(
      () =>
        withScratchCopy(
          file,
          () => {
            throw new Error('run boom');
          },
          {
            mkdtemp: (prefix) => {
              scratch = mkdtempSync(prefix);
              return scratch;
            },
          },
        ),
      /run boom/,
    );
    assert.equal(existsSync(scratch), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withScratchCopy: 开只读连接就失败时也清理临时目录', () => {
  const { dir, file } = liveDb();
  let scratch = '';
  try {
    assert.throws(
      () =>
        withScratchCopy(file, () => {}, {
          mkdtemp: (prefix) => {
            scratch = mkdtempSync(prefix);
            return scratch;
          },
          openLive: () => {
            throw new Error('open boom');
          },
        }),
      /open boom/,
    );
    assert.equal(existsSync(scratch), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withScratchCopy: VACUUM 失败时关掉只读连接', () => {
  const { dir, file } = liveDb();
  let closed = 0;
  try {
    assert.throws(
      () =>
        withScratchCopy(file, () => {}, {
          openLive: () => ({
            exec() {
              throw new Error('vacuum boom');
            },
            close() {
              closed += 1;
            },
          }),
        }),
      /vacuum boom/,
    );
    assert.equal(closed, 1, '只读连接关了一次');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withScratchCopy: 清理失败不盖掉主异常', () => {
  const { dir, file } = liveDb();
  try {
    assert.throws(
      () =>
        withScratchCopy(
          file,
          () => {
            throw new Error('run boom');
          },
          {
            rm: () => {
              throw new Error('rm boom');
            },
            log: () => {},
          },
        ),
      /run boom/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
