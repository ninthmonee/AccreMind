import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  deriveStanding,
  entryContentHash,
  LocalMarkdownSqliteStore,
  type KnowledgeEntry,
  type LedgerRecord,
} from '@accremind/core';
import { authFixtures } from './helpers/auth-fixtures.ts';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function repo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-ledger-'));
  dirs.push(base);
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'dev');
  return { root, git, globalDir: path.join(base, 'g') };
}

function rec(entry: KnowledgeEntry, over: Partial<LedgerRecord>): LedgerRecord {
  return { v: 1, id: `LG-${Math.random()}`, entryId: entry.id, revision: entry.revision, contentSha256: entryContentHash(entry), kind: 'validated', actor: 'a', at: '2026-01-01T00:00:00.000Z', note: '', tool: 't', ...over };
}

describe('Ledger standing', () => {
  const entry = authFixtures('ws').authPitfall;

  it('counts independent tasks on the exact wording, and needs a second person only in team mode', () => {
    const records = [
      rec(entry, { kind: 'decision', action: 'publish', actor: 'alice', at: '2026-01-01T00:00:00.000Z' }),
      rec(entry, { task: 't1', actor: 'alice', at: '2026-01-02T00:00:00.000Z' }),
      rec(entry, { task: 't2', actor: 'alice', at: '2026-01-03T00:00:00.000Z' }),
    ];
    assert.equal(deriveStanding(entry, records).maturity, 'proven');
    assert.equal(deriveStanding(entry, records, { requireSecondPerson: true }).maturity, 'verified');
    const withBob = [...records, rec(entry, { task: 't3', actor: 'bob', at: '2026-01-04T00:00:00.000Z' })];
    assert.equal(deriveStanding(entry, withBob, { requireSecondPerson: true }).maturity, 'proven');

    // Editing the claim makes earlier confirmations stop counting.
    const edited = { ...entry, claim: entry.claim + '（修订）' };
    assert.equal(deriveStanding(edited, withBob).maturity, 'draft');
  });

  it('treats a counterexample as open until a later resume decision', () => {
    const records = [
      rec(entry, { task: 't1', actor: 'alice', at: '2026-01-02T00:00:00.000Z' }),
      rec(entry, { kind: 'counterexample', task: 't9', actor: 'bob', at: '2026-01-03T00:00:00.000Z' }),
    ];
    const open = deriveStanding(entry, records);
    assert.deepEqual([open.unresolvedCounterexample, open.maturity], [true, 'draft']);
    const resumed = deriveStanding(entry, [...records, rec(entry, { kind: 'decision', action: 'resume', at: '2026-01-04T00:00:00.000Z' })]);
    assert.deepEqual([resumed.unresolvedCounterexample, resumed.maturity], [false, 'verified']);
  });
});

describe('Ledger in the store', () => {
  it('writes validations and decisions as one file per record, locally until sharing is on, then moves them', () => {
    const { root, globalDir } = repo();
    let shared = false;
    const store = new LocalMarkdownSqliteStore({ projectRoot: root, globalDir, actor: 'alice', shareLedger: () => shared });
    const { authPitfall, authAssessment } = authFixtures(store.workspaceId);
    store.upsertEntry(authPitfall, 'project', authAssessment);
    store.recordPublication(authPitfall);
    store.submitValidation({ entryId: authPitfall.id, sessionId: 's1', taskFingerprint: 'JIRA-1', outcome: 'success', evidenceNote: 'token sk-abcdefghijklmnopqrstuvwxyz123456 worked' });

    const local = path.join(store.paths.localLedgerDir, authPitfall.id);
    const files = fs.readdirSync(local);
    assert.equal(files.length, 2);
    assert.ok(!fs.existsSync(store.paths.ledgerDir), 'nothing written into the repository while sharing is off');
    const records = store.ledger.read(authPitfall.id);
    const validated = records.find((r) => r.kind === 'validated')!;
    assert.notEqual(validated.task, 'JIRA-1', 'task identifiers are hashed');
    assert.ok(!validated.note.includes('sk-abcdefghijklmnop'), 'notes are redacted');

    shared = true;
    assert.equal(store.ledger.exportToRepository(() => false), 2);
    assert.equal(fs.readdirSync(path.join(store.paths.ledgerDir, authPitfall.id)).length, 2);
    assert.equal(store.ledger.read(authPitfall.id).length, 2);

    // A teammate's confirmation arrives through Git; sync applies the team rule.
    const entry = store.getEntry(authPitfall.id, { recordUsage: false, includeHistoryOrSuspended: true });
    assert.ok(entry.found && entry.servable);
    store.ledger.append(entry.entry, { kind: 'validated', task: 'JIRA-2', actor: 'bob' });
    store.syncFromLedger();
    const after = store.getEntry(authPitfall.id, { recordUsage: false, includeHistoryOrSuspended: true });
    assert.ok(after.found && after.servable && after.entry.maturity === 'proven');
    store.close();
  });

  it('copies validations recorded before the ledger existed, so upgrading keeps maturity', () => {
    const { root, globalDir } = repo();
    const store = new LocalMarkdownSqliteStore({ projectRoot: root, globalDir });
    const { authPitfall, authAssessment } = authFixtures(store.workspaceId);
    store.upsertEntry(authPitfall, 'project', authAssessment);
    store.rawDb.prepare(`INSERT INTO validation_records (id, workspace_id, entry_id, revision, session_id, task_fingerprint, outcome, evidence_note, created_at)
      VALUES ('VAL-old', ?, ?, ?, 's0', 'OLD-1', 'success', 'before ledger', '2025-01-01T00:00:00.000Z')`).run(store.workspaceId, authPitfall.id, authPitfall.revision);
    const out = store.submitValidation({ entryId: authPitfall.id, sessionId: 's1', taskFingerprint: 'NEW-1', outcome: 'success', evidenceNote: 'ok' });
    assert.equal(out.updatedEntry.maturity, 'proven');
    assert.equal(store.ledger.read(authPitfall.id).filter((r) => r.kind === 'validated').length, 2);
    store.close();
  });
});

