import type { ApplicabilitySpec, KnowledgeEntry } from '../contracts/types.ts';

export class MergeConflictError extends Error {
  readonly filePath?: string;

  constructor(message: string, filePath?: string) {
    super(message);
    this.name = 'MergeConflictError';
    this.filePath = filePath;
  }
}

export class MarkdownCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkdownCodecError';
  }
}

/**
 * Version of the on-disk entry format. Bump it whenever a field is added, renamed or changes meaning.
 * A plugin never parses (and therefore never rewrites) a file written in a newer format: the file is
 * listed under “文件问题” with an upgrade hint, so an older teammate cannot silently drop new fields.
 */
export const ENTRY_FORMAT_VERSION = 2;

/** Cards that carry none of the v2 fields are still written as v1, so older plugins keep reading them. */
export function entryUsesV2Fields(entry: KnowledgeEntry): boolean {
  const a = entry.applies_to ?? {};
  return Boolean(
    entry.origin_repo || entry.domains?.length || a.languages?.length || a.dependencies?.length ||
    a.repos?.length || a.exclude_repos?.length || entry.portable_patterns?.length || entry.owner ||
    entry.visibility || entry.overrides?.length || entry.specializes || entry.tags?.length,
  );
}

/** Drops every v2 field (used by the rollback that downgrades cards to the v1 format). */
export function stripV2Fields(entry: KnowledgeEntry): KnowledgeEntry {
  const { origin_repo: _o, domains: _d, applies_to: _a, portable_patterns: _p, owner: _w, visibility: _v,
    overrides: _r, specializes: _s, tags: _t, ...rest } = entry;
  return rest;
}

export class NewerFormatError extends MarkdownCodecError {
  readonly formatVersion: number;
  constructor(formatVersion: number, filePath?: string) {
    super(`该经验由更新版本的 AccreMind 写入（格式 v${formatVersion}，当前支持 v${ENTRY_FORMAT_VERSION}），请升级插件后再读取：${filePath ?? 'unknown'}`);
    this.name = 'NewerFormatError';
    this.formatVersion = formatVersion;
  }
}

const CONFLICT_MARKER_REGEX = /^(<<<<<<< |=======$|>>>>>>> )/m;

function formatScalar(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return JSON.stringify(String(val));
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'null' || trimmed === '~' || trimmed === '') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed === '[]') return [];
  if (trimmed === '{}') return {};
  return trimmed;
}

