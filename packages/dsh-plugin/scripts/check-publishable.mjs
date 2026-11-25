#!/usr/bin/env node
// 发布前自检：确认包形态满足 DSH 插件市场的收录条件。
// 用法：node packages/dsh-plugin/scripts/check-publishable.mjs [--pack]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const root = resolve(pkgDir, '..', '..');
const coreDir = resolve(root, 'packages', 'core');

const results = [];
const ok = (label, detail = '') => results.push({ pass: true, label, detail });
const bad = (label, detail = '') => results.push({ pass: false, label, detail });

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const manifestPath = join(pkgDir, 'package.json');
if (!existsSync(manifestPath)) {
  console.error('找不到 packages/dsh-plugin/package.json');
  process.exit(1);
}
const manifest = readJson(manifestPath);
const coreManifest = readJson(join(coreDir, 'package.json'));

// 1. 身份字段
for (const field of ['name', 'version', 'description']) {
  if (typeof manifest[field] === 'string' && manifest[field].trim()) ok('manifest.' + field, manifest[field]);
  else bad('manifest.' + field, '缺失或为空');
}
if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.version)) ok('version 是精确 SemVer', manifest.version);
else bad('version 是精确 SemVer', String(manifest.version));

// 2. 市场展示
const iconPath = manifest.icon ? resolve(pkgDir, manifest.icon) : null;
if (iconPath && existsSync(iconPath) && statSync(iconPath).isFile()) ok('icon 文件存在', manifest.icon);
else bad('icon 文件存在', String(manifest.icon ?? '未声明 icon'));
if (manifest.publishConfig?.access === 'public') ok('publishConfig.access', 'public');
else bad('publishConfig.access', '市场包必须是 public');
if (manifest.repository?.url) ok('repository.url', manifest.repository.url);
else bad('repository.url', '缺失');
if (manifest.homepage) ok('homepage', manifest.homepage);
else bad('homepage', '缺失');

// 3. DSH 清单
const dsh = manifest.dsh ?? {};
const patch = dsh.bundle?.patch ? resolve(pkgDir, dsh.bundle.patch) : null;
if (patch && existsSync(patch)) ok('dsh.bundle.patch 存在', dsh.bundle.patch);
else bad('dsh.bundle.patch 存在', String(dsh.bundle?.patch ?? '未声明'));
const inject = dsh.client?.inject ?? [];
if (inject.length > 0) ok('dsh.client.inject', inject.length + ' 项');
else bad('dsh.client.inject', '为空，客户端不会加载');
if (dsh.client?.platform === 'web') ok('dsh.client.platform', 'web');
else bad('dsh.client.platform', String(dsh.client?.platform ?? '未声明'));
// 宿主 evaluatePluginCompatibility 只读顶层 engines.dsh（或 peerDependencies 里的 @deepseek-ai/dsh*）。
if (typeof manifest.engines?.dsh === 'string' && manifest.engines.dsh) ok('engines.dsh（顶层，宿主读取位置）', manifest.engines.dsh);
else bad('engines.dsh（顶层，宿主读取位置）', '缺失：宿主读不到版本要求时会放行任何 DSH 版本');
if (dsh.engines) bad('不应存在 dsh.engines', '宿主不读这个位置，写了只会造成"已声明门槛"的错觉');
else ok('没有失效的 dsh.engines 副本');

