/**
 * Hash of everything the workbench bundle is built from. embed.ts records it in app-html.ts, and the
 * root `check:webui` script recomputes it, so CI fails when someone edits the UI source without
 * rebuilding (or hand-edits the generated file).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const INPUTS = ['src', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json', 'scripts/embed.ts', 'scripts/source-hash.ts', '../dsh-plugin/icon.svg'];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name.startsWith('.')) return [];
    const full = path.join(dir, d.name);
    return d.isDirectory() ? walk(full) : [full];
  });
}

export function webuiSourceHash(webuiRoot: string): string {
  const files = INPUTS.flatMap((rel) => {
    const full = path.join(webuiRoot, rel);
    if (!fs.existsSync(full)) return [];
    return fs.statSync(full).isDirectory() ? walk(full) : [full];
  }).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    // Normalise line endings so Windows checkouts produce the same hash.
    hash.update(path.relative(webuiRoot, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
