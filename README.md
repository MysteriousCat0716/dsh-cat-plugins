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
