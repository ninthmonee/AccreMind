import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256Hex, writeFileAtomicSync } from '../codec/atomic-fs.ts';
import { redactSensitiveText } from '../capture/secret-redactor.ts';
import type { SessionContext } from '../contracts/types.ts';
import type { LocalMarkdownSqliteStore } from '../store/local-store.ts';
import {
  DOC_CATEGORIES,
  DOC_CATEGORY_LABEL,
  DOC_SCOPE_LABEL,
  isDocCategory,
  isShareableCategory,
  SCOPES_FOR_CATEGORY,
  type DocScope,
  parseDoc,
  sectionId,
  sectionSha,
  serializeDoc,
  type DocCategory,
  type ParsedDoc,
} from './doc-format.ts';
import { addToVocabularyFile, readVocabularyFile, tagIdFor, Vocabulary, type VocabularyTag } from './vocabulary.ts';

const GLOBAL = '__global__';
/** Index source ID of the knowledge base's documents. */
export const KB_SOURCE = '__kb__';
const PERSONAL_PREFIX = 'personal:';

/** Where a document lives: this repository, the knowledge base, another repository (by ID), or a person's folder. */
export type DocHome = 'repo' | 'kb' | 'personal' | { repo: string };
export type DocChangeOp = 'create_doc' | 'add_section' | 'update_section' | 'delete_section' | 'import' | 'manual_edit' | 'delete_doc';

/** One line of `.accremind/docs/changes.ndjson` (append-only, Git-shared): what changed in which document and why. */
export interface DocChange {
  id: string;
  at: string;
  actor: string;
  docId: string;
  docTitle: string;
  category: DocCategory;
  op: DocChangeOp;
  section: string | null;
  before: string | null;
  after: string | null;
  rationale: string;
  proposalId: string | null;
  version: number;
  /** Where the document lives, when not this repository (`kb`, `personal`, or another repository's ID). */
  home?: string;
}

export interface DocProposal {
  id: string;
  docId: string | null;
  category: DocCategory;
  docTitle: string | null;
  sectionHeading: string;
  op: 'create_doc' | 'add_section' | 'update_section' | 'delete_section';
  content: string;
  baseSha: string | null;
  rationale: string;
  evidence: string | null;
  source: string;
  sessionId: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  /** Who should decide: the owners of the document's domains (domain documents) or of the repository. */
  owners?: string[];
  assignedToMe?: boolean;
}

export interface DocHit {
  ref: string;
  docId: string;
  sectionId: string;
  docTitle: string;
  heading: string;
  category: DocCategory;
  snippet: string;
  score: number;
  originRepo: string | null;
  matchedTags: string[];
  scope: DocScope;
}

interface DocSource {
  wsId: string;
  dir: string;
  category: DocCategory;
  /** Must name its domains to be served (shareable documents from outside this repository). */
  foreign: boolean;
  /** Folder whose `changes.ndjson` records changes to it; null = read-only here (another repository's). */
  changesRoot: string | null;
}

/** Folder-safe form of a user ID. */
function safeUser(id: string): string {
  return id.replace(/[^A-Za-z0-9_.@-]+/g, '_').slice(0, 80) || 'me';
}

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.2);
}

function cjkShortTerms(q: string): string[] {
  const out = new Set<string>();
  for (const seg of q.match(/[一-鿿]{2,}/g) ?? []) for (let i = 0; i + 2 <= seg.length; i += 1) out.add(seg.slice(i, i + 2));
  return [...out].slice(0, 24);
}

function ftsTerms(q: string): string[] {
  const set = new Set<string>();
  for (const w of q.match(/[A-Za-z0-9_.-]{3,}/g) ?? []) set.add(w);
  for (const seg of q.match(/[一-鿿]{3,}/g) ?? []) for (let i = 0; i + 3 <= seg.length; i += 1) set.add(seg.slice(i, i + 3));
  return [...set].slice(0, 24);
}

/**
 * The rule document sets of this repository (`.accremind/docs/<category>/*.md`) plus the shareable ones
 * (domain, business rules) of other registered repositories with a common business domain:
 * section-level index and retrieval, the project profile as resident context, proposals a person decides on,
 * and a change log of every change (accepted proposals, imports and edits made directly in the files).
 */
export class DocLibrary {
  private readonly store: LocalMarkdownSqliteStore;
  private dirMtimes = new Map<string, number>();
  private vocabCache: { key: string; vocab: Vocabulary } | null = null;

  constructor(store: LocalMarkdownSqliteStore) {
    this.store = store;
  }

  get docsDir(): string {
    return path.join(this.store.paths.projectAccreMindDir, 'docs');
  }

  get changesFile(): string {
    return path.join(this.docsDir, 'changes.ndjson');
  }

  /** Documents of the knowledge base that belong to no single project. */
  get kbDocsDir(): string {
    return path.join(this.store.knowledgeBase.root, 'docs');
  }

  /** The identity personal documents were last gathered for; switching identity gathers them again. */
  private adoptedUser: string | null = null;

