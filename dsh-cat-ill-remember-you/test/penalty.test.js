import test from 'node:test'
import assert from 'node:assert/strict'
import { functionalPenalty } from '../lib/recall.js'

test('functionalPenalty: 碎片词降权', () => {
  for (const w of ['我说', '我没', '你说', '也不', '让我', '还会', '就行', '都很']) {
    assert.equal(functionalPenalty(w), 0.3, w)
  }
})

test('functionalPenalty: 有意义的二字词不受影响', () => {
  for (const w of ['会话', '说法', '有趣', '会议', '说话', '有效', '被叫', '把持']) {
    assert.equal(functionalPenalty(w), 1, w)
  }
})

test('functionalPenalty: 只作用于两字词', () => {
  assert.equal(functionalPenalty('我'), 1)
  assert.equal(functionalPenalty('我说过'), 1)
  // 「我们」也是碎片：库里几乎每条对话都有它，区分度为零。
  assert.equal(functionalPenalty('我们'), 0.3)
})
