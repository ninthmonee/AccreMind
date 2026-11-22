import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactSensitiveText } from '../capture/secret-redactor.ts';
import { sha256Hex, writeFileAtomicSync } from '../codec/atomic-fs.ts';
import type { Evidence, KnowledgeEntry } from '../contracts/types.ts';

/**
 * Evidence snapshots: what each piece of evidence said when the entry was approved or last confirmed.
 *
 * A locator like `src/order/service.ts#L40-L58` drifts as soon as the code moves. A snapshot keeps a
 * pointer (commit, path, line range, hash of the original lines) plus a short redacted excerpt, so a
 * reviewer can always compare “what we saw then” with “what the code says now”, even after squash
 * merges or shallow clones made the commit unreachable.
 *
 * Files: `<dir>/<entryId>/<evidenceId>@r<revision>-<time>.md` — a small front matter and the excerpt.
 * Confirming an entry again adds a new snapshot and keeps the previous ones (newest 3 per evidence).
 */
export const SNAPSHOT_MAX_LINES = 20;
export const SNAPSHOT_KEEP_PER_EVIDENCE = 3;

export interface EvidenceSnapshot {
  entryId: string;
  revision: number;
  evidenceId: string;
  sourceType: Evidence['source_type'];
  locator: string;
  /** Commit the excerpt was read at (null outside a Git repository). */
  commit: string | null;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  /** sha256 of the original (unredacted) lines; used to verify against Git later. */
  sourceSha256: string;
  excerpt: string;
  /** How many secrets were masked in the excerpt. */
  redacted: number;
  truncated: boolean;
  capturedAt: string;
  capturedBy: string;
}

