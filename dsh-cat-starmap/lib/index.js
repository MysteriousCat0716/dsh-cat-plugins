/**
 * dsh-cat-starmap — 把我们的记忆库画成一张会遗忘的星图。
 *
 * host 端很薄：只把 assets 目录里的页面与数据发出去。
 * 数据由 tools/export.mjs 从 core.db 生成（手动跑，插件不碰库）。
 *
 * 路由：
 *   GET /x-starmap            → index.html
 *   GET /x-starmap/data.js    → 页面内嵌数据
 *   GET /x-starmap/data.json  → 同一份数据，给外部脚本用
 *   GET /x-starmap/api/info   → 自检（星数、生成时间）
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ASSETS = resolve(join(here, '..', 'assets'))
const ROUTE = '/x-starmap'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
}

/** 只允许 assets 目录内的文件，挡掉 ../ 与绝对路径。 */
function insideAssets(target) {
  const full = resolve(join(ASSETS, target))
  return full === ASSETS || full.startsWith(ASSETS + sep) ? full : null
}

function sendJson(res, code, body) {
  const data = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(data)
}

export const name = 'dsh-cat-starmap'

export const inject = ['webServer']

export function apply(ctx) {
  const log = (msg) => {
    try {
      console.log('[dsh-cat-starmap] ' + msg)
    } catch {}
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')

          // 没有尾斜杠时页面里的相对路径会解析到根目录（/data.js → 404），
          // 所以先重定向到带斜杠的地址。
          if (url.pathname === ROUTE) {
            res.writeHead(302, { location: ROUTE + '/' })
            res.end()
            return
          }

          let rel = decodeURIComponent(url.pathname.replace(ROUTE, ''))
          if (rel === '' || rel === '/') rel = '/index.html'

          if (rel === '/api/info') {
            const dataPath = join(ASSETS, 'data.json')
            if (!existsSync(dataPath)) {
              sendJson(res, 200, { ok: false, reason: '还没生成数据，跑一次 tools/export.mjs' })
              return
            }
            const payload = JSON.parse(readFileSync(dataPath, 'utf8'))
            sendJson(res, 200, {
              ok: true,
              count: payload.count,
              generatedAt: payload.generatedAt,
              bytes: statSync(dataPath).size,
            })
            return
          }

          const full = insideAssets(rel)
          if (!full || !existsSync(full) || !statSync(full).isFile()) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('not found')
            return
          }

          const ext = full.slice(full.lastIndexOf('.'))
          const data = readFileSync(full)
          res.writeHead(200, {
            'content-type': TYPES[ext] || 'application/octet-stream',
            'cache-control': 'no-store',
            'content-length': data.length,
          })
          res.end(data)
        } catch (error) {
          log('serve failed: ' + (error && error.message ? error.message : String(error)))
          try {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('internal error')
          } catch {}
        }
      },
    }),
  )
}
