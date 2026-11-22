import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRepoProfile, writeFileAtomicSync, type RepoIdentity, type RepoProfileFile } from '../codec/atomic-fs.ts';
import { withFileLock } from '../codec/file-lock.ts';

/** One repository this machine has opened with AccreMind. */
export interface RegistryRecord {
  repo_id: string;
  root: string;
  name: string;
  remote: string | null;
  org: string | null;
  domains: string[];
  languages: string[];
  last_seen: string;
}

/**
 * Machine-wide list of repositories (`~/.dsh/accremind/registry/repos.json`). It is how one repository's
 * runtime finds the shareable knowledge (domain entries) committed in the others.
 */
export class RepoRegistry {
  readonly file: string;
  private readonly lockFile: string;

  constructor(file: string, locksDir: string) {
    this.file = file;
    this.lockFile = path.join(locksDir, 'registry.lock');
  }

  list(): RegistryRecord[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { repos?: RegistryRecord[] };
      return Array.isArray(parsed.repos) ? parsed.repos.filter((r) => r && typeof r.repo_id === 'string' && typeof r.root === 'string') : [];
    } catch {
      return [];
    }
  }

  get(repoId: string): RegistryRecord | undefined {
    return this.list().find((r) => r.repo_id === repoId);
  }

  /** Adds or refreshes a repository; another record with the same folder (an old ID) is replaced. */
  upsert(record: RegistryRecord): void {
    withFileLock(this.lockFile, () => {
      const others = this.list().filter((r) => r.repo_id !== record.repo_id && path.resolve(r.root) !== path.resolve(record.root));
      const repos = [...others, record].sort((a, b) => a.repo_id.localeCompare(b.repo_id));
      writeFileAtomicSync(this.file, `${JSON.stringify({ version: 1, repos }, null, 2)}\n`);
    });
  }
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.java': 'java', '.kt': 'kotlin', '.rs': 'rust', '.rb': 'ruby',
  '.php': 'php', '.cs': 'csharp', '.swift': 'swift', '.scala': 'scala', '.c': 'c', '.h': 'c',
  '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.sql': 'sql', '.vue': 'vue', '.dart': 'dart',
};

export function languageOfPath(filePath: string): string | null {
  return LANGUAGE_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

/** Languages making up at least 5% of the tracked source files (Git), most common first. */
export function detectLanguages(root: string): string[] {
  let files: string[] = [];
  try {
    files = execFileSync('git', ['ls-files', '-z'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter(Boolean);
  } catch {
    try {
      files = fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
        .filter((f) => !f.includes('node_modules') && !f.startsWith('.git')).slice(0, 20_000);
    } catch {
      files = [];
    }
  }
  const counts = new Map<string, number>();
  let total = 0;
  for (const f of files) {
    const lang = languageOfPath(f);
    if (!lang) continue;
    total += 1;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n / Math.max(1, total) >= 0.05)
    .sort((a, b) => b[1] - a[1]).map(([lang]) => lang);
}

/** Declared dependencies and their version ranges (package.json, requirements.txt, go.mod, Cargo.toml). */
export function readRepoDependencies(root: string): Record<string, string> {
  const deps: Record<string, string> = {};
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(root, name), 'utf8');
    } catch {
      return null;
    }
  };
  const pkg = read('package.json');
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as Record<string, Record<string, string> | undefined>;
      Object.assign(deps, parsed.peerDependencies ?? {}, parsed.devDependencies ?? {}, parsed.dependencies ?? {});
    } catch {
      // unreadable manifest: no dependencies from it
    }
  }
  const req = read('requirements.txt');
  if (req) {
    for (const line of req.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*(?:==|>=|~=|<=|>|<)?\s*([0-9][^\s;#,]*)?/.exec(line);
      if (m && !line.trim().startsWith('#') && !line.trim().startsWith('-')) deps[m[1]!.toLowerCase()] = m[2] ?? '*';
    }
  }
  const gomod = read('go.mod');
  if (gomod) {
    for (const m of gomod.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v([0-9][^\s]*)/gim)) deps[m[1]!] = m[2]!;
  }
  const cargo = read('Cargo.toml');
  if (cargo) {
    const section = /\[dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1] ?? '';
    for (const m of section.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) deps[m[1]!] = m[2] ?? m[3] ?? '*';
  }
  return deps;
}

/** Writes `.accremind/repo.json` (meant to be committed, so every clone shares the ID and domains). */
export function writeRepoProfile(projectRoot: string, projectDirName: string, update: RepoProfileFile): RepoProfileFile {
  const current = readRepoProfile(projectRoot, projectDirName) ?? {};
  const next: RepoProfileFile = { ...current, ...update };
  if (next.domains) next.domains = [...new Set(next.domains.map((d) => String(d).trim()).filter(Boolean))];
  writeFileAtomicSync(path.join(projectRoot, projectDirName, 'repo.json'), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function registryRecordFor(identity: RepoIdentity, root: string, languages: string[]): RegistryRecord {
  return {
    repo_id: identity.repoId,
    root: path.resolve(root),
    name: identity.name,
    remote: identity.remote,
    org: identity.org,
    domains: identity.domains,
    languages,
    last_seen: new Date().toISOString(),
  };
}
