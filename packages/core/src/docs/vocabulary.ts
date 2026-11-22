import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { writeFileAtomicSync } from '../codec/atomic-fs.ts';

/**
 * Controlled vocabulary of topic tags. Questions and knowledge are tagged with the same IDs, so "什么时候能
 * 退款" and an entry about "退款时机" meet on `refund` even without shared words. Tags come from:
 * - `.accremind/vocabulary.json` (maintained by people; accepted proposals are added here),
 * - the document sets (their `tags` and `domains`),
 * - the repository's business domains and its dependencies (`tech:<name>`).
 * A model may only choose from this list; a term it is missing becomes a proposal for a person to accept.
 */
export interface VocabularyTag {
  id: string;
  label: string;
  aliases: string[];
  kind: 'domain' | 'module' | 'term' | 'tech';
  source: 'manual' | 'doc' | 'repo' | 'dependency';
}

export interface VocabularyFile {
  version: 1;
  tags: Array<{ id: string; label: string; aliases?: string[]; kind?: VocabularyTag['kind'] }>;
}

export function tagIdFor(label: string): string {
  const t = label.trim().toLowerCase();
  const ascii = t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z0-9-]+$/.test(t.replace(/\s+/g, '-')) && ascii ? ascii : `t-${createHash('sha256').update(t).digest('hex').slice(0, 8)}`;
}

export function readVocabularyFile(file: string): VocabularyFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as VocabularyFile;
    if (parsed && Array.isArray(parsed.tags)) return { version: 1, tags: parsed.tags.filter((t) => t && t.id && t.label) };
  } catch {
    // no vocabulary yet
  }
  return { version: 1, tags: [] };
}

/** Adds (or extends with new aliases) tags in `.accremind/vocabulary.json`. */
export function addToVocabularyFile(file: string, tags: Array<{ id?: string; label: string; aliases?: string[]; kind?: VocabularyTag['kind'] }>): VocabularyFile {
  const v = readVocabularyFile(file);
  for (const t of tags) {
    const id = t.id || tagIdFor(t.label);
    const existing = v.tags.find((x) => x.id === id);
    if (existing) existing.aliases = [...new Set([...(existing.aliases ?? []), ...(t.aliases ?? [])])];
    else v.tags.push({ id, label: t.label.trim(), aliases: t.aliases ?? [], ...(t.kind ? { kind: t.kind } : {}) });
  }
  v.tags.sort((a, b) => a.id.localeCompare(b.id));
  writeFileAtomicSync(file, `${JSON.stringify(v, null, 2)}\n`);
  return v;
}

interface Matcher {
  id: string;
  needle: string;
  ascii: boolean;
}

export class Vocabulary {
  readonly tags: VocabularyTag[];
  readonly version: number;
  private readonly byId: Map<string, VocabularyTag>;
  private readonly matchers: Matcher[];

  constructor(tags: VocabularyTag[]) {
    const merged = new Map<string, VocabularyTag>();
    for (const t of tags) {
      const prev = merged.get(t.id);
      if (prev) prev.aliases = [...new Set([...prev.aliases, ...t.aliases])];
      else merged.set(t.id, { ...t, aliases: [...new Set(t.aliases)] });
    }
    this.tags = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
    this.byId = new Map(this.tags.map((t) => [t.id, t]));
    this.matchers = [];
    for (const t of this.tags) {
      for (const term of [t.label, ...t.aliases]) {
        const needle = term.trim().toLowerCase();
        // Single CJK characters and very short Latin words match too much.
        if (!needle || (/^[\x00-\x7f]+$/.test(needle) ? needle.length < 2 : needle.length < 2)) continue;
        this.matchers.push({ id: t.id, needle, ascii: /^[\x00-\x7f]+$/.test(needle) });
      }
    }
    // Longest first, so "部分退款" is matched before "退款".
    this.matchers.sort((a, b) => b.needle.length - a.needle.length);
    const h = createHash('sha256');
    for (const t of this.tags) h.update(`${t.id}\u0000${t.label}\u0000${t.aliases.join('\u0001')}\n`);
    this.version = Number.parseInt(h.digest('hex').slice(0, 8), 16);
  }

  /** Tags whose label or alias the text names (Latin terms on word boundaries). */
  tagText(text: string): string[] {
    if (!text || !this.matchers.length) return [];
    const lc = text.toLowerCase();
    const out = new Set<string>();
    for (const m of this.matchers) {
      if (out.has(m.id)) continue;
      const i = lc.indexOf(m.needle);
      if (i < 0) continue;
      if (m.ascii) {
        const before = i === 0 ? '' : lc[i - 1]!;
        const after = lc[i + m.needle.length] ?? '';
        if (/[a-z0-9_]/.test(before) || /[a-z0-9_]/.test(after)) continue;
      }
      out.add(m.id);
    }
    return [...out];
  }

  label(id: string): string {
    return this.byId.get(id)?.label ?? id;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Compact list for a model prompt: `id: label (alias, alias)`. */
  promptList(max = 300): string {
    return this.tags.slice(0, max).map((t) => `${t.id}: ${t.label}${t.aliases.length ? ` (${t.aliases.slice(0, 4).join(', ')})` : ''}`).join('\n');
  }
}
