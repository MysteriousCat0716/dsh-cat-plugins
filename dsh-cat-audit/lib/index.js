/**
 * dsh-cat-audit — 代码审计里「不需要判断力」的那一段。
 *
 * 为什么只做一半：找文件、跑规则引擎、按 `文件:行` 合并结果，这些是机械的；
 * 「这段代码在什么情况下会出错」需要判断力，交给 skill 派出去的各透镜。
 * 加一个新的审计角度 = 往 lenses 目录放一个 md，不改这里。
 *
 * 两个工具：
 *   audit_scan  —— 圈范围、跑 semgrep（若装了）、为每个透镜生成任务单
 *   audit_merge —— 收各透镜的条目，按 文件:行 聚类去重，交叉命中加权定级
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 不 import `defineTool`：它住在宿主自己的 node_modules 里，插件被 link 到 profile
// 之后解析不到。它的全部工作是把简写参数 spec 转成 JSON Schema 再加一层入参校验；
// 下面直接把 parameters 写成标准 JSON Schema，绕开这个依赖。

// 环境变量写空串或写成文字时 Number('') === 0、Number('abc') === NaN，
// 会让 setTimeout 立即超时、maxFiles 变 0。统一走这个，非法值退回默认。
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULTS = {
  maxFiles: envInt('DSH_AUDIT_MAX_FILES', 400),
  maxFileBytes: envInt('DSH_AUDIT_MAX_FILE_BYTES', 400_000),
  semgrepTimeoutMs: envInt('DSH_AUDIT_SEMGREP_TIMEOUT_MS', 120_000),
  exts: (process.env.DSH_AUDIT_EXTS ??
    '.js,.mjs,.cjs,.ts,.tsx,.jsx,.vue,.svelte,.py,.go,.rs,.java,.rb,.php,.cs')
    .split(',').map((s) => s.trim()).filter(Boolean),
  skipDirs: new Set((process.env.DSH_AUDIT_SKIP_DIRS ??
    'node_modules,.git,dist,build,out,.next,.cache,_backups,_tmp,coverage,.venv,__pycache__,.pnpm-store,.turbo')
    .split(',').map((s) => s.trim()).filter(Boolean)),
  lensesDir: process.env.DSH_AUDIT_LENSES ??
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'skills', 'audit', 'lenses'),
};

/**
 * 会话工作目录。dsh 里它不在 `ctx.cwd` 上，而是 `workingDirectory` 服务：
 * `await ctx.workingDirectory.ensure(agent, signal)`，所以必须接住 execute 的第二个参数。
 * 拿不到时（比如没有 agent）退回进程目录。
 */
async function resolveCwd(ctx, exec) {
  try {
    if (ctx.workingDirectory && exec?.agent) {
      const dir = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      if (typeof dir === 'string' && dir) return dir;
    }
  } catch {
    /* 拿不到会话目录，走兜底 */
  }
  return process.cwd();
}

const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2, info: 3 };
const SEVERITY_ALIAS = {
  critical: 'critical', blocker: 'critical', severe: 'critical', fatal: 'critical',
  major: 'major', high: 'major', error: 'major',
  minor: 'minor', medium: 'minor', low: 'minor', warning: 'minor',
  info: 'info', note: 'info', nit: 'info',
};
const SEVERITY_ZH = { critical: '致命', major: '主要', minor: '次要', info: '信息' };

/** 工具的规范输出：一个 markdown 字段，可选一条 warning。 */
const AUDIT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      markdown: { type: 'string' },
      warning: { type: 'string' },
    },
    required: ['markdown'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.markdown ?? '') }],
};

/* ── 圈范围 ─────────────────────────────────────────────── */

function walkFiles(root, limit) {
  const found = [];
  const stack = [root];
  while (stack.length > 0 && found.length < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= limit) break;
      if (entry.isDirectory()) {
        if (!DEFAULTS.skipDirs.has(entry.name)) stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!DEFAULTS.exts.includes(path.extname(entry.name).toLowerCase())) continue;
      const full = path.join(dir, entry.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > DEFAULTS.maxFileBytes) continue;
      found.push({ path: full, bytes: stat.size, lines: countLines(full) });
    }
  }
  return found.sort((a, b) => b.lines - a.lines);
}

