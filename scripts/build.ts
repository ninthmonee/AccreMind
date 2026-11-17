import * as fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['packages/core', 'packages/dsh-plugin'];

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

// Zero-dependency TypeScript -> ESM JavaScript build pipeline powered by Node 24's
// built-in `module.stripTypeScriptTypes`. Rewrites relative `.ts` specifiers to `.js`
// so compiled `dist/index.js` bundles can be loaded by any standard ESM / DSH host.
function buildPackage(pkgRelDir: string): number {
  const pkgDir = path.join(ROOT_DIR, pkgRelDir);
  const srcDir = path.join(pkgDir, 'src');
  const distDir = path.join(pkgDir, 'dist');

  fs.rmSync(distDir, { recursive: true, force: true });
  const tsFiles = collectTsFiles(srcDir);

  for (const tsFile of tsFiles) {
    const rel = path.relative(srcDir, tsFile);
    const outJsFile = path.join(distDir, rel.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(outJsFile), { recursive: true });

    const rawSource = fs.readFileSync(tsFile, 'utf8');
    const stripped = stripTypeScriptTypes(rawSource, { mode: 'strip' });

    // Rewrite relative `.ts` import/export specifiers to `.js` for standard ESM resolution
    const rewritten = stripped.replace(
      /((?:from|import)\s+['"])(\.\.?\/[^'"]+)\.ts(['"])/g,
      '$1$2.js$3',
    );

    fs.writeFileSync(outJsFile, rewritten, 'utf8');
  }

  return tsFiles.length;
}

let totalCompiled = 0;
const start = Date.now();
for (const pkg of PACKAGES) {
  totalCompiled += buildPackage(pkg);
}
console.log(
  `[AccreMind Build] Compiled ${totalCompiled} TypeScript files to ESM dist/ in ${Date.now() - start}ms.`,
);
