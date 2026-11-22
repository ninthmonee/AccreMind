/**
 * 把 Vite 单文件产物转成 dsh-plugin 可直接引用的 TS 模块（src/webui/app-html.ts）。
 *
 * - 模块脚本改为普通 <script> 并包进 IIFE：DSH 以 sandbox iframe + srcdoc 打开工作台，
 *   本地服务器的 CSP 也只放行内联脚本，普通脚本在两处行为一致；
 * - 脚本移到 </body> 前，保证执行时 #root 已存在，且始终是页面里最后一个 <script>；
 * - 产物不得引用 Node 内置模块或原生 alert/prompt（与插件测试的约束一致）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { webuiSourceHash } from './source-hash.ts';

const root = path.resolve(import.meta.dirname, '..');
const distHtml = path.join(root, 'dist', 'index.html');
const target = path.resolve(root, '../dsh-plugin/src/webui/app-html.ts');

let html = fs.readFileSync(distHtml, 'utf8');
const scripts: string[] = [];
html = html.replace(/<script type="module"[^>]*>([\s\S]*?)<\/script>/g, (_m, code: string) => {
  scripts.push(code);
  return '';
});
if (scripts.length !== 1) throw new Error(`期望 1 段应用脚本，实际 ${scripts.length} 段`);

// 代码里的 "<script" 字面量（React 用于创建 script 节点）改写为 \x3C 转义：既避免提前闭合标签，
// 也保证应用脚本始终是页面里最后一个 <script> 起始标记。
const code = scripts[0]!.replace(/<(\/?)script/gi, '\\x3C$1script');
if (/import\.meta|\bimport\s*\(/.test(code)) throw new Error('产物包含模块专属语法，无法作为普通脚本运行');
for (const banned of ['node:fs', 'node:sqlite']) {
  if (code.includes(banned)) throw new Error(`产物不应引用 ${banned}`);
}

// 用函数作替换值：压缩后的代码里常见 $& / $` 之类序列，字符串替换会把它们当成特殊模式展开。
const appScript = `<script>(function(){"use strict";\n${code}\n})();</script>\n</body>`;
html = html.replace('</body>', () => appScript);

const banner = `// 由 packages/webui 构建生成（pnpm build:webui），请勿手改。\n// webui-source-sha256: ${webuiSourceHash(root)}\n`;
fs.writeFileSync(target, `${banner}export const ACCREMIND_APP_HTML: string = ${JSON.stringify(html)};\n`, 'utf8');
console.log(`[webui] 已写入 ${path.relative(process.cwd(), target)}（${(html.length / 1024).toFixed(0)} KB）`);
