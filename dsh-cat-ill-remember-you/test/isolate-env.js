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

// 同一个病的后门：配置文件路径堵住了，环境变量没堵。本机把这两个变量配在
// 用户环境里（注册表），于是「没有云端配置时默认关」这类用例在别人机器上全绿、
// 在这台机器上必红——假失败看多了就没人信测试，毒害的是后续一切验证。
// 2026-11-20 渡彻查 W-01 实测：干净环境 285/285，本机 32/36。
// 要测向量层的用例本来就在用例内显式设 env（见 vectors-off.test.js:38-45），不受影响。
delete process.env.DSH_MEMORY_CORE_EMBED_BACKEND;
delete process.env.DSH_MEMORY_CORE_VECTOR;

// 同一类泄漏：集成测试会往真实的 ~/.dsh/cache/ill-remember-you.log 追加日志。
process.env.DSH_MEMORY_CORE_LOG = path.join(
  os.tmpdir(),
  `dsh-test-ill-remember-you-${process.pid}.log`,
);
