/**
 * 从 core.db 导出星图数据。
 *
 * 输出两份：assets/data.js（内嵌进页面，file:// 也能开）与 data.json（给路由用）。
 *
 * 星图的核心是「会遗忘」：亮度按 e^(-天数/半衰期) 衰减，球大小按重要度。
 * 我们库里没有 importance 字段，用 kind 的基准值 + mentions 折出来。
 *
 * 用法：
 *   node tools/export.mjs               # 写进本插件 assets/
 *   node tools/export.mjs --dry         # 只打印统计，不写文件
 *   node tools/export.mjs --db <path>   # 换库
 */
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(here)
const ASSETS = join(pluginRoot, 'assets')

const DAY = 86_400_000

/** 四个 kind 各自的基准重要度与半衰期。 */
const KIND_RULES = {
  decision:   { base: 0.85, halfLife: 30, label: '决定', color: [255, 180, 95] },
  preference: { base: 0.78, halfLife: 30, label: '偏好', color: [150, 125, 255] },
  emotion:    { base: 0.72, halfLife: 12, label: '情绪', color: [255, 125, 160] },
  fact:       { base: 0.58, halfLife: 12, label: '事实', color: [110, 170, 255] },
  other:      { base: 0.50, halfLife: 12, label: '别的', color: [200, 210, 235] },
}

/** 解析参数。 */
function parseArgs(argv) {
  const out = { dry: false, db: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry') out.dry = true
    else if (argv[i] === '--db') out.db = argv[i + 1]
  }
  return out
}

/** 确定性哈希：同一个 id 永远落在同一个位置。 */
function hash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 把单位向量从 +Z 轴旋转到目标方向（Rodrigues）。 */
function rotateTo(axis, v) {
  const [ax, ay, az] = axis
  const d = ax * v[0] + ay * v[1] + az * v[2]
  if (d > 0.9999) return v.slice()
  if (d < -0.9999) return [-v[0], -v[1], v[2]]
  const cx = ay * v[2] - az * v[1]
  const cy = az * v[0] - ax * v[2]
  const cz = ax * v[1] - ay * v[0]
  const k = 1 / (1 + d)
  return [
    v[0] * d + cx + k * (ay * cz - az * cy),
    v[1] * d + cy + k * (az * cx - ax * cz),
    v[2] * d + cz + k * (ax * cy - ay * cx),
  ]
}

/** 每个簇在球面上的中心方向（单位向量，四面体四个顶点，互相尽量远）。 */
const S = 1 / Math.sqrt(3)
const CLUSTER_AXIS = {
  decision:   [S, S, S],
  preference: [-S, -S, S],
  emotion:    [-S, S, -S],
  fact:       [S, -S, -S],
  other:      [0, 0, 1],
}

/**
 * 在簇的锥形区域内给第 i 颗星算坐标。
 * 组内用 Fibonacci 球面分布保证均匀，再沿簇中心方向收拢。
 */
function positionInCluster(clusterKey, index, total) {
  const axis = CLUSTER_AXIS[clusterKey] ?? CLUSTER_AXIS.other
  const n = Math.max(total, 1)
  const golden = Math.PI * (3 - Math.sqrt(5))
  const y = 1 - (index / Math.max(n - 1, 1)) * 2
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const theta = golden * index
  const unit = [Math.cos(theta) * r, y, Math.sin(theta) * r]
  const rotated = rotateTo(axis, unit)

  // 收拢到簇中心周围，再拉回 0.58~0.95 的球壳
  const spread = 0.22
  const mixed = [0, 1, 2].map((i) =>
    axis[i] * (1 - spread) + rotated[i] * spread,
  )
  const len = Math.hypot(...mixed) || 1
  const radius = 0.58 + (hash(clusterKey + index) % 1000) / 2700 // 0.58 ~ 0.95
  return mixed.map((v) => Number(((v / len) * radius).toFixed(4)))
}

