import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export interface EvidenceStore {
  write(tenantId: string, evidenceId: string, content: string): Promise<string>;
  read(tenantId: string, objectKey: string, hash: string): Promise<string>;
}

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const objectPattern = new RegExp(`^(${uuid})\\.(${uuid})\\.1\\.([a-f0-9]{64})$`);

/** Root is an operator-owned directory, never a request parameter. No source URLs are fetched.
 * Publish a fully fsynced immutable file before a DB transaction may reference it.
 * A failed/uncertain DB commit can leave an unreferenced object, never a missing committed object.
 */
export class FileEvidenceStore implements EvidenceStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private async prepare() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error('Evidence directory must be a private real directory');
  }

  private path(tenantId: string, objectKey: string, hash: string) {
    const match = objectPattern.exec(objectKey);
    if (!match || match[1] !== tenantId || match[3] !== hash)
      throw new Error('Invalid evidence object reference');
    return join(this.root, objectKey);
  }

  async write(tenantId: string, evidenceId: string, content: string): Promise<string> {
    const hash = sha256(content);
    const key = `${tenantId}.${evidenceId}.1.${hash}`;
    const destination = this.path(tenantId, key, hash);
    await this.prepare();
    const temporary = join(this.root, `.pending-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(content, 'utf8');
        await file.chmod(0o400);
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temporary, destination); // Never overwrite an existing identity/version.
      const directory = await open(this.root, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary);
    }
    return key;
  }

  async read(tenantId: string, objectKey: string, hash: string): Promise<string> {
    await this.prepare();
    const file = await open(
      this.path(tenantId, objectKey, hash),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Invalid evidence object');
      const content = await file.readFile('utf8');
      if (sha256(content) !== hash) throw new Error('Evidence integrity check failed');
      return content;
    } finally {
      await file.close();
    }
  }
}
