# 已停用（2026-11-16）

这个插件不再挂进 profile。它的召回被 `dsh-cat-ill-remember-you` 取代：
后者有 core.db、向量层和写入侧提炼，这个只有会话索引 + Ollama 精排。

- 目录留在仓库里当历史，不再加载。
- 它写的 `~/.dsh/cache/memory-entries.json`（234 条索引）已删除，
  备份在 `~/.dsh/_backups/memory-recall-20261116/`。
- 想重启这条路的话：先看 `lib/recall.js` 和 ill-remember-you 的召回差在哪，
  别直接挂回去——两套同时跑会重复注入。
