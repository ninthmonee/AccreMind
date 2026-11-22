import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StorageZone } from '../contracts/types.ts';

export interface StoreLayoutPaths {
  /** Stable repository ID (see `resolveRepoIdentity`); every per-repository folder is keyed by it. */
  workspaceId: string;
  /** Path-hash ID used before repository identities existed (per-repository folders are migrated from it). */
  legacyWorkspaceId: string;
  globalRoot: string;
  /** Machine-wide entry index shared by every repository (derived from the cards; rebuildable). */
  globalIndexPath: string;
  /** Domain knowledge without a home repository. */
  domainDir: string;
  /** Machine-wide registry of repositories seen by AccreMind. */
  registryFile: string;
  /** Cross-repository feedback on shared entries (one NDJSON file per entry). */
  feedbackDir: string;
  /** Lock files for writes to machine-wide folders. */
  locksDir: string;
  /** Manifests and backups of `accremind migrate`. */
  migrationsDir: string;
  /** Committed repository profile (`.accremind/repo.json`). */
  repoProfileFile: string;
  /** Ledger and evidence of machine-wide entries, shared by every repository on this machine. */
  globalLedgerDir: string;
  globalEvidenceDir: string;
  sqlitePath: string;
  legacySqlitePath: string;
  eventsDir: string;
  probationDir: string;
  personalDir: string;
  sharedTechDir: string;
  queueDir: string;
  projectRoot: string;
  projectAccreMindDir: string;
  projectRulesDir: string;
  projectEntriesDir: string;
  navigationFilePath: string;
  /** Evidence snapshots of repository entries (shared with the repository). */
  evidenceDir: string;
  /** Evidence snapshots of local-only entries (trials, personal). */
  localEvidenceDir: string;
  /** Validation ledger when sharing is on (in the repository). */
  ledgerDir: string;
  /** Validation ledger when sharing is off (this machine only). */
  localLedgerDir: string;
}

