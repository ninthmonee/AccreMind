#!/usr/bin/env node
// 生成 DSH 插件市场索引（format 1）。
// 用法：
//   node packages/dsh-plugin/scripts/market-index.mjs              写 market/index.json
//   node packages/dsh-plugin/scripts/market-index.mjs --check     校验现有索引与清单一致
//   node packages/dsh-plugin/scripts/market-index.mjs --from-npm  用 npm 上的真实发布时间做 publishTimestamp
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const root = resolve(pkgDir, '..', '..');

export const ICON_URL = 'https://raw.githubusercontent.com/carlosai-dev/AccreMind/main/packages/dsh-plugin/icon.svg';

export const INDEX_METADATA = {
  categories: {
    knowledge: { title: { en: 'Knowledge & memory', zh: '知识与记忆' } },
  },
  labels: {
    'local-first': { title: { en: 'Local-first', zh: '本地优先' } },
    'zero-dependency': { title: { en: 'Zero dependency', zh: '零依赖' } },
    sqlite: { title: { en: 'SQLite index', zh: 'SQLite 索引' } },
  },
  sortKeys: {
    recommended: { title: { en: 'Recommended', zh: '推荐度' }, order: 'desc' },
  },
};

function webUrl(raw, fallback) {
  const value = String(raw ?? fallback ?? '').trim();
  return value.replace(/^git\+/, '').replace(/\.git$/, '');
}

export function buildMarketIndex({ manifest, timestamp, iconUrl = ICON_URL }) {
  return {
    format: 1,
    title: { en: 'AccreMind plugin index', zh: 'AccreMind 插件源' },
    description: {
      en: 'Index sources for the AccreMind engineering experience engine and its DSH plugin.',
      zh: 'AccreMind 研发经验引擎及其 DSH 插件的索引源。',
    },
    metadata: INDEX_METADATA,
    plugins: [
      {
        name: manifest.name,
        title: { en: 'AccreMind', zh: 'AccreMind 经验引擎' },
        description: {
          en: 'Turn the experience scattered across your projects into reusable knowledge assets, then hand it back at the moment it matters. Markdown source of truth plus a node:sqlite FTS5 index, entirely on your machine.',
          zh: '把散落在项目里的经验沉淀成可复用的知识资产，再在需要的那一刻交还给模型和开发者。Markdown 为事实来源，node:sqlite FTS5 只做索引，数据不出本机。',
        },
        icon: iconUrl,
        author: 'carlosai-dev',
        homepage: webUrl(manifest.homepage, 'https://github.com/carlosai-dev/AccreMind'),
        repository: {
          url: webUrl(manifest.repository?.url, 'https://github.com/carlosai-dev/AccreMind'),
          directory: 'packages/dsh-plugin',
        },
        metadata: {
          category: 'knowledge',
          keywords: ['experience', 'memory', 'knowledge-base', 'engineering', 'sqlite', 'local-first', 'capture'],
          labels: ['local-first', 'zero-dependency', 'sqlite'],
          sortKeys: { recommended: 100 },
        },
        versions: [
          {
            version: manifest.version,
            publishTimestamp: timestamp,
            source: { type: 'npm' },
            engines: { dsh: manifest.engines?.dsh ?? '>=0.2.2-rc.5' },
          },
        ],
      },
    ],
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function npmPublishTimestamp(name, version) {
  try {
    const out = execFileSync('npm', ['view', name + '@' + version, 'time', '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    const iso = parsed?.[version];
    if (typeof iso === 'string') return Math.floor(new Date(iso).getTime() / 1000);
  } catch {
    // npm 不可用或包尚未发布：回落到调用方给的时间。
  }
  return null;
}

function main(argv) {
  const manifest = readJson(resolve(pkgDir, 'package.json'));
  const argOf = flag => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const outPath = resolve(root, argOf('--out') ?? 'market/index.json');
  const version = argOf('--version') ?? manifest.version;
  const fromNpm = argv.includes('--from-npm');
  const explicit = argOf('--timestamp');
  const existingIndex = existsSync(outPath) ? readJson(outPath) : null;
  const knownTimestamp = existingIndex?.plugins?.[0]?.versions?.find(item => item.version === version)?.publishTimestamp;
  let timestamp = explicit ? Number(explicit) : fromNpm ? npmPublishTimestamp(manifest.name, version) : null;
  // 同一版本沿用已记录的发布时间，避免每次 --check 都因为取不到 npm 时间而漂移。
  if (!timestamp && typeof knownTimestamp === 'number') timestamp = knownTimestamp;
  if (!timestamp) {
    const seconds = Math.floor(Date.now() / 1000);
    timestamp = seconds;
    if (!argv.includes('--quiet')) {
      console.log('[market-index] 未取到 npm 发布时间，暂用当前时间 ' + seconds + '；发布后请用 --from-npm 重跑。');
    }
  }
  const index = buildMarketIndex({ manifest: { ...manifest, version }, timestamp, iconUrl: argOf('--icon') ?? ICON_URL });
  const json = JSON.stringify(index, null, 2) + '\n';
  if (argv.includes('--check')) {
    if (!existsSync(outPath)) {
      console.error('[market-index] 缺少 ' + outPath);
      process.exit(1);
    }
    const current = readJson(outPath);
    const same = JSON.stringify(current) === JSON.stringify(index);
    if (!same) {
      console.error('[market-index] market/index.json 与 packages/dsh-plugin/package.json 不一致，请重跑生成。');
      process.exit(1);
    }
    if (!argv.includes('--quiet')) console.log('[market-index] 索引与清单一致');
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);
  if (!argv.includes('--quiet')) console.log('[market-index] 已写入 ' + outPath + '（' + manifest.name + '@' + version + '）');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
