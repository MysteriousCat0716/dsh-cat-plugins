# 猫的 DSH 插件集合

自研 DeepSeek Harness 插件的统一仓库。每个插件一个目录，安装用 `link:` 指向本仓库对应目录；设计、审计与交接文档在 `docs/`。

## 插件

| 目录 | 版本 | 作用 |
| --- | --- | --- |
| `dsh-cat-ill-remember-you` | 0.8.43 | 记忆系统：滚动替换旧对话为摘要，原文留本地，跨会话召回 |
| `dsh-cat-think` | 0.1.7 | 思考行：新段自动展开，展开过的跨段保留，换会话折叠 |
| `dsh-cat-inject-guard` | 0.1.1 | 扫外部工具返回里的提示词注入 |
| `dsh-cat-memory-auto` | 0.1.1 | 空闲后推进会话索引、向量、verbatim，外加巡检 |
| `dsh-cat-memory-recall` | 0.1.3 | 每轮注入旧会话片段与记忆条目（已从 profile 摘除，源码保留） |
| `dsh-cat-audit` | 0.1.0 | 代码审计管线的确定性一半：发现文件、跑 semgrep、出任务单 |
| `dsh-cat-syntax-check` | 0.1.0 | 改完文件后的语法检查 |
| `dsh-cat-eye` | 0.1.0 | 通过工具看 B 站：抓视频、按场景切帧、可选转写 |

## 目录

```
plugins/
├── dsh-cat-*/            各插件源码
├── docs/                 设计、审计、交接文档
│   ├── _archive/         旧交接
│   └── 记忆系统-README.md  原「记忆核心」README
├── tools/                记忆系统的辅助脚本
└── README.md
```

## 来历

原仓库叫 `记忆核心`，只装 `dsh-cat-ill-remember-you`。2026-11-07 重组为插件集合：插件全部提到根目录，文档收进 `docs/`，改名 `dsh-cat-plugins`。提交历史保留。

## 改插件的七步

2026-11-20 从 `~/.dsh/self/RULES.md`（已删）搬来。**机制按现状重写**——原文的「打包」和「robocopy 同步运行体」两步，在 `link:` 模式下都不成立。

1. **语法**：`node --check lib/index.js`。有客户端脚本的，在插件目录跑 `node tools/check-client.mjs lib/client.js`，期望 `APPLY OK`（目前只有 `dsh-cat-think` 带这个工具）。行为改动用临时探针覆盖，探针 `_` 开头、跑完删。
2. **升版本**：改 `package.json` 的 `version` 与 `description`。
3. **不需要同步**：profile 的 `package.json` 用 `link:` 指向本仓库目录（见 `~/.dsh/profiles/desktop/package.json:15-25`），`node_modules` 里是符号链接——**改源码即生效，没有打包，没有 robocopy**。
4. **依赖或包名变了**：在 profile 目录跑 `pnpm install`，`pnpm-lock.yaml` 跟着变；版本、dependencies、lock 三处一起改，少一处下次 install 会装回旧的。
5. **改第三方插件**（不是本仓库的）：走 `pnpm patch`，产物落 `~/.dsh/profiles/desktop/patches/`（本仓库 `工具/patches/` 只存已经落成的副本），README 写清原因与恢复步骤（`@jipika/dsh-memory` 的 slugOf 是现成例子）。
6. **提交**：源码仓库提交，写目的与影响。
7. **重载**：宿主不重读 `package.json` 的元数据（版本、描述），改这两样要托盘重启；只改 `lib/*.js` 多数情况下热重载就够。

