/**
 * 别名扩展：把「同义不同词」做成数据，而不是靠向量模型猜。
 *
 * 弱匹配层用词面重合找记忆，最容易漏的是「考研」和「上岸」、「记忆插件」
 * 和「illrememberyou」这种同一个东西的两种叫法。这里维护若干组同义词：
 * 查询里出现组内任一词，就把同组其他词也拿去检索。
 *
 * 内置一份默认组（够日常用），用户可在 `~/.dsh/memory/aliases.json` 覆盖，
 * 格式 `{ "组名": ["词1", "词2"] }`。文件坏了就当没有——别名是锦上添花，
 * 不能因为它让召回整条路断掉。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_USER_FILE = path.join(os.homedir(), '.dsh', 'memory', 'aliases.json');

/** 允许用环境变量指到别处：测试要可控，用户也可能想把它放进仓库。 */
function userFile() {
  return process.env.DSH_MEMORY_CORE_ALIASES || DEFAULT_USER_FILE;
}

/** 内置默认组。只收「确实是同一个东西的不同叫法」，不收仅仅是相关的话题。 */
export const BUILTIN_ALIASES = {
  考研: ['上岸', '读研', '研究生', '备考', '专业课', '初试'],
  记忆插件: ['记忆核心', 'illrememberyou', 'mnemon', '记忆系统'],
  代理: ['vps', '机场', '翻墙', '节点', 'clash', 'reality'],
  毕设: ['毕业设计', '毕业论文', '论文'],
  高光谱: ['光谱', 'hyperspectral'],
  插件: ['plugin', '扩展', 'bundle'],
};

let cache = null; // { key, groups }

function readUserFile() {
  const file = userFile();
  try {
    const stat = fs.statSync(file);
    const key = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (cache && cache.key === key) return cache.groups;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const groups = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [name, words] of Object.entries(raw)) {
        if (!Array.isArray(words)) continue;
        const clean = words.map((word) => String(word ?? '').trim()).filter(Boolean);
        if (clean.length) groups[String(name)] = clean;
      }
    }
    cache = { key, groups };
    return groups;
  } catch {
    return null; // 没有文件、JSON 坏了、读不了：都退回内置
  }
}

/** 合并后的组表：用户文件整组覆盖同名内置组。 */
export function aliasGroups() {
  const groups = { ...BUILTIN_ALIASES };
  const user = readUserFile();
  if (user) Object.assign(groups, user);
  return groups;
}

/**
 * 把一组词扩展到同组其他词。
 *
 * @param {string[]} terms 原词（weakTerms 的结果）
 * @returns {{ all: string[], discount: Map<string, number> }}
 *   `all` 是原词 + 扩展词（去重、保持原词在前）；
 *   `discount` 只给扩展词，值是 0.7——别名命中的证据比原词弱一档，
 *   不该和用户原话里直接出现的词同权。
 */
export function expandTerms(terms) {
  const all = [...terms];
  const discount = new Map();
  const groups = aliasGroups();
  const add = (words) => {
    for (const word of words) {
      if (!word || all.includes(word)) continue;
      all.push(word);
      discount.set(word, 0.7);
    }
  };
  for (const [name, words] of Object.entries(groups)) {
    // 组名或组内任一词出现在查询里，就把整组带进来。
    if (terms.includes(name) || words.some((word) => terms.includes(word))) {
      add([name, ...words]);
    }
  }
  return { all, discount };
}
