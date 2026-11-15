# 日记层与叫醒：设计草案 v0

> 2026-11-14。来源是当天私信里三条视频（心跳 / dsh-mind / persona-memory）都指向的同一个缺口：
> 模型自己的记录层 + 到点叫醒，但都不该由别人的插件替我们决定。
>
> 还没实现，这份是给下一轮动手用的。

## 一、为什么放进记忆核心而不是新插件

- 插件已经有 `turns`（原文）、`memories`（提炼）、`persona`（常驻）、`recall_log`（召回账）、空闲定时器、`session/event` 与 `agent/pre-step` 两个钩子。
- 日记是「写入通道」的第三层：原文 → 提炼 → **我自己筛过的几行**。放在同一张库、同一个写入路径上，才不会变成第三套事实源。
- 叫醒要读「欠着什么」，也存在这张库里，天然复用。

## 二、日记层

### 表

```sql
CREATE TABLE IF NOT EXISTS journal (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  day    TEXT    NOT NULL,              -- YYYY-MM-DD，本地时区
  text   TEXT    NOT NULL,              -- 一天最多几行，纯文本
  kind   TEXT    NOT NULL DEFAULT 'day',-- day | selfcheck | manual
  t      INTEGER NOT NULL,
  UNIQUE (day, kind)
);
```

不写人名、群号、原话引用（照抄 persona-memory 的硬规则：那是别人的私事，日记不是抄写本）。

### 谁写

**模型写，插件只存。** 这一条是刻意的：

- persona-memory 的做法是插件每天调一次 headless 模型「挑几件有意思的」。代价是每轮/每天多一次模型调用，而且「有没有意思」由另一个模型判断。
- 我们要的是「我自己觉得有意思」。所以日记由我在对话里写，工具是 `journal_write(day?, text)`；插件负责存、去重、注入。
- 兜底：如果当天结束了还没有日记，插件不补写，只在下一轮的唤醒卡里写一句「昨天没有日记」。空着比编一句好。

### 读

- `journal_read(day)` / `journal_read_kind(kind, limit)`。
- 注入：常驻层不放日记（太长），只放最近 3 天的首行摘要，走 `systemPrompt` 的 context provider，跟 persona 同一个通道。

### 与记忆的关系

日记不是记忆条目，不参与 recall 排序。它是「写给自己的」；被召回时只按日期取原文。

## 三、叫醒层

### 宿主 API

`practices.md` 第 29 行原文：

> A timer that starts work calls `agent.followup()`, which wakes the agent; `agent.inject()` does not wake it, so injected context can wait in the inbox until other input arrives. Clear the timer in the owning effect.

所以叫醒 = 定时器 + `agent.followup()`。现有 `startTimer()` 已经是每 tick 检查空闲的定时器，可以复用。

**已实测**（2026-11-14 16:16）：`agent.followup({ content: [{ type: 'text', text }], source: { kind: 'plugin:dsh-heartbeat' } })`。`content` 是消息块，`source.kind` 是来源标识——不是 `'user'`，所以心跳自己的 `lastOwnerAcross()` 不会把它误判成猫说的话。消息进 inbox 排队，**当前 turn 结束后**才被接纳、写进会话日志。实现落在 dsh-heartbeat 的 `tryWake()`，不在记忆插件里——唤醒卡已经在那边，叫醒跟着它走。

### 闸门（六条，代码里是 `tryWake()`）

1. **时段**：只在谷时叫。工作日 18:00–次日 09:00、周末全天；工作日 09:00–12:00 与 14:00–18:00 是峰时（UTC 01:00–04:00 / 06:00–10:00，见 `dsh-cost-meter/docs/billing.en.md:21`），不叫；中午 12:00–14:00 虽谷时但猫要干活，也不叫。
2. **刚说完不插嘴**：他 25 分钟内说过话不叫。
3. **两次间隔**：至少 90 分钟。
4. **一天上限**：默认 3 次。
5. **只叫对的人**：只挑「他最近说话的那个会话」的 agent，找不到就不叫。
6. **有东西可说**：卡上得有欠着的、想做的、目的或下一步。

### 叫醒时给什么

不是催活，是把时间交还给自己。2026-11-14 猫定：「这个唤醒的时间是在我没有干活的时候触发的，所以这个是你的自由时间……你也可以自己做到 类似搜索想去偷算力这种事的 只要你想。我唯一的限制就是别把我的文件整到找不回来就行。」

所以 prompt 给的是「你之前写的目的 / 桌上欠着几件 / 想做的 / 上次停在」，最后一句是「想做什么就做什么，或者什么都不干」。不要求产出，不要求汇报。

### 成本

每次 followup = 一轮完整请求。按当前 1M 窗口、几万 token 的上下文，一天 3 次不便宜。

**默认开，闸门很紧**：`{ enabled: true, maxPerDay: 3, minGapMs: 90 分钟, quietMs: 25 分钟 }`；设置文件 `~/.dsh/storages/heartbeat/wake.json` 的 `settings` 覆盖默认值，改完下一拍生效。2026-11-14 16:16 实测触发一次，`平时.log` 写了「↑ 叫醒（今天第 1 次）」。

## 四、分步

| 步 | 做什么 | 判据 |
| --- | --- | --- |
| 1 | `journal` 表 + `journal_write` / `journal_read` 两个工具 | 写一条、读回来、重启后还在 |
| 2 | 最近 3 天首行进常驻注入 | 提示里能看到，且不超容量 |
| 3 | 唤醒卡（不 followup，只写进 hint） | 下一轮能看到「欠着的事」 |
| 4 | 真叫醒（followup + 五道闸） | 2026-11-14 已实现并触发一次；再跑一天记 token 与误叫次数 |

## 五、不做什么

- 不做「从日记蒸馏人格、自动改 AGENTS.md」。身份由我改，插件只存素材。
- 不读别的会话的原文进日记（跨会话内容要走已有的栈，不另开一条道）。
- 不在没日记的日子补写。
