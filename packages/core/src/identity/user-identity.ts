import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256Hex, writeFileAtomicSync } from '../codec/atomic-fs.ts';

/**
 * Who the knowledge belongs to and who is asking. Locally this is the person using this machine, stable across
 * repositories even when each repository uses a different Git e-mail. A host with real sign-in (DSH accounts,
 * a team server) supplies its own provider; the local identity can be linked to it so earlier personal
 * entries keep their owner.
 */
export interface UserIdentity {
  /** Stable owner ID written into personal entries (`u-…` locally, `<provider>:<id>` for signed-in users). */
  userId: string;
  displayName: string;
  /** E-mail addresses known to belong to this person (Git identities, account e-mail). */
  emails: string[];
  source: 'local' | 'host';
  /** Other owner IDs that are the same person: linked accounts and owner hashes written by older versions. */
  aliases: string[];
}

export interface IdentityProvider {
  current(): UserIdentity;
}

/** Owner hash older versions wrote into personal entries (hash of the Git e-mail). */
export function legacyOwnerId(email: string): string {
  return `u-${sha256Hex(email.trim().toLowerCase()).slice(0, 16)}`;
}

interface LocalUserFile {
  version: 1;
  userId: string;
  displayName: string;
  emails: string[];
  /** Signed-in identities this local user was linked to (their user IDs). */
  linked: string[];
}

/**
 * The person using this machine (`~/.dsh/accremind/users/local.json`). Created once; every Git e-mail seen in a
 * repository is added, so personal knowledge follows the person rather than one e-mail.
 */
export class LocalIdentityProvider implements IdentityProvider {
  private readonly file: string;
  private cached: LocalUserFile | null = null;

  constructor(usersDir: string) {
    this.file = path.join(usersDir, 'local.json');
  }

  private read(): LocalUserFile {
    if (this.cached) return this.cached;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LocalUserFile;
      if (parsed && typeof parsed.userId === 'string' && /^u-[0-9a-f]{16}$/.test(parsed.userId)) {
        this.cached = { version: 1, userId: parsed.userId, displayName: String(parsed.displayName ?? ''),
          emails: Array.isArray(parsed.emails) ? parsed.emails.map(String) : [], linked: Array.isArray(parsed.linked) ? parsed.linked.map(String) : [] };
        return this.cached;
      }
    } catch {
      // first use on this machine
    }
    let name = 'local';
    try {
      name = os.userInfo().username;
    } catch {
      // no user database (containers)
    }
    this.cached = { version: 1, userId: `u-${randomBytes(8).toString('hex')}`, displayName: name, emails: [], linked: [] };
    this.save();
    return this.cached;
  }

  private save(): void {
    try {
      writeFileAtomicSync(this.file, `${JSON.stringify(this.cached, null, 2)}\n`);
    } catch {
      // read-only home: the identity still works for this process
    }
  }

  /** Records a Git e-mail (or account e-mail) as belonging to this person. */
  addEmail(email: string): void {
    const e = email.trim().toLowerCase();
    if (!e || !e.includes('@')) return;
    const u = this.read();
    if (u.emails.includes(e)) return;
    u.emails = [...u.emails, e];
    this.save();
  }

  linkedAccounts(): string[] {
    // Another process (or store) may have linked an account since this one read the file.
    this.cached = null;
    return [...this.read().linked];
  }

  /** Links a signed-in identity: entries owned by either ID are this person's. */
  link(userId: string): void {
    const u = this.read();
    if (!userId || u.linked.includes(userId) || userId === u.userId) return;
    u.linked = [...u.linked, userId];
    this.save();
  }

  current(): UserIdentity {
    const u = this.read();
    return {
      userId: u.userId,
      displayName: u.displayName,
      emails: u.emails,
      source: 'local',
      aliases: [...u.linked, ...u.emails.map(legacyOwnerId)],
    };
  }
}

/**
 * A signed-in identity supplied by the host. Owner IDs are namespaced by provider (`dsh:1234`). Linking the
 * local user keeps personal entries written before sign-in.
 */
export class HostIdentityProvider implements IdentityProvider {
  private readonly identity: UserIdentity;

  constructor(input: { provider: string; id: string; displayName?: string; emails?: string[] }, local?: LocalIdentityProvider) {
    const provider = input.provider.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'host';
    const userId = `${provider}:${input.id}`;
    const emails = (input.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
    // The local user is linked to the first account signed in on this machine account. A different person
    // signing in later (a shared machine) does not inherit the local user's personal entries.
    let localUser: UserIdentity | undefined;
    if (local) {
      const linked = local.linkedAccounts();
      if (!linked.length || linked.includes(userId)) {
        localUser = local.current();
        local.link(userId);
        for (const e of emails) local.addEmail(e);
      }
    }
    this.identity = {
      userId,
      displayName: input.displayName ?? userId,
      emails,
      source: 'host',
      aliases: [...new Set([...(localUser ? [localUser.userId, ...localUser.aliases] : []), ...emails.map(legacyOwnerId)])],
    };
  }

  current(): UserIdentity {
    return this.identity;
  }
}

/** True when an owner ID belongs to this person (their ID, a linked account, or a legacy e-mail hash). */
export function ownsEntry(user: UserIdentity, owner: string | null | undefined): boolean {
  if (!owner) return true;
  return owner === user.userId || user.aliases.includes(owner);
}
