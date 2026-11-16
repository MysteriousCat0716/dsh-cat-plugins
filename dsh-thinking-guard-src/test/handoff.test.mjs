import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handoffNote, steerHandoff } from '../lib/thinking-guard.mjs'

test('handoffNote 带次数、时间戳文件名、默认目录', () => {
  const note = handoffNote(3)
  assert.match(note, /折叠 3 次/)
  assert.match(note, /next-\d{8}-\d{4}\.md/)
  assert.match(note, /产出\/文档\/交接/)
  assert.ok(note.split('\n').length >= 8)
})

test('handoffNote 自定义目录会去掉尾斜杠', () => {
  assert.match(handoffNote(1, { handoffDir: 'custom/here/' }), /custom\/here\/next-/)
})

test('steerHandoff 投递一条 user 消息', () => {
  const calls = []
  assert.equal(steerHandoff({ steer: (m) => calls.push(m) }, 'hello'), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].role, 'user')
  assert.equal(calls[0].content[0].text, 'hello')
  assert.ok(String(calls[0].source.kind).startsWith('plugin:'))
})

test('steerHandoff 在没有 agent / 没有 steer / 抛错时静默返回 false', () => {
  assert.equal(steerHandoff(null, 'x'), false)
  assert.equal(steerHandoff({}, 'x'), false)
  assert.equal(steerHandoff({ steer: () => { throw new Error('nope') } }, 'x'), false)
})
