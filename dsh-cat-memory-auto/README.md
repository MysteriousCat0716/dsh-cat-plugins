# dsh-cat-memory-auto

对话空闲时自动推进会话索引。只做一件事：`turn/end` 之后空闲 ≥ 5 分钟，跑一次两阶段索引。

## 为什么

`tools/session-index.mjs` 已经拆成两阶段——`build` 只写文本（实测 0.26 秒），`embed` 单独补向量。缺的不是速度，是「什么时候跑」。手动跑靠自觉，和记忆写入同一个毛病。

## 行为

- 监听 `session/event` 的 `turn/end`，记下最后一次活动时间。
- 每 60 秒检查一次：距最后一次 `turn/end` ≥ 5 分钟、且距上次运行 ≥ 10 分钟，就跑：
  1. `node tools/session-index.mjs build`
  2. 成功后再 `node tools/session-index.mjs embed --max 20`
  3. `node tools/verbatim.mjs`（把最近会话的真人原话抄进当天底稿）
- 每 7 天，在同一轮空闲里再跑一次周扫：`memory-decay.mjs --write` + `memory-conflicts.mjs`。
- 同一时间只跑一个流程；失败只写日志，不抛。
- 日志：`~/.dsh/dsh-cat-memory-auto.log`，一次运行三到五行。

## 配置（环境变量，可不设）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_MEMORY_AUTO` | `on` | 设 `off` 整体停用 |
| `DSH_MEMORY_AUTO_IDLE_MS` | 300000 | 空闲多久算空闲 |
| `DSH_MEMORY_AUTO_GAP_MS` | 600000 | 两次 build 最小间隔 |
| `DSH_MEMORY_AUTO_TICK_MS` | 60000 | 检查周期 |
| `DSH_MEMORY_AUTO_EMBED_MAX` | 20 | 每次最多补多少条向量 |

## 不做的事

- 不在 `agent/pre-step` 里做任何事（不拖首轮延迟）。
- 不自动写记忆内容——只推进索引，写什么仍然由我在对话里决定。

## 回退

从 profile 的 `dsh.profile.bundles` 删掉 `dsh-cat-memory-auto`，重启；或设 `DSH_MEMORY_AUTO=off` 后重启。