  /** This person's documents (preferences), on this machine only. */
  get personalDocsDir(): string {
    const user = this.store.currentUser();
    const dir = path.join(this.store.paths.personalDir, 'docs', safeUser(user.userId));
    if (this.adoptedUser !== user.userId) {
      this.adoptedUser = user.userId;
      try {
        this.adoptPersonalDocs(user.aliases, dir);
      } catch (err) {
        console.warn(`[accremind] could not move personal documents: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return dir;
  }

  /**
   * Personal documents follow the person, not one account: when the same person shows up under another ID
   * (signed in to DSH after using the local identity, or back), the documents kept under the other ID move here.
   * Identical files are merged; a different file with the same name is kept under a suffixed name.
   */
  private adoptPersonalDocs(aliases: string[], dir: string): void {
    const base = path.join(this.store.paths.personalDir, 'docs');
    for (const alias of aliases) {
      const from = path.join(base, safeUser(alias));
      if (from === dir || !fs.existsSync(from)) continue;
      fs.mkdirSync(dir, { recursive: true });
      for (const name of fs.readdirSync(from)) {
        const src = path.join(from, name);
        const dst = path.join(dir, name);
        if (!fs.statSync(src).isFile()) continue;
        if (name === 'changes.ndjson') {
          fs.appendFileSync(dst, fs.readFileSync(src));
          fs.rmSync(src);
        } else if (!fs.existsSync(dst)) {
          fs.renameSync(src, dst);
        } else if (fs.readFileSync(src, 'utf8') === fs.readFileSync(dst, 'utf8')) {
          fs.rmSync(src);
        } else {
          const ext = path.extname(name);
          fs.renameSync(src, path.join(dir, `${path.basename(name, ext)}-${safeUser(alias).slice(-6)}${ext}`));
        }
      }
      try {
        fs.rmdirSync(from);
      } catch {
        // something else left in it
      }
      const ws = `${PERSONAL_PREFIX}${alias}`;
      const rows = this.db.prepare('SELECT doc_id FROM doc_files WHERE workspace_id = ?').all(ws) as Array<{ doc_id: string }>;
      for (const r of rows) this.removeDoc(ws, r.doc_id);
    }
  }

  private get personalSource(): string {
    return `${PERSONAL_PREFIX}${this.store.currentUser().userId}`;
  }

  /** Folder holding the change log of a document's home. */
  private changesRootFor(wsId: string): string | null {
    if (wsId === this.store.workspaceId) return this.docsDir;
    if (wsId === KB_SOURCE) return this.kbDocsDir;
    if (wsId.startsWith(PERSONAL_PREFIX)) return this.personalDocsDir;
    const rec = this.store.registry.get(wsId);
    return rec ? path.join(rec.root, path.basename(this.store.paths.projectAccreMindDir), 'docs') : null;
  }

  private homeLabel(wsId: string): string | undefined {
    if (wsId === this.store.workspaceId) return undefined;
    if (wsId === KB_SOURCE) return 'kb';
    if (wsId.startsWith(PERSONAL_PREFIX)) return 'personal';
    return wsId;
  }

  get vocabularyFile(): string {
    return path.join(this.store.paths.projectAccreMindDir, 'vocabulary.json');
  }

  private get db() {
    return this.store.rawDb;
  }

  private sources(): DocSource[] {
    const own: DocSource[] = DOC_CATEGORIES.filter((c) => c !== 'personal_preferences')
      .map((category) => ({ wsId: this.store.workspaceId, dir: path.join(this.docsDir, category), category, foreign: false, changesRoot: this.docsDir }));
    const kb: DocSource[] = DOC_CATEGORIES.filter(isShareableCategory)
      .map((category) => ({ wsId: KB_SOURCE, dir: path.join(this.kbDocsDir, category), category, foreign: true, changesRoot: this.kbDocsDir }));
    const personal: DocSource = { wsId: this.personalSource, dir: this.personalDocsDir, category: 'personal_preferences', foreign: false, changesRoot: this.personalDocsDir };
    const me = path.resolve(this.store.paths.projectRoot);
    const kbRoot = path.resolve(this.kbDocsDir);
    const foreign: DocSource[] = [];
    for (const rec of this.store.registry.list()) {
      if (rec.repo_id === this.store.workspaceId || path.resolve(rec.root) === me) continue;
      for (const category of DOC_CATEGORIES.filter(isShareableCategory)) {
        const dir = path.join(rec.root, path.basename(this.store.paths.projectAccreMindDir), 'docs', category);
        // The knowledge base may itself be a registered repository: read it once, as the knowledge base.
        if (path.resolve(dir).startsWith(kbRoot + path.sep)) continue;
        if (fs.existsSync(dir)) foreign.push({ wsId: rec.repo_id, dir, category, foreign: true, changesRoot: null });
      }
    }
    return [...own, ...kb, personal, ...foreign];
  }

  // ---------- indexing ----------

  /** Indexes every document set this repository reads; records direct edits of its own documents in the change log. */
  reconcile(): { docs: number; sections: number } {
    let docs = 0;
    let sections = 0;
    const seen = new Set<string>();
    for (const src of this.sources()) {
      const r = this.scanDir(src, seen);
      docs += r.docs;
      sections += r.sections;
    }
    // Prune documents whose files are gone (only in folders this repository scans).
    const scannedDirs = new Set(this.sources().map((s) => `${s.wsId}::${path.resolve(s.dir)}`));
    const rows = this.db.prepare('SELECT workspace_id, doc_id, file_path, category, title, version FROM doc_files').all() as
      Array<{ workspace_id: string; doc_id: string; file_path: string; category: string; title: string; version: number }>;
    const known = new Set([this.store.workspaceId, ...this.store.registry.list().map((r) => r.repo_id)]);
    for (const r of rows) {
      const key = `${r.workspace_id}::${r.doc_id}`;
      if (seen.has(key)) continue;
      const inScanned = scannedDirs.has(`${r.workspace_id}::${path.dirname(path.resolve(r.file_path))}`);
      // Other people's personal folders on this machine are indexed by their own sessions.
      if (!inScanned && (known.has(r.workspace_id) || r.workspace_id.startsWith(PERSONAL_PREFIX))) continue;
      const root = inScanned ? this.changesRootFor(r.workspace_id) : null;
      if (root && isDocCategory(r.category)) {
        this.appendChange({ docId: r.doc_id, docTitle: r.title, category: r.category, op: 'delete_doc', section: null,
          before: null, after: null, rationale: '文档文件已被删除', proposalId: null, version: r.version }, r.workspace_id);
      }
      this.removeDoc(r.workspace_id, r.doc_id);
    }
    this.vocabCache = null;
    return { docs, sections };
  }

  /** Cheap check (folder mtimes) run before each search; re-scans only changed folders. */
  refreshIfChanged(): void {
    let changed = false;
    for (const src of this.sources()) {
      let m: number | undefined;
      try {
        m = fs.statSync(src.dir).mtimeMs;
      } catch {
        m = undefined;
      }
      const key = `${src.wsId}::${src.dir}`;
      if (this.dirMtimes.get(key) !== m) changed = true;
    }
    if (changed) this.reconcile();
  }

  private scanDir(src: DocSource, seen: Set<string>): { docs: number; sections: number } {
    const key = `${src.wsId}::${src.dir}`;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(src.dir);
    } catch {
      this.dirMtimes.delete(key);
      return { docs: 0, sections: 0 };
    }
    this.dirMtimes.set(key, stat.mtimeMs);
    let docs = 0;
    let sections = 0;
    for (const name of fs.readdirSync(src.dir).filter((n) => n.endsWith('.md') && !n.startsWith('.') && n !== 'CHANGELOG.md').sort()) {
      const file = path.join(src.dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const fallbackId = `D-${src.category}-${name.replace(/\.md$/, '').replace(/[^A-Za-z0-9_一-鿿-]+/g, '-')}`;
      const known = this.db.prepare('SELECT doc_id, file_sha, mtime_ms, size FROM doc_files WHERE workspace_id = ? AND file_path = ?')
        .get(src.wsId, file) as { doc_id: string; file_sha: string; mtime_ms: number | null; size: number | null } | undefined;
      if (known && known.mtime_ms === Math.trunc(st.mtimeMs) && known.size === st.size) {
        seen.add(`${src.wsId}::${known.doc_id}`);
        docs += 1;
        continue;
      }
      const raw = fs.readFileSync(file, 'utf8');
      const fileSha = sha256Hex(raw);
      let doc: ParsedDoc;
      try {
        doc = parseDoc(raw, { id: fallbackId, category: src.category });
      } catch {
        continue;
      }
      // A shareable document from another repository is served only if it names its business domains.
      if (src.foreign && !doc.meta.domains.length) continue;
      if (known && known.file_sha === fileSha) {
        this.db.prepare('UPDATE doc_files SET mtime_ms = ?, size = ? WHERE workspace_id = ? AND doc_id = ?')
          .run(Math.trunc(st.mtimeMs), st.size, src.wsId, known.doc_id);
        seen.add(`${src.wsId}::${known.doc_id}`);
        docs += 1;
        continue;
      }
      if (src.changesRoot && known) this.recordManualEdits(src.wsId, doc, known.doc_id);
      this.indexDoc(src.wsId, file, doc, fileSha, st);
      seen.add(`${src.wsId}::${doc.meta.id}`);
      docs += 1;
      sections += doc.sections.length;
    }
    return { docs, sections };
  }

  /** Compares a directly edited document with what was indexed and writes one change per section. */
  private recordManualEdits(wsId: string, doc: ParsedDoc, previousId: string): void {
    const prev = this.db.prepare('SELECT section_id, heading, body, section_sha FROM doc_sections WHERE workspace_id = ? AND doc_id = ?')
      .all(wsId, previousId) as Array<{ section_id: string; heading: string; body: string; section_sha: string }>;
    if (!prev.length && !doc.sections.length) return;
    const lastChange = this.listChanges({ docId: doc.meta.id, limit: 1, home: wsId })[0];
    const before = new Map(prev.map((p) => [p.section_id, p]));
    const withIntro = doc.intro ? [{ id: '_intro', heading: '概述', body: doc.intro, sha: sectionSha('概述', doc.intro) }, ...doc.sections] : doc.sections;
    const after = new Map(withIntro.map((s) => [s.id, s]));
    const base = { docId: doc.meta.id, docTitle: doc.meta.title, category: doc.meta.category, rationale: '直接编辑文档文件', proposalId: null, version: doc.meta.version };
    // A write made by an accepted proposal is already in the log with the same content.
    const sameAsLast = (sec: string, text: string | null) => lastChange && lastChange.section === sec && lastChange.after === text;
    for (const [id, s] of after) {
      const p = before.get(id);
      if (!p) {
        if (!sameAsLast(s.heading, s.body)) this.appendChange({ ...base, op: 'manual_edit', section: s.heading, before: null, after: s.body }, wsId);
      } else if (p.section_sha !== s.sha) {
        if (!sameAsLast(s.heading, s.body)) this.appendChange({ ...base, op: 'manual_edit', section: s.heading, before: p.body, after: s.body }, wsId);
        this.flagCitations(doc.meta.id, id, s.heading, '依据的规则文档章节被直接修改');
      }
    }
    for (const [id, p] of before) {
      if (!after.has(id)) {
        if (!sameAsLast(p.heading, null)) this.appendChange({ ...base, op: 'manual_edit', section: p.heading, before: p.body, after: null }, wsId);
        this.flagCitations(doc.meta.id, id, p.heading, '依据的规则文档章节已被删除');
      }
    }
  }

  /** Re-indexes a file after AccreMind itself wrote it (no "direct edit" entry). */
  private reindexOwnFile(file: string, category: DocCategory, wsId = this.store.workspaceId): void {
    const raw = fs.readFileSync(file, 'utf8');
    const fallbackId = `D-${category}-${path.basename(file).replace(/\.md$/, '').replace(/[^A-Za-z0-9_\u4e00-\u9fff-]+/g, '-')}`;
    this.indexDoc(wsId, file, parseDoc(raw, { id: fallbackId, category }), sha256Hex(raw), fs.statSync(file));
    // Keep the folder mtime cache current so the write is not mistaken for someone else's edit.
    try {
      this.dirMtimes.set(`${wsId}::${path.dirname(file)}`, fs.statSync(path.dirname(file)).mtimeMs);
    } catch {
      // next refresh re-scans
    }
    this.vocabCache = null;
  }

  /** Entries that cite a section as evidence go back to review when the section changes. */
  private flagCitations(docId: string, sectionIdValue: string, heading: string, reason: string): void {
    try {
      this.store.flagEntriesCitingDoc?.(docId, sectionIdValue, heading, reason);
    } catch (err) {
      console.warn(`[accremind] could not flag entries citing ${docId}#${sectionIdValue}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private removeDoc(wsId: string, docId: string): void {
    const rows = this.db.prepare('SELECT rowid AS rid FROM doc_sections WHERE workspace_id = ? AND doc_id = ?').all(wsId, docId) as Array<{ rid: number }>;
    for (const r of rows) this.db.prepare('DELETE FROM doc_fts WHERE rowid = ?').run(r.rid);
    this.db.prepare('DELETE FROM doc_sections WHERE workspace_id = ? AND doc_id = ?').run(wsId, docId);
    this.db.prepare('DELETE FROM doc_files WHERE workspace_id = ? AND doc_id = ?').run(wsId, docId);
  }

  private scopeOf(wsId: string, doc: ParsedDoc): DocScope {
    if (doc.meta.scope) return doc.meta.scope;
    if (wsId.startsWith(PERSONAL_PREFIX) || doc.meta.category === 'personal_preferences') return 'personal';
    return isShareableCategory(doc.meta.category) && (doc.meta.domains.length || wsId !== this.store.workspaceId) ? 'domain' : 'project';
  }

  private indexDoc(wsId: string, file: string, doc: ParsedDoc, fileSha: string, st: fs.Stats): void {
    const domainsCsv = doc.meta.domains.length ? `,${doc.meta.domains.join(',')},` : '';
    const scope = this.scopeOf(wsId, doc);
    const audience = doc.meta.audience ?? 'all';
    const subproject = doc.meta.subproject ?? null;
    const tagIds = doc.meta.tags.map(tagIdFor);
    const tagsCsv = tagIds.length ? `,${tagIds.join(',')},` : '';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prevIds = this.db.prepare('SELECT doc_id FROM doc_files WHERE workspace_id = ? AND file_path = ?').all(wsId, file) as Array<{ doc_id: string }>;
      for (const p of prevIds) this.removeDoc(wsId, p.doc_id);
      this.removeDoc(wsId, doc.meta.id);
      this.db.prepare(`INSERT INTO doc_files (workspace_id, doc_id, file_path, category, title, domains_csv, tags_json, version, file_sha, mtime_ms, size,
        scope, audience, subproject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(wsId, doc.meta.id, file, doc.meta.category, doc.meta.title, domainsCsv,
        JSON.stringify(doc.meta.tags), doc.meta.version, fileSha, Math.trunc(st.mtimeMs), st.size, scope, audience, subproject);
      const ins = this.db.prepare(`INSERT INTO doc_sections (workspace_id, doc_id, section_id, category, doc_title, heading, body,
        domains_csv, tags_csv, file_path, section_sha, doc_version, ord, scope, audience, subproject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const fts = this.db.prepare('INSERT INTO doc_fts (rowid, doc_title, heading, body) VALUES (?, ?, ?, ?)');
      const all = doc.intro ? [{ id: '_intro', heading: '概述', body: doc.intro, sha: sectionSha('概述', doc.intro) }, ...doc.sections] : doc.sections;
      all.forEach((s, ord) => {
        const r = ins.run(wsId, doc.meta.id, s.id, doc.meta.category, doc.meta.title, s.heading, s.body, domainsCsv, tagsCsv, file, s.sha, doc.meta.version, ord,
          scope, audience, subproject);
        fts.run(r.lastInsertRowid, doc.meta.title, s.heading, s.body);
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- vocabulary ----------

  /** The controlled vocabulary for this repository (cached until its inputs change). */
  vocabulary(): Vocabulary {
    const ctx = this.store.sessionContext();
    let vocabMtime = 0;
    try {
      vocabMtime = fs.statSync(this.vocabularyFile).mtimeMs;
    } catch {
      vocabMtime = 0;
    }
    const docRows = this.db.prepare(`SELECT workspace_id, title, domains_csv, tags_json, version FROM doc_files`).all() as
      Array<{ workspace_id: string; title: string; domains_csv: string; tags_json: string; version: number }>;
    const visible = docRows.filter((d) => d.workspace_id === this.store.workspaceId ||
      ctx.domains.some((dom) => d.domains_csv.toLowerCase().includes(`,${dom.toLowerCase()},`)));
    const key = JSON.stringify([vocabMtime, ctx.domains, Object.keys(ctx.dependencies).sort(), visible.map((d) => `${d.workspace_id}:${d.version}:${d.tags_json}`)]);
    if (this.vocabCache?.key === key) return this.vocabCache.vocab;
    const tags: VocabularyTag[] = [];
    for (const t of readVocabularyFile(this.vocabularyFile).tags) {
      tags.push({ id: t.id, label: t.label, aliases: t.aliases ?? [], kind: t.kind ?? 'term', source: 'manual' });
    }
    for (const d of visible) {
      for (const label of JSON.parse(d.tags_json || '[]') as string[]) tags.push({ id: tagIdFor(label), label, aliases: [], kind: 'term', source: 'doc' });
      for (const dom of d.domains_csv.split(',').filter(Boolean)) tags.push({ id: tagIdFor(dom), label: dom, aliases: [], kind: 'domain', source: 'doc' });
    }
    for (const dom of ctx.domains) tags.push({ id: tagIdFor(dom), label: dom, aliases: [], kind: 'domain', source: 'repo' });
    for (const dep of Object.keys(ctx.dependencies).slice(0, 200)) {
      const short = dep.replace(/^@[^/]+\//, '');
      if (short.length < 2) continue;
      tags.push({ id: `tech:${dep}`, label: dep, aliases: short !== dep ? [short] : [], kind: 'tech', source: 'dependency' });
    }
    const vocab = new Vocabulary(tags);
    this.vocabCache = { key, vocab };
    return vocab;
  }

  /** Records terms a model wanted but the vocabulary lacks; a person accepts them into `.accremind/vocabulary.json`. */
  proposeTags(items: Array<{ label: string; kind?: VocabularyTag['kind']; example?: string }>): void {
    const vocab = this.vocabulary();
    for (const it of items.slice(0, 5)) {
      const label = it.label?.trim();
      if (!label || label.length > 40 || vocab.has(tagIdFor(label))) continue;
      const id = `VP-${tagIdFor(label)}`;
      const row = this.db.prepare('SELECT status FROM vocab_proposals WHERE id = ?').get(id) as { status: string } | undefined;
      if (row) {
        if (row.status === 'pending') this.db.prepare('UPDATE vocab_proposals SET count = count + 1 WHERE id = ?').run(id);
        continue;
      }
      this.db.prepare(`INSERT INTO vocab_proposals (id, label, kind, aliases, count, example, status, created_at)
        VALUES (?, ?, ?, '[]', 1, ?, 'pending', ?)`).run(id, label, it.kind ?? 'term',
        it.example ? redactSensitiveText(it.example).redactedText.slice(0, 200) : null, new Date().toISOString());
    }
  }

  listTagProposals(status: 'pending' | 'accepted' | 'rejected' | 'all' = 'pending') {
    const rows = this.db.prepare(`SELECT * FROM vocab_proposals ${status === 'all' ? '' : 'WHERE status = ?'} ORDER BY count DESC, created_at`)
      .all(...(status === 'all' ? [] : [status])) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: String(r.id), label: String(r.label), kind: String(r.kind ?? 'term'), count: Number(r.count),
      example: r.example ? String(r.example) : null, status: String(r.status), createdAt: String(r.created_at) }));
  }

  decideTag(id: string, decision: 'accept' | 'reject', edit: { label?: string; aliases?: string[]; kind?: VocabularyTag['kind'] } = {}) {
    const row = this.db.prepare('SELECT * FROM vocab_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`未找到词条提议: ${id}`);
    if (row.status !== 'pending') throw new Error('该词条提议已处理');
    if (decision === 'accept') {
      const label = edit.label?.trim() || String(row.label);
      addToVocabularyFile(this.vocabularyFile, [{ label, aliases: edit.aliases ?? [], kind: edit.kind ?? (String(row.kind) as VocabularyTag['kind']) }]);
      this.vocabCache = null;
    }
    this.db.prepare('UPDATE vocab_proposals SET status = ?, decided_at = ? WHERE id = ?')
      .run(decision === 'accept' ? 'accepted' : 'rejected', new Date().toISOString(), id);
    return { id, status: decision === 'accept' ? 'accepted' : 'rejected' };
  }

  // ---------- retrieval ----------

  /**
   * Sections relevant to a question: keyword hits (trigram + 2-character terms) and topic tags. Every category
   * of this repository; other repositories' domain and business-rule documents only for a shared domain.
   */
  search(input: { query: string; ctx: SessionContext; tags?: string[]; limit?: number; categories?: DocCategory[] }): DocHit[] {
    try {
      this.refreshIfChanged();
    } catch {
      // serve what is indexed
    }
    const q = input.query.trim();
    const tags = new Set([...(input.tags ?? []), ...this.vocabulary().tagText(q)]);
    if (!q && !tags.size) return [];
    const domains = JSON.stringify(input.ctx.domains ?? []);
    const rows = (this.db.prepare(`SELECT rowid AS rid, * FROM doc_sections WHERE category != 'personal_preferences' AND (workspace_id = ?
        OR (category IN ('domain', 'business_rules') AND EXISTS (SELECT 1 FROM json_each(?) d WHERE doc_sections.domains_csv LIKE '%,' || d.value || ',%')))`)
      .all(this.store.workspaceId, domains) as Array<{
      rid: number; workspace_id: string; doc_id: string; section_id: string; category: DocCategory; doc_title: string; heading: string;
      body: string; tags_csv: string; domains_csv: string; scope: DocScope | null; audience: string | null; subproject: string | null;
    }>).filter((r) => this.visibleTo(r, input.ctx));
    if (!rows.length) return [];
    const byRid = new Map(rows.map((r) => [Number(r.rid), r]));
    const scores = new Map<number, number>();
    const terms = ftsTerms(q);
    if (terms.length) {
      const expr = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
      const hits = this.db.prepare(`SELECT rowid AS rid, bm25(doc_fts, 6.0, 8.0, 1.0) AS rank FROM doc_fts WHERE doc_fts MATCH ? ORDER BY rank LIMIT 300`)
        .all(expr) as Array<{ rid: number; rank: number }>;
      for (const h of hits) if (byRid.has(Number(h.rid))) scores.set(Number(h.rid), Math.max(0.5, -h.rank * 10));
    }
    const shortTerms = cjkShortTerms(q);
    const vocab = this.vocabulary();
    const out: DocHit[] = [];
    for (const r of rows) {
      if (input.categories && !input.categories.includes(r.category)) continue;
      let score = scores.get(Number(r.rid)) ?? 0;
      const headLc = `${r.doc_title} ${r.heading}`.toLowerCase();
      for (const t of shortTerms) if (headLc.includes(t)) score += 4;
      const sectionTags = new Set([...r.tags_csv.split(',').filter(Boolean), ...vocab.tagText(`${r.doc_title} ${r.heading} ${r.body.slice(0, 400)}`)]);
      const matchedTags = [...tags].filter((t) => sectionTags.has(t));
      if (!score && !matchedTags.length) continue;
      score += 3 * Math.min(1, matchedTags.length / Math.max(1, Math.min(2, tags.size)));
      if (r.workspace_id !== this.store.workspaceId) score *= 0.9;
      if (r.category === 'business_rules' || r.category === 'project_norms') score *= 1.1;
      out.push({
        ref: `D:${r.doc_id}#${r.section_id}`, docId: r.doc_id, sectionId: r.section_id, docTitle: r.doc_title, heading: r.heading,
        category: r.category, snippet: r.body.replace(/\s+/g, ' ').slice(0, 140), score: Number(score.toFixed(3)),
        originRepo: r.workspace_id === this.store.workspaceId ? null : r.workspace_id === KB_SOURCE ? '团队知识库' : r.workspace_id, matchedTags,
        scope: r.scope ?? 'project',
      });
    }
    return out.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref)).slice(0, input.limit ?? 5);
  }

  /** A section by reference (`D:<doc>#<section>`), from this repository first. */
  getSection(ref: string): { docId: string; docTitle: string; category: DocCategory; heading: string; body: string; version: number; originRepo: string | null } | null {
    const m = /^D:([^#]+)#(.+)$/.exec(ref.trim());
    if (!m) return null;
    const rows = this.db.prepare(`SELECT * FROM doc_sections WHERE doc_id = ? AND section_id = ?
      ORDER BY CASE workspace_id WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END`).all(m[1]!, m[2]!, this.store.workspaceId, KB_SOURCE) as
      Array<{ workspace_id: string; doc_id: string; doc_title: string; category: DocCategory; heading: string; body: string; doc_version: number;
        domains_csv: string; scope: DocScope | null; audience: string | null; subproject: string | null }>;
    const ctx = this.store.sessionContext();
    const row = rows.find((r) => r.workspace_id === this.store.workspaceId || r.workspace_id === this.personalSource || this.visibleTo(r, ctx, { ignoreSubproject: true }));
    if (!row) return null;
    return { docId: row.doc_id, docTitle: row.doc_title, category: row.category, heading: row.heading, body: row.body,
      version: row.doc_version, originRepo: row.workspace_id === this.store.workspaceId ? null : row.workspace_id };
  }

  /**
   * The project profile (basic business attributes) as resident context: each section's heading and first
   * line, byte-stable while the documents do not change.
   */
  residentProfile(maxTokens = 300): string {
    const rows = this.db.prepare(`SELECT doc_title, heading, body FROM doc_sections WHERE workspace_id = ? AND category = 'project_profile'
      ORDER BY doc_id, ord`).all(this.store.workspaceId) as Array<{ doc_title: string; heading: string; body: string }>;
    const lines: string[] = [];
    let used = 0;
    for (const r of rows) {
      const first = r.body.split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).find(Boolean) ?? '';
      const line = `- ${r.heading}：${first.slice(0, 80)}`;
      const cost = estimateTokens(line);
      if (lines.length && used + cost > maxTokens) {
        lines.push('- …（更多见项目概况文档，可调 accremind_search 检索）');
        break;
      }
      used += cost;
      lines.push(line);
    }
    return lines.join('\n');
  }

  /**
   * The person's preferences (personal documents) as resident context, after the team's rules and the project
   * profile and below them in precedence.
   */
  residentPreferences(maxTokens = 120): string {
    const rows = this.db.prepare(`SELECT heading, body FROM doc_sections WHERE workspace_id = ? AND category = 'personal_preferences'
      ORDER BY doc_id, ord`).all(this.personalSource) as Array<{ heading: string; body: string }>;
    const lines: string[] = [];
    let used = 0;
    for (const r of rows) {
      const first = r.body.split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).find(Boolean) ?? '';
      const line = r.heading === '概述' ? `- ${first.slice(0, 100)}` : `- ${r.heading}：${first.slice(0, 80)}`;
      const cost = estimateTokens(line);
      if (lines.length && used + cost > maxTokens) break;
      used += cost;
      lines.push(line);
    }
    return lines.join('\n');
  }

  /**
   * Whether a document (row) reaches this session: own documents (of the active sub-project, if it names one),
   * the person's own, and domain documents of a shared domain — except `core`-only documents where this project
   * only uses the domain.
   */
  private visibleTo(r: { workspace_id: string; domains_csv: string; audience?: string | null; subproject?: string | null; category?: string },
    ctx: SessionContext, opts: { ignoreSubproject?: boolean } = {}): boolean {
    if (r.workspace_id.startsWith(PERSONAL_PREFIX)) return r.workspace_id === this.personalSource;
    if (r.workspace_id === this.store.workspaceId) {
      if (!opts.ignoreSubproject && r.subproject && ctx.subprojects?.length && !ctx.subprojects.includes(r.subproject)) return false;
      if (!r.domains_csv || !isShareableCategory((r.category ?? 'domain') as DocCategory)) return true;
    }
    const docDomains = r.domains_csv.split(',').filter(Boolean).map((d) => d.toLowerCase());
    const keys = new Set(ctx.domains.map((d) => d.toLowerCase()));
    const shared = docDomains.filter((d) => keys.has(d));
    if (!shared.length) return r.workspace_id === this.store.workspaceId;
    if (r.audience === 'core') {
      const consumer = new Set((ctx.consumerDomains ?? []).map((d) => d.toLowerCase()));
      if (shared.every((d) => consumer.has(d))) return r.workspace_id === this.store.workspaceId;
    }
    return true;
  }

  listDocs(): Array<{ docId: string; title: string; category: DocCategory; domains: string[]; tags: string[]; version: number; sections: number;
    file: string; originRepo: string | null; scope: DocScope; audience: 'core' | 'all'; subproject: string | null; home: string }> {
    const rows = this.db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM doc_sections s WHERE s.workspace_id = f.workspace_id AND s.doc_id = f.doc_id) AS n
      FROM doc_files f ORDER BY f.category, f.title`).all() as Array<Record<string, unknown>>;
    const ctx = this.store.sessionContext({ subprojects: [] });
    return rows.filter((r) => this.visibleTo({ workspace_id: String(r.workspace_id), domains_csv: String(r.domains_csv ?? ''),
      audience: r.audience as string | null, subproject: null, category: String(r.category) }, ctx)).map((r) => {
      const ws = String(r.workspace_id);
      return {
        docId: String(r.doc_id), title: String(r.title), category: r.category as DocCategory,
        domains: String(r.domains_csv).split(',').filter(Boolean), tags: JSON.parse(String(r.tags_json || '[]')) as string[],
        version: Number(r.version), sections: Number(r.n),
        file: ws === this.store.workspaceId ? path.relative(this.store.paths.projectRoot, String(r.file_path)) : String(r.file_path),
        originRepo: ws === this.store.workspaceId ? null : ws === KB_SOURCE ? '团队知识库' : ws.startsWith(PERSONAL_PREFIX) ? null : ws,
        scope: (r.scope as DocScope | null) ?? 'project', audience: r.audience === 'core' ? 'core' as const : 'all' as const,
        subproject: r.subproject ? String(r.subproject) : null, home: this.homeLabel(ws) ?? 'repo',
      };
    });
  }

  getDoc(docId: string): (ParsedDoc & { file: string; originRepo: string | null; wsId: string; writable: boolean }) | null {
    const row = this.db.prepare(`SELECT * FROM doc_files WHERE doc_id = ? ORDER BY CASE workspace_id WHEN ? THEN 0 WHEN ? THEN 1 WHEN ? THEN 2 ELSE 3 END LIMIT 1`)
      .get(docId, this.store.workspaceId, this.personalSource, KB_SOURCE) as { workspace_id: string; file_path: string; category: DocCategory } | undefined;
    if (!row || !fs.existsSync(row.file_path)) return null;
    if (row.workspace_id.startsWith(PERSONAL_PREFIX) && row.workspace_id !== this.personalSource) return null;
    const doc = parseDoc(fs.readFileSync(row.file_path, 'utf8'), { id: docId, category: row.category });
    let writable = true;
    try {
      fs.accessSync(row.file_path, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    return { ...doc, file: row.file_path, wsId: row.workspace_id, writable,
      originRepo: row.workspace_id === this.store.workspaceId || row.workspace_id.startsWith(PERSONAL_PREFIX) ? null
        : row.workspace_id === KB_SOURCE ? '团队知识库' : row.workspace_id };
  }

  /** Entries in this repository that cite a document (or one of its sections) as evidence. */
  citedBy(docId: string, sectionIdValue?: string): string[] {
    return this.store.entriesCitingDoc?.(docId, sectionIdValue) ?? [];
  }

  // ---------- import ----------

  /**
   * Imports a Markdown document into `.accremind/docs/<category>/`. The text is kept; front matter is added or
   * completed. Refuses to overwrite an existing document unless `replace` is set.
   */
  importDoc(input: {
    content: string; fileName: string; category: DocCategory; title?: string; domains?: string[]; tags?: string[]; replace?: boolean;
    /** Where the document is mounted (default: the category's first allowed scope). */
    scope?: DocScope;
    /** Domain scope: `kb` (default when a team knowledge base is mounted) or `repo` (this repository hosts it). */
    home?: 'kb' | 'repo';
    audience?: 'core' | 'all';
    subproject?: string;
    /** Add domain names the catalog does not know yet (otherwise an unknown name is refused). */
    createDomains?: boolean;
  }): { docId: string; file: string; sections: number; scope: DocScope; home: 'repo' | 'kb' | 'personal'; domains: string[]; createdDomains: string[] } {
    if (!isDocCategory(input.category)) throw new Error(`未知文档类别：${String(input.category)}（可选 ${DOC_CATEGORIES.join(' / ')}）`);
    const allowed = SCOPES_FOR_CATEGORY[input.category];
    const scope = input.scope ?? allowed[0]!;
    if (!allowed.includes(scope)) {
      throw new Error(`「${DOC_CATEGORY_LABEL[input.category]}」只能挂载到：${allowed.map((s) => DOC_SCOPE_LABEL[s]).join(' / ')}`);
    }
    const base = path.basename(input.fileName).replace(/\.(md|markdown|txt)$/i, '').replace(/[^A-Za-z0-9_一-鿿-]+/g, '-').replace(/^-+|-+$/g, '') || 'doc';
    const doc = parseDoc(input.content, { id: `D-${input.category}-${base}`, category: input.category });
    doc.meta.category = input.category;
    doc.meta.scope = scope;
    if (input.title) doc.meta.title = input.title;
    if (input.tags?.length) doc.meta.tags = [...new Set([...doc.meta.tags, ...input.tags])];
    let dir: string;
    let home: 'repo' | 'kb' | 'personal';
    let wsId: string;
    const createdDomains: string[] = [];
    if (scope === 'personal') {
      dir = this.personalDocsDir;
      home = 'personal';
      wsId = this.personalSource;
      doc.meta.domains = [];
      doc.meta.owner = this.store.currentUser().userId;
    } else if (scope === 'project') {
      if (input.domains?.length) throw new Error('项目范围的文档不属于任何领域；要给领域内的项目共享，请挂载到“领域”');
      if (input.subproject && !this.store.subprojects().some((p) => p.id === input.subproject)) {
        throw new Error(`repo.json 中没有子项目：${input.subproject}`);
      }
      dir = path.join(this.docsDir, input.category);
      home = 'repo';
      wsId = this.store.workspaceId;
      doc.meta.domains = [];
      if (input.subproject) doc.meta.subproject = input.subproject;
    } else {
      const resolved = this.resolveDomains(input.domains?.length ? input.domains : doc.meta.domains, input.createDomains === true);
      doc.meta.domains = resolved.ids;
      createdDomains.push(...resolved.created);
      doc.meta.audience = input.audience ?? doc.meta.audience ?? 'all';
      home = input.home ?? (this.store.knowledgeBase.kind === 'team' ? 'kb' : 'repo');
      dir = path.join(home === 'kb' ? this.kbDocsDir : this.docsDir, input.category);
      wsId = home === 'kb' ? KB_SOURCE : this.store.workspaceId;
    }
    const file = path.join(dir, `${base}.md`);
    if (fs.existsSync(file) && !input.replace) throw new Error(`文档已存在：${this.displayPath(file)}（如需覆盖请指定 replace）`);
    doc.meta.id = this.uniqueDocId(doc.meta.id, file);
    doc.meta.updated_at = new Date().toISOString();
    writeFileAtomicSync(file, serializeDoc(doc));
    this.appendChange({ docId: doc.meta.id, docTitle: doc.meta.title, category: doc.meta.category, op: 'import', section: null,
      before: null, after: `${doc.sections.length} 个章节`, rationale: `导入 ${path.basename(input.fileName)}（挂载到${DOC_SCOPE_LABEL[scope]}${
        doc.meta.domains.length ? `：${doc.meta.domains.join('、')}` : ''}）`, proposalId: null, version: doc.meta.version }, wsId);
    this.reindexOwnFile(file, input.category, wsId);
    return { docId: doc.meta.id, file: this.displayPath(file), sections: doc.sections.length, scope, home, domains: doc.meta.domains, createdDomains };
  }

  /**
   * Document IDs are what citations (`D:<id>#<section>`), proposals and change logs point at, so one ID must name
   * one document across every place documents come from (this repository, the team knowledge base, personal
   * documents, other repositories). A file name already used elsewhere gets a numbered ID (`D-business_rules-refund-2`).
   */
  private uniqueDocId(candidate: string, file: string): string {
    const taken = (id: string) => Boolean(this.db.prepare('SELECT 1 FROM doc_files WHERE doc_id = ? AND file_path != ? LIMIT 1').get(id, path.resolve(file)));
    if (!taken(candidate)) return candidate;
    for (let n = 2; n < 1000; n++) if (!taken(`${candidate}-${n}`)) return `${candidate}-${n}`;
    return `${candidate}-${Date.now().toString(36)}`;
  }

  /** Document IDs that more than one indexed document uses (from before IDs were checked, or copied files). */
  duplicateDocIds(): Array<{ docId: string; files: string[] }> {
    // Other people's personal documents on this machine are never visible here, so they cannot be confused.
    const rows = this.db.prepare(`SELECT doc_id, group_concat(file_path, '\n') AS files FROM doc_files
      WHERE workspace_id NOT LIKE 'personal:%' OR workspace_id = ? GROUP BY doc_id HAVING COUNT(*) > 1`)
      .all(this.personalSource) as Array<{ doc_id: string; files: string }>;
    return rows.map((r) => ({ docId: r.doc_id, files: r.files.split('\n').map((f) => this.displayPath(f)) }));
  }

  private displayPath(file: string): string {
    const rel = path.relative(this.store.paths.projectRoot, file);
    return rel.startsWith('..') ? file : rel;
  }

  /**
   * The catalog IDs for a domain document. Names are resolved through the catalog (aliases included); with none
   * given, a repository that belongs to exactly one domain uses it. Unknown names are refused unless
   * `create` (or the catalog is still empty), in which case they are added with this repository as a core member.
   */
  private resolveDomains(names: string[], create: boolean): { ids: string[]; created: string[] } {
    const catalog = this.store.domainCatalog;
    let wanted = names.map((n) => n.trim()).filter(Boolean);
    if (!wanted.length) {
      const mine = this.store.domainMembership().filter((m) => m.role === 'core');
      if (mine.length === 1) wanted = [mine[0]!.id];
      else if (!mine.length) throw new Error('这份文档要挂载到领域，请用 domains 指定领域（本仓库还没有设置业务领域）');
      else throw new Error(`本仓库属于多个领域（${mine.map((m) => m.name).join('、')}），请用 domains 指定这份文档属于哪个领域`);
    }
    const ids: string[] = [];
    const created: string[] = [];
    // A mounted team catalog is reviewed like code, so typos are refused there; on this machine alone new names are added.
    const emptyCatalog = catalog.list().length === 0 || this.store.knowledgeBase.kind !== 'team';
    for (const name of wanted) {
      const id = catalog.resolve(name);
      if (id) {
        ids.push(id);
        continue;
      }
      if (!create && !emptyCatalog) {
        const hint = catalog.suggest(name);
        throw new Error(`领域目录中没有「${name}」${hint.length ? `，是否指：${hint.join('、')}` : ''}。确认是新领域请加 --new-domain`);
      }
      const def = catalog.upsert({ name, members: [{ repo: this.store.workspaceId, role: 'core' }] });
      ids.push(def.id);
      created.push(def.id);
    }
    return { ids: [...new Set(ids)], created };
  }

  // ---------- proposals ----------

  /**
   * A proposed change to a document (from the AI during development, or a person). Nothing is written until
   * someone accepts it. Update and delete proposals remember the section they were based on, so an accept
   * after the section changed is refused instead of overwriting the newer text.
   */
  propose(input: {
    docId?: string | null; category?: DocCategory; docTitle?: string; section: string; op: DocProposal['op'];
    content: string; rationale: string; evidence?: string; source?: string; sessionId?: string;
  }): DocProposal {
    const op = input.op;
    if (!['create_doc', 'add_section', 'update_section', 'delete_section'].includes(op)) throw new Error(`未知修改类型：${String(op)}`);
    if (!input.rationale?.trim()) throw new Error('请说明修改理由（rationale）');
    if (!input.section?.trim() && op !== 'create_doc') throw new Error('请指明章节标题（section）');
    let docId = input.docId ?? null;
    let category = input.category;
    let docTitle = input.docTitle ?? null;
    let baseSha: string | null = null;
    const content = redactSensitiveText(input.content ?? '').redactedText.trim();
    if (op === 'create_doc') {
      if (!category || !isDocCategory(category)) throw new Error('新建文档需要类别 category');
      if (!docTitle?.trim()) throw new Error('新建文档需要标题 doc_title');
      docId = null;
    } else {
      if (!docId) throw new Error('请指明要修改的文档 doc_id');
      const doc = this.getDoc(docId);
      if (!doc) throw new Error(`未找到文档：${docId}`);
      if (!this.changesRootFor(doc.wsId)) throw new Error(`该文档属于仓库 ${doc.originRepo}，本机没有它的工作目录，请在该仓库中提议修改`);
      category = doc.meta.category;
      docTitle = doc.meta.title;
      const sec = doc.sections.find((s) => s.id === sectionId(input.section) || s.heading === input.section.trim());
      if (op === 'add_section' && sec) throw new Error(`章节「${input.section}」已存在，请改用 update_section`);
      if ((op === 'update_section' || op === 'delete_section') && !sec) throw new Error(`文档中没有章节「${input.section}」`);
      baseSha = sec?.sha ?? null;
    }
    if (op !== 'delete_section' && !content) throw new Error('请提供修改后的内容（content）');
    const p: DocProposal = {
      id: `DP-${randomUUID().slice(0, 8)}`, docId, category: category!, docTitle, sectionHeading: input.section?.trim() || '概述', op, content,
      baseSha, rationale: redactSensitiveText(input.rationale.trim()).redactedText, evidence: input.evidence ? redactSensitiveText(input.evidence).redactedText : null,
      source: input.source ?? 'ai', sessionId: input.sessionId ?? null, status: 'pending', createdAt: new Date().toISOString(),
      decidedAt: null, decidedBy: null, decisionNote: null,
    };
    this.db.prepare(`INSERT INTO doc_proposals (id, doc_id, category, doc_title, section_heading, op, content, base_sha, rationale, evidence,
      source, session_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
      p.id, p.docId, p.category, p.docTitle, p.sectionHeading, p.op, p.content, p.baseSha, p.rationale, p.evidence, p.source, p.sessionId, p.createdAt);
    return p;
  }

  /** Owners of a document: its domains' owners for domain documents, else the repository's (or sub-project's). */
  docOwners(docId: string | null): string[] {
    const doc = docId ? this.getDoc(docId) : null;
    if (!doc) return this.store.repoOwners();
    if (doc.wsId.startsWith(PERSONAL_PREFIX)) return [];
    const out = new Set<string>();
    if (this.scopeOf(doc.wsId, doc) === 'domain') for (const d of doc.meta.domains) for (const o of this.store.domainOwners(d)) out.add(o);
    if (doc.wsId === this.store.workspaceId) for (const o of this.store.repoOwners(doc.meta.subproject)) out.add(o);
    return [...out];
  }

  listProposals(status: DocProposal['status'] | 'all' = 'pending'): DocProposal[] {
    const rows = this.db.prepare(`SELECT * FROM doc_proposals ${status === 'all' ? '' : 'WHERE status = ?'} ORDER BY created_at DESC`)
      .all(...(status === 'all' ? [] : [status])) as Array<Record<string, unknown>>;
    return rows.map((r) => this.withOwners({
      id: String(r.id), docId: r.doc_id ? String(r.doc_id) : null, category: r.category as DocCategory, docTitle: r.doc_title ? String(r.doc_title) : null,
      sectionHeading: String(r.section_heading), op: r.op as DocProposal['op'], content: String(r.content), baseSha: r.base_sha ? String(r.base_sha) : null,
      rationale: String(r.rationale), evidence: r.evidence ? String(r.evidence) : null, source: String(r.source), sessionId: r.session_id ? String(r.session_id) : null,
      status: r.status as DocProposal['status'], createdAt: String(r.created_at), decidedAt: r.decided_at ? String(r.decided_at) : null,
      decidedBy: r.decided_by ? String(r.decided_by) : null, decisionNote: r.decision_note ? String(r.decision_note) : null,
    }, status === 'pending'));
  }

  private withOwners(p: DocProposal, resolve: boolean): DocProposal {
    if (!resolve) return p;
    const owners = this.docOwners(p.docId);
    return { ...p, owners, assignedToMe: this.store.isMine(owners) };
  }

  /** Accepts (applies, bumps the version, logs the change) or rejects a proposal. */
  decide(id: string, decision: 'accept' | 'reject', options: { content?: string; note?: string; force?: boolean } = {}): { proposal: DocProposal; change: DocChange | null } {
    const p = this.listProposals('all').find((x) => x.id === id);
    if (!p) throw new Error(`未找到修改提议：${id}`);
    if (p.status !== 'pending') throw new Error('该提议已处理');
    const now = new Date().toISOString();
    const actor = this.store.actor;
    const finish = (status: 'accepted' | 'rejected') => {
      this.db.prepare('UPDATE doc_proposals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ?')
        .run(status, now, actor, options.note ?? null, id);
      return { ...p, status, decidedAt: now, decidedBy: actor, decisionNote: options.note ?? null };
    };
    if (decision === 'reject') return { proposal: finish('rejected'), change: null };
    const content = (options.content ?? p.content).trim();
    let doc: ParsedDoc;
    let file: string;
    let before: string | null = null;
    let homeWs = this.store.workspaceId;
    if (p.op === 'create_doc') {
      const base = (p.docTitle ?? 'doc').replace(/[^A-Za-z0-9_一-鿿-]+/g, '-').replace(/^-+|-+$/g, '') || 'doc';
      const scope: DocScope = SCOPES_FOR_CATEGORY[p.category][0]!;
      // A new domain document follows the same rules as an import: one clear domain, stored at its home.
      const domains = scope === 'domain' ? this.resolveDomains([], false).ids : [];
      if (scope === 'personal') {
        homeWs = this.personalSource;
        file = path.join(this.personalDocsDir, `${base}.md`);
      } else if (scope === 'domain' && this.store.knowledgeBase.kind === 'team') {
        homeWs = KB_SOURCE;
        file = path.join(this.kbDocsDir, p.category, `${base}.md`);
      } else {
        file = path.join(this.docsDir, p.category, `${base}.md`);
      }
      if (fs.existsSync(file)) throw new Error(`文档已存在：${this.displayPath(file)}`);
      doc = { meta: { id: this.uniqueDocId(`D-${p.category}-${base}`, file), title: p.docTitle ?? base, category: p.category, scope,
        domains, tags: [], version: 0, updated_at: now, ...(scope === 'personal' ? { owner: this.store.currentUser().userId } : {}) },
        intro: '', sections: content ? [{ id: sectionId(p.sectionHeading), heading: p.sectionHeading, body: content, sha: sectionSha(p.sectionHeading, content) }] : [] };
    } else {
      const current = this.getDoc(p.docId!);
      if (!current) throw new Error(`文档 ${p.docId} 已不存在`);
      if (!this.changesRootFor(current.wsId) || !current.writable) throw new Error(`文档 ${p.docId} 在本机不可写（来自 ${current.originRepo}）`);
      homeWs = current.wsId;
      file = current.file;
      doc = current;
      const idx = doc.sections.findIndex((s) => s.id === sectionId(p.sectionHeading) || s.heading === p.sectionHeading);
      if (p.op === 'add_section') {
        if (idx >= 0) throw new Error(`章节「${p.sectionHeading}」已存在，请重新提议为修改`);
        doc.sections.push({ id: sectionId(p.sectionHeading), heading: p.sectionHeading, body: content, sha: sectionSha(p.sectionHeading, content) });
      } else {
        if (idx < 0) throw new Error(`章节「${p.sectionHeading}」已不存在`);
        const sec = doc.sections[idx]!;
        if (p.baseSha && sec.sha !== p.baseSha && !options.force) {
          throw new Error(`章节「${p.sectionHeading}」在提议之后已被修改，请先核对最新内容（或确认后强制应用）`);
        }
        before = sec.body;
        if (p.op === 'delete_section') doc.sections.splice(idx, 1);
        else doc.sections[idx] = { ...sec, body: content, sha: sectionSha(sec.heading, content) };
        this.flagCitations(doc.meta.id, sec.id, sec.heading, p.op === 'delete_section' ? '依据的规则文档章节已被删除' : '依据的规则文档章节已修改');
      }
    }
    doc.meta.version += 1;
    doc.meta.updated_at = now;
    const { file: _f, originRepo: _o, wsId: _w, writable: _wr, ...plain } = doc as ParsedDoc & { file?: string; originRepo?: unknown; wsId?: unknown; writable?: unknown };
    writeFileAtomicSync(file, serializeDoc(plain));
    const change = this.appendChange({
      docId: doc.meta.id, docTitle: doc.meta.title, category: doc.meta.category, op: p.op, section: p.sectionHeading,
      before, after: p.op === 'delete_section' ? null : content, rationale: p.rationale, proposalId: p.id, version: doc.meta.version,
    }, homeWs);
    this.reindexOwnFile(file, doc.meta.category, homeWs);
    return { proposal: finish('accepted'), change };
  }

  // ---------- change log ----------

  /** Appends to the change log of the document's home (this repository, the knowledge base, a person's folder). */
  appendChange(c: Omit<DocChange, 'id' | 'at' | 'actor'>, homeWs: string = this.store.workspaceId): DocChange {
    const root = this.changesRootFor(homeWs) ?? this.docsDir;
    const home = this.homeLabel(homeWs);
    const change: DocChange = { id: `DC-${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), actor: this.store.actor, ...c, ...(home ? { home } : {}) };
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(path.join(root, 'changes.ndjson'), `${JSON.stringify(change)}\n`, 'utf8');
    try {
      if (!homeWs.startsWith(PERSONAL_PREFIX)) this.renderChangelog(root);
    } catch {
      // the structured log is the record; the Markdown view is regenerated next time
    }
    return change;
  }

  private readChanges(root: string): DocChange[] {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(root, 'changes.ndjson'), 'utf8');
    } catch {
      return [];
    }
    const out: DocChange[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as DocChange);
      } catch {
        // skip a torn line
      }
    }
    return out;
  }

  /** Changes of this repository's, the knowledge base's and the person's documents (or of one home only). */
  listChanges(filter: { docId?: string; limit?: number; home?: string } = {}): DocChange[] {
    const roots = filter.home ? [this.changesRootFor(filter.home)].filter((r): r is string => Boolean(r))
      : [...new Set([this.docsDir, this.kbDocsDir, this.personalDocsDir])];
    const out = roots.flatMap((r) => this.readChanges(r)).filter((c) => !filter.docId || c.docId === filter.docId);
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, filter.limit ?? 200);
  }

