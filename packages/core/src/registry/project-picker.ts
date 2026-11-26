import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SubprojectDef } from '../codec/atomic-fs.ts';

/**
 * Choosing which project a document belongs to: what a folder is (a Git repository? already using AccreMind?)
 * and which folders lie below one, for a folder browser. Only folder names are read here, never file contents
 * outside the AccreMind profile.
 */
export interface ProjectDirInfo {
  root: string;
  name: string;
  exists: boolean;
  isGit: boolean;
  /** Has a `.accremind/` folder (knowledge already lives there). */
  hasAccremind: boolean;
  /** `repo_id` from `.accremind/repo.json`, when set. */
  repoId: string | null;
  subprojects: SubprojectDef[];
}

export function inspectProjectDir(dir: string, projectDirName = '.accremind'): ProjectDirInfo {
  const root = path.resolve(dir);
  let exists = false;
  try {
    exists = fs.statSync(root).isDirectory();
  } catch {
    exists = false;
  }
  let repoId: string | null = null;
  let subprojects: SubprojectDef[] = [];
  if (exists) {
    try {
      const profile = JSON.parse(fs.readFileSync(path.join(root, projectDirName, 'repo.json'), 'utf8')) as { repo_id?: string; projects?: SubprojectDef[] };
      repoId = typeof profile.repo_id === 'string' ? profile.repo_id : null;
      subprojects = Array.isArray(profile.projects) ? profile.projects.filter((p) => p && typeof p.id === 'string' && Array.isArray(p.paths)) : [];
    } catch {
      // no profile yet
    }
  }
  return {
    root, name: path.basename(root) || root, exists,
    isGit: exists && fs.existsSync(path.join(root, '.git')),
    hasAccremind: exists && fs.existsSync(path.join(root, projectDirName)),
    repoId, subprojects,
  };
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  /** The folder itself, when it is a project. */
  current: ProjectDirInfo;
  dirs: Array<{ name: string; path: string; isGit: boolean; hasAccremind: boolean }>;
  truncated: boolean;
}

const SKIP = new Set(['node_modules', 'Library', 'Applications', 'System', 'dist', 'build', 'target', 'vendor']);

/** The sub-folders of `dir` (hidden and dependency folders left out), projects first. */
export function browseDirs(dir: string, projectDirName = '.accremind', limit = 300): BrowseResult {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`目录不存在：${abs}`);
  let names: string[] = [];
  try {
    names = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name)).map((d) => d.name);
  } catch {
    throw new Error(`没有权限读取：${abs}`);
  }
  const dirs = names.slice(0, limit).map((name) => {
    const p = path.join(abs, name);
    return { name, path: p, isGit: fs.existsSync(path.join(p, '.git')), hasAccremind: fs.existsSync(path.join(p, projectDirName)) };
  }).sort((a, b) => Number(b.isGit || b.hasAccremind) - Number(a.isGit || a.hasAccremind) || a.name.localeCompare(b.name));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, current: inspectProjectDir(abs, projectDirName), dirs, truncated: names.length > limit };
}
