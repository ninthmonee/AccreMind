import { sha256Hex } from '../codec/atomic-fs.ts';
import type { SymbolAnchor } from '../contracts/types.ts';

/**
 * Strips single-line comments, multi-line block comments, and all whitespace while
 * preserving string / template literals so formatting or comment edits NEVER change
 * the normalized logic hash of an anchored symbol.
 */
export function normalizeCodeForFingerprint(source: string): string {
  let out = '';
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i]!;
    const next = source[i + 1];

    // Line comment //
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && source[i] !== '\n') i += 1;
      continue;
    }

    // Block comment /* ... */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    // Python hash comment # (outside strings)
    if (ch === '#') {
      i += 1;
      while (i < len && source[i] !== '\n') i += 1;
      continue;
    }

    // String or template literal ('...', "...", `...`)
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += quote;
      i += 1;
      while (i < len) {
        const c = source[i]!;
        out += c;
        if (c === '\\') {
          if (i + 1 < len) {
            out += source[i + 1]!;
            i += 2;
            continue;
          }
        }
        i += 1;
        if (c === quote) break;
      }
      continue;
    }

    // Skip all whitespace (spaces, tabs, newlines)
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasUpcomingBodyBraceOnHeader(line: string, fromIdx: number): boolean {
  const rest = line.slice(fromIdx).replace(/\/\/.*$/, '').trim();
  return rest.includes('{') || rest.includes('=>');
}

function findBraceBalancedEndLine(lines: string[], startLineIdx: number): number {
  let parenDepth = 0;
  let bodyDepth = 0;
  let bodyOpened = false;

  for (let lineIdx = startLineIdx; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx]!;
    let i = 0;
    while (i < line.length) {
      const ch = line[i]!;
      const next = line[i + 1];
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < line.length && !(line[i] === '*' && line[i + 1] === '/')) i += 1;
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        i += 1;
        while (i < line.length) {
          if (line[i] === '\\') {
            i += 2;
            continue;
          }
          if (line[i] === quote) {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }

      if (!bodyOpened) {
        if (ch === '(') {
          parenDepth += 1;
          i += 1;
          continue;
        }
        if (ch === ')' && parenDepth > 0) {
          parenDepth -= 1;
          i += 1;
          continue;
        }
        // Ignore object type literals `{ id: string }` inside parameter lists `(...)`
        if (parenDepth > 0) {
          i += 1;
          continue;
        }
      }

      if (ch === '{') {
        bodyDepth += 1;
        bodyOpened = true;
      } else if (ch === '}' && bodyOpened) {
        bodyDepth -= 1;
        if (bodyDepth <= 0) {
          // If still on header line and another `{` or `=>` follows (e.g. `: Promise<{ ok: boolean }> {`),
          // that `{ ... }` belonged to the return type annotation, not the function body!
          if (lineIdx === startLineIdx && hasUpcomingBodyBraceOnHeader(line, i + 1)) {
            bodyOpened = false;
            bodyDepth = 0;
            i += 1;
            continue;
          }
          return lineIdx;
        }
      }
      i += 1;
    }
  }

  return Math.min(startLineIdx + 30, lines.length - 1);
}

function findPythonIndentedEndLine(lines: string[], startLineIdx: number): number {
  const headerLine = lines[startLineIdx] ?? '';
  const baseIndent = headerLine.match(/^\s*/)?.[0].length ?? 0;
  let lastContentLine = startLineIdx;

  for (let idx = startLineIdx + 1; idx < lines.length; idx += 1) {
    const line = lines[idx]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= baseIndent) break;
    lastContentLine = idx;
  }

  return lastContentLine;
}

/**
 * Extracts a function, method (`ClassName.methodName`), arrow function, or class block
 * from source text and computes its comment/whitespace-invariant SHA-256 hash.
 */
export function extractSymbolAnchor(
  filePath: string,
  sourceCode: string,
  symbolName: string,
): SymbolAnchor | null {
  const lines = sourceCode.split(/\r?\n/);
  const parts = symbolName.split(/[.#]/);
  const leafName = parts[parts.length - 1]!;
  const containerName = parts.length > 1 ? parts[0]! : null;

  let searchStartIdx = 0;
  let searchEndIdx = lines.length - 1;

  if (containerName) {
    const classPattern = new RegExp(`\\bclass\\s+${escapeRegExp(containerName)}\\b`);
    const classIdx = lines.findIndex((l) => classPattern.test(l));
    if (classIdx === -1) return null;
    searchStartIdx = classIdx;
    searchEndIdx = /^\s*class\s+.*:\s*$/.test(lines[classIdx]!)
      ? findPythonIndentedEndLine(lines, classIdx)
      : findBraceBalancedEndLine(lines, classIdx);
  }

  const escaped = escapeRegExp(leafName);
  const declPatterns = [
    new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*[<(]`),
    new RegExp(`\\b(?:export\\s+)?class\\s+${escaped}\\b`),
    new RegExp(
      `^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+|readonly\\s+|async\\s+)*${escaped}\\s*[<(].*[){]\\s*$`,
    ),
    new RegExp(
      `\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[a-zA-Z0-9_]+)\\s*=>`,
    ),
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${escaped}\\s*\\(`),
    new RegExp(`^\\s*class\\s+${escaped}\\b.*:\\s*$`),
  ];

  let foundStart = -1;
  let isPython = false;

  for (let idx = searchStartIdx; idx <= searchEndIdx; idx += 1) {
    const line = lines[idx]!;
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
    for (let p = 0; p < declPatterns.length; p += 1) {
      if (declPatterns[p]!.test(line)) {
        foundStart = idx;
        isPython = p >= 4;
        break;
      }
    }
    if (foundStart !== -1) break;
  }

  if (foundStart === -1) return null;

  const foundEnd = isPython
    ? findPythonIndentedEndLine(lines, foundStart)
    : findBraceBalancedEndLine(lines, foundStart);

  const slice = lines.slice(foundStart, foundEnd + 1).join('\n');
  const normalized = normalizeCodeForFingerprint(slice);

  return {
    file_path: filePath,
    symbol_name: symbolName,
    normalized_sha256: sha256Hex(normalized),
    start_line: foundStart + 1,
    end_line: foundEnd + 1,
  };
}

export type SymbolDriftCheckResult =
  | { status: 'unchanged'; anchor: SymbolAnchor }
  | { status: 'relocated'; previous: SymbolAnchor; updated: SymbolAnchor }
  | { status: 'modified'; previous: SymbolAnchor; current: SymbolAnchor }
  | { status: 'missing'; previous: SymbolAnchor };

/**
 * Compares a stored symbol anchor against the updated file source:
 * - Formatting, comments, or edits elsewhere in the file -> `unchanged` or `relocated` (NO false alarm!)
 * - Actual logic change inside the symbol or symbol deletion -> `modified` or `missing` (triggers `review_due`)
 */
export function checkSymbolAnchorDrift(
  previous: SymbolAnchor,
  updatedSourceCode: string,
): SymbolDriftCheckResult {
  const current = extractSymbolAnchor(previous.file_path, updatedSourceCode, previous.symbol_name);
  if (!current) {
    return { status: 'missing', previous };
  }

  if (current.normalized_sha256 === previous.normalized_sha256) {
    if (
      current.start_line === previous.start_line &&
      current.end_line === previous.end_line
    ) {
      return { status: 'unchanged', anchor: current };
    }
    return { status: 'relocated', previous, updated: current };
  }

  return { status: 'modified', previous, current };
}