function serializeFrontmatterObject(record: Record<string, unknown>): string {
  const lines: string[] = ['---'];

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const entries = Object.entries(item as Record<string, unknown>);
          entries.forEach(([subKey, subVal], idx) => {
            const prefix = idx === 0 ? '  - ' : '    ';
            lines.push(`${prefix}${subKey}: ${formatScalar(subVal)}`);
          });
        } else {
          lines.push(`  - ${formatScalar(item)}`);
        }
      }
      continue;
    }

    if (value !== null && typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [subKey, subVal] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${subKey}: ${formatScalar(subVal)}`);
      }
      continue;
    }

    lines.push(`${key}: ${formatScalar(value)}`);
  }

  lines.push('---');
  return lines.join('\n');
}

function parseFrontmatterBlock(yamlText: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlText.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) {
      i += 1;
      continue;
    }

    const topMatch = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(line);
    if (!topMatch) {
      throw new MarkdownCodecError(`无法解析 Frontmatter 行: ${line}`);
    }

    const key = topMatch[1]!;
    const rest = topMatch[2] ?? '';

    if (rest.trim() !== '') {
      result[key] = parseScalar(rest);
      i += 1;
      continue;
    }

    // Nested block: inspect next non-empty line
    i += 1;
    const nextLine = lines[i] ?? '';
    if (nextLine.startsWith('  - ')) {
      const arr: unknown[] = [];
      while (i < lines.length) {
        const itemLine = lines[i] ?? '';
        if (!itemLine.trim()) {
          i += 1;
          continue;
        }
        if (!itemLine.startsWith('  - ')) break;

        const afterDash = itemLine.slice(4);
        const objPropMatch = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(afterDash);
        if (objPropMatch) {
          const obj: Record<string, unknown> = {
            [objPropMatch[1]!]: parseScalar(objPropMatch[2] ?? ''),
          };
          i += 1;
          while (i < lines.length) {
            const subLine = lines[i] ?? '';
            if (!subLine.startsWith('    ') || subLine.startsWith('  - ')) break;
            const subMatch = /^\s{4}([a-zA-Z0-9_]+):\s*(.*)$/.exec(subLine);
            if (subMatch) {
              obj[subMatch[1]!] = parseScalar(subMatch[2] ?? '');
            }
            i += 1;
          }
          arr.push(obj);
        } else {
          arr.push(parseScalar(afterDash));
          i += 1;
        }
      }
      result[key] = arr;
    } else if (nextLine.startsWith('  ')) {
      const nestedObj: Record<string, unknown> = {};
      while (i < lines.length) {
        const subLine = lines[i] ?? '';
        if (!subLine.trim()) {
          i += 1;
          continue;
        }
        if (!subLine.startsWith('  ') || subLine.startsWith('  - ')) break;
        const subMatch = /^\s{2}([a-zA-Z0-9_]+):\s*(.*)$/.exec(subLine);
        if (subMatch) {
          nestedObj[subMatch[1]!] = parseScalar(subMatch[2] ?? '');
        }
        i += 1;
      }
      result[key] = nestedObj;
    } else {
      result[key] = null;
    }
  }

  return result;
}

function extractSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const regex = /^##\s+([^\r\n]+)\r?\n([\s\S]*?)(?=^##\s+|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    const heading = match[1]!.trim().toLowerCase();
    sections[heading] = match[2]!.trim();
  }
  return sections;
}

/**
 * Deterministically serializes a KnowledgeEntry into Git-friendly Markdown (MdCG card style).
 * Body holds Claim, Knowledge Delta, Rationale, and Verification for human readability in PRs.
 */
export function serializeEntryMarkdown(entry: KnowledgeEntry): string {
  const v2 = entryUsesV2Fields(entry);
  const a = entry.applies_to ?? {};
  const nonEmpty = <T>(list: T[] | undefined) => (list && list.length ? list : undefined);
  // Flat keys only: the frontmatter codec nests one level (lists of flat objects).
  const v2Data: Record<string, unknown> = v2 ? {
    origin_repo: entry.origin_repo || undefined,
    domains: nonEmpty(entry.domains),
    applies_languages: nonEmpty(a.languages),
    applies_dependencies: nonEmpty(a.dependencies),
    applies_repos: nonEmpty(a.repos),
    exclude_repos: nonEmpty(a.exclude_repos),
    portable_patterns: nonEmpty(entry.portable_patterns),
    owner: entry.owner || undefined,
    visibility: entry.visibility || undefined,
    overrides: nonEmpty(entry.overrides),
    specializes: entry.specializes || undefined,
    tags: nonEmpty(entry.tags),
  } : {};
  const frontmatterData: Record<string, unknown> = {
    format_version: v2 ? 2 : 1,
    id: entry.id,
    revision: entry.revision,
    type: entry.type,
    ...(entry.polarity ? { polarity: entry.polarity } : {}),
    knowledge_role: entry.knowledge_role,
    layer: entry.layer,
    title: entry.title,
    search_aliases: entry.search_aliases,
    status: entry.status,
    maturity: entry.maturity,
    freshness: entry.freshness,
    serving: entry.serving,
    priority: entry.priority,
    capture_assessment_id: entry.capture_assessment_id,
    supersedes: entry.supersedes,
    preconditions: entry.preconditions,
    exclusions: entry.exclusions,
    dependency_constraints: entry.dependency_constraints,
    watch_paths: entry.watch_paths,
    symbol_anchors: entry.symbol_anchors,
    invalidation_triggers: entry.invalidation_triggers,
    alternatives: entry.alternatives,
    evidence: entry.evidence,
    enforcement: entry.enforcement,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    last_validated_at: entry.last_validated_at,
    review_due_at: entry.review_due_at,
    ...v2Data,
  };

  const fm = serializeFrontmatterObject(frontmatterData);
  const sections = [
    fm,
    '',
    '## Claim',
    entry.claim.trim(),
    '',
    '## Knowledge Delta',
    entry.knowledge_delta.trim(),
    '',
    '## Rationale',
    entry.rationale.trim(),
    '',
    '## Verification',
    entry.verification_method.trim(),
    '',
  ];
  return sections.join('\n');
}

export function parseEntryMarkdown(markdown: string, filePath?: string): KnowledgeEntry {
  if (CONFLICT_MARKER_REGEX.test(markdown)) {
    throw new MergeConflictError(
      `检测到未解决的 Git 合并冲突标记，已隔离该条目文件: ${filePath ?? 'unknown'}`,
      filePath,
    );
  }

  const normalized = markdown.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    throw new MarkdownCodecError(`缺少 YAML Frontmatter 起始标记: ${filePath ?? 'unknown'}`);
  }

  const endMarkerIdx = normalized.indexOf('\n---', 3);
  if (endMarkerIdx === -1) {
    throw new MarkdownCodecError(`缺少 YAML Frontmatter 闭合标记: ${filePath ?? 'unknown'}`);
  }

  const yamlBlock = normalized.slice(4, endMarkerIdx);
  const restAfterMarker = normalized.slice(endMarkerIdx + 4).replace(/^\r?\n/, '');

  const meta = parseFrontmatterBlock(yamlBlock);
  // Files without the field predate versioning and are format 1.
  const formatVersion = meta.format_version === undefined || meta.format_version === null ? 1 : Number(meta.format_version);
  if (!Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new MarkdownCodecError(`无法识别的经验文件格式版本 ${String(meta.format_version)}: ${filePath ?? 'unknown'}`);
  }
  if (formatVersion > ENTRY_FORMAT_VERSION) throw new NewerFormatError(formatVersion, filePath);
  const sections = extractSections(restAfterMarker);

  const pickSection = (keys: string[], fallbackField?: string): string => {
    for (const k of keys) {
      if (sections[k] !== undefined) return sections[k]!;
    }
    return typeof fallbackField === 'string' ? fallbackField : '';
  };

  const entry: KnowledgeEntry = {
    id: String(meta.id ?? ''),
    revision: Number(meta.revision ?? 1),
    type: meta.type as KnowledgeEntry['type'],
    ...(meta.polarity ? { polarity: meta.polarity as 'recommend' | 'avoid' } : {}),
    knowledge_role: (meta.knowledge_role as KnowledgeEntry['knowledge_role']) ?? 'experience',
    layer: (meta.layer as KnowledgeEntry['layer']) ?? 'project',
    title: String(meta.title ?? ''),
    search_aliases: Array.isArray(meta.search_aliases) ? meta.search_aliases.map(String) : [],
    claim: pickSection(['claim', '核心结论 (claim)', '核心结论'], meta.claim as string | undefined),
    knowledge_delta: pickSection(
      ['knowledge delta', '相较现有代码新增的上下文 (knowledge delta)', '新增上下文'],
      meta.knowledge_delta as string | undefined,
    ),
    rationale: pickSection(
      ['rationale', '为什么与证据依据 (rationale)', '结论依据'],
      meta.rationale as string | undefined,
    ),
    verification_method: pickSection(
      ['verification', '验证方法 (verification)', '验证方法'],
      meta.verification_method as string | undefined,
    ),
    preconditions: Array.isArray(meta.preconditions) ? meta.preconditions.map(String) : [],
    exclusions: Array.isArray(meta.exclusions) ? meta.exclusions.map(String) : [],
    dependency_constraints: Array.isArray(meta.dependency_constraints)
      ? (meta.dependency_constraints as KnowledgeEntry['dependency_constraints'])
      : [],
    watch_paths: Array.isArray(meta.watch_paths) ? meta.watch_paths.map(String) : [],
    symbol_anchors: Array.isArray(meta.symbol_anchors)
      ? (meta.symbol_anchors as KnowledgeEntry['symbol_anchors']).map((a) => ({
          file_path: String(a.file_path),
          symbol_name: String(a.symbol_name),
          normalized_sha256: String(a.normalized_sha256),
          start_line: Number(a.start_line),
          end_line: Number(a.end_line),
        }))
      : [],
    invalidation_triggers: Array.isArray(meta.invalidation_triggers)
      ? meta.invalidation_triggers.map(String)
      : [],
    alternatives: Array.isArray(meta.alternatives)
      ? (meta.alternatives as KnowledgeEntry['alternatives'])
      : [],
    evidence: Array.isArray(meta.evidence) ? (meta.evidence as KnowledgeEntry['evidence']) : [],
    enforcement: (meta.enforcement as KnowledgeEntry['enforcement']) ?? {
      kind: 'none',
      status: 'proposed',
      ref: null,
    },
    status: (meta.status as KnowledgeEntry['status']) ?? 'active',
    maturity: (meta.maturity as KnowledgeEntry['maturity']) ?? 'draft',
    freshness: (meta.freshness as KnowledgeEntry['freshness']) ?? 'current',
    serving: (meta.serving as KnowledgeEntry['serving']) ?? 'enabled',
    priority: (meta.priority as KnowledgeEntry['priority']) ?? 'P1',
    capture_assessment_id:
      meta.capture_assessment_id === null || meta.capture_assessment_id === undefined
        ? null
        : String(meta.capture_assessment_id),
    supersedes:
      meta.supersedes === null || meta.supersedes === undefined ? null : String(meta.supersedes),
    created_at: String(meta.created_at ?? new Date().toISOString()),
    updated_at: String(meta.updated_at ?? meta.created_at ?? new Date().toISOString()),
    last_validated_at:
      meta.last_validated_at === null || meta.last_validated_at === undefined
        ? null
        : String(meta.last_validated_at),
    review_due_at: String(meta.review_due_at ?? new Date().toISOString()),
  };

  const strList = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : undefined);
  const str = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : String(v));
  if (str(meta.origin_repo)) entry.origin_repo = str(meta.origin_repo)!;
  if (strList(meta.domains)?.length) entry.domains = strList(meta.domains);
  const applies: ApplicabilitySpec = {};
  if (strList(meta.applies_languages)?.length) applies.languages = strList(meta.applies_languages);
  if (Array.isArray(meta.applies_dependencies) && meta.applies_dependencies.length) {
    applies.dependencies = (meta.applies_dependencies as Array<Record<string, unknown>>)
      .map((d) => ({ name: String(d.name ?? ''), range: String(d.range ?? '*') }))
      .filter((d) => d.name);
  }
  if (strList(meta.applies_repos)?.length) applies.repos = strList(meta.applies_repos);
  if (strList(meta.exclude_repos)?.length) applies.exclude_repos = strList(meta.exclude_repos);
  if (Object.keys(applies).length) entry.applies_to = applies;
  if (strList(meta.portable_patterns)?.length) entry.portable_patterns = strList(meta.portable_patterns);
  if (str(meta.owner)) entry.owner = str(meta.owner)!;
  const visibility = str(meta.visibility);
  if (visibility === 'private' || visibility === 'team' || visibility === 'org') entry.visibility = visibility;
  if (Array.isArray(meta.overrides) && meta.overrides.length) {
    entry.overrides = (meta.overrides as Array<Record<string, unknown>>).map((o) => ({
      rule_id: String(o.rule_id ?? ''), reason: String(o.reason ?? ''),
      approver: String(o.approver ?? ''), expires_at: String(o.expires_at ?? ''),
    })).filter((o) => o.rule_id);
  }
  if (str(meta.specializes)) entry.specializes = str(meta.specializes)!;
  if (strList(meta.tags)?.length) entry.tags = strList(meta.tags);

  return entry;
}