describe('Evidence snapshots', () => {
  it('keeps what the evidence said, verifies it against Git, and shows the change after the code moves', () => {
    const { root, git, globalDir } = repo();
    const file = path.join(root, 'src/order.ts');
    fs.writeFileSync(file, ['export function create() {', '  save();', '  const key = "sk-abcdefghijklmnopqrstuvwxyz123456";', '  afterCommit(send);', '}'].join('\n'));
    git('add', '.');
    git('commit', '-qm', 'init');

    const store = new LocalMarkdownSqliteStore({ projectRoot: root, globalDir });
    const { authPitfall, authAssessment } = authFixtures(store.workspaceId);
    const entry: KnowledgeEntry = { ...authPitfall, evidence: [{ id: 'EV-1', source_type: 'file_lines', source_ref: 'src/order.ts', locator: 'src/order.ts#L1-L5', summary: '事务提交后再发送' }] };
    store.upsertEntry(entry, 'project', authAssessment);
    const [snap] = store.snapshots.capture(entry);
    assert.ok(snap);
    assert.match(snap.excerpt, /afterCommit\(send\)/);
    assert.ok(!snap.excerpt.includes('sk-abcdefghijklmnop'), 'secrets are masked in the excerpt');
    assert.ok(snap.redacted > 0);
    assert.equal(store.snapshots.verify(snap).status, 'verified');
    assert.match(fs.readdirSync(path.join(store.paths.evidenceDir, entry.id))[0]!, /^EV-1@r1-\d+\.md$/);

    fs.writeFileSync(file, ['export function create() {', '  save();', '  send();', '}'].join('\n'));
    const now = store.snapshots.read(entry.evidence[0]!);
    assert.notEqual(now.sourceSha256, snap.sourceSha256);
    assert.equal(store.snapshots.latest(entry).get('EV-1')!.excerpt, snap.excerpt, 'the snapshot still shows what was approved');

    // Hand-edited snapshot is detected.
    const snapFile = path.join(store.paths.evidenceDir, entry.id, fs.readdirSync(path.join(store.paths.evidenceDir, entry.id))[0]!);
    fs.writeFileSync(snapFile, fs.readFileSync(snapFile, 'utf8').replace(snap.sourceSha256, '0'.repeat(64)));
    assert.equal(store.snapshots.verify(store.snapshots.latest(entry).get('EV-1')!).status, 'mismatch');
    store.close();
  });

  it('keeps the newest three snapshots per evidence and moves trial snapshots into the repository on promotion', async () => {
    const { root, globalDir } = repo();
    const store = new LocalMarkdownSqliteStore({ projectRoot: root, globalDir });
    const { authPitfall, authAssessment } = authFixtures(store.workspaceId);
    const trial: KnowledgeEntry = { ...authPitfall, id: 'K-7101', status: 'probation' };
    store.upsertEntry(trial, 'probation', authAssessment);
    for (let i = 0; i < 5; i += 1) {
      store.snapshots.capture(trial);
      await new Promise((r) => setTimeout(r, 5));
    }
    const localDir = path.join(store.paths.localEvidenceDir, trial.id);
    assert.equal(fs.readdirSync(localDir).length, 3 * trial.evidence.length);
    store.promoteProbationToActive(trial.id);
    assert.ok(!fs.existsSync(localDir));
    assert.equal(fs.readdirSync(path.join(store.paths.evidenceDir, trial.id)).length, 3 * trial.evidence.length);
    store.close();
  });
});
