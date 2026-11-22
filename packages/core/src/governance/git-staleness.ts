import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactSensitiveText } from '../capture/secret-redactor.ts';
import { sha256Hex } from '../codec/atomic-fs.ts';
import { transition } from './lifecycle.ts';
import type { KnowledgeEntry } from '../contracts/types.ts';
import type { LocalMarkdownSqliteStore } from '../store/local-store.ts';
import { satisfiesSemverRange } from '../store/sqlite-schema.ts';
import { checkSymbolAnchorDrift, extractSymbolAnchor } from '../symbol/symbol-anchor.ts';

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

  private anchorFile(relativePath: string): string | null {
    const root = fs.realpathSync(this.store.paths.projectRoot);
    try {
      const resolved = fs.realpathSync(path.resolve(root, relativePath));
      return resolved.startsWith(root + path.sep) && fs.statSync(resolved).isFile()
        ? resolved
        : null;
    } catch {
      return null;
    }
  }

  reviewDetails(entry: KnowledgeEntry) {
    const root = this.store.paths.projectRoot;
    const review = this.store.rawDb
      .prepare(
        `SELECT reason, previous_head, affected_paths FROM freshness_reviews
      WHERE workspace_id = ? AND entry_id = ?`,
      )
      .get(this.store.workspaceId, entry.id) as
      | { reason: string; previous_head: string | null; affected_paths: string }
      | undefined;
    const captured =
      entry.capture_assessment_id &&
      this.store.getAssessment(entry.capture_assessment_id)?.checked_context.head_commit;
    const previousHead =
      review?.previous_head ?? (captured && /^[0-9a-f]{7,64}$/i.test(captured) ? captured : null);
    const currentHead = runGitSafe(root, ['rev-parse', 'HEAD']);
    const files: string[] = review
      ? JSON.parse(review.affected_paths)
      : entry.symbol_anchors.map((a) => a.file_path);
    const diff =
      previousHead && files.length
        ? runGitSafe(root, [
            '--literal-pathspecs',
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            previousHead,
            '--',
            ...files,
          ])
        : null;
    const anchors = this.currentAnchors(entry);
    const decision = this.store.rawDb
      .prepare(
        `SELECT action, reason FROM governance_decisions
      WHERE workspace_id = ? AND entry_id = ? AND action IN ('stale','request_review')
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(this.store.workspaceId, entry.id) as { action: string; reason: string } | undefined;
    const decisionReason =
      (entry.freshness === 'stale' && decision?.action === 'stale') ||
      (!review && entry.freshness === 'review_due' && decision?.action === 'request_review')
        ? decision.reason
        : undefined;
    return {
      reason: decisionReason ?? review?.reason ?? '该条目已记录为待复核，缺少原巡检详情',
      previousHead,
      baselineCommit: previousHead,
      currentHead,
      diff: (diff ?? '').slice(0, 24000),
      truncated: (diff?.length ?? 0) > 24000,
      anchorIssues: anchors.issues,
      reviewToken: sha256Hex(
        JSON.stringify([entry.revision, entry.freshness, previousHead, currentHead, diff, anchors]),
      ),
    };
  }

  private currentAnchors(entry: KnowledgeEntry) {
    const issues: string[] = [];
    const anchors = entry.symbol_anchors.map((anchor) => {
      const source = this.anchorFile(anchor.file_path);
      const updated =
        source &&
        extractSymbolAnchor(anchor.file_path, fs.readFileSync(source, 'utf8'), anchor.symbol_name);
      if (!updated)
        issues.push(`找不到锚点 ${anchor.file_path} · ${anchor.symbol_name}，请先修订绑定`);
      return updated || anchor;
    });
    const { deps } = readPackageDependencies(this.store.paths.projectRoot);
    for (const rule of entry.dependency_constraints) {
      if (deps[rule.name] && !satisfiesSemverRange(deps[rule.name]!, rule.range)) {
        issues.push(
          `当前依赖 ${rule.name}@${deps[rule.name]} 超出 ${rule.range}，请先修订适用版本`,
        );
      }
    }
    return { anchors, issues };
  }

  readAnchor(entry: KnowledgeEntry, filePath: string, symbolName: string) {
    const anchor = entry.symbol_anchors.find(
      (a) => a.file_path === filePath && a.symbol_name === symbolName,
    );
    if (!anchor) throw new Error('当前条目中找不到此锚点');
    const location = this.anchorFile(filePath);
    if (!location) throw new Error('当前文件已被移除，请修订绑定');
    const source = fs.readFileSync(location, 'utf8');
    const current = extractSymbolAnchor(filePath, source, symbolName);
    if (!current) throw new Error('当前文件已找不到此符号，请修订绑定');
    const lines = source
      .split(/\r?\n/)
      .slice(current.start_line - 1, Math.min(current.end_line, current.start_line + 159));
    const text = redactSensitiveText(lines.join('\n')).redactedText;
    return {
      startLine: current.start_line,
      endLine: current.end_line,
      code: text.slice(0, 24000),
      truncated: current.end_line - current.start_line >= 160 || text.length > 24000,
    };
  }

  rebindAnchor(
    entry: KnowledgeEntry,
    oldPath: string,
    oldName: string,
    file: string,
    name: string,
  ) {
    if (!['active', 'probation'].includes(entry.status))
      throw new Error('仅可修订正式或试用条目的锚点');
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !name.trim()) {
      throw new Error('请填写仓库内相对路径和有效符号名');
    }
    const index = entry.symbol_anchors.findIndex(
      (a) => a.file_path === oldPath && a.symbol_name === oldName,
    );
    if (index < 0) throw new Error('旧锚点已经变化，请刷新并重新核对');
    const source = this.anchorFile(file);
    if (!source) throw new Error('仓库中找不到此文件');
    const target = extractSymbolAnchor(file, fs.readFileSync(source, 'utf8'), name);
    if (!target) throw new Error('文件中找不到此函数或类，请核对符号名');
    const previous = entry.symbol_anchors[index]!;
    const oldLocator = `${oldPath}#L${previous.start_line}-L${previous.end_line}`;
    const newLocator = `${file}#L${target.start_line}-L${target.end_line}`;
    const symbol_anchors = entry.symbol_anchors.map((anchor, i) => (i === index ? target : anchor));
    const evidence = entry.evidence.map((ev) =>
      ev.source_type === 'file_lines' && ev.locator === oldLocator
        ? {
            ...ev,
            locator: newLocator,
            source_ref: ev.source_ref === oldPath ? file : ev.source_ref,
          }
        : ev,
    );
    const saved = this.store.updateExistingEntryDirect(
      transition({ ...entry, symbol_anchors, evidence }, 'revise', { impact: 'substantive', needsReview: true }),
    );
    const head = runGitSafe(this.store.paths.projectRoot, ['rev-parse', 'HEAD']);
    this.store.rawDb
      .prepare(
        `INSERT INTO freshness_reviews (workspace_id, entry_id, reason, previous_head, affected_paths)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspace_id, entry_id)
       DO UPDATE SET reason = excluded.reason, affected_paths = excluded.affected_paths`,
      )
      .run(
        this.store.workspaceId,
        entry.id,
        `已将 ${oldPath} · ${oldName} 重新绑定至 ${file} · ${name}，请核对适用性`,
        head,
        JSON.stringify([...new Set([oldPath, file])]),
      );
    return saved;
  }

  confirmFresh(entry: KnowledgeEntry): KnowledgeEntry {
    if (entry.freshness === 'current') return entry;
    if (entry.freshness === 'stale') throw new Error('已明确失效的经验须先提交依据并重新评估');
    const { anchors, issues } = this.currentAnchors(entry);
    if (issues.length) throw new Error(issues.join('；'));
    const evidence = entry.evidence.map((ev) => {
      const index = entry.symbol_anchors.findIndex(
        (a) => ev.locator === `${a.file_path}#L${a.start_line}-L${a.end_line}`,
      );
      if (index < 0) return ev;
      const a = anchors[index]!;
      return { ...ev, locator: `${a.file_path}#L${a.start_line}-L${a.end_line}` };
    });
    const saved = this.store.updateExistingEntryDirect({
      ...transition(entry, 'confirm_fresh', { reviewDueAt: new Date(Date.now() + 90 * 86400000).toISOString() }),
      evidence,
      symbol_anchors: anchors,
    });
    this.store.rawDb
      .prepare('DELETE FROM freshness_reviews WHERE workspace_id = ? AND entry_id = ?')
      .run(this.store.workspaceId, entry.id);
    // The code was checked by a person: record it and keep what the evidence says now, next to what it said before.
    this.store.recordGovernanceDecision(saved, 'confirm_fresh', '核对代码变化后确认仍然成立');
    try {
      this.store.snapshots.capture(saved);
    } catch (err) {
      console.warn(`[accremind] snapshot skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    return saved;
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

    const previousHead = checkpoint?.last_checked_head ?? currentHead;
    let changedFiles: Set<string> | null = null;
    if (previousHead && currentHead && previousHead !== currentHead) {
      const changed = runGitSafe(repoRoot, [
        'diff',
        '--name-only',
        '-z',
        previousHead,
        currentHead,
        '--',
      ]);
      if (changed !== null) changedFiles = new Set(changed.split('\0').filter(Boolean));
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
          const absFile = this.anchorFile(anchor.file_path);
          if (!absFile) {
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
        const updated = transition(entry, 'flag_review_due', { now });
        const files = new Set(entry.symbol_anchors.map((a) => a.file_path));
        for (const file of changedFiles ?? []) {
          if (entry.watch_paths.some((glob) => path.matchesGlob(file, glob))) files.add(file);
        }
        if (reviewDueReason.startsWith('依赖 ')) files.add('package.json');
        this.store.rawDb
          .prepare(
            `INSERT OR REPLACE INTO freshness_reviews
          (workspace_id, entry_id, reason, previous_head, affected_paths) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            this.store.workspaceId,
            id,
            reviewDueReason,
            previousHead,
            JSON.stringify([...files]),
          );
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

    // Shared entries are not rewritten from this repository; dependency upgrades here flag them locally.
    try {
      for (const flagged of this.store.reviewSharedEntriesForDependencyChanges()) markedReviewDue.push(flagged);
    } catch (err) {
      console.warn(`[accremind] shared-entry review skipped: ${err instanceof Error ? err.message : String(err)}`);
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