function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    let n = 1;
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
    return n;
  } catch {
    return 0;
  }
}

function rel(root, file) {
  const r = path.relative(root, file);
  return r === '' ? '.' : r.split(path.sep).join('/');
}

/* ── semgrep（可选层） ──────────────────────────────────── */

function resolveSemgrep() {
  if (process.env.DSH_AUDIT_SEMGREP) return process.env.DSH_AUDIT_SEMGREP;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home) {
    const pyRoot = path.join(home, 'AppData', 'Local', 'Programs', 'Python');
    try {
      for (const dir of fs.readdirSync(pyRoot)) {
        const exe = path.join(pyRoot, dir, 'Scripts', 'semgrep.exe');
        if (fs.existsSync(exe)) return exe;
      }
    } catch {
      /* 没有 Python 安装目录，继续往下 */
    }
    const local = path.join(home, '.local', 'bin', 'semgrep');
    if (fs.existsSync(local)) return local;
  }
  return 'semgrep';
}

const SEMGREP_MAX_FILES = 60;

function runSemgrep(bin, root, files) {
  // semgrep 一次扫太多文件会慢到没法用；但截断必须说出来，否则报告是假的
  const scanned = files.slice(0, SEMGREP_MAX_FILES);
  const coverage = { scanned: scanned.length, total: files.length };
  return new Promise((resolve) => {
    const args = ['scan', '--json', '--quiet', '--config', 'p/secrets', '--config', 'p/default'];
    for (const f of scanned) args.push(f);
    let child;
    try {
      child = spawn(bin, args, {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ran: false, error: String(error?.message ?? error), findings: [], ...coverage });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...value, ...coverage });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出 */ }
      finish({ ran: false, error: `semgrep 超过 ${DEFAULTS.semgrepTimeoutMs} ms 未返回`, findings: [] });
    }, DEFAULTS.semgrepTimeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => {
      const code = error?.code;
      finish({
        ran: false,
        error: code === 'ENOENT' ? 'semgrep 未安装（装法见 README）' : String(error?.message ?? error),
        findings: [],
      });
    });
    child.on('close', () => {
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        finish({ ran: false, error: `semgrep 输出不是 JSON：${err.trim().slice(0, 200)}`, findings: [] });
        return;
      }
      const results = Array.isArray(parsed?.results) ? parsed.results : [];
      const findings = results.map((r) => ({
        rule: r.check_id ?? '',
        file: r.path ?? '',
        line: r.start?.line ?? 0,
        severity: String(r.extra?.severity ?? 'INFO').toLowerCase(),
        message: String(r.extra?.message ?? '').trim(),
      }));
      finish({ ran: true, error: '', findings });
    });
  });
}

/* ── 透镜 ───────────────────────────────────────────────── */

const BUILTIN_LENSES = [
  {
    id: 'correctness',
    title: '正确性与边界',
    brief: '找会出错的逻辑：初值与节流基准、空值与类型、越界与截断、状态机漏分支、时间与单位换算。',
  },
  {
    id: 'safety',
    title: '安全与资源',
    brief: '找能被利用的路径：命令拼接、路径穿越、SSRF、凭据落盘、无上限增长、句柄与子进程泄漏。',
  },
  {
    id: 'lifecycle',
    title: '并发与生命周期',
    brief: '找装上去卸不干净的：监听器与定时器、异步窗口里的事件、重复注册、卸载后仍在跑的循环。',
  },
  {
    id: 'deps',
    title: '依赖与供应链',
    brief: '看外部输入：依赖版本与锁、未校验的远程配置、脚本执行能力、来源不明的数据。',
  },
];

function loadLenses() {
  let entries;
  try {
    entries = fs.readdirSync(DEFAULTS.lensesDir, { withFileTypes: true });
  } catch {
    return BUILTIN_LENSES;
  }
  const lenses = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const file = path.join(DEFAULTS.lensesDir, entry.name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8').trim();
    } catch {
      continue;
    }
    if (!text) continue;
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? entry.name.replace(/\.md$/, '');
    lenses.push({ id: entry.name.replace(/\.md$/, ''), title, brief: text });
  }
  return lenses.length > 0 ? lenses : BUILTIN_LENSES;
}

