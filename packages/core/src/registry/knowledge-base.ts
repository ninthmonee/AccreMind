import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expandHomeDir, writeFileAtomicSync } from '../codec/atomic-fs.ts';
import { withFileLock } from '../codec/file-lock.ts';

/**
 * The knowledge base shared by a team, outside any single project:
 *
 *   <root>/domains/<domain>.json         one file per domain: name, aliases, parent, owners
 *   <root>/members/<repo>.json           one file per repository: the domains it belongs to, and as what
 *   <root>/docs/<category>/*.md          domain documents that belong to no single project
 *   <root>/docs/changes.ndjson           their change log (+ CHANGELOG.md)
 *   <root>/feedback/<repo>/<user>.json   usage counts shared across machines (no prompts, no sessions)
 *
 * Splitting the catalog by domain and by repository keeps Git merges clean: adding a domain or joining one
 * touches a file nobody else edits at the same time. (`domains.json` from earlier versions is read and
 * migrated on the first change.) A team mounts a Git repository (`accremind team set <path>`) so all of this
 * is reviewed and shared like code; without one, `~/.dsh/accremind/knowledge/` is used: same layout, this machine only.
 */
export interface KnowledgeBaseInfo {
  root: string;
  /** `team`: a mounted folder (normally a Git repository) · `local`: this machine only. */
  kind: 'team' | 'local';
  /** On mount: files carried over from this machine's knowledge base (domains, memberships, documents). */
  carriedOver?: string[];
}

/**
 * What was built on this machine before a team knowledge base existed (domains, memberships, domain documents)
 * is copied into it on mount, so nothing silently disappears when the catalog switches. Files the team already
 * has are left alone (theirs win); change logs are appended.
 */
function carryOverLocal(localRoot: string, teamRoot: string): string[] {
  if (path.resolve(localRoot) === path.resolve(teamRoot) || !fs.existsSync(localRoot)) return [];
  // Once per team knowledge base: mounting it again (or after unmounting) does not copy or log twice.
  const marker = path.join(localRoot, '.carried-over.json');
  const done = (readJson<{ roots?: string[] }>(marker)?.roots ?? []).map((r) => path.resolve(r));
  if (done.includes(path.resolve(teamRoot))) return [];
  const copied: string[] = [];
  const walk = (rel: string) => {
    const from = path.join(localRoot, rel);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) {
        walk(r);
        continue;
      }
      if (!e.isFile() || e.name === 'CHANGELOG.md') continue;
      const to = path.join(teamRoot, r);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (e.name === 'changes.ndjson') {
        const lines = fs.readFileSync(path.join(localRoot, r), 'utf8');
        if (lines.trim()) {
          fs.appendFileSync(to, lines.endsWith('\n') ? lines : `${lines}\n`);
          copied.push(r);
        }
      } else if (!fs.existsSync(to)) {
        fs.copyFileSync(path.join(localRoot, r), to);
        copied.push(r);
      }
    }
  };
  for (const top of ['domains', 'members', 'docs']) walk(top);
  // A catalog from before per-domain files: merged into the team's on its next change.
  const legacy = path.join(localRoot, 'domains.json');
  if (fs.existsSync(legacy) && !fs.existsSync(path.join(teamRoot, 'domains.json'))) {
    fs.copyFileSync(legacy, path.join(teamRoot, 'domains.json'));
    copied.push('domains.json');
  }
  writeFileAtomicSync(marker, `${JSON.stringify({ roots: [...done, path.resolve(teamRoot)] }, null, 2)}\n`);
  return copied;
}

function configFile(globalRoot: string): string {
  return path.join(globalRoot, 'knowledge.json');
}

export function resolveKnowledgeBase(globalRoot: string): KnowledgeBaseInfo {
  const env = process.env.ACCREMIND_KNOWLEDGE_ROOT?.trim();
  if (env) return { root: path.resolve(expandHomeDir(env)), kind: 'team' };
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(globalRoot), 'utf8')) as { root?: string };
    if (cfg.root && fs.existsSync(cfg.root)) return { root: path.resolve(cfg.root), kind: 'team' };
  } catch {
    // not mounted
  }
  return { root: path.join(globalRoot, 'knowledge'), kind: 'local' };
}

