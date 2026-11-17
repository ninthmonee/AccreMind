import { execFileSync } from 'node:child_process';

export interface ArchaeologyCommitCandidate {
  commitSha: string;
  committedAtIso: string;
  subject: string;
  body: string;
  touchedFiles: string[];
  hasCoModifiedTest: boolean;
  rapidFixClusterFiles: string[];
  signalScore: number;
  signalReasons: string[];
  diffPreview: string;
}

export interface BootstrapScanOptions {
  repoRoot: string;
  maxCommitsToScan?: number;
  topK?: number;
  rapidFixWindowHours?: number;
}

const HIGH_SIGNAL_KEYWORDS =
  /\b(revert|hotfix|workaround|race(?:\s+condition)?|deadlock|idempoten\w*|rollback|order|compat\w*)\b|(回滚|踩坑|竞态|死锁|幂等|时序|兼容|防重|事务|兜底)/i;

const FIX_COMMIT_REGEX = /^(?:fix|hotfix|revert|bugfix)(?:\([^)]+\))?!?:/i;
const TEST_FILE_REGEX = /\.(?:test|spec)\.[cm]?[jt]sx?$|__tests__\//i;
const IGNORED_LOCK_OR_ASSET_REGEX =
  /(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|\.snap$|\.png$|\.svg$)/i;

function execGit(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Optimization #2: Git Archaeology Cold-Start Miner (`accremind bootstrap`).
 * Deterministically mines high-signal historical commits (reverts, race conditions,
 * workarounds, rapid 48h repeat-fixes, and bugfixes backed by regression tests)
 * with ZERO LLM tokens required during the discovery phase!
 */
export function scanGitHistorySignals(
  options: BootstrapScanOptions,
): ArchaeologyCommitCandidate[] {
  const maxCommits = options.maxCommitsToScan ?? 200;
  const topK = options.topK ?? 20;
  const windowMs = (options.rapidFixWindowHours ?? 48) * 3600 * 1000;

  let rawLog = '';
  try {
    rawLog = execGit(options.repoRoot, [
      'log',
      `-n`,
      String(maxCommits),
      '--no-merges',
      '--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1f',
      '--name-only',
    ]);
  } catch {
    return [];
  }

  interface ParsedCommit {
    sha: string;
    iso: string;
    ts: number;
    subject: string;
    body: string;
    files: string[];
  }

  const parsedCommits: ParsedCommit[] = [];
  const records = rawLog.split('\x1e').filter((chunk) => chunk.trim().length > 0);

  for (const rec of records) {
    const parts = rec.split('\x1f');
    if (parts.length < 5) continue;
    const sha = parts[0]!.trim();
    const iso = parts[1]!.trim();
    const subject = parts[2]!.trim();
    const body = parts[3]!.trim();
    const filesRaw = parts.slice(4).join('\n');
    const files = filesRaw
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && !IGNORED_LOCK_OR_ASSET_REGEX.test(f));

    if (files.length === 0 || files.length > 30) continue;

    parsedCommits.push({
      sha,
      iso,
      ts: Date.parse(iso),
      subject,
      body,
      files,
    });
  }

  // Track timestamps of fix-like commits per file to spot 48h rapid-fix clusters
  const fileFixTimestamps = new Map<string, number[]>();
  for (const c of parsedCommits) {
    if (FIX_COMMIT_REGEX.test(c.subject) || HIGH_SIGNAL_KEYWORDS.test(c.subject)) {
      for (const f of c.files) {
        if (TEST_FILE_REGEX.test(f)) continue;
        const arr = fileFixTimestamps.get(f) ?? [];
        arr.push(c.ts);
        fileFixTimestamps.set(f, arr);
      }
    }
  }

  const candidates: ArchaeologyCommitCandidate[] = [];

  for (const c of parsedCommits) {
    let score = 0;
    const reasons: string[] = [];
    const combinedMsg = `${c.subject}\n${c.body}`;

    if (HIGH_SIGNAL_KEYWORDS.test(combinedMsg)) {
      score += 3;
      reasons.push('提交说明命中强工程经验信号词（回滚/竞态/幂等/时序/绕行方案）');
    } else if (FIX_COMMIT_REGEX.test(c.subject)) {
      score += 1;
      reasons.push('缺陷修复提交');
    }

    const rapidClusterFiles: string[] = [];
    for (const f of c.files) {
      const timestamps = fileFixTimestamps.get(f);
      if (!timestamps || timestamps.length < 2) continue;
      const nearbyCount = timestamps.filter((otherTs) => Math.abs(otherTs - c.ts) <= windowMs).length;
      if (nearbyCount >= 2) {
        rapidClusterFiles.push(f);
      }
    }

    if (rapidClusterFiles.length > 0) {
      score += 3;
      reasons.push(`48h 快速返工热区文件: ${rapidClusterFiles.slice(0, 3).join(', ')}`);
    }

    const hasTest = c.files.some((f) => TEST_FILE_REGEX.test(f));
    const hasProdCode = c.files.some((f) => !TEST_FILE_REGEX.test(f));
    if (hasTest && hasProdCode && score > 0) {
      score += 2;
      reasons.push('同时包含业务代码修复与回归测试证据');
    }

    if (score < 3) continue;

    let diffPreview = '';
    try {
      diffPreview = execGit(options.repoRoot, [
        'show',
        '--stat',
        '--patch',
        '--unified=2',
        c.sha,
      ]).slice(0, 6000);
    } catch {
      diffPreview = '';
    }

    candidates.push({
      commitSha: c.sha,
      committedAtIso: c.iso,
      subject: c.subject,
      body: c.body,
      touchedFiles: c.files,
      hasCoModifiedTest: hasTest && hasProdCode,
      rapidFixClusterFiles: rapidClusterFiles,
      signalScore: score,
      signalReasons: reasons,
      diffPreview,
    });
  }

  candidates.sort((a, b) => b.signalScore - a.signalScore || b.committedAtIso.localeCompare(a.committedAtIso));
  return candidates.slice(0, topK);
}
