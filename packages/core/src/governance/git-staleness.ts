import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256Hex } from '../codec/atomic-fs.ts';
import type { KnowledgeEntry } from '../contracts/types.ts';
import type { LocalMarkdownSqliteStore } from '../store/local-store.ts';
import { satisfiesSemverRange } from '../store/sqlite-schema.ts';
import { checkSymbolAnchorDrift } from '../symbol/symbol-anchor.ts';

export interface StalenessScanReport {
  skippedUnchanged: boolean;
  previousHead: string | null;
  currentHead: string | null;
  relocatedEntries: string[];
  markedReviewDue: Array<{ entryId: string; reason: string }>;
}

function runGitSafe(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function readPackageDependencies(repoRoot: string): {
  deps: Record<string, string>;
  depsHash: string;
} {
  const pkgPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { deps: {}, depsHash: 'none' };
  }
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const merged: Record<string, string> = {
      ...(parsed.devDependencies ?? {}),
      ...(parsed.dependencies ?? {}),
    };
    return { deps: merged, depsHash: sha256Hex(JSON.stringify(merged)) };
  } catch {
    return { deps: {}, depsHash: 'invalid' };
  }
}

/**
 * Symbol-Anchor-Aware Local Git & Semver Staleness Scanner (Optimization #3):
 * - Formatting or adding unrelated functions in a watched file silently updates line offsets (`relocated`)
 *   WITHOUT causing false `review_due` alert fatigue!
 * - Modifying the target symbol's normalized logic body, deleting the file/symbol, or crossing a
 *   dependency semver range immediately marks `freshness = 'review_due'`.
 */
export class GitStalenessScanner {
  private readonly store: LocalMarkdownSqliteStore;

  constructor(store: LocalMarkdownSqliteStore) {
    this.store = store;
  }

  scanWorkspace(): StalenessScanReport {
    const repoRoot = this.store.paths.projectRoot;
    const currentHead = runGitSafe(repoRoot, ['rev-parse', 'HEAD']);
    const { deps, depsHash } = readPackageDependencies(repoRoot);

    const checkpoint = this.store.rawDb
      .prepare('SELECT * FROM workspace_checkpoints WHERE workspace_id = ?')
      .get(this.store.workspaceId) as
      | { last_checked_head: string; package_deps_sha256: string }
      | undefined;

    if (
      checkpoint &&
      currentHead &&
      checkpoint.last_checked_head === currentHead &&
      checkpoint.package_deps_sha256 === depsHash
    ) {
      return {
        skippedUnchanged: true,
        previousHead: checkpoint.last_checked_head,
        currentHead,
        relocatedEntries: [],
        markedReviewDue: [],
      };
    }

    let changedFiles: Set<string> | null = null;
    if (checkpoint?.last_checked_head && currentHead && checkpoint.last_checked_head !== currentHead) {
      const diffOut = runGitSafe(repoRoot, [
        'diff',
        '--name-only',
        checkpoint.last_checked_head,
        currentHead,
      ]);
      if (diffOut !== null) {
        changedFiles = new Set(
          diffOut
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }
    }

    const activeRows = this.store.rawDb
      .prepare(
        `SELECT id FROM entries
         WHERE workspace_id = ? AND status IN ('active', 'probation') AND freshness = 'current'`,
      )
      .all(this.store.workspaceId) as Array<{ id: string }>;

    const relocatedEntries: string[] = [];
    const markedReviewDue: Array<{ entryId: string; reason: string }> = [];
    const now = new Date().toISOString();

    for (const { id } of activeRows) {
      const found = this.store.getEntry(id, {
        recordUsage: false,
        includeHistoryOrSuspended: true,
      });
      if (!found.found || !found.servable) continue;
      const entry = found.entry;

      let reviewDueReason: string | null = null;
      let anchorsRelocated = false;
      const updatedAnchors = [...entry.symbol_anchors];

      // 1. Check time-based review expiration
      if (Date.parse(entry.review_due_at) <= Date.now()) {
        reviewDueReason = `已到达定期复核时间 (${entry.review_due_at})`;
      }

      // 2. Check dependency semver constraints against current package.json
      if (!reviewDueReason && entry.dependency_constraints.length > 0) {
        for (const constraint of entry.dependency_constraints) {
          const installed = deps[constraint.name];
          if (installed && !satisfiesSemverRange(installed, constraint.range)) {
            reviewDueReason = `依赖 ${constraint.name} 当前版本 (${installed}) 超出约束 (${constraint.range})`;
            break;
          }
        }
      }

      // 3. Check symbol anchors with formatting/line-shift immunity!
      if (!reviewDueReason && entry.symbol_anchors.length > 0) {
        for (let i = 0; i < updatedAnchors.length; i += 1) {
          const anchor = updatedAnchors[i]!;
          if (changedFiles && !changedFiles.has(anchor.file_path)) {
            continue;
          }

          const absFile = path.join(repoRoot, anchor.file_path);
          if (!fs.existsSync(absFile)) {
            reviewDueReason = `锚定源码文件已被删除或移动: ${anchor.file_path}`;
            break;
          }

          const sourceText = fs.readFileSync(absFile, 'utf8');
          const drift = checkSymbolAnchorDrift(anchor, sourceText);
          if (drift.status === 'relocated') {
            updatedAnchors[i] = drift.updated;
            anchorsRelocated = true;
          } else if (drift.status === 'modified') {
            reviewDueReason = `锚定符号 ${anchor.symbol_name} (${anchor.file_path}) 内部逻辑已发生变更`;
            break;
          } else if (drift.status === 'missing') {
            reviewDueReason = `锚定符号 ${anchor.symbol_name} 在 ${anchor.file_path} 中已被移除或重命名`;
            break;
          }
        }
      } else if (!reviewDueReason && changedFiles && entry.watch_paths.length > 0) {
        // Fallback path-glob check ONLY for entries that did not bind specific symbol_anchors
        for (const changed of changedFiles) {
          if (entry.watch_paths.some((glob) => path.matchesGlob(changed, glob))) {
            reviewDueReason = `监听路径命中文件变更: ${changed}`;
            break;
          }
        }
      }

      if (reviewDueReason) {
        const updated: KnowledgeEntry = {
          ...entry,
          freshness: 'review_due',
          updated_at: now,
        };
        this.store.updateExistingEntryDirect(updated);
        markedReviewDue.push({ entryId: entry.id, reason: reviewDueReason });
      } else if (anchorsRelocated) {
        const updatedEvidence = entry.evidence.map((ev) => {
          const matchedAnchor = updatedAnchors.find((a) =>
            ev.locator.startsWith(`${a.file_path}#L`),
          );
          if (!matchedAnchor) return ev;
          return {
            ...ev,
            locator: `${matchedAnchor.file_path}#L${matchedAnchor.start_line}-L${matchedAnchor.end_line}`,
          };
        });
        const relocated: KnowledgeEntry = {
          ...entry,
          symbol_anchors: updatedAnchors,
          evidence: updatedEvidence,
          updated_at: now,
        };
        this.store.updateExistingEntryDirect(relocated);
        relocatedEntries.push(entry.id);
      }
    }

    if (currentHead) {
      this.store.rawDb
        .prepare(
          `INSERT OR REPLACE INTO workspace_checkpoints (
            workspace_id, repo_root, last_checked_head, package_deps_sha256, checked_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(this.store.workspaceId, repoRoot, currentHead, depsHash, now);
    }

    return {
      skippedUnchanged: false,
      previousHead: checkpoint?.last_checked_head ?? null,
      currentHead,
      relocatedEntries,
      markedReviewDue,
    };
  }
}
