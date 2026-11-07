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

test('sameFile: 深度差的边界——短边至少 3 段才允许后缀匹配', () => {
  // 短 4 段、长 6 段、后缀一致：允许（n = 4 ≥ 3）。
  assert.equal(sameFile('a/b/c/index.js', 'repo/plugins/x/a/b/c/index.js'), true);
  // 短 2 段、长 4 段：拒绝——`index.js` 这种尾巴满仓库都是，靠它认不出是哪个文件。
  assert.equal(sameFile('b/index.js', 'repo/plugins/x/b/index.js'), false);
  assert.equal(sameFile('src/index.js', 'repo/src/index.js'), false);
  // 同深度不受这条例外影响。
  assert.equal(sameFile('a/b/index.js', 'x/y/index.js'), false);
});

test('sameFile: 现有的路径规范化行为不变', () => {
  // 只按 `/` 切，反斜杠不是分隔符（Windows 路径进来认不出，这是既有行为）。
  assert.equal(sameFile('a\\b\\c.js', 'a/b/c.js'), false);
  // 大小写敏感。
  assert.equal(sameFile('A/b/c.js', 'a/b/c.js'), false);
  // 开头的空段被 filter(Boolean) 去掉：绝对路径和相对路径同深度时会被当成同一个。
  assert.equal(sameFile('/a/b/c.js', 'a/b/c.js'), true);
  // `./` 只影响开头，后缀比对不受影响。
  assert.equal(sameFile('./a/b/c.js', 'a/b/c.js'), true);
  // `..` 不解析，只当普通一段：短边 2 段、长边 4 段，按深度规则拒绝。
  assert.equal(sameFile('a/../b/c.js', 'b/c.js'), false);
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