/** Mounts a team knowledge base (creates the layout if the folder is empty); `null` unmounts. */
export function mountKnowledgeBase(globalRoot: string, dir: string | null): KnowledgeBaseInfo {
  if (dir === null) {
    fs.rmSync(configFile(globalRoot), { force: true });
    return resolveKnowledgeBase(globalRoot);
  }
  const root = path.resolve(expandHomeDir(dir));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`目录不存在：${root}`);
  for (const d of ['domains', 'members', 'docs']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const carriedOver = carryOverLocal(path.join(globalRoot, 'knowledge'), root);
  writeFileAtomicSync(configFile(globalRoot), `${JSON.stringify({ root, mountedAt: new Date().toISOString() }, null, 2)}\n`);
  return { root, kind: 'team', carriedOver };
}

export type DomainRole = 'core' | 'consumer';

export interface DomainMember {
  /** Repository ID (as in repo.json / the registry). */
  repo: string;
  role: DomainRole;
  /** A sub-project of that repository, when only part of it belongs to the domain. */
  subproject?: string;
}

export interface DomainDef {
  /** Stable ID, e.g. `payment`. */
  id: string;
  /** Display name, e.g. `支付`. */
  name: string;
  /** Other spellings people use (`pay`, `支付域`); matched case-insensitively. */
  aliases: string[];
  /** Parent domain: a project in `refund` also gets the rules of `payment`. */
  parent?: string | null;
  owners: string[];
  members: DomainMember[];
  description?: string;
}

export interface DomainMembership {
  id: string;
  name: string;
  role: DomainRole;
  /** False when the name is not in the catalog (kept as written). */
  known: boolean;
}

const norm = (s: string) => s.trim().toLowerCase();

export function domainIdFor(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'domain';
}

type DomainFile = Omit<DomainDef, 'members'>;
interface MembersFile {
  version: 1;
  repo: string;
  memberships: Array<{ domain: string; role: DomainRole; subproject?: string }>;
}

