/**
 * Fails when packages/dsh-plugin/src/webui/app-html.ts was not rebuilt from the current UI source.
 * Run `pnpm build:webui` and commit app-html.ts to fix.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webuiSourceHash } from '../packages/webui/scripts/source-hash.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generated = fs.readFileSync(path.join(root, 'packages/dsh-plugin/src/webui/app-html.ts'), 'utf8');
const recorded = /webui-source-sha256: ([0-9a-f]+)/.exec(generated)?.[1];
const actual = webuiSourceHash(path.join(root, 'packages/webui'));
if (recorded !== actual) {
  console.error(`[check:webui] 工作台产物与源码不一致（记录 ${recorded ?? '无'}，当前 ${actual}）。请运行 pnpm build:webui 并提交 app-html.ts。`);
  process.exit(1);
}
console.log(`[check:webui] 产物与源码一致（${actual}）`);
