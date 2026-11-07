import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeFindings, sameFile } from '../lib/index.js';

function entry(source, confidence = 50) {
  return { source, confidence, severity: 'major', title: '同一处', location: 'lib/a.js:10', raw: '' };
}

test('mergeFindings: 同一透镜在同一处报两条，置信度不加分', () => {
  const merged = mergeFindings([entry('lens-a'), entry('lens-a')]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].confidence, 50);
});

test('sameFile: 不同插件的同名文件不合并', () => {
  // 同一仓库里两个插件都有 lib/index.js，只比后缀会把它们当同一个文件。
  assert.equal(sameFile('dsh-cat-audit/lib/index.js', 'dsh-cat-eye/lib/index.js'), false);
  assert.equal(sameFile('lib/index.js', 'dsh-cat-eye/lib/index.js'), false);
  // 同一个文件、只是报告里深度不同，仍然要认。
  assert.equal(sameFile('src/lib/index.js', 'dsh-cat-ill-remember-you/src/lib/index.js'), true);
  assert.equal(sameFile('lib/index.js', 'lib/index.js'), true);
});

test('mergeFindings: 两个透镜互相印证，加 8 分并标交叉命中', () => {
  const merged = mergeFindings([entry('lens-a'), entry('lens-b')]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].confidence, 58);
  assert.deepEqual(merged[0].lenses.sort(), ['lens-a', 'lens-b']);
});

test('mergeFindings: 三个透镜封顶 95', () => {
  const merged = mergeFindings([entry('a', 90), entry('b'), entry('c')]);
  assert.equal(merged[0].confidence, 95);
});
