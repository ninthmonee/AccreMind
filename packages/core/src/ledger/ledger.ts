import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactSensitiveText } from '../capture/secret-redactor.ts';
import { sha256Hex, writeFileAtomicSync } from '../codec/atomic-fs.ts';
import type { KnowledgeEntry } from '../contracts/types.ts';

/**
 * Validation ledger: who confirmed, refuted or decided what about which revision of an entry.
 *
 * One record per file (`<dir>/<entryId>/<time>-<random>.json`), written once and never edited, so two
 * people adding records at the same time never produce a merge conflict on any hosting platform.
 * Records are bound to the exact wording through `contentSha256`: editing the claim makes earlier
 * confirmations stop counting. Only conclusions are recorded — never prompts, sessions or per-turn
 * usage — and notes are redacted and capped.
 *
 * While sharing is off the ledger lives on this machine; turning it on moves it into the repository
 * (`.accremind/ledger`). Reads always merge both places, so switching never loses records.
 */
export const LEDGER_FORMAT_VERSION = 1;
const NOTE_MAX = 200;

export type LedgerKind = 'validated' | 'counterexample' | 'inapplicable' | 'decision';
export type LedgerDecision = 'publish' | 'promote' | 'dismiss' | 'stale' | 'request_review' | 'resume' | 'withdraw' | 'confirm_fresh';

export interface LedgerRecord {
  v: number;
  id: string;
  entryId: string;
  revision: number;
  contentSha256: string;
  kind: LedgerKind;
  action?: LedgerDecision;
  /** Short hash of the task / ticket / test identifier: counts independent tasks without revealing them. */
  task?: string;
  actor: string;
  at: string;
  note: string;
  tool: string;
}

export interface LedgerStanding {
  maturity: KnowledgeEntry['maturity'];
  /** A counterexample on this revision with no later “resume” decision. */
  unresolvedCounterexample: boolean;
  successTasks: number;
  confirmers: string[];
  /** Distinct people who said “doesn't apply here” (a hint, never an automatic pause). */
  inapplicableReporters: number;
  /** Who first published the entry, when known. */
  author: string | null;
  lastValidatedAt: string | null;
  /** Records that count for the current wording. */
  counted: number;
}

/** Hash of what the entry claims. Lifecycle fields and dates are excluded on purpose. */
export function entryContentHash(entry: Pick<KnowledgeEntry, 'type' | 'layer' | 'title' | 'claim' | 'knowledge_delta' | 'rationale' | 'preconditions' | 'exclusions'>): string {
  return sha256Hex(JSON.stringify([entry.type, entry.layer, entry.title, entry.claim, entry.knowledge_delta, entry.rationale, entry.preconditions, entry.exclusions])).slice(0, 32);
}

export function hashTask(task: string): string {
  return sha256Hex(`accremind-task:${task.trim()}`).slice(0, 16);
}

/**
 * The single rule that turns ledger records into maturity and pause state (see design §24.2).
 * `requireSecondPerson`: in team mode “proven” needs a confirmer other than the author. A single person
 * working alone has nobody else, so locally two independent tasks are enough.
 */
export function deriveStanding(entry: KnowledgeEntry, records: LedgerRecord[], options: { requireSecondPerson?: boolean } = {}): LedgerStanding {
  const content = entryContentHash(entry);
  const sorted = [...records].sort((a, b) => a.at.localeCompare(b.at));
  const author = sorted.find((r) => r.kind === 'decision' && r.action === 'publish')?.actor ?? null;
  const current = sorted.filter((r) => r.revision === entry.revision && r.contentSha256 === content);
  const successes = current.filter((r) => r.kind === 'validated');
  const tasks = new Set(successes.map((r) => r.task ?? r.id));
  const confirmers = [...new Set(successes.map((r) => r.actor))];
  const resumes = current.filter((r) => r.kind === 'decision' && r.action === 'resume');
  const unresolved = current.some((r) => r.kind === 'counterexample' && !resumes.some((x) => x.at > r.at));
  const someoneElse = !options.requireSecondPerson || author === null || confirmers.some((a) => a !== author);
  const maturity: KnowledgeEntry['maturity'] =
    !unresolved && tasks.size >= 2 && someoneElse ? 'proven' : tasks.size >= 1 && !unresolved ? 'verified' : 'draft';
  return {
    maturity,
    unresolvedCounterexample: unresolved,
    successTasks: tasks.size,
    confirmers,
    inapplicableReporters: new Set(current.filter((r) => r.kind === 'inapplicable').map((r) => r.actor)).size,
    author,
    lastValidatedAt: successes.at(-1)?.at ?? null,
    counted: current.length,
  };
}

