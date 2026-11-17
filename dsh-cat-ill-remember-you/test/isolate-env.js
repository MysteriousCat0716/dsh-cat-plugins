/**
 * 测试隔离：不读本机真实的 ~/.dsh/memory/cloudflare.json。
 *
 * 本机配好云端向量后端之后，`activeBackend()` 在没设环境变量时会认出它、
 * 默认走 cloudflare；测试于是跟着这台机器的家目录漂——同一个 commit 在没配
 * 云端的机器上全绿，在配了的机器上 8 个红。每个测试文件开头先加载这一行，
 * 把配置路径指到一个不存在的临时文件，后端就稳定回落到 ollama；想测云端的
 * 用例自己在里面显式设 DSH_CLOUDFLARE_FILE。
 */
import os from 'node:os';
import path from 'node:path';

process.env.DSH_CLOUDFLARE_FILE = path.join(
  os.tmpdir(),
  `dsh-test-no-cloudflare-${process.pid}.json`,
);
