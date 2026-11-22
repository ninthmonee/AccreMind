import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomicSync } from '../codec/atomic-fs.ts';
import { withFileLock } from '../codec/file-lock.ts';

export interface CrossRepoSignal {
  repo: string;
  revision: number;
  kind: 'inapplicable' | 'success' | 'failure';
  session: string;
  at: string;
}

/** One line of a compacted file: every signal of one kind from one repository on one revision. */
interface CompactedSignal {
  repo: string;
  revision: number;
  kind: CrossRepoSignal['kind'];
  /** Distinct sessions (capped; `count` keeps the true number). */
  sessions: string[];
  count: number;
  at: string;
}

/** A repository stops being shown an entry after this many distinct sessions there said it does not apply. */
export const REPO_SUPPRESS_SESSIONS = 2;
/** A cross-repository entry is paused everywhere only when this many repositories suppressed it (and none confirmed it). */
export const GLOBAL_SUSPEND_REPOS = 2;
/** A file is compacted when it grows past this size (appends stay O(1); reads stay small). */
export const FEEDBACK_COMPACT_BYTES = 32 * 1024;
const MAX_SESSIONS_KEPT = 20;

/**
 * Append-only, machine-wide record of how shared entries (domain, shared-tech, personal) fared in each
 * repository (`~/.dsh/accremind/feedback/<entry>.ndjson`). Per-repository state cannot see other
 * repositories, so this is where "doesn't apply here" in one repository is told apart from "wrong everywhere".
 *
 * Files are compacted: older revisions are dropped and each (repository, revision, kind) becomes one line,
 * so a busy entry's file stays small however long it is used.
 */
export class CrossRepoFeedback {
  readonly dir: string;
  private readonly locksDir: string;

  constructor(dir: string, locksDir = path.join(path.dirname(dir), 'locks')) {
    this.dir = dir;
    this.locksDir = locksDir;
  }

  private safe(entryId: string): string {
    return entryId.replace(/[^A-Za-z0-9_-]/g, '_');
  }

  private file(entryId: string): string {
    return path.join(this.dir, `${this.safe(entryId)}.ndjson`);
  }

  private lock<T>(entryId: string, fn: () => T): T {
    return withFileLock(path.join(this.locksDir, `feedback-${this.safe(entryId)}.lock`), fn, { waitMs: 2000 });
  }

  append(entryId: string, signal: Omit<CrossRepoSignal, 'at'> & { at?: string }): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const line = JSON.stringify({ ...signal, at: signal.at ?? new Date().toISOString() });
    this.lock(entryId, () => fs.appendFileSync(this.file(entryId), `${line}\n`, { encoding: 'utf8', mode: 0o600 }));
    try {
      if (fs.statSync(this.file(entryId)).size > FEEDBACK_COMPACT_BYTES) this.compact(entryId, signal.revision);
    } catch {
      // compaction is housekeeping; the signal is recorded
    }
  }

  /** Raw and compacted lines, aggregated per (repo, revision, kind). */
  private aggregate(entryId: string): CompactedSignal[] {
    let raw = '';
    try {
      raw = fs.readFileSync(this.file(entryId), 'utf8');
    } catch {
      return [];
    }
    const groups = new Map<string, { repo: string; revision: number; kind: CrossRepoSignal['kind']; at: string; set: Set<string>; extra: number }>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec: Partial<CompactedSignal & CrossRepoSignal>;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // a torn last line from a crash is skipped
      }
      if (!rec.repo || !rec.kind || typeof rec.revision !== 'number') continue;
      const key = `${rec.repo}\u0000${rec.revision}\u0000${rec.kind}`;
      let g = groups.get(key);
      if (!g) {
        g = { repo: rec.repo, revision: rec.revision, kind: rec.kind, at: rec.at ?? '', set: new Set(), extra: 0 };
        groups.set(key, g);
      }
      if (Array.isArray(rec.sessions)) {
        for (const sess of rec.sessions) g.set.add(String(sess));
        // Sessions beyond the kept list are carried as a number.
        g.extra += Math.max(0, (rec.count ?? rec.sessions.length) - rec.sessions.length);
      } else if (rec.session) {
        g.set.add(rec.session);
      }
      if ((rec.at ?? '') > g.at) g.at = rec.at ?? g.at;
    }
    return [...groups.values()].map((g) => {
      const sessions = [...g.set];
      const kept = sessions.slice(-MAX_SESSIONS_KEPT);
      return { repo: g.repo, revision: g.revision, kind: g.kind, at: g.at, sessions: kept, count: sessions.length + g.extra };
    });
  }

  read(entryId: string, revision?: number): CompactedSignal[] {
    const all = this.aggregate(entryId);
    return revision === undefined ? all : all.filter((g) => g.revision === revision);
  }

  /**
   * Rewrites a file as one line per (repository, revision, kind), keeping only revisions at or after
   * `keepFromRevision` (signals about wording that no longer exists are moot). Returns lines before/after.
   */
  compact(entryId: string, keepFromRevision = 0): { before: number; after: number } {
    return this.lock(entryId, () => {
      const file = this.file(entryId);
      let before = 0;
      try {
        before = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
      } catch {
        return { before: 0, after: 0 };
      }
      const kept = this.aggregate(entryId).filter((g) => g.revision >= keepFromRevision);
      if (!kept.length) {
        fs.rmSync(file, { force: true });
        return { before, after: 0 };
      }
      writeFileAtomicSync(file, kept.map((g) => JSON.stringify(g)).join('\n') + '\n');
      return { before, after: kept.length };
    });
  }

  entryIds(): string[] {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, -'.ndjson'.length));
    } catch {
      return [];
    }
  }

  /** Per-repository standing of one revision. */
  standing(entryId: string, revision: number): {
    suppressedRepos: string[];
    successRepos: string[];
    failureRepos: string[];
    inapplicableSessionsByRepo: Record<string, number>;
    shouldSuspendGlobally: boolean;
  } {
    const bySession: Record<string, number> = {};
    const success = new Set<string>();
    const failure = new Set<string>();
    for (const g of this.read(entryId, revision)) {
      if (g.kind === 'inapplicable') bySession[g.repo] = (bySession[g.repo] ?? 0) + g.count;
      else if (g.kind === 'success') success.add(g.repo);
      else if (g.kind === 'failure') failure.add(g.repo);
    }
    const suppressedRepos = Object.entries(bySession).filter(([, n]) => n >= REPO_SUPPRESS_SESSIONS).map(([r]) => r);
    return {
      suppressedRepos,
      successRepos: [...success],
      failureRepos: [...failure],
      inapplicableSessionsByRepo: bySession,
      shouldSuspendGlobally: failure.size > 0 || (suppressedRepos.length >= GLOBAL_SUSPEND_REPOS && success.size === 0),
    };
  }
}
