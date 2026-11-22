import * as fs from 'node:fs';
import * as path from 'node:path';

const held = new Map<string, number>();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process exclusive lock on a lock file (create-exclusive). Re-entrant within one process.
 * A lock file older than `staleMs` is treated as left behind by a crashed process and taken over.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, options: { waitMs?: number; staleMs?: number; busyMessage?: string } = {}): T {
  const key = path.resolve(lockPath);
  const depth = held.get(key) ?? 0;
  if (depth > 0) {
    held.set(key, depth + 1);
    try {
      return fn();
    } finally {
      held.set(key, (held.get(key) ?? 1) - 1);
      if (held.get(key) === 0) held.delete(key);
    }
  }
  const waitMs = options.waitMs ?? 3000;
  const staleMs = options.staleMs ?? 30_000;
  fs.mkdirSync(path.dirname(key), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(key, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(key).mtimeMs > staleMs) {
          fs.rmSync(key, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(options.busyMessage ?? '另一个 AccreMind 窗口正在写入，请稍后重试');
      sleepSync(25);
    }
  }
  held.set(key, 1);
  try {
    return fn();
  } finally {
    held.delete(key);
    fs.rmSync(key, { force: true });
  }
}
