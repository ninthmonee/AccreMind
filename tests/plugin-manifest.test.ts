import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(root, 'packages', 'dsh-plugin');
const coreDir = path.join(root, 'packages', 'core');

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const manifest = readJson(path.join(pluginDir, 'package.json'));
const coreManifest = readJson(path.join(coreDir, 'package.json'));
const index = readJson(path.join(root, 'market', 'index.json'));

function resolveExport(target: unknown): string | null {
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object' && typeof (target as any).default === 'string') return (target as any).default;
  return null;
}

describe('plugin market manifest', () => {
  it('声明了市场必需的展示元数据', () => {
    assert.equal(manifest.name, '@accremind/dsh-plugin');
    assert.match(manifest.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    assert.ok(manifest.description.length > 20);
    assert.equal(manifest.publishConfig?.access, 'public');
    assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length >= 3);
    assert.match(manifest.homepage, /^https:\/\//);
    assert.match(manifest.repository?.url, /^https:\/\//);
    assert.equal(manifest.repository?.directory, 'packages/dsh-plugin');
  });

  it('图标与 README 真实存在', () => {
    assert.equal(manifest.icon, 'icon.svg');
    const icon = fs.readFileSync(path.join(pluginDir, manifest.icon), 'utf8');
    assert.match(icon, /^<svg[\s>]/);
    assert.ok(fs.statSync(path.join(pluginDir, 'README.md')).size > 500);
  });

  it('DSH 清单能被宿主解析', () => {
    assert.equal(manifest.dsh?.client?.platform, 'web');
    assert.match(manifest.dsh?.engines?.dsh ?? '', /^>=/);
    assert.ok(fs.existsSync(path.join(pluginDir, manifest.dsh.bundle.patch)));
    const inject: string[] = manifest.dsh.client.inject;
    for (const service of [
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-connection',
    ]) {
      assert.ok(inject.includes(service), '缺少 client 服务声明：' + service);
    }
  });

  it('每个 exports 目标都指向真实文件', () => {
    const targets: Array<[string, string | null]> = [
      ['main', resolveExport(manifest.main)],
      ['exports[.]', resolveExport(manifest.exports?.['.'])],
      ['exports[./client]', resolveExport(manifest.exports?.['./client'])],
      ['exports[./webui]', resolveExport(manifest.exports?.['./webui'])],
      ['bin.accremind', resolveExport(manifest.bin?.accremind)],
    ];
    for (const [label, target] of targets) {
      assert.ok(target, label + ' 缺失');
      assert.ok(fs.existsSync(path.join(pluginDir, target!)), label + ' 指向的文件不存在：' + target);
    }
  });

  it('files 白名单覆盖 dist，避免被 .gitignore 吞掉', () => {
    const files: string[] = manifest.files;
    assert.ok(Array.isArray(files) && files.length > 0);
    for (const need of ['dist', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
      assert.ok(files.some(entry => entry === need || entry.startsWith(need + '/')), '未列入 files：' + need);
    }
    const coreFiles: string[] = coreManifest.files;
    assert.ok(coreFiles.some(entry => entry.startsWith('dist')), '@accremind/core 也需要 files 白名单');
    assert.ok(fs.existsSync(path.join(coreDir, 'dist', 'index.js')));
  });

  it('core 依赖在本地是 workspace 协议，发布时由 pnpm 改写', () => {
    assert.equal(manifest.dependencies['@accremind/core'], 'workspace:*');
    assert.equal(coreManifest.name, '@accremind/core');
    assert.equal(coreManifest.publishConfig?.access, 'public');
  });
});

describe('market index format 1', () => {
  const plugin = index.plugins?.[0];

  it('顶层结构符合 format 1', () => {
    assert.equal(index.format, 1);
    assert.equal(typeof index.title?.en, 'string', 'LocalizedText 必须带 en');
    assert.ok(Array.isArray(index.plugins) && index.plugins.length === 1);
    assert.ok(index.metadata?.categories && index.metadata?.labels && index.metadata?.sortKeys);
  });

  it('插件条目与包清单一致', () => {
    assert.equal(plugin.name, manifest.name);
    assert.equal(plugin.metadata.category, 'knowledge');
    assert.equal(plugin.repository.directory, 'packages/dsh-plugin');
    assert.match(plugin.repository.url, /^https:\/\//);
    assert.doesNotMatch(plugin.repository.url, /\.git$/);
    assert.equal(plugin.versions.length, 1);
    assert.equal(plugin.versions[0].version, manifest.version);
    assert.equal(plugin.versions[0].engines.dsh, manifest.dsh.engines.dsh);
  });

  it('版本源与发布时间可用', () => {
    const version = plugin.versions[0];
    assert.equal(version.source.type, 'npm');
    assert.ok(Number.isInteger(version.publishTimestamp) && version.publishTimestamp > 0);
    assert.match(plugin.icon, /^https:\/\//);
  });

  it('category / labels / sortKeys 都在索引里声明过', () => {
    assert.ok(index.metadata.categories[plugin.metadata.category], '未声明的 category：' + plugin.metadata.category);
    for (const label of plugin.metadata.labels) {
      assert.ok(index.metadata.labels[label], '未声明的 label：' + label);
    }
    for (const [key, value] of Object.entries(plugin.metadata.sortKeys)) {
      assert.ok(index.metadata.sortKeys[key], '未声明的 sortKey：' + key);
      assert.equal(typeof value, 'number');
    }
  });

  it('索引可以由生成器复现，不会漂移', async () => {
    const module = await import(path.join(pluginDir, 'scripts', 'market-index.mjs'));
    const rebuilt = module.buildMarketIndex({
      manifest: { ...manifest, version: plugin.versions[0].version },
      timestamp: plugin.versions[0].publishTimestamp,
      iconUrl: plugin.icon,
    });
    assert.deepEqual(rebuilt, index);
  });
});
