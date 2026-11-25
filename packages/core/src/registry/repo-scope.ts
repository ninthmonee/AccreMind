/**
 * Which repositories AccreMind stays out of.
 *
 * Two levels, both committed in `.accremind/repo.json` so every clone behaves the same:
 * - `settings.enabled: false` — the whole repository is out: no rules, no reminders, no capture, no tuning.
 * - `settings.excludePaths` — repository-relative prefixes that get no file guard and no turn signals, which is
 *   how vendored, generated and third-party trees stay quiet without disabling the repository.
 */

/** Cleans a list of repository-relative prefixes: drops absolute paths, `..` escapes and duplicates. */
export function normalizeExcludePaths(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    const cleaned = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!cleaned || cleaned.startsWith('/') || cleaned.startsWith('~')) continue;
    if (cleaned.split('/').includes('..')) continue;
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

/** True when the path sits under one of the excluded prefixes (a prefix matches itself and everything below). */
export function isExcludedPath(relPath: string, excludePaths: string[]): boolean {
  if (!excludePaths.length) return false;
  const p = String(relPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!p) return false;
  return excludePaths.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** A repository pauses AccreMind by committing `"settings": { "enabled": false }`. */
export function isProjectDisabled(settings: { enabled?: boolean } | null | undefined): boolean {
  return settings?.enabled === false;
}
