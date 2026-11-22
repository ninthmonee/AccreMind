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
  isDocCategory,
  isShareableCategory,
  parseDoc,
  sectionId,
  sectionSha,
  serializeDoc,
  type DocCategory,
  type ParsedDoc,
} from './doc-format.ts';
import { addToVocabularyFile, readVocabularyFile, tagIdFor, Vocabulary, type VocabularyTag } from './vocabulary.ts';

const GLOBAL = '__global__';

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
}

interface DocSource {
  wsId: string;
  dir: string;
  category: DocCategory;
  foreign: boolean;
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

  get vocabularyFile(): string {
    return path.join(this.store.paths.projectAccreMindDir, 'vocabulary.json');
  }

  private get db() {
    return this.store.rawDb;
  }

  private sources(): DocSource[] {
    const own = DOC_CATEGORIES.map((category) => ({ wsId: this.store.workspaceId, dir: path.join(this.docsDir, category), category, foreign: false }));
    const me = path.resolve(this.store.paths.projectRoot);
    const foreign: DocSource[] = [];
    for (const rec of this.store.registry.list()) {
      if (rec.repo_id === this.store.workspaceId || path.resolve(rec.root) === me) continue;
      for (const category of DOC_CATEGORIES.filter(isShareableCategory)) {
        const dir = path.join(rec.root, path.basename(this.store.paths.projectAccreMindDir), 'docs', category);
        if (fs.existsSync(dir)) foreign.push({ wsId: rec.repo_id, dir, category, foreign: true });
      }
    }
    return [...own, ...foreign];
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
      if (!inScanned && known.has(r.workspace_id)) continue;
      if (r.workspace_id === this.store.workspaceId && isDocCategory(r.category)) {
        this.appendChange({ docId: r.doc_id, docTitle: r.title, category: r.category, op: 'delete_doc', section: null,
          before: null, after: null, rationale: '文档文件已被删除', proposalId: null, version: r.version });
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
    for (const name of fs.readdirSync(src.dir).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort()) {
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
      if (!src.foreign && known) this.recordManualEdits(src.wsId, doc, known.doc_id);
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
    const lastChange = this.listChanges({ docId: doc.meta.id, limit: 1 })[0];
    const before = new Map(prev.map((p) => [p.section_id, p]));
    const withIntro = doc.intro ? [{ id: '_intro', heading: '概述', body: doc.intro, sha: sectionSha('概述', doc.intro) }, ...doc.sections] : doc.sections;
    const after = new Map(withIntro.map((s) => [s.id, s]));
    const base = { docId: doc.meta.id, docTitle: doc.meta.title, category: doc.meta.category, rationale: '直接编辑文档文件', proposalId: null, version: doc.meta.version };
    // A write made by an accepted proposal is already in the log with the same content.
    const sameAsLast = (sec: string, text: string | null) => lastChange && lastChange.section === sec && lastChange.after === text;
    for (const [id, s] of after) {
      const p = before.get(id);
      if (!p) {
        if (!sameAsLast(s.heading, s.body)) this.appendChange({ ...base, op: 'manual_edit', section: s.heading, before: null, after: s.body });
      } else if (p.section_sha !== s.sha) {
        if (!sameAsLast(s.heading, s.body)) this.appendChange({ ...base, op: 'manual_edit', section: s.heading, before: p.body, after: s.body });
      }
    }
    for (const [id, p] of before) {
      if (!after.has(id) && !sameAsLast(p.heading, null)) this.appendChange({ ...base, op: 'manual_edit', section: p.heading, before: p.body, after: null });
    }
  }

  /** Re-indexes one of this repository's files after AccreMind itself wrote it (no "direct edit" entry). */
  private reindexOwnFile(file: string, category: DocCategory): void {
    const raw = fs.readFileSync(file, 'utf8');
    const fallbackId = `D-${category}-${path.basename(file).replace(/\.md$/, '').replace(/[^A-Za-z0-9_\u4e00-\u9fff-]+/g, '-')}`;
    this.indexDoc(this.store.workspaceId, file, parseDoc(raw, { id: fallbackId, category }), sha256Hex(raw), fs.statSync(file));
    this.vocabCache = null;
  }

  private removeDoc(wsId: string, docId: string): void {
    const rows = this.db.prepare('SELECT rowid AS rid FROM doc_sections WHERE workspace_id = ? AND doc_id = ?').all(wsId, docId) as Array<{ rid: number }>;
    for (const r of rows) this.db.prepare('DELETE FROM doc_fts WHERE rowid = ?').run(r.rid);
    this.db.prepare('DELETE FROM doc_sections WHERE workspace_id = ? AND doc_id = ?').run(wsId, docId);
    this.db.prepare('DELETE FROM doc_files WHERE workspace_id = ? AND doc_id = ?').run(wsId, docId);
  }

  private indexDoc(wsId: string, file: string, doc: ParsedDoc, fileSha: string, st: fs.Stats): void {
    const domainsCsv = doc.meta.domains.length ? `,${doc.meta.domains.join(',')},` : '';
    const tagIds = doc.meta.tags.map(tagIdFor);
    const tagsCsv = tagIds.length ? `,${tagIds.join(',')},` : '';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prevIds = this.db.prepare('SELECT doc_id FROM doc_files WHERE workspace_id = ? AND file_path = ?').all(wsId, file) as Array<{ doc_id: string }>;
      for (const p of prevIds) this.removeDoc(wsId, p.doc_id);
      this.removeDoc(wsId, doc.meta.id);
      this.db.prepare(`INSERT INTO doc_files (workspace_id, doc_id, file_path, category, title, domains_csv, tags_json, version, file_sha, mtime_ms, size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(wsId, doc.meta.id, file, doc.meta.category, doc.meta.title, domainsCsv,
        JSON.stringify(doc.meta.tags), doc.meta.version, fileSha, Math.trunc(st.mtimeMs), st.size);
      const ins = this.db.prepare(`INSERT INTO doc_sections (workspace_id, doc_id, section_id, category, doc_title, heading, body,
        domains_csv, tags_csv, file_path, section_sha, doc_version, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const fts = this.db.prepare('INSERT INTO doc_fts (rowid, doc_title, heading, body) VALUES (?, ?, ?, ?)');
      const all = doc.intro ? [{ id: '_intro', heading: '概述', body: doc.intro, sha: sectionSha('概述', doc.intro) }, ...doc.sections] : doc.sections;
      all.forEach((s, ord) => {
        const r = ins.run(wsId, doc.meta.id, s.id, doc.meta.category, doc.meta.title, s.heading, s.body, domainsCsv, tagsCsv, file, s.sha, doc.meta.version, ord);
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
      ctx.domains.some((dom) => d.domains_csv.includes(`,${dom},`)));
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
    const rows = this.db.prepare(`SELECT rowid AS rid, * FROM doc_sections WHERE workspace_id = ?
        OR (category IN ('domain', 'business_rules') AND EXISTS (SELECT 1 FROM json_each(?) d WHERE doc_sections.domains_csv LIKE '%,' || d.value || ',%'))`)
      .all(this.store.workspaceId, domains) as Array<{
      rid: number; workspace_id: string; doc_id: string; section_id: string; category: DocCategory; doc_title: string; heading: string;
      body: string; tags_csv: string; domains_csv: string;
    }>;
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
        originRepo: r.workspace_id === this.store.workspaceId ? null : r.workspace_id, matchedTags,
      });
    }
    return out.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref)).slice(0, input.limit ?? 5);
  }

