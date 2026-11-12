/**
 * Cloudflare Workers AI embedding backend.
 *
 * Same contract as embed.js `embedText`: one text in, one vector out; throws
 * on any failure so the caller can fall back to lexical recall. Credentials
 * live outside the plugin (the file is chmod 600 and never tracked).
 *
 * This backend exists to test bge-m3 vectors without keeping Ollama resident.
 * It is opt-in via DSH_MEMORY_CORE_EMBED_BACKEND=cloudflare.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLOUDFLARE_MODEL = 'bge-m3';
const DEFAULT_FILE = () =>
  process.env.DSH_CLOUDFLARE_FILE ||
  path.join(os.homedir(), '.dsh', 'memory', 'cloudflare.json');

function readConfig() {
  const file = DEFAULT_FILE();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw.accountId || !raw.apiToken) {
    throw new Error(`cloudflare config incomplete: ${file}`);
  }
  return raw;
}

export function cloudflareReady() {
  try {
    const cfg = readConfig();
    return Boolean(cfg.accountId && cfg.apiToken);
  } catch {
    return false;
  }
}

/**
 * @param {string} text
 * @param {{model?:string, timeoutMs?:number}} [options]
 * @returns {Promise<number[]>}
 */
export async function embedTextCloudflare(text, options = {}) {
  const cfg = readConfig();
  const model = options.model || CLOUDFLARE_MODEL;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 4000;
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/run/@cf/baai/${model}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: [String(text ?? '')] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`cloudflare ${model} ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  if (!payload?.success) {
    throw new Error(`cloudflare ${model} failed: ${JSON.stringify(payload?.errors ?? [])}`);
  }
  const data = payload?.result?.data;
  const vector = Array.isArray(data) ? data[0] : null;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('cloudflare returned no vector');
  }
  return vector;
}
