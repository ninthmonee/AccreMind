import { createHash } from 'node:crypto';

/**
 * Rule document sets: hand-written, Git-reviewed Markdown kept in `.accremind/docs/<category>/*.md`.
 * They hold what is too long or too structured for single experience cards — the business domain, the
 * project's norms, its basic business attributes and its business rules — and grow during development
 * through proposals a person accepts.
 */
export const DOC_CATEGORIES = ['domain', 'business_rules', 'project_norms', 'project_profile', 'personal_preferences'] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];
export const DOC_CATEGORY_LABEL: Record<DocCategory, string> = {
  domain: '业务领域',
  business_rules: '业务规则',
  project_norms: '项目规范',
  project_profile: '项目基本业务属性',
  personal_preferences: '个人偏好',
};

/**
 * Where a document is mounted, which decides where it is stored and who gets it:
 * project — this repository only (`.accremind/docs/`, committed);
 * domain — every project in its business domains (the knowledge base, or the repository that hosts it);
 * personal — only its owner, in every repository (this machine, never committed).
 */
export type DocScope = 'project' | 'domain' | 'personal';
export const DOC_SCOPE_LABEL: Record<DocScope, string> = { project: '项目', domain: '领域', personal: '个人' };

/** Scopes a category may be mounted on; the first is the default. */
export const SCOPES_FOR_CATEGORY: Record<DocCategory, DocScope[]> = {
  domain: ['domain'],
  business_rules: ['domain', 'project'],
  project_norms: ['project'],
  project_profile: ['project'],
  personal_preferences: ['personal'],
};
export function isDocCategory(v: unknown): v is DocCategory {
  return typeof v === 'string' && (DOC_CATEGORIES as readonly string[]).includes(v);
}
/**
 * Categories that may be served in other repositories of the same business domain (when the document names
 * its domains). Project norms and the project profile belong to their repository.
 */
export function isShareableCategory(c: DocCategory): boolean {
  return c === 'domain' || c === 'business_rules';
}

export interface DocMeta {
  id: string;
  title: string;
  /** Absent in older documents: derived from the category and where the file lives. */
  scope?: DocScope;
  /** Domain documents: `core` = only the domain's core projects; `all` (default) = consumers too. */
  audience?: 'core' | 'all';
  /** Monorepo sub-project the document is about (project scope). */
  subproject?: string;
  /** Personal documents: the owner's user ID. */
  owner?: string;
  category: DocCategory;
  domains: string[];
  tags: string[];
  version: number;
  updated_at: string;
}

export interface DocSection {
  /** Stable within a document: derived from the heading text. */
  id: string;
  heading: string;
  /** Section text (sub-headings included), without its own `##` line. */
  body: string;
  sha: string;
}

export interface ParsedDoc {
  meta: DocMeta;
  /** Text before the first `##` heading (after the title line). */
  intro: string;
  sections: DocSection[];
}

export function sectionId(heading: string): string {
  const slug = heading.trim().toLowerCase().replace(/[\s/\\:：,，。.()（）[\]【】'"`]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || `s-${createHash('sha256').update(heading).digest('hex').slice(0, 8)}`;
}

const sha = (t: string) => createHash('sha256').update(t.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  const t = raw.trim();
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t) as unknown[];
      return arr.map(String).map((s) => s.trim()).filter(Boolean);
    } catch {
      // fall through to comma list
    }
  }
  return t.replace(/^\[|\]$/g, '').split(/[,，]/).map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function unquote(v: string | undefined): string {
  if (v === undefined) return '';
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t.replace(/^'|'$/g, '');
}

/** Parses a document. Missing front matter is tolerated (title from the first `#` line, id from the file name). */
export function parseDoc(markdown: string, fallback: { id: string; category: DocCategory }): ParsedDoc {
  const text = markdown.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fields: Record<string, string> = {};
  let body = text;
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end > 0) {
      for (const line of text.slice(4, end).split('\n')) {
        const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
        if (m) fields[m[1]!] = m[2]!;
      }
      body = text.slice(end + 4).replace(/^\n/, '');
    }
  }
  const lines = body.split('\n');
  let title = unquote(fields.title);
  const titleIdx = lines.findIndex((l) => /^#\s+/.test(l));
  if (!title && titleIdx >= 0) title = lines[titleIdx]!.replace(/^#\s+/, '').trim();
  const rest = titleIdx >= 0 ? lines.slice(titleIdx + 1) : lines;
  const sections: DocSection[] = [];
  const intro: string[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  const seen = new Map<string, number>();
  const flush = () => {
    if (!current) return;
    const b = current.lines.join('\n').trim();
    let id = sectionId(current.heading);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id = `${id}-${n}`;
    sections.push({ id, heading: current.heading, body: b, sha: sha(`${current.heading}\n${b}`) });
  };
  for (const line of rest) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      flush();
      current = { heading: h[1]!.trim(), lines: [] };
    } else if (current) current.lines.push(line);
    else intro.push(line);
  }
  flush();
  const category = isDocCategory(unquote(fields.category)) ? (unquote(fields.category) as DocCategory) : fallback.category;
  const scope = unquote(fields.scope);
  const audience = unquote(fields.audience);
  return {
    meta: {
      id: unquote(fields.id) || fallback.id,
      title: title || fallback.id,
      category,
      ...(scope === 'project' || scope === 'domain' || scope === 'personal' ? { scope } : {}),
      ...(audience === 'core' || audience === 'all' ? { audience } : {}),
      ...(unquote(fields.subproject) ? { subproject: unquote(fields.subproject) } : {}),
      ...(unquote(fields.owner) ? { owner: unquote(fields.owner) } : {}),
      domains: parseList(fields.domains),
      tags: parseList(fields.tags),
      version: Number.parseInt(unquote(fields.version), 10) || 1,
      updated_at: unquote(fields.updated_at) || '',
    },
    intro: intro.join('\n').trim(),
    sections,
  };
}

/** Writes a document back in the canonical layout (front matter, title, intro, `##` sections). */
export function serializeDoc(doc: ParsedDoc): string {
  const m = doc.meta;
  const fm = [
    '---',
    `id: ${JSON.stringify(m.id)}`,
    `title: ${JSON.stringify(m.title)}`,
    `category: ${JSON.stringify(m.category)}`,
    ...(m.scope ? [`scope: ${JSON.stringify(m.scope)}`] : []),
    `domains: ${JSON.stringify(m.domains)}`,
    ...(m.audience && m.audience !== 'all' ? [`audience: ${JSON.stringify(m.audience)}`] : []),
    ...(m.subproject ? [`subproject: ${JSON.stringify(m.subproject)}`] : []),
    ...(m.owner ? [`owner: ${JSON.stringify(m.owner)}`] : []),
    `tags: ${JSON.stringify(m.tags)}`,
    `version: ${m.version}`,
    `updated_at: ${JSON.stringify(m.updated_at)}`,
    '---',
    '',
    `# ${m.title}`,
    '',
  ];
  if (doc.intro) fm.push(doc.intro, '');
  for (const s of doc.sections) fm.push(`## ${s.heading}`, '', s.body, '');
  return fm.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function sectionSha(heading: string, body: string): string {
  return sha(`${heading}\n${body}`);
}
