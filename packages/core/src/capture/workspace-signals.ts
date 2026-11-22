import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** What the working tree says about the task before the agent has touched anything. */
export interface WorkspaceSignals {
  /** Files with uncommitted changes (most recently modified first). */
  changedFiles: string[];
  branch: string | null;
  /** Words from the branch name (`feature/refund-partial` → `refund partial`), empty for main/master/etc. */
  branchHint: string;
  /** Subject of the last commit. */
  lastCommit: string | null;
}

const GENERIC_BRANCH = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'head', 'release', 'staging', 'prod', 'production']);
const BRANCH_PREFIX = new Set(['feature', 'feat', 'fix', 'bugfix', 'hotfix', 'chore', 'refactor', 'release', 'test', 'tests', 'wip', 'dev', 'users', 'user']);

export function branchHint(branch: string | null): string {
  if (!branch || GENERIC_BRANCH.has(branch.toLowerCase())) return '';
  const parts = branch.split(/[/_\-.]+/).filter(Boolean);
  return parts.filter((p, i) => !(i === 0 && BRANCH_PREFIX.has(p.toLowerCase())) && !/^\d+$/.test(p)).join(' ').trim();
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/**
 * Reads the working tree's state for the first turns of a session (the host sends only the user's text).
 * Cached until `.git/index` or `.git/HEAD` changes, and for at most a few seconds, so it costs one `git`
 * call per change, not per turn.
 */
export class WorkspaceSignalReader {
  private readonly root: string;
  private cache: { key: string; at: number; value: WorkspaceSignals } | null = null;

  constructor(root: string) {
    this.root = root;
  }

  private stamp(): string {
    const parts: string[] = [];
    for (const f of ['index', 'HEAD']) {
      try {
        parts.push(String(fs.statSync(path.join(this.root, '.git', f)).mtimeMs));
      } catch {
        parts.push('-');
      }
    }
    return parts.join('|');
  }

  read(maxAgeMs = 5000): WorkspaceSignals {
    const key = this.stamp();
    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < maxAgeMs) return this.cache.value;
    const status = git(this.root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']) ?? '';
    const files: string[] = [];
    const entries = status.split('\0').filter(Boolean);
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i]!;
      const code = e.slice(0, 2);
      const file = e.slice(3);
      if (code.startsWith('R') || code.startsWith('C')) i += 1; // rename: next item is the old path
      if (!file || file.startsWith('.accremind/') || file.endsWith('/')) continue;
      files.push(file);
    }
    const mtime = (f: string) => {
      try {
        return fs.statSync(path.join(this.root, f)).mtimeMs;
      } catch {
        return 0;
      }
    };
    const changedFiles = files.slice(0, 200).sort((a, b) => mtime(b) - mtime(a)).slice(0, 20);
    const branch = git(this.root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || null;
    const lastCommit = git(this.root, ['log', '-1', '--format=%s'])?.trim() || null;
    const value: WorkspaceSignals = { changedFiles, branch: branch === 'HEAD' ? null : branch, branchHint: branchHint(branch), lastCommit };
    this.cache = { key, at: Date.now(), value };
    return value;
  }
}
