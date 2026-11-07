/**
 * dsh-cat-memory-auto — 对话空闲时自动推进记忆的「收」侧。
 *
 * 四件事，都只在空闲时做：
 *   1) 会话索引：`session-index.mjs build`（只写文本）→ `embed --max 200`（补向量）
 *   2) 原话底稿：`verbatim.mjs` 把最近会话的真人原话抄进 ~/.dsh/memory/verbatim/
 *   3) 上下文体检：`ctx-watch.mjs` 把近 6 小时的窗口占用快照写到 ~/.dsh/cache/ctx-latest.txt，
 *      醒来简报读它——GUI 圆点看不见子代理、400 时还停住不动，这份是唯一能事后对证的记录
 *   4) 周扫：每 7 天一次 `memory-decay.mjs --write`（分片衰减）与 `memory-conflicts.mjs`（冲突报告）
 *
 * 注意第 3 件只治「醒来先知道」，治不了「正在爆」：它只在没有活动时跑，而在爆的那会儿恰恰在忙；
 * 连续跑不停的会话也永远等不到这 5 分钟空闲。真要拦在请求前，那是 billion-context 的位置。
 *
 * 为什么只做「收」不做「写」：写入内容必须由我在对话里判断，模型自动总结会把原话折成转述。
 * 这个插件只保证「素材是齐的」。
 *
 * 约束：turn/end 后空闲 ≥ 5 分钟、两次至少隔 10 分钟；同时只跑一个；失败只写日志；
 * 计时器 unref，宿主退出不被它拖住。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-cat-memory-auto';

const WORKSPACE = process.env.DSH_MEMORY_AUTO_WORKSPACE
  ?? path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace');
const LOG = path.join(os.homedir(), '.dsh', 'dsh-cat-memory-auto.log');
const CTX_SNAPSHOT = path.join(os.homedir(), '.dsh', 'cache', 'ctx-latest.txt');
const TROUBLE_SNAPSHOT = path.join(os.homedir(), '.dsh', 'cache', 'trouble-latest.txt');

const CFG = {
  idleMs: Number(process.env.DSH_MEMORY_AUTO_IDLE_MS ?? 5 * 60 * 1000),
  minGapMs: Number(process.env.DSH_MEMORY_AUTO_GAP_MS ?? 10 * 60 * 1000),
  tickMs: Number(process.env.DSH_MEMORY_AUTO_TICK_MS ?? 60 * 1000),
  embedMax: Number(process.env.DSH_MEMORY_AUTO_EMBED_MAX ?? 200),
  weeklyMs: Number(process.env.DSH_MEMORY_AUTO_WEEKLY_MS ?? 7 * 24 * 60 * 60 * 1000),
  enabled: process.env.DSH_MEMORY_AUTO !== 'off',
};

function log(message) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* 日志失败不影响宿主 */
  }
}

let lastTurnEnd = Date.now();   // 挂载时当作「刚有活动」；置 0 会让重启后的首个 tick 立刻在对话中跑全量索引
let lastRun = 0;
let lastWeekly = 0;             // 0 是有意的：新装/重启后补跑一次周扫
let running = false;
let activeChild = null;         // 正在跑的子进程，dispose 时要能掐掉
let disposed = false;

function run(script, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [path.join(WORKSPACE, '产出', '工具', script), ...args], {
        cwd: WORKSPACE,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, out: String(error?.message ?? error) });
      return;
    }
    activeChild = child;
    const settle = (value) => {
      if (activeChild === child) activeChild = null;
      resolve(value);
    };
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('error', (error) => settle({ code: -1, out: `${out}${error?.message ?? error}` }));
    child.on('close', (code) => settle({ code, out }));
  });
}

function lastLine(text) {
  const lines = String(text).trim().split(/\r?\n/).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '(no output)';
}

async function idleCycle() {
  const a = await run('session-index.mjs', ['build']);
  log(`build exit=${a.code} | ${lastLine(a.out)}`);
  if (a.code === 0) {
    const b = await run('session-index.mjs', ['embed', '--max', String(CFG.embedMax)]);
    log(`embed exit=${b.code} | ${lastLine(b.out)}`);
  }
  const v = await run('verbatim.mjs', []);
  log(`verbatim exit=${v.code} | ${lastLine(v.out)}`);
  // 上下文体检：只读 bili.log，几十毫秒。全文存盘给人看，--line 取一句进日志。
  const c = await run('ctx-watch.mjs', ['--hours', '6']);
  if (c.code === 0) {
    try {
      fs.mkdirSync(path.dirname(CTX_SNAPSHOT), { recursive: true });
      fs.writeFileSync(CTX_SNAPSHOT, c.out, 'utf8');
    } catch (error) {
      log(`ctx-snapshot write failed: ${error?.message ?? error}`);
    }
    const one = await run('ctx-watch.mjs', ['--hours', '6', '--line']);
    log(`ctx-watch exit=${c.code} | ${one.code === 0 ? lastLine(one.out) : lastLine(c.out)}`);
  } else {
    log(`ctx-watch exit=${c.code} | ${lastLine(c.out)}`);
  }
  // 故障巡检：Ollama 活着没、bili.log 里有硬错误没、上面这几步自己失败没。
  const t = await run('watch-trouble.mjs', []);
  if (t.code === 0 || t.code === 1) {
    try {
      fs.mkdirSync(path.dirname(TROUBLE_SNAPSHOT), { recursive: true });
      fs.writeFileSync(TROUBLE_SNAPSHOT, t.out, 'utf8');
    } catch (error) {
      log(`trouble-snapshot write failed: ${error?.message ?? error}`);
    }
  }
  log(`watch-trouble exit=${t.code} | ${lastLine(t.out)}`);
}

async function weeklyCycle() {
  const d = await run('memory-decay.mjs', ['--write']);
  log(`decay exit=${d.code} | ${lastLine(d.out)}`);
  // 条目级三层：只标 cold 的最老 ≤10 条，写 tier.log；判据与账本见 记忆系统-P2方案.md
  const t = await run('memory-tier.mjs', ['--write']);
  log(`tier exit=${t.code} | ${lastLine(t.out)}`);
  const c = await run('memory-conflicts.mjs', []);
  log(`conflicts exit=${c.code} | ${lastLine(c.out)}`);
}

async function tick() {
  if (!CFG.enabled || running || disposed) return;
  const now = Date.now();
  if (now - lastTurnEnd < CFG.idleMs) return;
  if (now - lastRun < CFG.minGapMs) return;
  running = true;
  lastRun = now;
  try {
    await idleCycle();
    if (now - lastWeekly >= CFG.weeklyMs) {
      lastWeekly = now;
      await weeklyCycle();
    }
  } catch (error) {
    log(`tick error: ${error?.message ?? error}`);
  } finally {
    running = false;
  }
}

export function apply(ctx) {
  ctx.on('session/event', (_session, event) => {
    if (event?.type === 'turn/end') lastTurnEnd = Date.now();
  });

  const timer = setInterval(() => {
    tick().catch((error) => log(`tick rejected: ${error?.message ?? error}`));
  }, CFG.tickMs);
  if (typeof timer.unref === 'function') timer.unref();

  ctx.effect(() => () => {
    disposed = true;
    clearInterval(timer);
    if (activeChild) {
      try { activeChild.kill(); } catch { /* 已经退出 */ }
    }
  }, 'dsh-cat-memory-auto: idle timer');

  log(`mounted idle=${CFG.idleMs}ms gap=${CFG.minGapMs}ms tick=${CFG.tickMs}ms embedMax=${CFG.embedMax} weekly=${CFG.weeklyMs}ms enabled=${CFG.enabled}`);
}