  /** A section by reference (`D:<doc>#<section>`), from this repository first. */
  getSection(ref: string): { docId: string; docTitle: string; category: DocCategory; heading: string; body: string; version: number; originRepo: string | null } | null {
    const m = /^D:([^#]+)#(.+)$/.exec(ref.trim());
    if (!m) return null;
    const row = this.db.prepare(`SELECT * FROM doc_sections WHERE doc_id = ? AND section_id = ?
      ORDER BY CASE workspace_id WHEN ? THEN 0 ELSE 1 END LIMIT 1`).get(m[1]!, m[2]!, this.store.workspaceId) as
      { workspace_id: string; doc_id: string; doc_title: string; category: DocCategory; heading: string; body: string; doc_version: number } | undefined;
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

  listDocs(): Array<{ docId: string; title: string; category: DocCategory; domains: string[]; tags: string[]; version: number; sections: number; file: string; originRepo: string | null }> {
    const rows = this.db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM doc_sections s WHERE s.workspace_id = f.workspace_id AND s.doc_id = f.doc_id) AS n
      FROM doc_files f ORDER BY f.category, f.title`).all() as Array<Record<string, unknown>>;
    const ctx = this.store.sessionContext();
    return rows.filter((r) => r.workspace_id === this.store.workspaceId ||
      ctx.domains.some((d) => String(r.domains_csv).includes(`,${d},`))).map((r) => ({
      docId: String(r.doc_id), title: String(r.title), category: r.category as DocCategory,
      domains: String(r.domains_csv).split(',').filter(Boolean), tags: JSON.parse(String(r.tags_json || '[]')) as string[],
      version: Number(r.version), sections: Number(r.n),
      file: r.workspace_id === this.store.workspaceId ? path.relative(this.store.paths.projectRoot, String(r.file_path)) : String(r.file_path),
      originRepo: r.workspace_id === this.store.workspaceId ? null : String(r.workspace_id),
    }));
  }

  getDoc(docId: string): (ParsedDoc & { file: string; originRepo: string | null }) | null {
    const row = this.db.prepare(`SELECT * FROM doc_files WHERE doc_id = ? ORDER BY CASE workspace_id WHEN ? THEN 0 ELSE 1 END LIMIT 1`)
      .get(docId, this.store.workspaceId) as { workspace_id: string; file_path: string; category: DocCategory } | undefined;
    if (!row || !fs.existsSync(row.file_path)) return null;
    const doc = parseDoc(fs.readFileSync(row.file_path, 'utf8'), { id: docId, category: row.category });
    return { ...doc, file: row.file_path, originRepo: row.workspace_id === this.store.workspaceId ? null : row.workspace_id };
  }

  // ---------- import ----------

  /**
   * Imports a Markdown document into `.accremind/docs/<category>/`. The text is kept; front matter is added or
   * completed. Refuses to overwrite an existing document unless `replace` is set.
   */
  importDoc(input: { content: string; fileName: string; category: DocCategory; title?: string; domains?: string[]; tags?: string[]; replace?: boolean }): { docId: string; file: string; sections: number } {
    if (!isDocCategory(input.category)) throw new Error(`未知文档类别：${String(input.category)}（可选 ${DOC_CATEGORIES.join(' / ')}）`);
    const base = path.basename(input.fileName).replace(/\.(md|markdown|txt)$/i, '').replace(/[^A-Za-z0-9_一-鿿-]+/g, '-').replace(/^-+|-+$/g, '') || 'doc';
    const file = path.join(this.docsDir, input.category, `${base}.md`);
    if (fs.existsSync(file) && !input.replace) throw new Error(`文档已存在：${path.relative(this.store.paths.projectRoot, file)}（如需覆盖请指定 replace）`);
    const doc = parseDoc(input.content, { id: `D-${input.category}-${base}`, category: input.category });
    doc.meta.category = input.category;
    if (input.title) doc.meta.title = input.title;
    if (input.domains?.length) doc.meta.domains = [...new Set(input.domains.map((d) => d.trim()).filter(Boolean))];
    if (!doc.meta.domains.length && isShareableCategory(input.category)) doc.meta.domains = [...this.store.identity.domains];
    if (input.tags?.length) doc.meta.tags = [...new Set([...doc.meta.tags, ...input.tags])];
    doc.meta.updated_at = new Date().toISOString();
    writeFileAtomicSync(file, serializeDoc(doc));
    this.appendChange({ docId: doc.meta.id, docTitle: doc.meta.title, category: doc.meta.category, op: 'import', section: null,
      before: null, after: `${doc.sections.length} 个章节`, rationale: `导入 ${path.basename(input.fileName)}`, proposalId: null, version: doc.meta.version });
    this.reindexOwnFile(file, input.category);
    return { docId: doc.meta.id, file: path.relative(this.store.paths.projectRoot, file), sections: doc.sections.length };
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
      if (doc.originRepo) throw new Error(`该文档属于仓库 ${doc.originRepo}，请在该仓库中提议修改`);
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

  listProposals(status: DocProposal['status'] | 'all' = 'pending'): DocProposal[] {
    const rows = this.db.prepare(`SELECT * FROM doc_proposals ${status === 'all' ? '' : 'WHERE status = ?'} ORDER BY created_at DESC`)
      .all(...(status === 'all' ? [] : [status])) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id), docId: r.doc_id ? String(r.doc_id) : null, category: r.category as DocCategory, docTitle: r.doc_title ? String(r.doc_title) : null,
      sectionHeading: String(r.section_heading), op: r.op as DocProposal['op'], content: String(r.content), baseSha: r.base_sha ? String(r.base_sha) : null,
      rationale: String(r.rationale), evidence: r.evidence ? String(r.evidence) : null, source: String(r.source), sessionId: r.session_id ? String(r.session_id) : null,
      status: r.status as DocProposal['status'], createdAt: String(r.created_at), decidedAt: r.decided_at ? String(r.decided_at) : null,
      decidedBy: r.decided_by ? String(r.decided_by) : null, decisionNote: r.decision_note ? String(r.decision_note) : null,
    }));
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
    if (p.op === 'create_doc') {
      const base = (p.docTitle ?? 'doc').replace(/[^A-Za-z0-9_一-鿿-]+/g, '-').replace(/^-+|-+$/g, '') || 'doc';
      file = path.join(this.docsDir, p.category, `${base}.md`);
      if (fs.existsSync(file)) throw new Error(`文档已存在：${path.relative(this.store.paths.projectRoot, file)}`);
      doc = { meta: { id: `D-${p.category}-${base}`, title: p.docTitle ?? base, category: p.category,
        domains: isShareableCategory(p.category) ? [...this.store.identity.domains] : [], tags: [], version: 0, updated_at: now },
        intro: '', sections: content ? [{ id: sectionId(p.sectionHeading), heading: p.sectionHeading, body: content, sha: sectionSha(p.sectionHeading, content) }] : [] };
    } else {
      const current = this.getDoc(p.docId!);
      if (!current || current.originRepo) throw new Error(`文档 ${p.docId} 已不存在`);
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
      }
    }
    doc.meta.version += 1;
    doc.meta.updated_at = now;
    writeFileAtomicSync(file, serializeDoc(doc));
    const change = this.appendChange({
      docId: doc.meta.id, docTitle: doc.meta.title, category: doc.meta.category, op: p.op, section: p.sectionHeading,
      before, after: p.op === 'delete_section' ? null : content, rationale: p.rationale, proposalId: p.id, version: doc.meta.version,
    });
    this.reindexOwnFile(file, doc.meta.category);
    return { proposal: finish('accepted'), change };
  }

  // ---------- change log ----------

  appendChange(c: Omit<DocChange, 'id' | 'at' | 'actor'>): DocChange {
    const change: DocChange = { id: `DC-${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), actor: this.store.actor, ...c };
    fs.mkdirSync(this.docsDir, { recursive: true });
    fs.appendFileSync(this.changesFile, `${JSON.stringify(change)}\n`, 'utf8');
    try {
      this.renderChangelog();
    } catch {
      // the structured log is the record; the Markdown view is regenerated next time
    }
    return change;
  }

  listChanges(filter: { docId?: string; limit?: number } = {}): DocChange[] {
    let raw = '';
    try {
      raw = fs.readFileSync(this.changesFile, 'utf8');
    } catch {
      return [];
    }
    const out: DocChange[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line) as DocChange;
        if (!filter.docId || c.docId === filter.docId) out.push(c);
      } catch {
        // skip a torn line
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, filter.limit ?? 200);
  }

