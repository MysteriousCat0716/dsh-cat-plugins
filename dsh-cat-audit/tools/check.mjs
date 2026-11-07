// 离线自检：不装进宿主就能验证 audit_merge 的合并逻辑。
// 跑法：node plugin-helper/dsh-cat-audit/tools/check.mjs
//
// 验两件事：
//   1) 同一处问题被写成 :120 与 :120-126（行号区间）时合并成一组
//   2) 同一处问题一条绝对路径一条相对路径时也合并
// 两条都合并了，「交叉命中」才会出现，置信度才会 +8。

import { apply } from '../lib/index.js';

const tools = {};
apply({ tools: { register: (t) => { tools[t.name] = t; } }, workingDirectory: {} });

const textA = `### [major] 折叠时不清 inline 样式
- 位置：\`dsh-cat-mobile/lib/client.js:800\`
- 触发：卸载时 composer 还钉着 height:0
- 证据：apply 的清理函数只 remove grip
- 置信度：88
`;

const textB = `### [blocker] 卸载不清折叠样式
- 位置：\`C:/Users/Administrator/Documents/deepseek-harness/default-workspace/plugin-helper/dsh-cat-mobile/lib/client.js:796-803\`
- 触发：插件被禁用
- 证据：unmountGrip() 从未被调用
- 置信度：85
`;

const textC = `### [minor] 另一处跟上面无关
- 位置：\`dsh-cat-net/lib/index.js:164\`
- 触发：缓存条目过多
- 证据：只按 30 天过期
- 置信度：70
`;

const out = await tools.audit_merge.execute({
  findings: [textA, textB, textC],
  sources: ['lifecycle', 'safety', 'safety'],
});

const groups = out.markdown.match(/^## \[/gm) || [];
const checks = [
  ['两条同源被合并成一组', groups.length === 2],
  ['出现交叉命中标记', out.markdown.includes('交叉命中')],
  ['置信度被加权到 95', out.markdown.includes('置信度：95')],
  ['位置展示用短路径', out.markdown.includes('- 位置：`dsh-cat-mobile/lib/client.js:796`')],
];

let bad = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${label}`);
  if (!ok) bad += 1;
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exitCode = bad === 0 ? 0 : 1;
