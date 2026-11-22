import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createAccreMindRuntime } from '@accremind/dsh-plugin';

/**
 * Contract between the plugin RPC and the workbench (packages/webui/src/lib/types.ts). The workbench
 * reads these fields; renaming or removing one must fail here, not silently in the browser.
 * When a shape changes on purpose, update this list and the front-end types together.
 */
const CONTRACT: Record<string, { params?: Record<string, unknown>; keys: string[]; nested?: Record<string, string[]> }> = {
  'accremind.dashboard.overview': {
    keys: ['workspaceId', 'projectName', 'maxProbationExposures', 'hasDemoSeeded', 'counts'],
    nested: { counts: ['totalEntries', 'activeCount', 'rulesCount', 'probationCount', 'reviewDueCount', 'suspendedCount', 'governanceQueueCount', 'verifiedOrProvenCount', 'pendingReviewCount', 'corruptedCount', 'queuedCaptureJobs', 'byScope', 'byCategory'] },
  },
  'accremind.insights.overview': {
    params: { days: 7, tzOffsetMinutes: 480 },
    keys: ['days', 'tzOffsetMinutes', 'daily', 'totals', 'byType', 'byHealth', 'lifecycle', 'topEntries', 'attention'],
    nested: {
      'daily.0': ['date', 'reminders', 'helpful', 'inapplicable', 'wrong', 'ruleTurns'],
      totals: ['reminders', 'remindersLast7', 'remindersPrev7', 'helpful', 'inapplicable', 'wrong', 'ruleTurns'],
      byHealth: ['usable', 'verified', 'trial', 'attention', 'stopped'],
      lifecycle: ['candidates', 'trial', 'active', 'verified'],
      'topEntries.0': ['id', 'title', 'type', 'reminders', 'helpful'],
    },
  },
  'accremind.kb.list': {
    params: { adminView: true },
    keys: ['scopeCounts', 'items', 'zeroReason'],
    nested: { 'items.0': ['entry', 'storageZone'] },
  },
  'accremind.review.listQueue': {
    params: { reviewState: 'pending', limit: 5 },
    keys: ['offset', 'limit', 'total', 'hasMore', 'items'],
    nested: { 'items.0': ['assessment', 'reviewState', 'candidateDraft', 'missingFields'] },
  },
  'accremind.attention.list': { keys: ['items'] },
  'accremind.gov.reviewQueue': { keys: ['staleEntries', 'suspendedEntries', 'corruptedFiles', 'attentionItems'] },
  'accremind.gov.scanStaleness': {
    keys: ['scan', 'staleEntries', 'suspendedEntries', 'corruptedFiles', 'attentionItems'],
    nested: { scan: ['skippedUnchanged', 'previousHead', 'currentHead', 'relocatedEntries', 'markedReviewDue'] },
  },
  'accremind.turn.list': {
    params: { limit: 10 },
    keys: ['receipts'],
    nested: { 'receipts.0': ['sessionId', 'turnId', 'createdAt', 'hits'], 'receipts.0.hits.0': ['id', 'revision', 'title', 'status', 'source', 'currentStatus', 'currentRevision', 'currentServing', 'feedback'] },
  },
  'accremind.sim.compile': {
    params: { userPrompt: '支付回调验签' },
    keys: ['residentPrefix', 'residentRuleIds', 'residentDroppedIds', 'residentTokens', 'radarBlock', 'radarTokens', 'radarSurfacedIds', 'guardBlock', 'guardTokens', 'guardSurfacedIds', 'budgets'],
  },
  'accremind.settings.get': { keys: ['writeGate', 'modelEndpoint', 'modelAvailable', 'autoCapture', 'modelUpload', 'shareLedger'] },
  'accremind.ledger.status': { keys: ['shared', 'sharedFile', 'pendingCount', 'preview'], nested: { 'preview.0': ['id', 'entryId', 'revision', 'contentSha256', 'kind', 'actor', 'at', 'note'] } },
  'accremind.kb.get': {
    params: { id: 'K-0901' },
    keys: ['entry', 'assessment', 'validations', 'rawMarkdown', 'snapshots', 'ledger'],
    nested: {
      'snapshots.0': ['evidenceId', 'revision', 'excerpt', 'sourceSha256', 'capturedAt', 'capturedBy', 'redacted', 'truncated'],
      ledger: ['shared', 'standing', 'records'],
      'ledger.standing': ['maturity', 'unresolvedCounterexample', 'successTasks', 'confirmers', 'author', 'counted'],
    },
  },
  'accremind.queue.list': { keys: ['jobs'] },
};

function at(value: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((v, k) => (v == null ? v : (v as Record<string, unknown>)[k]), value);
}

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('RPC contract with the workbench', () => {
  it('returns every field the workbench reads', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-contract-'));
    dirs.push(base);
    fs.mkdirSync(path.join(base, 'repo'));
    const runtime = createAccreMindRuntime({ projectRoot: path.join(base, 'repo'), globalDir: path.join(base, 'g') });
    const { token } = await runtime.rpcHandlers['accremind.demo.open']!({}) as { token: string };
    const call = (method: string, params: Record<string, unknown> = {}) =>
      runtime.rpcHandlers['accremind.demo.call']!({ token, method, params });

    for (const [method, spec] of Object.entries(CONTRACT)) {
      const out = await call(method, spec.params ?? {});
      for (const key of spec.keys) assert.ok(out && typeof out === 'object' && key in out, `${method} → ${key}`);
      for (const [where, keys] of Object.entries(spec.nested ?? {})) {
        const node = at(out, where);
        assert.ok(node && typeof node === 'object', `${method} → ${where} is present in the demo data`);
        for (const key of keys) assert.ok(key in (node as object), `${method} → ${where}.${key}`);
      }
    }
    // Per-entry diff for the review queue.
    const queue = await call('accremind.gov.reviewQueue') as { staleEntries: Array<{ id: string; revision: number }> };
    assert.ok(queue.staleEntries.length > 0, 'demo data has an entry to review');
    const details = await call('accremind.gov.reviewDetails', { id: queue.staleEntries[0]!.id, revision: queue.staleEntries[0]!.revision });
    for (const key of ['reason', 'previousHead', 'currentHead', 'diff', 'truncated', 'anchorIssues', 'reviewToken', 'evidence']) {
      assert.ok(key in (details as object), `reviewDetails → ${key}`);
    }
    const ev = (details as { evidence: Array<Record<string, unknown>> }).evidence[0]!;
    for (const key of ['evidenceId', 'locator', 'then', 'now', 'changed', 'verification']) assert.ok(key in ev, `reviewDetails.evidence → ${key}`);
    await runtime.rpcHandlers['accremind.demo.close']!({ token });
  });
});
