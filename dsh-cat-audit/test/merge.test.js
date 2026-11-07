import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeFindings } from '../lib/index.js';

function entry(source, confidence = 50) {
  return { source, confidence, severity: 'major', title: '同一处', location: 'lib/a.js:10', raw: '' };
}

test('mergeFindings: 同一透镜在同一处报两条，置信度不加分', () => {
  const merged = mergeFindings([entry('lens-a'), entry('lens-a')]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].confidence, 50);
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
