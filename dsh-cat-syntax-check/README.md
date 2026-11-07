# dsh-cat-syntax-check

每次 `edit` / `write` 落盘后，对 `.mjs` / `.cjs` 跑一遍 `node --check`，把编译错误**追加进同一条工具结果**。

## 为什么

改脚本最费时间的不是改，是「改完 → 另跑一次 `node --check` → 发现少个括号 → 再改」。
语法错是机器能立刻判定的，不该让模型再花一轮往返。

2026-11-01 凌晨重构 10 个脚本，每个改两三遍，就是二十几次这种往返。

## 行为

| 情况 | 结果 |
| --- | --- |
| 语法正确 | **原样返回，一个字都不加** |
| 语法错误 | 在原结果后追加一个 `text` 块：`⚠ 语法检查未通过 · <文件名>` + `node --check` 的 stderr |
| 不是 `edit`/`write` | 原样 |
| 后缀不在名单 | 原样 |
| 文件解析不出来 | 原样（宁可漏检，也不误报） |
| 工具本身报错 | 原样 |

## 边界

1. 只读文件、只跑 `--check`，**不执行被检查的代码**。
2. 任何异常都吞掉并返回原结果——验证插件坏了不能连累工具。
3. 挂在 `tools/post-execute` 的 `{ prepend: true }`，排在别的改写者前面，但仍先 `await next()` 拿最终结果。

## 默认只查 `.mjs` / `.cjs`

`.js` 默认不查：`node --check` 对 `.js` 按最近的 `package.json` 判断 CJS/ESM，工作区里不少 `.js` 是 ESM 却没有 `type: module`，会误报。

要查就设环境变量 `DSH_SYNTAX_CHECK_JS=on`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_SYNTAX_CHECK` | 开 | 设 `off` 关掉整个插件 |
| `DSH_SYNTAX_CHECK_JS` | 关 | 设 `on` 把 `.js` 也纳入 |
| `DSH_SYNTAX_CHECK_TIMEOUT` | `8000` | 单次 `node --check` 超时（毫秒） |

## 安装

```bash
dsh plugin --profile web add "C:/Users/Administrator/Documents/deepseek-harness/default-workspace/产出/插件/dsh-cat-syntax-check"
```

**改完源码必须重启 dsh web**（`dsh plugin` 是 link 安装，profile 里的 `node_modules` 是软链到本目录，但 Host 半体只在启动时加载）。

## 离线自检

```bash
node _tmp/t-syntax-check.mjs
```

十个用例：语法正确不加噪音、语法错误追加提示、非目标工具跳过、非目标后缀跳过、文件不存在跳过、工具失败跳过、`block` 决策透传、相对路径解析、缺 `file_path` 跳过、`edit` 与 `write` 都覆盖。