  /** `<docs>/CHANGELOG.md`: the change log for people (newest first), regenerated from changes.ndjson. */
  renderChangelog(root: string = this.docsDir): void {
    const OP: Record<DocChangeOp, string> = {
      create_doc: '新建文档', add_section: '新增章节', update_section: '修改章节', delete_section: '删除章节',
      import: '导入', manual_edit: '直接编辑', delete_doc: '删除文档',
    };
    const lines = ['# 规则文档变更记录', '', '> 由 AccreMind 根据 `changes.ndjson` 生成，请勿手工编辑。', ''];
    for (const c of this.readChanges(root).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500)) {
      lines.push(`## ${c.at.slice(0, 19).replace('T', ' ')} · ${DOC_CATEGORY_LABEL[c.category] ?? c.category} · ${c.docTitle} v${c.version}`);
      lines.push('', `- 类型：${OP[c.op] ?? c.op}${c.section ? `　章节：${c.section}` : ''}`, `- 操作人：${c.actor}${c.proposalId ? `（提议 ${c.proposalId}）` : ''}`, `- 理由：${c.rationale}`);
      if (c.before) lines.push('- 修改前：', '', ...c.before.split('\n').slice(0, 12).map((l) => `  > ${l}`));
      if (c.after) lines.push('- 修改后：', '', ...c.after.split('\n').slice(0, 12).map((l) => `  > ${l}`));
      lines.push('');
    }
    writeFileAtomicSync(path.join(root, 'CHANGELOG.md'), lines.join('\n'));
  }
}

export { GLOBAL as DOC_GLOBAL_SOURCE };
