import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SymbolAnchor } from '../contracts/types.ts';
import { extractSymbolAnchor } from '../symbol/symbol-anchor.ts';
import {
  enforceCapturePayloadLimit,
  isSensitiveFilePath,
  redactSensitiveText,
} from './secret-redactor.ts';

export interface FileSnapshotSlice {
  relPath: string;
  totalLines: number;
  snippet: string;
}

export interface DocSnapshotSlice {
  relPath: string;
  snippet: string;
}

export interface CollectedEvidenceBundle {
  headCommit: string;
  sourceRef: string;
  sourceType: 'git_commit' | 'session_turn';
  rawCandidateContext: string;
  touchedFiles: string[];
  codeSlices: FileSnapshotSlice[];
  docSlices: DocSnapshotSlice[];
  detectedSymbols: SymbolAnchor[];
}

function getGitHeadSafe(repoRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'uncommitted';
  }
}

function guessPrimarySymbolNames(sourceCode: string): string[] {
  const names = new Set<string>();
  const classMatch = /\bclass\s+([A-Za-z0-9_]+)/g;
  const fnMatch = /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = classMatch.exec(sourceCode)) !== null) {
    names.add(m[1]!);
  }
  while ((m = fnMatch.exec(sourceCode)) !== null) {
    names.add(m[1]!);
  }
  return [...names].slice(0, 4);
}

function collectAuthoritativeDocs(repoRoot: string, maxDocs = 4): DocSnapshotSlice[] {
  const candidates = ['README.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md'];
  const adrDirs = ['docs/adr', 'docs/decisions', 'adr'];

  for (const relDir of adrDirs) {
    const absDir = path.join(repoRoot, relDir);
    if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
      const files = fs
        .readdirSync(absDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .slice(0, 5);
      for (const f of files) {
        candidates.push(path.posix.join(relDir, f));
      }
    }
  }

  const slices: DocSnapshotSlice[] = [];
  for (const rel of candidates) {
    if (slices.length >= maxDocs) break;
    if (isSensitiveFilePath(rel)) continue;
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const raw = fs.readFileSync(abs, 'utf8').slice(0, 3000);
    slices.push({
      relPath: rel,
      snippet: redactSensitiveText(raw).redactedText,
    });
  }
  return slices;
}

/**
 * Automatically gathers sanitized current workspace code snapshots, authoritative docs,
 * HEAD commit SHA, and symbol anchors for `DeltaAssessor` without manual user copy-pasting.
 */
export function collectEvidenceBundle(options: {
  repoRoot: string;
  touchedFiles: string[];
  rawCandidateContext: string;
  sourceType: 'git_commit' | 'session_turn';
  sourceRef?: string;
  explicitSymbols?: Array<{ filePath: string; symbolName: string }>;
}): CollectedEvidenceBundle {
  const repoRoot = path.resolve(options.repoRoot);
  const headCommit = getGitHeadSafe(repoRoot);
  const safeFiles = options.touchedFiles
    .map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((f) => f.length > 0 && !f.startsWith('..') && !isSensitiveFilePath(f))
    .slice(0, 8);

  const codeSlices: FileSnapshotSlice[] = [];
  const detectedSymbols: SymbolAnchor[] = [];

  for (const relFile of safeFiles) {
    const absFile = path.join(repoRoot, relFile);
    if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) continue;
    const rawCode = fs.readFileSync(absFile, 'utf8');
    const lines = rawCode.split(/\r?\n/);
    const capped = lines.slice(0, 160).join('\n');
    codeSlices.push({
      relPath: relFile,
      totalLines: lines.length,
      snippet: redactSensitiveText(capped).redactedText,
    });

    const explicitForFile = (options.explicitSymbols ?? []).filter((s) => s.filePath === relFile);
    if (explicitForFile.length > 0) {
      for (const spec of explicitForFile) {
        const anchor = extractSymbolAnchor(relFile, rawCode, spec.symbolName);
        if (anchor) detectedSymbols.push(anchor);
      }
    } else {
      for (const guessed of guessPrimarySymbolNames(rawCode)) {
        const anchor = extractSymbolAnchor(relFile, rawCode, guessed);
        if (anchor) detectedSymbols.push(anchor);
      }
    }
  }

  const docSlices = collectAuthoritativeDocs(repoRoot);
  const redactedRaw = redactSensitiveText(options.rawCandidateContext).redactedText;
  const boundedRaw = enforceCapturePayloadLimit(redactedRaw).content;

  return {
    headCommit,
    sourceRef: options.sourceRef ?? headCommit,
    sourceType: options.sourceType,
    rawCandidateContext: boundedRaw,
    touchedFiles: safeFiles,
    codeSlices,
    docSlices,
    detectedSymbols,
  };
}