// 3b. 真实宿主判定：找到 @deepseek-ai/dsh-app-boot 时，用宿主自己的函数确认门槛确实生效
const hostDirs = [];
const hostArgIndex = process.argv.indexOf('--host');
if (hostArgIndex >= 0 && process.argv[hostArgIndex + 1]) hostDirs.push(resolve(process.argv[hostArgIndex + 1]));
if (process.env.DSH_HOST_NODE_MODULES) hostDirs.push(resolve(process.env.DSH_HOST_NODE_MODULES));
for (const guess of [
  '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules',
  resolve(root, 'node_modules'),
]) hostDirs.push(guess);
try {
  hostDirs.push(dirname(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-app-boot/package.json'))));
} catch {
  // 常规 node_modules 里没有宿主包：走上面几个候选目录。
}
let hostAppBoot = null;
for (const dir of hostDirs) {
  for (const candidate of [
    join(dir, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'),
    join(dir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'),
  ]) {
    if (existsSync(candidate)) {
      hostAppBoot = candidate;
      break;
    }
  }
  if (hostAppBoot) break;
}
if (!hostAppBoot) {
  ok('宿主兼容性判定', '跳过：未找到 @deepseek-ai/dsh-app-boot，可用 --host <DSH 的 node_modules> 指定');
} else {
  try {
    const { evaluatePluginCompatibility } = await import(pathToFileURL(hostAppBoot).href);
    const tooOld = evaluatePluginCompatibility(manifest, {}, '0.0.0');
    const target = evaluatePluginCompatibility(manifest, {}, '0.2.2-rc.5');
    if (tooOld) ok('宿主拒绝过旧版本', '0.0.0 → 不兼容');
    else bad('宿主拒绝过旧版本', '0.0.0 也被当成兼容：版本门槛没有生效');
    if (target === undefined) ok('宿主接受声明的范围', '0.2.2-rc.5 → 兼容');
    else bad('宿主接受声明的范围', JSON.stringify(target));
  } catch (error) {
    bad('宿主兼容性判定', error instanceof Error ? error.message : String(error));
  }
}

// 4. 入口可解析
for (const [label, rel] of [
  ['main', manifest.main],
  ['exports["."]', manifest.exports?.['.']?.default ?? manifest.exports?.['.']],
  ['exports["./client"]', manifest.exports?.['./client']],
]) {
  const target = typeof rel === 'string' ? rel : rel?.default;
  if (typeof target === 'string' && existsSync(resolve(pkgDir, target))) ok(label + ' 可解析', target);
  else bad(label + ' 可解析', String(target ?? '缺失') + '（先跑 node scripts/build.ts）');
}

// 5. 打包白名单
const files = Array.isArray(manifest.files) ? manifest.files : [];
if (files.length > 0) ok('files 白名单', files.join(', '));
else bad('files 白名单', '缺失：.gitignore 含 **/dist/，缺少白名单会漏打 dist');
for (const need of ['dist', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
  if (files.some(entry => entry === need || entry.startsWith(need + '/'))) ok('files 覆盖 ' + need);
  else bad('files 覆盖 ' + need, '未列入白名单');
}
if (existsSync(join(pkgDir, 'README.md'))) ok('README.md 存在');
else bad('README.md 存在', '市场详情页会读它');

// 6. 依赖闭包：core 必须与插件同版本可发布
const coreRange = manifest.dependencies?.['@accremind/core'];
if (coreRange) ok('依赖 @accremind/core', coreRange);
else bad('依赖 @accremind/core', '缺失');
if (coreRange?.startsWith('workspace:')) {
  ok('workspace 协议', '发布时由 pnpm 替换为 ' + coreManifest.version + '，需先发布 @accremind/core@' + coreManifest.version);
} else if (coreRange !== coreManifest.version && coreRange !== '^' + coreManifest.version) {
  bad('core 版本对齐', coreRange + ' vs core ' + coreManifest.version);
} else {
  ok('core 版本对齐', coreRange);
}
const coreFiles = Array.isArray(coreManifest.files) ? coreManifest.files : [];
if (coreFiles.some(entry => entry.startsWith('dist'))) ok('@accremind/core files 覆盖 dist');
else bad('@accremind/core files 覆盖 dist', 'core 缺 files 白名单会漏打 dist');

// 7. 可选：真实打包检查
if (process.argv.includes('--pack')) {
  try {
    const out = execFileSync(process.execPath, [resolve(root, 'scripts', 'build.ts')], { cwd: root, encoding: 'utf8' });
    ok('build', out.trim().split('\n').pop() ?? '');
  } catch (error) {
    bad('build', error instanceof Error ? error.message : String(error));
  }
  try {
    const out = execFileSync('pnpm', ['pack', '--dry-run', '--json'], { cwd: pkgDir, encoding: 'utf8' });
    const packed = JSON.parse(out);
    const count = packed?.files?.length ?? 0;
    const hasDist = (packed?.files ?? []).some(file => file.path.startsWith('dist/'));
    if (count > 0 && hasDist) ok('pnpm pack 产物', count + ' 个文件，含 dist');
    else bad('pnpm pack 产物', count + ' 个文件，dist ' + (hasDist ? '在' : '缺失'));
  } catch (error) {
    bad('pnpm pack 产物', error instanceof Error ? error.message.split('\n')[0] : String(error));
  }
}

let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log((item.pass ? '  ✓ ' : '  ✗ ') + item.label + (item.detail ? '  — ' + item.detail : ''));
}
console.log('');
console.log(failed === 0 ? '发布形态自检通过（' + results.length + ' 项）' : '发布形态自检失败 ' + failed + ' 项 / 共 ' + results.length + ' 项');
process.exit(failed === 0 ? 0 : 1);