  /** `.accremind/docs/CHANGELOG.md`: the change log for people (newest first), regenerated from changes.ndjson. */
  renderChangelog(): void {
    const OP: Record<DocChangeOp, string> = {
      create_doc: '新建文档', add_section: '新增章节', update_section: '修改章节', delete_section: '删除章节',
      import: '导入', manual_edit: '直接编辑', delete_doc: '删除文档',
    };
    const lines = ['# 规则文档变更记录', '', '> 由 AccreMind 根据 `changes.ndjson` 生成，请勿手工编辑。', ''];
    for (const c of this.listChanges({ limit: 500 })) {
      lines.push(`## ${c.at.slice(0, 19).replace('T', ' ')} · ${DOC_CATEGORY_LABEL[c.category] ?? c.category} · ${c.docTitle} v${c.version}`);
      lines.push('', `- 类型：${OP[c.op] ?? c.op}${c.section ? `　章节：${c.section}` : ''}`, `- 操作人：${c.actor}${c.proposalId ? `（提议 ${c.proposalId}）` : ''}`, `- 理由：${c.rationale}`);
      if (c.before) lines.push('- 修改前：', '', ...c.before.split('\n').slice(0, 12).map((l) => `  > ${l}`));
      if (c.after) lines.push('- 修改后：', '', ...c.after.split('\n').slice(0, 12).map((l) => `  > ${l}`));
      lines.push('');
    }
    writeFileAtomicSync(path.join(this.docsDir, 'CHANGELOG.md'), lines.join('\n'));
  }
}

export { GLOBAL as DOC_GLOBAL_SOURCE };