export function expandHomeDir(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

export function computeWorkspaceId(projectRoot: string): string {
  const normalized = path.resolve(projectRoot);
  const base = path.basename(normalized).replace(/[^a-zA-Z0-9_-]/g, '_');
  const shortHash = createHash('sha256').update(normalized).digest('hex').slice(0, 10);
  return `${base}-${shortHash}`;
}

export interface RepoIdentity {
  repoId: string;
  /** Where the ID came from: the committed profile, the Git remote, or (fallback) the folder path. */
  source: 'repo.json' | 'remote' | 'path';
  name: string;
  remote: string | null;
  /** `host/owner` of the remote. */
  org: string | null;
  domains: string[];
}

export interface RepoProfileFile {
  repo_id?: string;
  domains?: string[];
  org?: string;
}

/** `git@github.com:Acme/Pay.git`, `https://user@github.com/acme/pay` → `github.com/acme/pay`. */
export function normalizeGitRemote(url: string): string | null {
  let u = url.trim();
  if (!u) return null;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  u = u.replace(/:\d+\//, '/').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  return u.includes('/') ? u : null;
}

export function readRepoProfile(projectRoot: string, projectDirName = '.accremind'): RepoProfileFile | null {
  const file = path.join(projectRoot, projectDirName, 'repo.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RepoProfileFile;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const SAFE_REPO_ID = /^[A-Za-z0-9_.-]{1,80}$/;

/**
 * Stable repository identity, independent of where the folder lives: the committed `.accremind/repo.json`
 * wins, then the normalized `origin` remote, then (no remote) the old path hash.
 */
export function resolveRepoIdentity(projectRoot: string, projectDirName = '.accremind'): RepoIdentity {
  const root = path.resolve(projectRoot);
  const profile = readRepoProfile(root, projectDirName);
  let remote: string | null = null;
  try {
    remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).trim() || null;
  } catch {
    remote = null;
  }
  const normalized = remote ? normalizeGitRemote(remote) : null;
  const org = profile?.org?.trim() || (normalized ? normalized.split('/').slice(0, -1).join('/') : null);
  const domains = Array.isArray(profile?.domains) ? profile!.domains!.map(String).map((d) => d.trim()).filter(Boolean) : [];
  if (profile?.repo_id && SAFE_REPO_ID.test(profile.repo_id)) {
    return { repoId: profile.repo_id, source: 'repo.json', name: path.basename(root), remote: normalized, org, domains };
  }
  if (normalized) {
    const name = normalized.split('/').at(-1)!.replace(/[^a-zA-Z0-9_-]/g, '_');
    return {
      repoId: `${name}-${createHash('sha256').update(normalized).digest('hex').slice(0, 10)}`,
      source: 'remote', name, remote: normalized, org, domains,
    };
  }
  return { repoId: computeWorkspaceId(root), source: 'path', name: path.basename(root), remote: null, org, domains };
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function resolveStorePaths(options: {
  projectRoot: string;
  globalDir?: string;
  projectDirName?: string;
  workspaceId?: string;
}): StoreLayoutPaths {
  const projectRoot = path.resolve(options.projectRoot);
  const globalRoot = expandHomeDir(options.globalDir ?? '~/.dsh/accremind');
  const projectDirName = options.projectDirName ?? '.accremind';
  const legacyWorkspaceId = computeWorkspaceId(projectRoot);
  const workspaceId = options.workspaceId ?? resolveRepoIdentity(projectRoot, projectDirName).repoId;
  const projectAccreMindDir = path.join(projectRoot, projectDirName);

  return {
    workspaceId,
    legacyWorkspaceId,
    globalRoot,
    globalIndexPath: path.join(globalRoot, 'index', 'global.sqlite'),
    domainDir: path.join(globalRoot, 'domain'),
    registryFile: path.join(globalRoot, 'registry', 'repos.json'),
    feedbackDir: path.join(globalRoot, 'feedback'),
    locksDir: path.join(globalRoot, 'locks'),
    migrationsDir: path.join(globalRoot, 'migrations'),
    repoProfileFile: path.join(projectAccreMindDir, 'repo.json'),
    globalLedgerDir: path.join(globalRoot, 'ledger', '_global'),
    globalEvidenceDir: path.join(globalRoot, 'evidence', '_global'),
    sqlitePath: path.join(globalRoot, 'workspaces', workspaceId, 'index.sqlite'),
    legacySqlitePath: path.join(globalRoot, 'accremind.sqlite'),
    // Kept apart from the disposable index so deleting or rebuilding the index never loses history.
    eventsDir: path.join(globalRoot, 'events', workspaceId),
    probationDir: path.join(globalRoot, 'probation', workspaceId),
    personalDir: path.join(globalRoot, 'personal'),
    sharedTechDir: path.join(globalRoot, 'shared-tech'),
    queueDir: path.join(globalRoot, 'queue', workspaceId),
    projectRoot,
    projectAccreMindDir,
    projectRulesDir: path.join(projectAccreMindDir, 'rules'),
    projectEntriesDir: path.join(projectAccreMindDir, 'entries'),
    navigationFilePath: path.join(projectAccreMindDir, 'navigation.json'),
    evidenceDir: path.join(projectAccreMindDir, 'evidence'),
    localEvidenceDir: path.join(globalRoot, 'evidence', workspaceId),
    ledgerDir: path.join(projectAccreMindDir, 'ledger'),
    localLedgerDir: path.join(globalRoot, 'ledger', workspaceId),
  };
}

export function ensureStoreDirectoriesSync(paths: StoreLayoutPaths): void {
  const dirs = [
    paths.globalRoot,
    path.dirname(paths.sqlitePath),
    path.dirname(paths.globalIndexPath),
    paths.probationDir,
    paths.personalDir,
    paths.sharedTechDir,
    paths.domainDir,
    paths.queueDir,
    paths.projectAccreMindDir,
    paths.projectRulesDir,
    paths.projectEntriesDir,
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function directoryForZone(paths: StoreLayoutPaths, zone: StorageZone): string {
  switch (zone) {
    case 'project':
      return paths.projectEntriesDir;
    case 'rules':
      return paths.projectRulesDir;
    case 'probation':
      return paths.probationDir;
    case 'personal':
      return paths.personalDir;
    case 'shared_tech':
      return paths.sharedTechDir;
    case 'domain':
      return paths.domainDir;
  }
}

/**
 * Crash-safe atomic file replacement:
 * writes to sibling `.tmp.<pid>.<uuid>`, flushes fd (`fsyncSync`), then atomically `renameSync`.
 */
export function writeFileAtomicSync(targetPath: string, content: string): void {
  const parentDir = path.dirname(targetPath);
  fs.mkdirSync(parentDir, { recursive: true });
  const tempPath = path.join(
    parentDir,
    `.${path.basename(targetPath)}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`,
  );

  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, 'w', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, targetPath);
    fsyncDirectoryBestEffort(parentDir);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error during cleanup
      }
    }
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore unlink error during cleanup
      }
    }
    throw err;
  }
}

/** Persist the rename itself; not supported on every platform (e.g. Windows), so failures are ignored. */
function fsyncDirectoryBestEffort(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // best effort
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
