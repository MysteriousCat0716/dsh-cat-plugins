/**
 * dsh-cat-eye — host half.
 *
 * 把 tools/look.py 包成一个模型可调的工具：给 BV 号或直播间号，
 * 回来一份报告（元信息 + 简介 + 抽帧路径 + 可选台词 + 可选评论）。
 *
 * 设计原则：这里不重复实现任何抓取逻辑，全部落在 look.py 里。
 * 插件只负责：找 python、拼参数、读 result.json、把结果摆成模型能读的样子。
 * 这样脚本可以单独跑（人用），也可以被工具调（模型用），只有一份真相。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const SCRIPT = path.join(PKG, "tools", "look.py");

// defineTool 只是构造器；解析不到就用裸对象，宿主认同样的形状。
let defineTool;
try {
  ({ defineTool } = await import("@deepseek-ai/dsh-tools"));
} catch {
  defineTool = (t) => t;
}

export const name = "dsh-cat-eye";

/** 只借 tools 服务来注册工具，不碰别的。 */
export const inject = ["tools"];

function pythonBin() {
  return process.env.DSH_CAT_EYE_PYTHON || "python";
}

function run(argv, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), [SCRIPT, ...argv], {
      cwd: PKG,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (s) => (stdout += s));
    child.stderr.on("data", (s) => (stderr += s));
    child.on("error", reject);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      resolve({ code, stdout, stderr });
    });
  });
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "look_bili",
      description:
        "看一条 B 站视频或一个正在直播的直播间。投稿视频会下 360P 源、抽若干帧、可选转写人声、可选抓热评，写一份 report.md 并返回报告正文与帧的绝对路径（帧要用 read_image 逐张读）。直播只能抓当前画面，抓不到连续动作也听不到声音。参数 target 给 BV 号、视频链接，或配合 live 给房间号。",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: {
            type: "string",
            required: true,
            description: "BV 号（BV1xx…）、视频链接，或纯数字直播间号（配合 live）",
          },
          live: {
            type: "boolean",
            description: "把 target 当直播间号抓当前画面（默认 false）",
          },
          frames: {
            type: "integer",
            description: "最多抽多少帧，默认 12；直播时是抓几张，默认 2",
          },
          interval: {
            type: "integer",
            description: "直播抓帧间隔秒数，默认 10",
          },
          asr: {
            type: "boolean",
            description: "转写人声（本地 whisper，慢；只有投稿视频有）",
          },
          model: {
            type: "string",
            description: "转写模型 tiny/base/small/medium，默认 small",
          },
          comments: {
            type: "integer",
            description: "抓评论区热度前 N 条，默认 10，0=不抓",
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.report }],
      async execute(args, exec) {
        if (!existsSync(SCRIPT)) {
          throw new Error(`找不到 look.py：${SCRIPT}`);
        }
        const argv = [];
        if (args.live) {
          argv.push("--live", String(args.target).trim(), "--frames", String(args.frames ?? 2));
          if (args.interval) argv.push("--interval", String(args.interval));
        } else {
          argv.push(String(args.target).trim(), "--frames", String(args.frames ?? 12));
          if (args.asr) argv.push("--asr");
          if (args.model) argv.push("--model", args.model);
          if (args.comments !== undefined) argv.push("--comments", String(args.comments));
        }

        const { code, stdout, stderr } = await run(argv, exec.signal);
        if (code !== 0) {
          const tail = (stderr || stdout).trim().split("\n").slice(-6).join("\n");
          throw new Error(`look.py 退出码 ${code}\n${tail}`);
        }

        // 脚本最后会打印「结果  <…>/result.json」，按这一行定位，不猜目录结构。
        const hit = stdout.match(/^\s*结果\s+(.+result\.json)\s*$/m);
        if (!hit) throw new Error(`脚本没打印结果路径：\n${stdout.slice(-400)}`);
        const resultPath = hit[1].trim();
        if (!existsSync(resultPath)) {
          throw new Error(`脚本没错但没写 result.json：${resultPath}`);
        }
        const result = JSON.parse(await readFile(resultPath, "utf8"));
        const report = await readFile(result.report, "utf8");
        return {
          report,
          title: result.title || "",
          url: result.url || "",
          duration: result.duration ?? null,
          frames: result.frames || [],
          frameMode: result.frameMode || "",
          dir: result.dir,
        };
      },
    }),
  );
}
