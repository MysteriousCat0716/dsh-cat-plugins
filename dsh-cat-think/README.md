# dsh-cat-think

思考行（reasoning）的自动展开与收起。纯客户端插件，无宿主服务。

## 行为

1. 新一段思考出现时自动展开。
2. 这一段结束后保持展开，运行命令、读文件等步骤期间不收。
3. 下一段思考开始，只收起「插件自己展开」的旧段；用户手动展开的段保持展开。
4. 用户手动收起的段保持收起，不再被自动打开。
5. 用户手动展开多个段时互不影响，先展开的不会因为后展开而被收起。
6. 最后一段思考在所有思考完成后保持展开。
7. 整批收起发生在新会话开始时，或页面切到另一个会话时。

页面刷新后按内核默认状态显示：未运行的思考行保持折叠。

## 原理

内核在 `@deepseek-ai/dsh-client-ui-chat` 里给每段 reasoning 渲染一个折叠行，标记为：

- 容器：`[data-variant="think"]`
- 状态：`data-state="running"`（仍在思考）或 `"ok"`（本段已结束）
- 展开：`data-expanded` 属性存在即为展开

展开状态保存在 React 里，外部只能通过点击行的开关（带 `aria-expanded` 的元素）来切换。插件用 `MutationObserver` 监听新增节点与 `data-state` 变化，并用 document 上的捕获阶段点击监听区分「用户点击」与「插件自己点击」（插件点击在同步派发期间置 `suppressing` 标记）。三类行分别记在 `userOpened`、`userClosed`、`autoOpened` 三个集合里，只有 `autoOpened` 的行会被自动收起。

会话切换的判据是 `window.location.href` 变化：变化时收起本插件与用户展开的行，并清空集合。

## 开关

在地址后加 `?catthink=off` 可临时关闭本页面的自动展开，例如：

```
http://100.74.210.74:3081/?catthink=off
```

## 自检

```
node tools/check-client.mjs
```

用 DOM 桩重放十九种场景：历史行不动、新段展开、段结束重开、用户收起被尊重、用户展开跨段保留、插件展开的旧段被下一段收起、末段保持展开、多个手动段并存、会话切换清空等。

## 安装与回退

- 源码：本目录。
- 运行副本：`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-cat-think\`。
- 回退：从 `cordis.patch.yml` 删掉 `dsh-cat-think` 的插入行，或把 profile 依赖换回旧 tgz。
- 0.1.2 及以前的行为：新段开始时收起所有旧段（含用户展开的），思考结束即收。需要旧行为时从 git 取 `0.1.2` 标签或该版本 tgz。
