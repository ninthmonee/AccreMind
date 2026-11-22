import * as fs from 'node:fs';
import * as path from 'node:path';

/** One line of the append-only activity log: who did what to which entry revision, and why. */
export interface AccreMindEvent {
  ts: string;
  actor: string;
  type:
    | 'entry.saved'
    | 'entry.promoted'
    | 'entry.dismissed'
    | 'entry.validated'
    | 'entry.feedback_inapplicable'
  | 'entry.ledger_synced'
    | 'entry.suspended'
    | 'governance.decided'
    | 'attention.raised';
  entryId: string;
  revision: number;
  detail?: Record<string, unknown>;
}

/**
 * Append-only NDJSON activity log, sharded by month (`events/2026-11.ndjson`).
 * Each line is self-contained so files from different machines can later be merged by
 * concatenation (Git `merge=union`) and replayed in timestamp order. Writes use O_APPEND,
 * which keeps single-line appends atomic on local filesystems.
 */
export class EventLog {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  append(event: Omit<AccreMindEvent, 'ts'> & { ts?: string }): AccreMindEvent {
    const full: AccreMindEvent = { ts: event.ts ?? new Date().toISOString(), ...event } as AccreMindEvent;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${full.ts.slice(0, 7)}.ndjson`);
    fs.appendFileSync(file, JSON.stringify(full) + '\n', { encoding: 'utf8', mode: 0o600 });
    return full;
  }

  /** Reads events (oldest first), optionally only for one entry. Malformed lines are skipped. */
  read(filter: { entryId?: string } = {}): AccreMindEvent[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: AccreMindEvent[] = [];
    for (const name of fs.readdirSync(this.dir).filter((n) => n.endsWith('.ndjson')).sort()) {
      for (const line of fs.readFileSync(path.join(this.dir, name), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as AccreMindEvent;
          if (!filter.entryId || ev.entryId === filter.entryId) out.push(ev);
        } catch {
          // a torn last line after a crash is ignored
        }
      }
    }
    return out.sort((a, b) => a.ts.localeCompare(b.ts));
  }
}
