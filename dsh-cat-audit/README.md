# dsh-cat-audit

DSH 插件。把代码审计中**不依赖判断力**的那一部分机械化：枚举范围、调用规则引擎、约束输出格式、把多个来源的结果按位置聚类。

它不判断代码对不对。判断由 `audit` 技能的透镜（lens）完成——每个透镜是一个只读子代理，各自负责一个审计角度。

## 1. 设计

一次审计包含两类工作：

| 工作 | 性质 | 由谁完成 |
|---|---|---|
| 找出该看的文件、跑规则引擎、把结果对齐到 `文件:行` | 确定性 | 本插件 |
| 「这段代码在什么条件下会出错」 | 判断 | 透镜子代理 |

这种拆分带来一个直接后果：**增加审计角度不需要改代码**。在 `lenses/` 下新增一个 Markdown 文件，声明该角度的职责与判据，插件本身不用动，也不需要重装。

## 2. 能力边界

**提供：**

- 按扩展名、目录黑名单、单文件大小枚举代码文件
- 调用 semgrep（若已安装）并解析 JSON 结果
- 为每个透镜生成独立任务单，附带统一输出格式
- 按 `文件:行` 聚类多个来源的结果，交叉命中加权，分级排序

**不提供：**

- 数据流分析、污点追踪。这是 CodeQL、Semgrep Pro 的领域
- 依赖漏洞数据库查询
- 自动修复。本插件只读
- 增量审计。当前的实现是全量扫描；非 git 仓库尤其如此

## 3. 组成

```
dsh-cat-audit/            插件本体（两个工具）
  lib/index.js
  cordis.patch.yml
  tools/check.mjs         离线自检，不装进宿主也能跑
~/.dsh/skills/audit/      技能（四步流程 + 判据）
  SKILL.md
  lenses/*.md             一个文件一个审计角度
```

`audit` 技能负责调度：调 `audit_scan` 取任务单，为每个透镜派一个只读子代理，再用 `audit_merge` 收口。插件本身不含任何流程逻辑。

## 4. 安装

**前置条件**

- DSH `0.2.1-rc.3` 或更高
- Node.js 18 或更高
- semgrep（可选）

**第一步：装插件**

```bash
dsh plugin --profile web add -w /绝对路径/dsh-cat-audit-0.1.0.tgz
```

若从源码目录安装，把 `.tgz` 换成目录路径。

**第二步：装技能**

把 `skill/` 目录整体复制到 `~/.dsh/skills/`，最终路径应为 `~/.dsh/skills/audit/SKILL.md`。

**第三步：重启并验证**

```bash
dsh plugin --profile web list | grep cat-audit     # 应看到 dsh-cat-audit@0.1.0
```

重启 Harness 后，工具列表中应出现 `audit_scan` 与 `audit_merge`。若没有，说明插件模块加载失败，检查 DSH 日志。

**semgrep（可选）**

```bash
pip install semgrep
```

装在 Python 的 `Scripts/` 目录下会被自动探测；其他位置用 `DSH_AUDIT_SEMGREP` 指定。

## 5. 使用

### 三个例子

```
audit_scan({ root: "src" })
audit_scan({ root: ".", semgrep: false })          // 跳规则引擎
audit_scan({ root: "src", lens: "safety" })        // 只出安全透镜的任务单

audit_merge({
  findings: [ correctnessRaw, safetyRaw, lifecycleRaw ],
  sources:  [ "correctness", "safety", "lifecycle" ]
})
```

### `audit_scan`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `root` | string | 会话工作目录 | 审计范围 |
| `max_files` | number | 400 | 文件数上限，超出时截断并在报告中标注 |
| `lens` | string | 全部 | 只生成指定透镜的任务单；id 拼错会明确报错，不会回退成全量 |
| `semgrep` | boolean | true | 是否调用规则引擎 |

产出为一份 Markdown 任务单：文件清单（按行数降序）、semgrep 命中、每个透镜的职责与输出格式。

**semgrep 覆盖提示**：单次命令行最多传 60 个文件（由插件设定，避免参数过长）。超过时任务单会写明「扫了 N / M 个文件，后 K 个没扫」。这是有意为之——静默截断会让报告看起来完整而实际不全。

### `audit_merge`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `findings` | string[] | 是 | 各透镜返回的原文，一段一个元素 |
| `sources` | string[] | 否 | 与 `findings` 一一对应的透镜名 |
| `root` | string | 否 | 报告中显示的范围 |
| `out` | string | 否 | 将报告写入该路径 |

合并规则：

1. **聚类**：位置按 `文件:行` 归一化。行号区间重叠视为同一处；绝对路径与相对路径按路径后缀匹配
2. **交叉命中**：两个及以上透镜报同一处时，置信度加 8，上限 95，报告标 ⚡
3. **分级**：严重度取组内最高的一条，同级按置信度降序

## 6. 子代理输出格式

格式不符的条目会被丢弃，报告末尾说明丢弃数量。

```
### [major] 一句话说清问题
- 位置：`路径:行号`
- 触发：什么输入或什么时序会走到这里
- 证据：关键代码行
- 置信度：0-100，并说明不确定的部分
```

严重度四个取值：`critical` / `major` / `minor` / `info`。同时接受 `blocker`、`high`、`low` 等常见写法并映射。

## 7. 配置

均为环境变量，非法值（空串、非数字）会退回默认，不会导致工具静默失效。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_AUDIT_MAX_FILES` | 400 | 文件数上限 |
| `DSH_AUDIT_MAX_FILE_BYTES` | 400000 | 单文件字节上限 |
| `DSH_AUDIT_SEMGREP_TIMEOUT_MS` | 120000 | 规则层超时 |
| `DSH_AUDIT_EXTS` | 十余种常见扩展名 | 逗号分隔 |
| `DSH_AUDIT_SKIP_DIRS` | `node_modules`、`.git`、`dist` 等 | 逗号分隔 |
| `DSH_AUDIT_SEMGREP` | 自动探测 | semgrep 可执行文件路径 |
| `DSH_AUDIT_LENSES` | `~/.dsh/skills/audit/lenses` | 透镜目录 |

## 8. 已知限制

1. **semgrep 命中默认是假阳性。** 规则引擎只识别语法模式。`detect-child-process` 在 Node 中几乎总是误报；`bypass-tls-verification` 在探测自签内网证书时属于设计。每一条都必须回原文判断，不能直接引用进报告。
2. **`max_files` 的截断顺序是目录遍历序，不是文件大小序。** 任务单会按行数排序展示，但截断发生在排序之前。重要目录应通过 `root` 指定后再单独审计。
3. **合并质量依赖位置写法。** 同一处被写成 `lib/x.js:120` 与 `lib/x.js:118-124` 能合并；写成两个完全不同的文件路径则不能。
4. **置信度是子代理自报的值。** 合并后的加权只是排序线索。阅读报告的人仍需逐条复核，尤其是 `critical` 与 `major`。
5. **无增量能力。** 每次都全量扫描。大型仓库建议按目录分批。

这些限制不是实现缺陷的清单，而是这套方法能覆盖的范围。超出范围的部分应由人工或其他工具承担。

## 9. 自检

不安装也能验证合并逻辑：

```bash
node dsh-cat-audit/tools/check.mjs
```

检查项：同源条目合并、交叉命中标记、置信度加权、位置展示取短路径。四项全过时退出码为 0。

## 10. 许可

MIT。