/** 从一条 memories 行算出星。 */
function toStar(row, now, clusterTotals, clusterSeen) {
  const kind = KIND_RULES[row.kind] ? row.kind : 'other'
  const rule = KIND_RULES[kind]

  const mentions = Math.max(1, Number(row.mentions) || 1)
  const mentionBoost = Math.min(0.15, Math.log2(mentions) * 0.06)
  const confidenceBoost = row.confidence === 'explicit' ? 0.05 : row.confidence === 'inferred' ? 0 : -0.05
  const importance = Math.min(1, Math.max(0.2, rule.base + mentionBoost + confidenceBoost))

  // 有人反复提过、或是决定/偏好，衰减更慢
  const halfLifeDays = mentions >= 3 || kind === 'decision' || kind === 'preference'
    ? 30
    : rule.halfLife

  const lastSeen = Number(row.last_used) || Number(row.t) || now
  const days = Math.max(0, (now - lastSeen) / DAY)
  const decay = Math.exp(-days / halfLifeDays)
  const retention = Number(Math.min(1, Math.max(0.05, decay * (0.65 + 0.35 * importance))).toFixed(4))

  const index = clusterSeen[kind]
  clusterSeen[kind] += 1

  const summary = (row.summary || '').trim()
  const full = (row.text || '').trim()
  // 卡片首行要一眼看懂：summary 够长就用它，太短（常常只有一个 URL）就退回正文
  const headline = summary.length >= 24 ? summary : full

  return {
    id: row.id,
    text: headline.slice(0, 120),
    detail: full.slice(0, 1200),
    tags: (JSON.parse(row.entities || '[]')).slice(0, 4),
    source: kind,
    band: days > 30 ? '冷' : days > 7 ? '温' : '热',
    halfLifeDays,
    importance: Number(importance.toFixed(3)),
    mentions,
    days: Number(days.toFixed(2)),
    retention,
    pos: positionInCluster(kind, index, clusterTotals[kind]),
    ts: Number(row.t),
  }
}

/** 主流程。 */
function main() {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = args.db || join(homedir(), '.dsh', 'memory', 'core.db')

  const db = new DatabaseSync(dbPath, { readOnly: true })
  const rows = db.prepare(
    'SELECT id, kind, text, summary, entities, t, last_used, mentions, confidence, tier FROM memories ORDER BY id',
  ).all()
  db.close()

  const now = Date.now()
  const clusterTotals = {}
  for (const row of rows) {
    const kind = KIND_RULES[row.kind] ? row.kind : 'other'
    clusterTotals[kind] = (clusterTotals[kind] || 0) + 1
  }
  const clusterSeen = {}
  for (const key of Object.keys(clusterTotals)) clusterSeen[key] = 0

  const stars = rows.map((row) => toStar(row, now, clusterTotals, clusterSeen))

  const payload = {
    generatedAt: new Date(now).toISOString(),
    count: stars.length,
    rule: {
      formula: 'w = e^(-(天数 / 半衰期))；被反复提起的记忆半衰期 30 天，其余 12 天；亮度再乘一次重要度系数',
      size: '球大小 = 重要度（kind 基准 + 提及次数）',
      glow: '亮度 = 还剩多少（越暗越快忘光）',
    },
    clusters: Object.entries(KIND_RULES)
      .filter(([key]) => (clusterTotals[key] || 0) > 0)
      .map(([key, rule]) => ({ key, label: rule.label, color: rule.color, count: clusterTotals[key] || 0 })),
    stars,
  }

  const byBand = { 热: 0, 温: 0, 冷: 0 }
  const fading = stars.filter((s) => s.retention < 0.25).length
  for (const s of stars) byBand[s.band] += 1

  console.log('库:', dbPath)
  console.log('星数:', stars.length)
  console.log('分簇:', payload.clusters.map((c) => `${c.label} ${c.count}`).join(' / '))
  console.log('时效:', `热 ${byBand.热} / 温 ${byBand.温} / 冷 ${byBand.冷}`)
  console.log('快忘光(<0.25):', fading)
  console.log('最亮的五颗:')
  for (const s of [...stars].sort((a, b) => b.retention * b.importance - a.retention * a.importance).slice(0, 5)) {
    console.log(`  [${s.band}] ${s.retention.toFixed(2)} × ${s.importance.toFixed(2)}  ${s.text.slice(0, 40)}`)
  }
  console.log('最暗的五颗:')
  for (const s of [...stars].sort((a, b) => a.retention - b.retention).slice(0, 5)) {
    console.log(`  [${s.band}] ${s.retention.toFixed(2)}  ${s.days.toFixed(0)} 天前  ${s.text.slice(0, 40)}`)
  }

  if (args.dry) {
    console.log('(--dry，没写文件)')
    return
  }

  mkdirSync(ASSETS, { recursive: true })
  const json = JSON.stringify(payload)
  writeFileSync(join(ASSETS, 'data.json'), json, 'utf8')
  writeFileSync(join(ASSETS, 'data.js'), 'window.STARMAP_DATA = ' + json + ';\n', 'utf8')
  console.log('已写:', join(ASSETS, 'data.js'), `(${json.length} 字节)`)
}

main()
