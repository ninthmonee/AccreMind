import { randomUUID } from 'node:crypto';
import type { EntryStatus, KnowledgeEntry, LocalMarkdownSqliteStore, ServingStatus } from '@accremind/core';

export interface ReceiptHit {
  id: string;
  revision: number;
  title: string;
  status: EntryStatus;
  source: 'rule' | 'radar' | 'jit';
  filePath?: string | null;
  currentStatus: EntryStatus | null;
  currentRevision: number | null;
  currentServing: ServingStatus | null;
  feedback: 'success' | 'failure' | 'inconclusive' | null;
}

export interface TurnReceipt {
  sessionId: string;
  turnId: string;
  createdAt: string;
  hits: ReceiptHit[];
}

/** Snapshots refer to the version actually presented, including after it is edited. */
export class TurnReceipts {
  private readonly store: LocalMarkdownSqliteStore;
  private readonly openTurns = new Map<string, string>();

  constructor(store: LocalMarkdownSqliteStore) {
    this.store = store;
  }

  begin(sessionId: string, turnId?: string): string {
    const current = this.openTurns.get(sessionId);
    const next = turnId || current || randomUUID();
    if (next === current) return next;
    const { rawDb, workspaceId } = this.store;
    const added = rawDb.prepare(`INSERT OR IGNORE INTO turn_receipts
      (workspace_id, session_id, turn_id, created_at) VALUES (?, ?, ?, ?)`).run(
      workspaceId, sessionId, next, new Date().toISOString(),
    );
    if (added.changes) {
      // The last allowed exposure remains actionable until the user starts another turn.
      const expired = rawDb.prepare(`SELECT p.entry_id, p.revision, e.status, e.revision AS current_revision
        FROM probation_grace p LEFT JOIN entries e ON e.workspace_id = p.workspace_id AND e.id = p.entry_id
        WHERE p.workspace_id = ? AND (p.turn_completed = 1 OR p.session_id = ?)
        AND (p.session_id != ? OR p.turn_id != ?)`).all(workspaceId, sessionId, sessionId, next);
      for (const row of expired) {
        if (row.status === 'probation' && row.current_revision === row.revision) this.store.dismissProbation(String(row.entry_id));
        rawDb.prepare('DELETE FROM probation_grace WHERE workspace_id = ? AND entry_id = ?').run(workspaceId, String(row.entry_id));
      }
    }
    this.openTurns.set(sessionId, next);
    return next;
  }

  finish(sessionId: string) {
    const turn = this.openTurns.get(sessionId);
    if (turn) this.store.rawDb.prepare('UPDATE probation_grace SET turn_completed = 1 WHERE workspace_id = ? AND session_id = ? AND turn_id = ?')
      .run(this.store.workspaceId, sessionId, turn);
    this.openTurns.delete(sessionId);
  }

  record(entry: KnowledgeEntry, sessionId: string, source: ReceiptHit['source'], filePath?: string) {
    const turn = this.begin(sessionId);
    const result = this.store.rawDb.prepare(`INSERT OR IGNORE INTO turn_hits
      (workspace_id, session_id, turn_id, entry_id, revision, title, status, source, file_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.store.workspaceId, sessionId, turn, entry.id, entry.revision, entry.title, entry.status, source, filePath ?? null,
    );
    if (!result.changes || source === 'rule') return;
    this.store.recordUsage({
      workspace_id: this.store.workspaceId, session_id: sessionId, entry_id: entry.id,
      revision: entry.revision, event_type: source === 'radar' ? 'radar_shown' : 'guard_shown', detail: filePath,
    });
    if (entry.status === 'probation') {
      const prior = this.store.rawDb.prepare(`SELECT 1 FROM turn_hits WHERE workspace_id = ?
        AND session_id = ? AND turn_id = ? AND entry_id = ? AND revision = ? AND source != ?`)
        .get(this.store.workspaceId, sessionId, turn, entry.id, entry.revision, source);
      if (prior) return;
      const { exposures } = this.store.recordProbationExposure(entry.id, true);
      if (exposures >= this.store.maxProbationExposures) {
        this.store.rawDb.prepare(`INSERT OR IGNORE INTO probation_grace
          (workspace_id, entry_id, revision, session_id, turn_id) VALUES (?, ?, ?, ?, ?)`)
          .run(this.store.workspaceId, entry.id, entry.revision, sessionId, turn);
      }
    }
  }

  list(sessionId?: string, turnId?: string, limit = 20): TurnReceipt[] {
    const where = ['workspace_id = ?'];
    const values = [this.store.workspaceId];
    if (sessionId) { where.push('session_id = ?'); values.push(sessionId); }
    if (turnId) { where.push('turn_id = ?'); values.push(turnId); }
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20;
    const turns = this.store.rawDb.prepare(`SELECT session_id AS sessionId, turn_id AS turnId, created_at AS createdAt
      FROM turn_receipts WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...values, bounded) as unknown as Omit<TurnReceipt, 'hits'>[];
    const hits = this.store.rawDb.prepare(`SELECT h.entry_id AS id, h.revision, h.title, h.status, h.source, h.file_path AS filePath,
      COALESCE(e.status, g.status) AS currentStatus, COALESCE(e.revision, g.revision) AS currentRevision,
      COALESCE(e.serving, g.serving) AS currentServing, v.outcome AS feedback
      FROM turn_hits h
      LEFT JOIN entries e ON e.workspace_id = h.workspace_id AND e.id = h.entry_id
      LEFT JOIN entries g ON g.workspace_id = '__global__' AND g.id = h.entry_id
      LEFT JOIN validation_records v ON v.workspace_id = COALESCE(e.workspace_id, g.workspace_id)
        AND v.entry_id = h.entry_id AND v.revision = h.revision AND v.task_fingerprint = ('session:' || h.session_id)
      WHERE h.workspace_id = ? AND h.session_id = ? AND h.turn_id = ? ORDER BY h.rowid`);
    return turns.map((turn) => ({
      ...turn, hits: hits.all(this.store.workspaceId, turn.sessionId, turn.turnId) as unknown as ReceiptHit[],
    }));
  }

  checkReference(params: Record<string, unknown>, entry: KnowledgeEntry): void {
    if (params.revision !== undefined && params.revision !== entry.revision) {
      throw new Error('引用的经验版本已经变化，请打开当前版本重新核对');
    }
    if (params.sessionId === undefined && params.turnId === undefined) return;
    if (typeof params.sessionId !== 'string' || !params.sessionId || typeof params.turnId !== 'string' || !params.turnId) {
      throw new Error('回执缺少会话或回合标识');
    }
    const hit = this.store.rawDb.prepare(`SELECT 1 FROM turn_hits WHERE workspace_id = ? AND session_id = ?
      AND turn_id = ? AND entry_id = ? AND revision = ?`).get(
      this.store.workspaceId, params.sessionId, params.turnId, entry.id, entry.revision,
    );
    if (!hit) throw new Error('该回合未引用这条经验的当前版本');
  }
}
