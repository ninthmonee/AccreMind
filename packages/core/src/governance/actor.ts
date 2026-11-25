import { execFileSync } from 'node:child_process';
import * as os from 'node:os';

/**
 * Who is acting, for attribution in decisions and the activity log.
 * Locally this is the repository's Git identity (what teammates will see in history);
 * a host or a future server can pass its own authenticated identity instead.
 */
export function resolveLocalActor(projectRoot: string): string {
  try {
    const email = execFileSync('git', ['config', 'user.email'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
    if (email) return email;
  } catch {
    // not a git repository or git missing
  }
  try {
    return `local:${os.userInfo().username}`;
  } catch {
    return 'local:unknown';
  }
}

/** The repository's Git user name (`git config user.name`), or null. */
export function resolveGitUserName(projectRoot: string): string | null {
  try {
    const name = execFileSync('git', ['config', 'user.name'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
    return name || null;
  } catch {
    return null;
  }
}