function taskSheet({ root, files, semgrep, lenses, note }) {
  const totalLines = files.reduce((sum, f) => sum + f.lines, 0);
  const lines = [];
  lines.push('# 审计任务单', '');
  lines.push(`- 范围：\`${root}\``);
  lines.push(`- 文件：${files.length} 个 / ${totalLines} 行`);
  if (note) lines.push(`- 说明：${note}`);
  lines.push('');
  lines.push('## 文件清单', '');
  for (const f of files) lines.push(`- \`${rel(root, f.path)}\` （${f.lines} 行）`);
  lines.push('');
  lines.push('## 确定性层（semgrep）', '');
  const covered = semgrep.scanned != null
    ? `（扫了 ${semgrep.scanned} / ${semgrep.total} 个文件${semgrep.scanned < semgrep.total ? `，**后 ${semgrep.total - semgrep.scanned} 个没扫**` : ''}）`
    : '';
  if (!semgrep.ran) {
    lines.push(`未运行：${semgrep.error}`);
  } else if (semgrep.findings.length === 0) {
    lines.push(`跑完了${covered}，零命中。`);
  } else {
    lines.push(`跑完了${covered}，${semgrep.findings.length} 条（下面这些是规则匹配，**必须逐条人工判断真假**）：`, '');
    for (const f of semgrep.findings) {
      lines.push(`- \`${f.file}:${f.line}\` [${f.severity}] ${f.rule} — ${f.message}`);
    }
  }
  lines.push('');
  lines.push('## 透镜任务', '');
  lines.push('每个透镜派一个只读子代理，只报能指到 `文件:行` 的问题，按下面的格式写。');
  lines.push('');
  for (const lens of lenses) {
    lines.push(`### ${lens.title}（${lens.id}）`, '');
    lines.push(lens.brief, '');
    lines.push('输出格式（每条一段，缺字段即视为无效）：', '');
    lines.push('```');
    lines.push('### [critical|major|minor] 一句话说清是什么问题');
    lines.push('- 位置：`路径:行号`');
    lines.push('- 触发：什么输入或什么时序会走到这里');
    lines.push('- 证据：那段代码的关键行，或「读了 A 与 B 两处才能看出」的说明');
    lines.push('- 置信度：0-100，说清不确定的是什么');
    lines.push('```', '');
  }
  return lines.join('\n');
}

/* ── 合并 ───────────────────────────────────────────────── */

