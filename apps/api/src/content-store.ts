import { spawn } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256 } from './evidence-store.js';

import type { ContentStore } from '@accremind/domain';
export type { ContentStore } from '@accremind/domain';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const reference = /^([a-f0-9]{40}):([a-f0-9-]{36})\.json$/;

/** Operator-owned bare repositories. No clone, remote, source execution or shell interpolation.
 * Caller serializes tenant writes with a database advisory lock. Orphan Git commits are harmless:
 * only a committed knowledge_revisions content_ref can become visible to readers.
 */
export class GitContentStore implements ContentStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private async git(
    path: string,
    args: string[],
    input = '',
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((done, reject) => {
      const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '--git-dir', path, ...args], {
        env: {
          PATH: process.env.PATH ?? '',
          LANG: 'C.UTF-8',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'AccreMind synthetic publisher',
          GIT_AUTHOR_EMAIL: 'synthetic@invalid',
          GIT_COMMITTER_NAME: 'AccreMind synthetic publisher',
          GIT_COMMITTER_EMAIL: 'synthetic@invalid',
        },
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(signal ? { signal } : {}),
      });
      let output = '';
      let size = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) child.kill();
        else output += chunk.toString('utf8');
      });
      child.stderr.resume();
      let failure: Error | undefined;
      child.on('error', (error) => {
        failure = error;
      });
      child.on('close', (code) =>
        code === 0 && !failure
          ? done(output)
          : reject(failure ?? new Error('Content store unavailable')),
      );
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  private async repository(tenant: string, signal?: AbortSignal) {
    if (!uuid.test(tenant)) throw new Error('Invalid tenant');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077)
      throw new Error('Content root must be private');
    const path = join(this.root, `${tenant}.git`);
    await mkdir(path, { mode: 0o700, recursive: true });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
      throw new Error('Invalid content directory');
    let initialized = false;
    try {
      const head = await lstat(join(path, 'HEAD'));
      if (!head.isFile() || head.isSymbolicLink()) throw new Error('Invalid repository HEAD');
      initialized = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    // Reads of existing repositories must not rewrite config or contend on git-init locks.
    if (!initialized) await this.git(path, ['init', '--bare', '--quiet', path], '', signal);
    if ((await this.git(path, ['rev-parse', '--is-bare-repository'])).trim() !== 'true')
      throw new Error('Expected bare repository');
    return path;
  }
  async write(tenant: string, publication: string, content: string, signal?: AbortSignal) {
    if (!uuid.test(publication) || Buffer.byteLength(content) > 512 * 1024)
      throw new Error('Invalid publication content');
    const path = await this.repository(tenant, signal);
    signal?.throwIfAborted();
    const ref = `refs/publications/${publication}`;
    let existing: string | undefined;
    try {
      existing = (await this.git(path, ['rev-parse', '--verify', ref])).trim();
    } catch {
      /* first attempt */
    }
    if (existing) {
      const result = `${existing}:${publication}.json`;
      if ((await this.read(tenant, result, sha256(content))) !== content)
        throw new Error('Publication content conflicts');
      return result;
    }
    let parent: string | undefined;
    try {
      parent = (await this.git(path, ['rev-parse', '--verify', 'refs/heads/publications'])).trim();
    } catch {
      /* first write */
    }
    const blob = (await this.git(path, ['hash-object', '-w', '--stdin'], content, signal)).trim();
    const tree = (
      await this.git(path, ['mktree'], `100644 blob ${blob}\t${publication}.json\n`, signal)
    ).trim();
    const commit = (
      await this.git(
        path,
        ['commit-tree', tree, ...(parent ? ['-p', parent] : [])],
        `Publication ${publication} content_hash=${sha256(content)}\n`,
        signal,
      )
    ).trim();
    await this.git(
      path,
      ['update-ref', '--stdin'],
      `start\ncreate ${ref} ${commit}\nupdate refs/heads/publications ${commit} ${parent ?? '0'.repeat(40)}\nprepare\ncommit\n`,
      signal,
    );
    return `${commit}:${publication}.json`;
  }
  async read(tenant: string, ref: string, hash: string) {
    const match = reference.exec(ref);
    if (!match || !uuid.test(match[2]!)) throw new Error('Invalid content reference');
    const path = await this.repository(tenant);
    const content = await this.git(path, ['show', ref]);
    if (sha256(content) !== hash) throw new Error('Content integrity failed');
    return content;
  }
}
