/**
 * dsh-cat-syntax-check — 每次 edit/write 落盘后，对 .mjs/.cjs 跑一遍 node --check。
 *
 * 为什么存在：2026-11-01 凌晨改 10 个脚本，每个改两三遍，就是二十几次「改完 →
 * 单独跑一次 node --check → 再改」。语法错是机器能立刻判定的，不该让我再花一轮往返。
 *
 * 做法：挂 `tools/post-execute` 瀑布。看到 exec.name 是 edit/write、落盘文件后缀是
 * .mjs/.cjs，就用 process.execPath 跑 `--check`。**通过则原样返回，一个字都不加**；
 * 失败才把 stderr 追成一个 text 块，和工具结果一起回到这一轮的上下文里。
 *
 * 边界（三条，都是为了不让验证插件自己变成故障源）：
 *   1. 只读文件、只跑 --check，不执行被检查的代码；
 *   2. 任何异常都吞掉并返回原结果——插件坏了不能连累工具；
 *   3. 路径猜不准就跳过。宁可漏检，也不要对别的文件误报。
 *
 * 环境变量：`DSH_SYNTAX_CHECK=off` 关掉；`DSH_SYNTAX_CHECK_JS=on` 把 .js 也纳入
 * （默认不纳入：node --check 对 .js 按最近的 package.json 判断 CJS/ESM，工作区里
 * 不少 .js 是 ESM 却没有 type:module，会误报）；`DSH_SYNTAX_CHECK_TIMEOUT` 默认 8000。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-cat-syntax-check';

const CFG = {
  enabled: process.env.DSH_SYNTAX_CHECK !== 'off',
  exts:
    process.env.DSH_SYNTAX_CHECK_JS === 'on'
      ? ['.mjs', '.cjs', '.js']
      : ['.mjs', '.cjs'],
  timeoutMs: Number(process.env.DSH_SYNTAX_CHECK_TIMEOUT ?? 8000),
  maxErrorChars: 1200,
};

/**
 * 把工具参数里的 file_path 解析成真实路径。
 *
 * 绝对路径直接用；相对路径依次试 session cwd 与进程 cwd，取第一个存在的。
 * 都解析不出来返回 null —— 调用方跳过检查。
 *
 * @param {unknown} input - exec.arguments.file_path
 * @param {object} exec - ToolExecution
 * @returns {string | null}
 */
function resolveFile(input, exec) {
  if (typeof input !== 'string' || input.trim() === '') return null;
  if (path.isAbsolute(input)) return fs.existsSync(input) ? input : null;

  const bases = [];
  const agentCwd = exec?.agent?.session?.cwd ?? exec?.agent?.cwd;
  if (typeof agentCwd === 'string' && agentCwd !== '') bases.push(agentCwd);
  bases.push(process.cwd());

  for (const base of bases) {
    const candidate = path.resolve(base, input);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 跑一次语法检查。
 *
 * @param {string} file - 已落盘的绝对路径
 * @returns {{ ok: boolean, detail: string }}
 */
function checkSyntax(file) {
  const run = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    timeout: CFG.timeoutMs,
    windowsHide: true,
  });
  if (run.status === 0) return { ok: true, detail: '' };
  const raw = `${run.stderr ?? ''}${run.stdout ?? ''}`.trim();
  const detail =
    raw || `node --check 没有正常退出（status=${run.status}, signal=${run.signal ?? 'none'}）`;
  return { ok: false, detail: detail.slice(0, CFG.maxErrorChars) };
}

export function apply(ctx) {
  if (!CFG.enabled) return;

  ctx.on(
    'tools/post-execute',
    async (exec, result, next) => {
      const decision = await next();
      try {
        if (decision.kind !== 'accept') return decision;
        if (Object.hasOwn(decision, 'value')) return decision; // 值型结果没有可追加的 content
        if (exec.name !== 'edit' && exec.name !== 'write') return decision;
        if (result.isError) return decision; // 工具本身失败了，语法检查没有意义

        const file = resolveFile(exec.arguments?.file_path, exec);
        if (file === null) return decision;
        if (!CFG.exts.includes(path.extname(file).toLowerCase())) return decision;
        if (file.split(/[\\/]/).includes('node_modules')) return decision;

        const { ok, detail } = checkSyntax(file);
        if (ok) return decision;

        const base = decision.content ?? result.content ?? [];
        return {
          kind: 'accept',
          content: [
            ...base,
            {
              type: 'text',
              text: `\n⚠ 语法检查未通过 · ${path.basename(file)}\n${detail}`,
            },
          ],
        };
      } catch (error) {
        ctx.logger?.warn?.(`dsh-cat-syntax-check: ${String(error)}; 返回原结果`);
        return decision;
      }
    },
    { prepend: true },
  );
}
