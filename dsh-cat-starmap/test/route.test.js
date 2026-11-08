/**
 * 路由测试：只验两件事——路径穿越被挡、正常文件能发出去。
 * 用假的 ctx/res，不启 DSH。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/** 建一个假 ctx，捕获注册进来的 handler。 */
function harness() {
  const captured = {}
  const ctx = {
    effect: (fn) => fn(),
    webServer: {
      register: (route) => {
        captured.route = route
        return () => {}
      },
    },
  }
  apply(ctx)
  return captured.route
}

/** 发一个请求，收集状态码与正文。 */
function request(route, path) {
  const chunks = []
  let status = 0
  const headers = {}
  const res = {
    writeHead: (code, h) => {
      status = code
      Object.assign(headers, h || {})
    },
    end: (data) => {
      if (data !== undefined) chunks.push(Buffer.from(data))
    },
  }
  route.handler({ url: path }, res)
  return { status, headers, body: Buffer.concat(chunks).toString('utf8') }
}

test('starmap: 根路径发 index.html', () => {
  const route = harness()
  const r = request(route, '/x-starmap/')
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /text\/html/)
  assert.match(r.body, /岸的记忆星图/)
})

test('starmap: 不带尾斜杠时重定向，否则相对路径会解析到根目录', () => {
  const route = harness()
  const r = request(route, '/x-starmap')
  assert.equal(r.status, 302)
  assert.equal(r.headers.location, '/x-starmap/')
})

test('starmap: data.json 发得出去', () => {
  const route = harness()
  const r = request(route, '/x-starmap/data.json')
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /application\/json/)
  const payload = JSON.parse(r.body)
  assert.ok(Array.isArray(payload.stars))
  assert.ok(payload.stars.length > 0)
})

test('starmap: api/info 报告星数', () => {
  const route = harness()
  const r = request(route, '/x-starmap/api/info')
  assert.equal(r.status, 200)
  const info = JSON.parse(r.body)
  assert.equal(info.ok, true)
  assert.ok(info.count > 0)
  assert.ok(typeof info.generatedAt === 'string')
})

test('starmap: 路径穿越被挡', () => {
  const route = harness()
  for (const bad of [
    '/x-starmap/../lib/index.js',
    '/x-starmap/..%2f..%2fpackage.json',
    '/x-starmap/%2e%2e%2fpackage.json',
    '/x-starmap/....//package.json',
  ]) {
    const r = request(route, bad)
    assert.equal(r.status, 404, `应该拒绝: ${bad}`)
  }
})

test('starmap: 不存在的文件 404', () => {
  const route = harness()
  const r = request(route, '/x-starmap/nope.png')
  assert.equal(r.status, 404)
})
