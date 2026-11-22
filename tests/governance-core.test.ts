import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import {
  ACCREMIND_SCHEMA_VERSION,
  ACCREMIND_SQLITE_DDL,
  ConcurrentModificationError,
  GovernanceService,
  LocalMarkdownSqliteStore,
  migrateSchema,
  resolveStorePaths,
} from '@accremind/core';
import { authFixtures } from './helpers/auth-fixtures.ts';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function ws() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-gov-'));
  dirs.push(base);
  fs.mkdirSync(path.join(base, 'repo'));
  return { projectRoot: path.join(base, 'repo'), globalDir: path.join(base, 'g') };
}

describe('Governance in the core: attribution, activity log, migrations', () => {
  it('attributes every decision to the acting identity and logs it', () => {
    const store = new LocalMarkdownSqliteStore({ ...ws(), actor: 'alice@example.com' });
    const { authPitfall, authAssessment } = authFixtures(store.workspaceId);
    store.upsertEntry(authPitfall, 'project', authAssessment);
    const gov = new GovernanceService(store);

    gov.markStale(authPitfall, '令牌轮换改用单飞锁，宽限期已删除');
    const decisions = store.listGovernanceDecisions(authPitfall.id);
    assert.equal(decisions[0]!.actor, 'alice@example.com');
    assert.equal(decisions[0]!.action, 'stale');

    const events = store.events.read({ entryId: authPitfall.id });
    assert.deepEqual(events.map((e) => e.type), ['entry.saved', 'governance.decided']);
    assert.ok(events.every((e) => e.actor === 'alice@example.com'));
    store.close();
  });

  it('refuses decisions without a reason and on retired entries', () => {
    const store = new LocalMarkdownSqliteStore(ws());
    const { authPitfall, authAssessment } = authFixtures(store.workspaceId);
    store.upsertEntry(authPitfall, 'project', authAssessment);
    const gov = new GovernanceService(store);
    assert.throws(() => gov.markStale(authPitfall, '  '), /依据/);
    assert.throws(() => gov.markStale({ ...authPitfall, status: 'archived' }, '理由'), /归档或撤回/);
    store.close();
  });

  it('upgrades an existing index database in place and records the schema version', () => {
    const w = ws();
    const paths = resolveStorePaths(w);
    fs.mkdirSync(path.dirname(paths.sqlitePath), { recursive: true });
    const legacy = new DatabaseSync(paths.sqlitePath);
    legacy.exec(ACCREMIND_SQLITE_DDL);
    legacy.exec("INSERT INTO governance_decisions VALUES ('w', 'K-1', 1, 'stale', 'old', '2026-01-01')");
    legacy.close();

    const store = new LocalMarkdownSqliteStore(w);
    const version = (store.rawDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.equal(version, ACCREMIND_SCHEMA_VERSION);
    const cols = (store.rawDb.prepare('PRAGMA table_info(governance_decisions)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('actor'));
    assert.equal((store.rawDb.prepare('SELECT COUNT(*) AS n FROM governance_decisions').get() as { n: number }).n, 1, 'old rows kept');
    assert.equal(migrateSchema(store.rawDb as never), ACCREMIND_SCHEMA_VERSION, 'running again is a no-op');
    store.close();
  });

  it('can be replayed from the activity log even if the index is lost', () => {
    const w = ws();
    const store = new LocalMarkdownSqliteStore({ ...w, actor: 'bob@example.com' });
    const { authPitfall, authAssessment } = authFixtures(store.workspaceId);
    store.upsertEntry(authPitfall, 'project', authAssessment);
    new GovernanceService(store).markStale(authPitfall, '依赖升级后行为改变');
    const dbPath = store.paths.sqlitePath;
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    const reopened = new LocalMarkdownSqliteStore(w);
    const types = reopened.events.read().map((e) => e.type);
    assert.ok(types.includes('governance.decided'), 'history survives losing the index');
    reopened.close();
  });

  it('does not overwrite an entry that another window or a git pull changed meanwhile', () => {
    const w = ws();
    const a = new LocalMarkdownSqliteStore(w);
    const { authPitfall, authAssessment } = authFixtures(a.workspaceId);
    a.upsertEntry(authPitfall, 'project', authAssessment);
    const file = path.join(a.paths.projectEntriesDir, `${authPitfall.id}.md`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('5 秒旧票据', '10 秒旧票据'));
    assert.throws(() => new GovernanceService(a).markStale(authPitfall, '理由'), ConcurrentModificationError);
    const reloaded = a.getEntry(authPitfall.id, { recordUsage: false });
    assert.ok(reloaded.found && reloaded.servable && reloaded.entry.title.includes('10 秒'), 'the newer content is picked up');
    a.close();
  });

  it('waits for another process holding the write lock, and takes over a lock left by a crash', () => {
    const w = ws();
    const store = new LocalMarkdownSqliteStore(w);
    const { authPitfall, authAssessment } = authFixtures(store.workspaceId);
    const lock = path.join(path.dirname(store.paths.sqlitePath), 'write.lock');
    fs.writeFileSync(lock, '999999\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    store.upsertEntry(authPitfall, 'project', authAssessment);
    assert.equal(fs.existsSync(lock), false, 'stale lock taken over and released');

    fs.writeFileSync(lock, '999999\n');
    const t0 = Date.now();
    assert.throws(() => store.upsertEntry({ ...authPitfall, title: authPitfall.title + '（修订）' }, 'project', authAssessment), /另一个 AccreMind 窗口/);
    assert.ok(Date.now() - t0 >= 2500, 'it waited before giving up');
    fs.rmSync(lock);
    store.close();
  });

  it('summarises reminders, feedback and lifecycle for the overview', () => {
    const store = new LocalMarkdownSqliteStore({ ...ws(), actor: 'alice@example.com' });
    const { authPitfall, authAssessment, ruleEntry } = authFixtures(store.workspaceId);
    store.upsertEntry(ruleEntry, 'rules', null);
    store.upsertEntry(authPitfall, 'project', authAssessment);
    for (const s of ['s1', 's2', 's3']) {
      store.recordUsage({ workspace_id: store.workspaceId, session_id: s, entry_id: authPitfall.id, revision: 1, event_type: 'radar_shown' });
    }
    store.submitValidation({ entryId: authPitfall.id, sessionId: 's9', taskFingerprint: 't1', outcome: 'success', evidenceNote: 'ok' });
    const ins = store.insights(28);
    assert.equal(ins.daily.length, 28);
    assert.equal(ins.totals.reminders, 3);
    assert.equal(ins.totals.remindersLast7, 3);
    assert.equal(ins.totals.helpful, 1);
    assert.equal(ins.topEntries[0]!.id, authPitfall.id);
    assert.equal(ins.topEntries[0]!.helpful, 1);
    assert.equal(ins.byType.pitfall, 1);
    assert.equal(ins.byHealth.verified, 2);
    assert.equal(ins.lifecycle.active, 2);
    store.close();
  });
});
