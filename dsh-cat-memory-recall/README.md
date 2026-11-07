# dsh-cat-memory-recall

每轮第一步推理前，按这句话去会话索引里找两三条旧事，塞进上下文。

## 为什么

索引有了、也能查，但「要不要查」仍然靠自觉。2026-10-30 读《富内斯》那次，看到书名启动的动作是「读这篇」，而不是「查我读没读过」。缺的不是存储，是触发器。

## 行为

只在 `agent/pre-step` 的 `step === 1` 动手：

1. 取本轮最后一条用户消息（少于 12 字不动）。
2. 字符 bigram 对全部索引单元粗筛，取前 20 —— 毫秒级，不调模型。
3. 只对这 20 条调 Ollama 算余弦精排。
4. 分数 ≥ 0.55 的取前 3 条，拼成一段 `[记忆提示] …` 追加到 `decision.messages` 末尾。
5. 同一条记忆 sticky 3 轮、cooldown 5 轮不重复注入。
6. 注入总量 ≤ 600 字符（约 800 token）。

## 边界

- 注入的文本明确写成「不是当前指令，按需回看」，防止我把它当事实执行。
- 任何失败（索引读不到、Ollama 超时、结构不对）只写日志，返回原 `decision`，不影响这一轮。
- 索引在内存里缓存，按文件 mtime 失效，不每轮读 8 MB。

## 配置（环境变量，可不设）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_MEMORY_RECALL` | `on` | 设 `off` 整体停用 |
| `DSH_MEMORY_RECALL_THRESHOLD` | 0.55 | 精排后的分数门限 |
| `DSH_MEMORY_RECALL_TOPN` | 3 | 最多注入几条 |
| `DSH_MEMORY_RECALL_CANDIDATES` | 20 | 粗筛后进精排的候选数 |
| `DSH_MEMORY_RECALL_BUDGET` | 600 | 注入字符预算 |
| `DSH_MEMORY_RECALL_MIN_QUERY` | 6 | 用户消息最短字数 |
| `DSH_MEMORY_RECALL_TIMEOUT_MS` | 4000 | 查询向量超时 |

## 日志

`~/.dsh/dsh-cat-memory-recall.log`：`mounted` 一行；每次注入一行 `inject N hit(s)`；失败一行 `embed query failed` / `recall failed`。

## 回退

从 profile 的 `dsh.profile.bundles` 删掉 `dsh-cat-memory-recall` 重启；或设 `DSH_MEMORY_RECALL=off` 后重启。