export class ValidationLedger {
  private readonly repoDir: string;
  private readonly localDir: string;
  private readonly shared: () => boolean;
  private readonly actor: () => string;
  private readonly tool: string;

  constructor(options: { repoDir: string; localDir: string; shared: () => boolean; actor: () => string; tool?: string }) {
    this.repoDir = options.repoDir;
    this.localDir = options.localDir;
    this.shared = options.shared;
    this.actor = options.actor;
    this.tool = options.tool ?? 'accremind';
  }

  get isShared(): boolean {
    return this.shared();
  }

  /** Writes one record. Local-only entries (trials, personal) never go to the repository. */
  append(
    entry: KnowledgeEntry,
    input: { kind: LedgerKind; action?: LedgerDecision; task?: string; note?: string; at?: string; actor?: string },
  ): LedgerRecord {
    const at = input.at ?? new Date().toISOString();
    const record: LedgerRecord = {
      v: LEDGER_FORMAT_VERSION,
      id: `LG-${randomUUID().slice(0, 12)}`,
      entryId: entry.id,
      revision: entry.revision,
      contentSha256: entryContentHash(entry),
      kind: input.kind,
      ...(input.action ? { action: input.action } : {}),
      ...(input.task ? { task: hashTask(input.task) } : {}),
      actor: input.actor ?? this.actor(),
      at,
      note: redactSensitiveText((input.note ?? '').trim()).redactedText.slice(0, NOTE_MAX),
      tool: this.tool,
    };
    const local = !this.shared() || entry.status === 'probation' || entry.layer === 'personal' || entry.layer === 'shared_tech';
    const dir = path.join(local ? this.localDir : this.repoDir, entry.id);
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(path.join(dir, `${at.replace(/[:.]/g, '')}-${record.id.slice(3)}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  /** Every record of an entry from both places, oldest first, de-duplicated by id. */
  read(entryId: string): LedgerRecord[] {
    const byId = new Map<string, LedgerRecord>();
    for (const root of [this.repoDir, this.localDir]) {
      const dir = path.join(root, entryId);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as LedgerRecord;
          if (rec && rec.id && rec.entryId === entryId && rec.v <= LEDGER_FORMAT_VERSION) byId.set(rec.id, rec);
        } catch {
          /* a damaged record is skipped; the rest of the ledger still counts */
        }
      }
    }
    return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Entry ids that have records anywhere. */
  entryIds(): string[] {
    const ids = new Set<string>();
    for (const root of [this.repoDir, this.localDir]) {
      if (fs.existsSync(root)) for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory()) ids.add(d.name);
    }
    return [...ids];
  }

  /** Records still on this machine that sharing would move into the repository. */
  pendingExport(isLocalOnly: (entryId: string) => boolean): LedgerRecord[] {
    if (!fs.existsSync(this.localDir)) return [];
    return fs.readdirSync(this.localDir).filter((id) => !isLocalOnly(id)).flatMap((id) => {
      const dir = path.join(this.localDir, id);
      return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).flatMap((n) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as LedgerRecord];
        } catch {
          return [];
        }
      });
    });
  }

  /** Moves local records of repository entries into the repository ledger. Returns how many moved. */
  exportToRepository(isLocalOnly: (entryId: string) => boolean): number {
    if (!fs.existsSync(this.localDir)) return 0;
    let moved = 0;
    for (const id of fs.readdirSync(this.localDir)) {
      if (isLocalOnly(id)) continue;
      const from = path.join(this.localDir, id);
      const to = path.join(this.repoDir, id);
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) {
        fs.renameSync(path.join(from, name), path.join(to, name));
        moved += 1;
      }
      fs.rmSync(from, { recursive: true, force: true });
    }
    return moved;
  }
}