function parseFindings(text, source) {
  const out = [];
  let skipped = 0;
  const chunks = String(text ?? '').split(/\n(?=#{2,3}\s*\[)/);
  for (const chunk of chunks) {
    if (!/^#{2,3}\s*\[/.test(chunk)) continue;
    const head = /^#{2,3}\s*\[([a-z]+)\]\s*(.+)$/m.exec(chunk);
    if (!head) {
      skipped += 1;
      continue;
    }
    // 子代理常写 blocker / high / low，这些不是我们的四级，但语义清楚，映射过来而不是丢掉。
    const severity = SEVERITY_ALIAS[head[1].toLowerCase()];
    if (!severity) {
      skipped += 1;
      continue;
    }
    const loc = /位置[：:]\s*`?([^`\s]+?:\d+(?:-\d+)?)`?/m.exec(chunk);
    const conf = /置信度[：:]\s*(\d{1,3})/.exec(chunk);
    out.push({
      severity,
      title: head[2].trim(),
      location: loc ? loc[1] : '',
      confidence: conf ? Math.max(0, Math.min(100, Number(conf[1]))) : 0,
      source,
      raw: chunk.trim(),
    });
  }
  return { entries: out, skipped };
}

// 两个透镜报同一处时，常见的写法差异是 :120 / :120-126 / :118-124，
// 或者一个给绝对路径一个给相对路径。不归一化就各成一组，交叉命中加权永远拿不到。
function splitLocation(location) {
  const raw = String(location ?? '').trim().replace(/\\/g, '/');
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(raw);
  if (!m) return { file: raw.replace(/^[A-Za-z]:\//, ''), line: 0, end: 0 };
  const a = Number(m[2]);
  const b = m[3] ? Number(m[3]) : a;
  return {
    file: m[1].replace(/^[A-Za-z]:\//, '').replace(/^\.?\//, ''),
    line: Math.min(a, b),
    end: Math.max(a, b),
  };
}

// 路径后缀匹配：绝对路径与相对路径只要从末尾往前完全一致就算同一个文件。
// 只共享 basename（1 段）时不合并——六个插件里都有 lib/index.js，会误合。
function sameFile(a, b) {
  const pa = a.split('/').filter(Boolean);
  const pb = b.split('/').filter(Boolean);
  const n = Math.min(pa.length, pb.length);
  if (n < 2) return false;
  for (let i = 1; i <= n; i += 1) {
    if (pa[pa.length - i] !== pb[pb.length - i]) return false;
  }
  return true;
}

const MERGE_LINE_TOLERANCE = 3;

// 一个透镜报具体行 :800，另一个报范围 :796-803，起始行差 4 但指的是同一处。
// 先看行号区间是否重叠，再退回容差。
function sameSpot(a, b) {
  if (!a.file || !b.file || !sameFile(a.file, b.file)) return false;
  if (!a.line || !b.line) return false;
  const aEnd = a.end || a.line;
  const bEnd = b.end || b.line;
  if (a.line <= bEnd && b.line <= aEnd) return true;
  return Math.abs(a.line - b.line) <= MERGE_LINE_TOLERANCE;
}

function mergeFindings(entries) {
  const groups = [];
  for (const entry of entries) {
    const spot = splitLocation(entry.location);
    let target = null;
    if (spot.file && spot.line) {
      target = groups.find((g) => sameSpot(g, spot));
    } else {
      target = groups.find((g) => !g.file && g.title === entry.title);
    }
    if (target) {
      target.list.push(entry);
      // 组的位置取最小区间，展示才稳定
      if (spot.file && spot.line) {
        target.file = spot.file;
        target.line = target.line ? Math.min(target.line, spot.line) : spot.line;
        target.end = Math.max(target.end || 0, spot.end || spot.line);
      }
    } else {
      groups.push({ file: spot.file, line: spot.line, end: spot.end, title: entry.title, list: [entry] });
    }
  }
  const merged = [];
  for (const g of groups) {
    const list = g.list;
    const severity = list
      .map((e) => e.severity)
      .sort((a, b) => (SEVERITY_ORDER[a] ?? 9) - (SEVERITY_ORDER[b] ?? 9))[0];
    const top = Math.max(...list.map((e) => e.confidence));
    const confidence = Math.min(95, top + 8 * (list.length - 1));
    // 组里可能同时有绝对路径和相对路径，展示取最短的那个（通常是子代理写的相对路径）
    const shortest = list
      .map((e) => splitLocation(e.location).file)
      .filter(Boolean)
      .sort((a, b) => a.length - b.length)[0];
    const key = shortest ? `${shortest}:${g.line}` : `未定位：${g.title}`;
    merged.push({ key, severity, confidence, lenses: [...new Set(list.map((e) => e.source))], entries: list });
  }
  merged.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (b.confidence - a.confidence));
  return merged;
}

function mergeReport({ root, merged, dropped }) {
  const lines = [];
  const bySeverity = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const m of merged) bySeverity[m.severity] = (bySeverity[m.severity] ?? 0) + 1;
  lines.push('# 审计合并结果', '');
  lines.push(`- 范围：\`${root}\``);
  lines.push(`- 条目：${merged.length} 条（致命 ${bySeverity.critical} / 主要 ${bySeverity.major} / 次要 ${bySeverity.minor} / 信息 ${bySeverity.info}）`);
  if (dropped > 0) lines.push(`- 未解析：${dropped} 个条目块（标题的严重度写错或格式不符，已丢弃）`);
  lines.push('');
  for (const m of merged) {
    const cross = m.lenses.length > 1 ? ` ⚡ 交叉命中（${m.lenses.join(' + ')}）` : '';
    lines.push(`## [${SEVERITY_ZH[m.severity] ?? m.severity}] ${m.entries[0].title}`, '');
    lines.push(`- 位置：\`${m.key}\``);
    lines.push(`- 置信度：${m.confidence}${cross}`);
    lines.push(`- 来源：${m.lenses.join('、')}`);
    for (const e of m.entries) {
      lines.push('');
      lines.push(e.raw);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* ── 插件入口 ───────────────────────────────────────────── */

export const name = 'dsh-cat-audit';
export const inject = ['tools', 'workingDirectory'];

export function apply(ctx) {
  ctx.tools.register({
    name: 'audit_scan',
    description: '圈出要审计的代码范围，跑一遍 semgrep（若装了），并为每个透镜生成任务单。只读，不改文件。',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: '要审计的目录，默认当前工作目录' },
        max_files: { type: 'number', description: '最多收多少个文件，默认 400' },
        lens: { type: 'string', description: '只生成指定透镜的任务单（id），默认全部' },
        semgrep: { type: 'boolean', description: '是否跑 semgrep，默认 true' },
      },
      additionalProperties: false,
    },
    output: AUDIT_OUTPUT,
    async execute(args, exec) {
      const root = path.resolve(await resolveCwd(ctx, exec), String(args.root ?? '.'));
      const limit = Number(args.max_files ?? DEFAULTS.maxFiles);
      const files = walkFiles(root, limit);
      if (files.length === 0) {
        return { markdown: `范围 \`${root}\` 里没有匹配的文件（扩展名：${DEFAULTS.exts.join(' ')}）` };
      }
      let semgrep = { ran: false, error: '按参数跳过', findings: [] };
      if (args.semgrep !== false) {
        const bin = resolveSemgrep();
        semgrep = await runSemgrep(bin, root, files.map((f) => f.path));
      }
      const allLenses = loadLenses();
      // 拼错的 id 以前会静默变回全量，任务单看着正常、其实跑的不是你要的那一个。
      const wanted = args.lens ? String(args.lens) : '';
      const lenses = wanted ? allLenses.filter((l) => l.id === wanted) : allLenses;
      if (wanted && lenses.length === 0) {
        const known = allLenses.map((l) => l.id).join(' / ') || '（没有可用透镜）';
        return {
          markdown: `# 透镜未匹配\n\n要的是 \`${wanted}\`，可用的只有：${known}。\n\n没有回退成全量——宁可让你看见拼错，也不要给一份看着正常的错任务单。`,
          warning: `unknown lens: ${wanted}`,
        };
      }
      const note = files.length >= limit ? `已到文件上限 ${limit}，范围被截断` : '';
      return { markdown: taskSheet({ root, files, semgrep, lenses, note }) };
    },
  });

  ctx.tools.register({
    name: 'audit_merge',
    description: '把各透镜的审计结果按 文件:行 聚类去重，交叉命中加权，输出分级报告。可以同时给多段文本。',
    parameters: {
      type: 'object',
      properties: {
        findings: { type: 'array', items: { type: 'string' }, description: '透镜结果文本数组（每段是子代理返回的原文）' },
        sources: { type: 'array', items: { type: 'string' }, description: '与 findings 一一对应的透镜名，缺省用序号' },
        root: { type: 'string', description: '用于显示的范围，默认当前工作目录' },
        out: { type: 'string', description: '把报告写到这个路径（可选）' },
      },
      required: ['findings'],
      additionalProperties: false,
    },
    output: AUDIT_OUTPUT,
    async execute(args, exec) {
      const texts = Array.isArray(args.findings) ? args.findings : [args.findings];
      const names = Array.isArray(args.sources) ? args.sources : [];
      const entries = [];
      let parsedCount = 0;
      let droppedCount = 0;
      for (let i = 0; i < texts.length; i += 1) {
        const source = String(names[i] ?? `透镜${i + 1}`);
        const { entries: got, skipped } = parseFindings(texts[i], source);
        parsedCount += got.length;
        droppedCount += skipped;
        entries.push(...got);
      }
      const root = path.resolve(await resolveCwd(ctx, exec), String(args.root ?? '.'));
      if (entries.length === 0) {
        return { markdown: `一段条目都没解析出来（期望每段以 \`### [major] 标题\` 开头）。共收到 ${texts.length} 段文本。` };
      }
      const merged = mergeFindings(entries);
      const markdown = mergeReport({ root, merged, dropped: droppedCount });
      if (args.out) {
        try {
          fs.writeFileSync(path.resolve(await resolveCwd(ctx, exec), String(args.out)), markdown, 'utf8');
        } catch (error) {
          return { markdown, warning: `写文件失败：${error?.message ?? error}` };
        }
      }
      return { markdown };
    },
  });
}