export interface SnapshotVerification {
  status: 'verified' | 'mismatch' | 'unavailable';
  detail: string;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** `path/to/file.ts#L10-L20` → parts; anything else → null. */
export function parseLineLocator(locator: string): { filePath: string; start: number; end: number } | null {
  const m = /^([^#]+)#L(\d+)(?:-L?(\d+))?$/.exec(locator.trim());
  if (!m) return null;
  const start = Number(m[2]);
  const end = Number(m[3] ?? m[2]);
  if (!(start >= 1) || end < start) return null;
  return { filePath: m[1]!, start, end };
}

function safeRelative(root: string, rel: string): string | null {
  if (path.isAbsolute(rel)) return null;
  const full = path.resolve(root, rel);
  return full.startsWith(path.resolve(root) + path.sep) ? full : null;
}

function encodeFile(s: EvidenceSnapshot): string {
  const { excerpt, ...meta } = s;
  // Four backticks so excerpts containing ``` stay intact.
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n\n\`\`\`\`text\n${excerpt}\n\`\`\`\`\n`;
}

function decodeFile(text: string): EvidenceSnapshot | null {
  const m = /^---\n([\s\S]*?)\n---\n\n````text\n([\s\S]*?)\n````\n?$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return null;
  try {
    return { ...(JSON.parse(m[1]!) as Omit<EvidenceSnapshot, 'excerpt'>), excerpt: m[2]! };
  } catch {
    return null;
  }
}

export class EvidenceSnapshots {
  private readonly projectRoot: string;
  private readonly repoDir: string;
  private readonly localDir: string;
  private readonly globalDir: string;
  private readonly actor: () => string;

  constructor(options: { projectRoot: string; repoDir: string; localDir: string; globalDir?: string; actor: () => string }) {
    this.projectRoot = options.projectRoot;
    this.repoDir = options.repoDir;
    this.localDir = options.localDir;
    this.globalDir = options.globalDir ?? options.localDir;
    this.actor = options.actor;
  }

  /** Repository entries keep snapshots in the repository; trials and personal entries stay on this machine. */
  dirFor(entry: Pick<KnowledgeEntry, 'id' | 'status' | 'layer'>): string {
    if (entry.status === 'probation') return path.join(this.localDir, entry.id);
    // Machine-wide entries are read from every repository, so their snapshots are kept machine-wide too.
    if (entry.layer === 'personal' || entry.layer === 'shared_tech') return path.join(this.globalDir, entry.id);
    return path.join(this.repoDir, entry.id);
  }

  /** Reads one piece of evidence as it stands now, without writing anything. */
  read(evidence: Evidence, head = git(this.projectRoot, ['rev-parse', 'HEAD'])?.trim() ?? null): Omit<EvidenceSnapshot, 'entryId' | 'revision' | 'capturedAt' | 'capturedBy'> {
    const base = { evidenceId: evidence.id, sourceType: evidence.source_type, locator: evidence.locator };
    const loc = parseLineLocator(evidence.locator);
    // Any evidence that points at lines in the repository (a commit's touched lines included) is read from the file.
    if (loc && evidence.source_type !== 'session_turn') {
      const full = safeRelative(this.projectRoot, loc.filePath);
      if (full && fs.existsSync(full)) {
        const lines = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').split('\n').slice(loc.start - 1, loc.end);
        const original = lines.join('\n');
        const shown = lines.slice(0, SNAPSHOT_MAX_LINES).join('\n');
        const red = redactSensitiveText(shown);
        return {
          ...base, commit: head, filePath: loc.filePath, startLine: loc.start, endLine: loc.end,
          sourceSha256: sha256Hex(original), excerpt: red.redactedText, redacted: red.redactedCount,
          truncated: lines.length > SNAPSHOT_MAX_LINES,
        };
      }
    }
    if (evidence.source_type === 'git_commit') {
      const sha = evidence.source_ref.trim();
      const show = /^[0-9a-f]{7,64}$/i.test(sha) ? git(this.projectRoot, ['show', '--no-color', '--stat', '--format=%H%n%s%n%n%b', sha]) : null;
      if (show) {
        const lines = show.trimEnd().split('\n');
        const red = redactSensitiveText(lines.slice(0, SNAPSHOT_MAX_LINES).join('\n'));
        return {
          ...base, commit: lines[0] ?? sha, filePath: null, startLine: null, endLine: null,
          sourceSha256: sha256Hex(show), excerpt: red.redactedText, redacted: red.redactedCount, truncated: lines.length > SNAPSHOT_MAX_LINES,
        };
      }
    }
    // Not readable from the repository (session turn, external doc, missing file): keep the summary.
    const red = redactSensitiveText(evidence.summary ?? '');
    return {
      ...base, commit: head, filePath: loc?.filePath ?? null, startLine: loc?.start ?? null, endLine: loc?.end ?? null,
      sourceSha256: sha256Hex(evidence.summary ?? ''), excerpt: red.redactedText, redacted: red.redactedCount, truncated: false,
    };
  }

  /** Captures every piece of evidence as it stands now; earlier snapshots are kept (see prune). */
  capture(entry: KnowledgeEntry): EvidenceSnapshot[] {
    if (!entry.evidence.length) return [];
    const head = git(this.projectRoot, ['rev-parse', 'HEAD'])?.trim() ?? null;
    const dir = this.dirFor(entry);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const out: EvidenceSnapshot[] = [];
    for (const ev of entry.evidence) {
      const snap: EvidenceSnapshot = { entryId: entry.id, revision: entry.revision, ...this.read(ev, head), capturedAt: now, capturedBy: this.actor() };
      writeFileAtomicSync(path.join(dir, `${safeName(ev.id)}@r${entry.revision}-${now.replace(/[-:.TZ]/g, '')}.md`), encodeFile(snap));
      out.push(snap);
    }
    this.prune(entry);
    return out;
  }

  /** All snapshots of an entry, newest revision first. */
  list(entry: Pick<KnowledgeEntry, 'id' | 'status' | 'layer'>): EvidenceSnapshot[] {
    const dirs = [...new Set([this.dirFor(entry), path.join(this.repoDir, entry.id), path.join(this.localDir, entry.id), path.join(this.globalDir, entry.id)])];
    const seen = new Set<string>();
    const out: EvidenceSnapshot[] = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.md') || seen.has(name)) continue;
        const snap = decodeFile(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (snap) {
          seen.add(name);
          out.push(snap);
        }
      }
    }
    return out.sort((a, b) => b.revision - a.revision || b.capturedAt.localeCompare(a.capturedAt) || a.evidenceId.localeCompare(b.evidenceId));
  }

  /** Latest snapshot per evidence id. */
  latest(entry: Pick<KnowledgeEntry, 'id' | 'status' | 'layer'>): Map<string, EvidenceSnapshot> {
    const map = new Map<string, EvidenceSnapshot>();
    for (const s of this.list(entry)) if (!map.has(s.evidenceId)) map.set(s.evidenceId, s);
    return map;
  }

  /** Re-reads the original lines from Git at the recorded commit and compares hashes. */
  verify(snapshot: EvidenceSnapshot): SnapshotVerification {
    if (snapshot.sourceType === 'git_commit' && !snapshot.filePath && snapshot.commit) {
      const show = git(this.projectRoot, ['show', '--no-color', '--stat', '--format=%H%n%s%n%n%b', snapshot.commit]);
      if (show === null) return { status: 'unavailable', detail: '该提交已不在本地仓库（可能被压缩合并或浅克隆）' };
      return sha256Hex(show) === snapshot.sourceSha256
        ? { status: 'verified', detail: `与提交 ${snapshot.commit.slice(0, 7)} 的说明一致` }
        : { status: 'mismatch', detail: '快照与提交说明不一致，可能被手工改过' };
    }
    if (!snapshot.commit || !snapshot.filePath || !snapshot.startLine || !snapshot.endLine) {
      return { status: 'unavailable', detail: '这条证据不在代码里，无法从 Git 校验' };
    }
    const blob = git(this.projectRoot, ['show', `${snapshot.commit}:${snapshot.filePath}`]);
    if (blob === null) return { status: 'unavailable', detail: '当时的提交已不在本地仓库（可能被压缩合并或浅克隆）' };
    const original = blob.replace(/\r\n/g, '\n').split('\n').slice(snapshot.startLine - 1, snapshot.endLine).join('\n');
    return sha256Hex(original) === snapshot.sourceSha256
      ? { status: 'verified', detail: `与提交 ${snapshot.commit.slice(0, 7)} 中的原文一致` }
      : { status: 'mismatch', detail: '快照与当时提交中的原文不一致，可能被手工改过' };
  }

  /** Moves snapshots along when an entry changes zone (trial promoted into the repository). */
  relocate(before: Pick<KnowledgeEntry, 'id' | 'status' | 'layer'>, after: Pick<KnowledgeEntry, 'id' | 'status' | 'layer'>): void {
    const from = this.dirFor(before);
    const to = this.dirFor(after);
    if (from === to || !fs.existsSync(from)) return;
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) fs.renameSync(path.join(from, name), path.join(to, name));
    fs.rmSync(from, { recursive: true, force: true });
  }

  /** Keeps the newest snapshots per evidence id. */
  prune(entry: Pick<KnowledgeEntry, 'id' | 'status' | 'layer'>, keep = SNAPSHOT_KEEP_PER_EVIDENCE): number {
    const dir = this.dirFor(entry);
    if (!fs.existsSync(dir)) return 0;
    const byEvidence = new Map<string, Array<{ name: string; rev: number; time: string }>>();
    for (const name of fs.readdirSync(dir)) {
      const m = /^(.*)@r(\d+)(?:-(\d+))?\.md$/.exec(name);
      if (!m) continue;
      const list = byEvidence.get(m[1]!) ?? [];
      list.push({ name, rev: Number(m[2]), time: m[3] ?? '' });
      byEvidence.set(m[1]!, list);
    }
    let removed = 0;
    for (const list of byEvidence.values()) {
      for (const old of list.sort((a, b) => b.rev - a.rev || b.time.localeCompare(a.time)).slice(keep)) {
        fs.rmSync(path.join(dir, old.name), { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}

function safeName(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned || `EV-${randomUUID().slice(0, 8)}`;
}