function fileNameFor(id: string): string {
  return `${id.trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^\.+/, '_') || 'domain'}.json`;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function normalizeDef(d: Partial<DomainDef>): DomainFile | null {
  if (!d || typeof d.id !== 'string' || !d.id.trim()) return null;
  return {
    id: String(d.id).trim(),
    name: String(d.name ?? d.id).trim(),
    aliases: Array.isArray(d.aliases) ? d.aliases.map(String).map((a) => a.trim()).filter(Boolean) : [],
    parent: typeof d.parent === 'string' && d.parent.trim() ? d.parent.trim() : null,
    owners: Array.isArray(d.owners) ? d.owners.map(String).filter(Boolean) : [],
    ...(d.description ? { description: String(d.description) } : {}),
  };
}

function normalizeMember(m: Partial<DomainMember> | undefined): DomainMember | null {
  if (!m || typeof m.repo !== 'string' || !m.repo) return null;
  return { repo: m.repo, role: m.role === 'consumer' ? 'consumer' : 'core', ...(m.subproject ? { subproject: String(m.subproject) } : {}) };
}

/**
 * The domain catalog of a knowledge base: which domains exist, what else they are called, how they nest, who
 * owns them and which projects belong to them (and as what). Stored as `domains/<id>.json` + `members/<repo>.json`.
 */
export class DomainCatalog {
  readonly root: string;
  /** Where the domain definitions live (`<root>/domains`). */
  readonly file: string;
  private readonly membersDir: string;
  private readonly legacyFile: string;
  private readonly lockFile: string;
  /** Shared by every catalog of the same knowledge base in this process, so one store's change is seen by all. */
  private static readonly caches = new Map<string, { sig: string; checkedAt: number; domains: DomainDef[]; fileById: Map<string, string> }>();

  private get cache() {
    return DomainCatalog.caches.get(this.root) ?? null;
  }

  private set cache(v: { sig: string; checkedAt: number; domains: DomainDef[]; fileById: Map<string, string> } | null) {
    if (v) DomainCatalog.caches.set(this.root, v);
    else DomainCatalog.caches.delete(this.root);
  }

  constructor(root: string, locksDir: string) {
    this.root = root;
    this.file = path.join(root, 'domains');
    this.membersDir = path.join(root, 'members');
    this.legacyFile = path.join(root, 'domains.json');
    this.lockFile = path.join(locksDir, 'domains.lock');
  }

  private jsonFiles(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  private signature(): string {
    const parts: string[] = [];
    for (const f of [this.legacyFile, ...this.jsonFiles(this.file), ...this.jsonFiles(this.membersDir)]) {
      try {
        const st = fs.statSync(f);
        parts.push(`${f}:${st.mtimeMs}:${st.size}`);
      } catch {
        // gone
      }
    }
    return parts.join('|');
  }

  list(): DomainDef[] {
    const now = Date.now();
    // A Git pull can change the files at any time; re-checking at most once a second keeps per-turn reads cheap.
    if (this.cache && now - this.cache.checkedAt < 1000) return this.cache.domains;
    const sig = this.signature();
    if (this.cache && this.cache.sig === sig) {
      this.cache.checkedAt = now;
      return this.cache.domains;
    }
    const defs = new Map<string, DomainFile>();
    const fileById = new Map<string, string>();
    const members = new Map<string, DomainMember[]>();
    const addMember = (domain: string, m: DomainMember) => {
      const list = members.get(domain) ?? [];
      if (!list.some((x) => x.repo === m.repo && (x.subproject ?? '') === (m.subproject ?? ''))) list.push(m);
      members.set(domain, list);
    };
    const legacy = readJson<{ domains?: Array<Partial<DomainDef>> }>(this.legacyFile);
    for (const d of legacy?.domains ?? []) {
      const def = normalizeDef(d);
      if (!def) continue;
      defs.set(def.id, def);
      for (const m of Array.isArray(d.members) ? d.members : []) {
        const n = normalizeMember(m);
        if (n) addMember(def.id, n);
      }
    }
    for (const f of this.jsonFiles(this.file)) {
      const def = normalizeDef(readJson<Partial<DomainDef>>(f) ?? {});
      if (!def) continue;
      defs.set(def.id, def);
      fileById.set(def.id, f);
    }
    for (const f of this.jsonFiles(this.membersDir)) {
      const raw = readJson<Partial<MembersFile>>(f);
      if (!raw || typeof raw.repo !== 'string') continue;
      for (const m of Array.isArray(raw.memberships) ? raw.memberships : []) {
        if (!m || typeof m.domain !== 'string') continue;
        const n = normalizeMember({ repo: raw.repo, role: m.role, subproject: m.subproject });
        if (n) addMember(m.domain, n);
      }
    }
    const domains = [...defs.values()].sort((a, b) => a.id.localeCompare(b.id)).map((d) => ({ ...d, members: members.get(d.id) ?? [] }));
    this.cache = { sig, checkedAt: now, domains, fileById };
    return domains;
  }

  get(id: string): DomainDef | undefined {
    return this.list().find((d) => d.id === id);
  }

  /** The catalog ID a name, ID or alias refers to (case-insensitive), or null. */
  resolve(term: string): string | null {
    const t = norm(term);
    if (!t) return null;
    for (const d of this.list()) {
      if (norm(d.id) === t || norm(d.name) === t || d.aliases.some((a) => norm(a) === t)) return d.id;
    }
    return null;
  }

  /** The domain and its parents, nearest first (cycles are cut). */
  lineage(id: string): DomainDef[] {
    const out: DomainDef[] = [];
    const seen = new Set<string>();
    let cur = this.get(id);
    while (cur && !seen.has(cur.id)) {
      out.push(cur);
      seen.add(cur.id);
      cur = cur.parent ? this.get(cur.parent) : undefined;
    }
    return out;
  }

  /** Every spelling that identifies these domains or their parents (ID, name, aliases). */
  matchKeys(ids: string[]): string[] {
    const keys = new Set<string>();
    for (const id of ids) {
      const line = this.lineage(id);
      if (!line.length) {
        keys.add(id);
        continue;
      }
      for (const d of line) {
        keys.add(d.id);
        keys.add(d.name);
        for (const a of d.aliases) keys.add(a);
      }
    }
    return [...keys].filter(Boolean);
  }

  /**
   * Which domains a repository (or one of its sub-projects) belongs to, and as what: the catalog's member list,
   * then what the repository declares in repo.json (unknown names are kept as written).
   */
  membership(repoId: string, declared: string[], declaredRoles: Record<string, DomainRole> = {}, subprojects: string[] = []): DomainMembership[] {
    const out = new Map<string, DomainMembership>();
    for (const d of this.list()) {
      const m = d.members.find((x) => x.repo === repoId && (!x.subproject || subprojects.includes(x.subproject)));
      if (m) out.set(d.id, { id: d.id, name: d.name, role: m.role, known: true });
    }
    for (const name of declared) {
      const id = this.resolve(name);
      if (id && out.has(id)) continue;
      const def = id ? this.get(id) : undefined;
      out.set(id ?? name, { id: id ?? name, name: def?.name ?? name, role: declaredRoles[name] ?? declaredRoles[id ?? ''] ?? 'core', known: Boolean(id) });
    }
    return [...out.values()];
  }

  /** Projects that belong to a domain (directly or through a sub-domain), with their roles. */
  membersOf(id: string): DomainMember[] {
    const ids = new Set([id, ...this.list().filter((d) => this.lineage(d.id).some((x) => x.id === id)).map((d) => d.id)]);
    return this.list().filter((d) => ids.has(d.id)).flatMap((d) => d.members);
  }

  /** Names among `terms` that are not in the catalog. */
  unknown(terms: string[]): string[] {
    return terms.filter((t) => !this.resolve(t));
  }

  /** Domain names similar to `term`, for "did you mean" messages. */
  suggest(term: string): string[] {
    const t = norm(term);
    return this.list().filter((d) => [d.id, d.name, ...d.aliases].some((k) => norm(k).includes(t) || t.includes(norm(k))))
      .map((d) => `${d.name}（${d.id}）`).slice(0, 5);
  }

  private locked<T>(fn: () => T): T {
    return withFileLock(this.lockFile, () => {
      this.cache = null;
      try {
        this.migrateLegacy();
        return fn();
      } finally {
        this.cache = null;
      }
    });
  }

  /** Moves a `domains.json` of an earlier version into the per-domain / per-repository files (once). */
  private migrateLegacy(): void {
    const legacy = readJson<{ domains?: Array<Partial<DomainDef>> }>(this.legacyFile);
    if (!legacy) return;
    fs.mkdirSync(this.file, { recursive: true });
    const byRepo = new Map<string, MembersFile>();
    for (const d of legacy.domains ?? []) {
      const def = normalizeDef(d);
      if (!def) continue;
      const target = path.join(this.file, fileNameFor(def.id));
      if (!fs.existsSync(target)) writeFileAtomicSync(target, `${JSON.stringify(def, null, 2)}\n`);
      for (const m of Array.isArray(d.members) ? d.members : []) {
        const n = normalizeMember(m);
        if (!n) continue;
        const file = byRepo.get(n.repo) ?? this.readMembers(n.repo);
        if (!file.memberships.some((x) => x.domain === def.id && (x.subproject ?? '') === (n.subproject ?? ''))) {
          file.memberships.push({ domain: def.id, role: n.role, ...(n.subproject ? { subproject: n.subproject } : {}) });
        }
        byRepo.set(n.repo, file);
      }
    }
    for (const f of byRepo.values()) this.writeMembers(f);
    fs.rmSync(this.legacyFile, { force: true });
  }

  private membersFile(repo: string): string {
    return path.join(this.membersDir, fileNameFor(repo));
  }

  private readMembers(repo: string): MembersFile {
    const raw = readJson<Partial<MembersFile>>(this.membersFile(repo));
    return { version: 1, repo, memberships: Array.isArray(raw?.memberships) ? raw!.memberships.filter((m) => m && typeof m.domain === 'string') : [] };
  }

  private writeMembers(f: MembersFile): void {
    const file = this.membersFile(f.repo);
    if (!f.memberships.length) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(this.membersDir, { recursive: true });
    f.memberships.sort((a, b) => `${a.domain}|${a.subproject ?? ''}`.localeCompare(`${b.domain}|${b.subproject ?? ''}`));
    writeFileAtomicSync(file, `${JSON.stringify(f, null, 2)}\n`);
  }

  /** Adds or updates a domain; lists are merged, not replaced. */
  upsert(def: Partial<DomainDef> & { name?: string; id?: string }): DomainDef {
    const id = def.id?.trim() || (def.name ? this.resolve(def.name) ?? domainIdFor(def.name) : '');
    if (!id) throw new Error('请提供领域 id 或名称');
    if (def.parent) {
      const parent = this.resolve(def.parent);
      if (!parent) throw new Error(`上级领域不存在：${def.parent}`);
      if (parent === id || this.lineage(parent).some((d) => d.id === id)) throw new Error('上级领域不能是它自己或它的下级');
      def.parent = parent;
    }
    this.locked(() => {
      const cur = this.get(id);
      const merged: DomainFile = {
        id,
        name: def.name?.trim() || cur?.name || id,
        aliases: [...new Set([...(cur?.aliases ?? []), ...(def.aliases ?? [])].map((a) => a.trim()).filter((a) => a && a !== id))],
        parent: def.parent !== undefined ? def.parent : cur?.parent ?? null,
        owners: [...new Set([...(cur?.owners ?? []), ...(def.owners ?? [])])],
        ...(def.description ?? cur?.description ? { description: def.description ?? cur?.description } : {}),
      };
      fs.mkdirSync(this.file, { recursive: true });
      // Keep a domain in the file it already has (it may have been named by hand), else name the file after its ID.
      const target = this.cache?.fileById.get(id) ?? path.join(this.file, fileNameFor(id));
      writeFileAtomicSync(target, `${JSON.stringify(merged, null, 2)}\n`);
      for (const m of def.members ?? []) this.writeMembership(id, m);
    });
    return this.get(id)!;
  }

  private writeMembership(domain: string, member: DomainMember): void {
    const f = this.readMembers(member.repo);
    f.memberships = f.memberships.filter((x) => !(x.domain === domain && (x.subproject ?? '') === (member.subproject ?? '')));
    f.memberships.push({ domain, role: member.role, ...(member.subproject ? { subproject: member.subproject } : {}) });
    this.writeMembers(f);
  }

  /** Adds (or changes the role of) a member project. */
  addMember(domain: string, member: DomainMember): DomainDef {
    const id = this.resolve(domain);
    if (!id) throw new Error(`领域不存在：${domain}${this.suggest(domain).length ? `（是否指：${this.suggest(domain).join('、')}）` : ''}`);
    this.locked(() => this.writeMembership(id, member));
    return this.get(id)!;
  }

  removeMember(domain: string, repo: string, subproject?: string): DomainDef {
    const id = this.resolve(domain);
    if (!id) throw new Error(`领域不存在：${domain}`);
    this.locked(() => {
      const f = this.readMembers(repo);
      f.memberships = f.memberships.filter((m) => !(m.domain === id && (m.subproject ?? '') === (subproject ?? '')));
      this.writeMembers(f);
    });
    return this.get(id)!;
  }
}

export interface GitShareStatus {
  isGit: boolean;
  /** Changed or new files not committed yet (under `subdir`, when given). */
  uncommitted: number;
  /** Local commits not pushed (against the upstream as last fetched; no network access). */
  ahead: number;
  /** Upstream commits not pulled yet (as of the last fetch). */
  behind: number;
  hasUpstream: boolean;
}

/**
 * Whether knowledge written here has reached the team: AccreMind writes files but never commits or pushes,
 * so the workbench says what is still only on this machine. Reads the local Git state only (fast, offline).
 */
export function gitShareStatus(root: string, subdir?: string): GitShareStatus {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  const out: GitShareStatus = { isGit: false, uncommitted: 0, ahead: 0, behind: 0, hasUpstream: false };
  try {
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return out;
  } catch {
    return out;
  }
  out.isGit = true;
  try {
    const status = git(['status', '--porcelain', '--untracked-files=all', '--', subdir ?? '.']);
    out.uncommitted = status ? status.split('\n').length : 0;
  } catch {
    // leave 0
  }
  try {
    const [behind, ahead] = git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']).split(/\s+/).map(Number);
    out.hasUpstream = true;
    out.behind = behind ?? 0;
    out.ahead = ahead ?? 0;
  } catch {
    // no upstream configured
  }
  return out;
}
