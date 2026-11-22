import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StorageZone } from '../contracts/types.ts';

export interface StoreLayoutPaths {
  workspaceId: string;
  globalRoot: string;
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
  const workspaceId = options.workspaceId ?? computeWorkspaceId(projectRoot);
  const projectAccreMindDir = path.join(projectRoot, projectDirName);

  return {
    workspaceId,
    globalRoot,
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
    paths.probationDir,
    paths.personalDir,
    paths.sharedTechDir,
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
