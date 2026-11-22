import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRepoProfile, sha256Hex, writeFileAtomicSync } from '../codec/atomic-fs.ts';
import { parseEntryMarkdown, serializeEntryMarkdown, stripV2Fields } from '../codec/frontmatter.ts';
import type { KnowledgeEntry } from '../contracts/types.ts';
import { writeRepoProfile } from '../registry/repo-registry.ts';
import { claimSimilarity, DUPLICATE_SIMILARITY } from '../retrieval/applicability.ts';
import type { LocalMarkdownSqliteStore } from '../store/local-store.ts';

export interface MigrationPlan {
  repoId: string;
  idSource: 'repo.json' | 'remote' | 'path';
  legacyWorkspaceId: string;
  /** Per-repository folders copied from the path-based ID (done automatically when the repository opens). */
  adoptedFromLegacy: string[];
  writeRepoProfile: { file: string; domains: string[]; exists: boolean };
  /** Domain cards that get the repository's business domains. */
  tagDomains: Array<{ id: string; file: string; domains: string[] }>;
  /** Near-identical entries across repositories and layers, for a human to link, generalize or keep. */
  duplicateClusters: Array<{ ids: string[]; layers: string[]; sources: string[]; similarity: number }>;
  registeredRepositories: number;
}

export interface MigrationManifest {
  version: 1;
  kind: 'accremind_migrate';
  at: string;
  repoId: string;
  root: string;
  repoProfile: { file: string; createdByMigration: boolean; previous: string | null };
  files: Array<{ file: string; backup: string; sha256Before: string; sha256After: string }>;
}

function projectDirName(store: LocalMarkdownSqliteStore): string {
  return path.basename(store.paths.projectAccreMindDir);
}

/** What `accremind migrate --apply` would do for this repository. Read-only. */
export function planMigration(store: LocalMarkdownSqliteStore, options: { domains?: string[] } = {}): MigrationPlan {
  const domains = [...new Set((options.domains?.length ? options.domains : store.identity.domains).map((d) => d.trim()).filter(Boolean))];
  const tagDomains: MigrationPlan['tagDomains'] = [];
  const own = store.listEntriesForAdmin();
  if (domains.length) {
    for (const { entry, storageZone } of own) {
      if (entry.layer !== 'domain' || storageZone === 'domain' || entry.domains?.length) continue;
      tagDomains.push({ id: entry.id, file: path.join(store.paths.projectEntriesDir, `${entry.id}.md`), domains });
    }
  }
  const adoptManifest = path.join(store.paths.migrationsDir, `adopt-${store.workspaceId}.json`);
  let adopted: string[] = [];
  try {
    adopted = (JSON.parse(fs.readFileSync(adoptManifest, 'utf8')) as { copied?: string[] }).copied ?? [];
  } catch {
    adopted = [];
  }
  return {
    repoId: store.workspaceId,
    idSource: store.identity.source,
    legacyWorkspaceId: store.paths.legacyWorkspaceId,
    adoptedFromLegacy: adopted,
    writeRepoProfile: { file: store.paths.repoProfileFile, domains, exists: fs.existsSync(store.paths.repoProfileFile) },
    tagDomains: tagDomains.filter((t) => fs.existsSync(t.file)),
    duplicateClusters: findDuplicateClusters(store),
    registeredRepositories: store.registry.list().length,
  };
}

/** Near-duplicates among everything this repository can see (own, machine-wide and other repositories). */
export function findDuplicateClusters(store: LocalMarkdownSqliteStore): MigrationPlan['duplicateClusters'] {
  const rows = store.rawDb.prepare(`SELECT id, workspace_id, layer, claim, knowledge_delta FROM entries
    WHERE status IN ('active', 'probation')`).all() as Array<{ id: string; workspace_id: string; layer: KnowledgeEntry['layer']; claim: string; knowledge_delta: string }>;
  const items = rows.map((r) => ({ ...r, e: { claim: r.claim, knowledge_delta: r.knowledge_delta } as KnowledgeEntry }));
  const used = new Set<number>();
  const clusters: MigrationPlan['duplicateClusters'] = [];
  for (let i = 0; i < items.length && i < 5000; i += 1) {
    if (used.has(i)) continue;
    const group = [i];
    let best = 0;
    for (let j = i + 1; j < items.length && j < 5000; j += 1) {
      if (used.has(j)) continue;
      const sim = claimSimilarity(items[i]!.e, items[j]!.e);
      if (sim >= DUPLICATE_SIMILARITY) {
        group.push(j);
        best = Math.max(best, sim);
      }
    }
    if (group.length < 2) continue;
    for (const g of group) used.add(g);
    clusters.push({
      ids: group.map((g) => items[g]!.id), layers: group.map((g) => items[g]!.layer),
      sources: group.map((g) => items[g]!.workspace_id), similarity: Number(best.toFixed(2)),
    });
  }
  return clusters;
}

function backupAndWrite(manifestDir: string, manifest: MigrationManifest, file: string, next: string): void {
  const before = fs.readFileSync(file, 'utf8');
  if (before === next) return;
  const backup = path.join(manifestDir, 'backup', `${manifest.files.length}-${path.basename(file)}`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, before, 'utf8');
  writeFileAtomicSync(file, next);
  manifest.files.push({ file, backup, sha256Before: sha256Hex(before), sha256After: sha256Hex(next) });
}

/**
 * Applies the plan. Additive and reversible: every card it rewrites is backed up and listed in a manifest
 * (`~/.dsh/accremind/migrations/<time>-<repo>/manifest.json`) that `rollbackMigration` replays in reverse.
 */
export function applyMigration(store: LocalMarkdownSqliteStore, options: { domains?: string[] } = {}): { plan: MigrationPlan; manifestFile: string } {
  const plan = planMigration(store, options);
  const at = new Date().toISOString();
  const dir = path.join(store.paths.migrationsDir, `${at.replace(/[:.]/g, '')}-${store.workspaceId}`);
  fs.mkdirSync(dir, { recursive: true });
  const previousProfile = fs.existsSync(plan.writeRepoProfile.file) ? fs.readFileSync(plan.writeRepoProfile.file, 'utf8') : null;
  const manifest: MigrationManifest = {
    version: 1, kind: 'accremind_migrate', at, repoId: store.workspaceId, root: store.paths.projectRoot,
    repoProfile: { file: plan.writeRepoProfile.file, createdByMigration: previousProfile === null, previous: previousProfile },
    files: [],
  };
  const manifestFile = path.join(dir, 'manifest.json');
  const save = () => writeFileAtomicSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  save();
  // The committed profile pins the repository ID for every clone (decision: commit repo.json).
  const current = readRepoProfile(store.paths.projectRoot, projectDirName(store));
  writeRepoProfile(store.paths.projectRoot, projectDirName(store), {
    repo_id: store.workspaceId,
    domains: plan.writeRepoProfile.domains.length ? plan.writeRepoProfile.domains : current?.domains ?? [],
    ...(store.identity.org ? { org: store.identity.org } : {}),
  });
  store.updateRepoProfile({ domains: plan.writeRepoProfile.domains.length ? plan.writeRepoProfile.domains : store.identity.domains });
  for (const t of plan.tagDomains) {
    const entry = parseEntryMarkdown(fs.readFileSync(t.file, 'utf8'), t.file);
    backupAndWrite(dir, manifest, t.file, serializeEntryMarkdown({ ...entry, domains: t.domains, origin_repo: entry.origin_repo ?? store.workspaceId }));
    save();
  }
  store.initializeAndReconcile();
  return { plan, manifestFile };
}

/** Latest manifest of this repository, if any. */
export function latestMigrationManifest(store: LocalMarkdownSqliteStore): string | null {
  if (!fs.existsSync(store.paths.migrationsDir)) return null;
  const dirs = fs.readdirSync(store.paths.migrationsDir).filter((d) => d.endsWith(`-${store.workspaceId}`)).sort();
  for (const d of dirs.reverse()) {
    const f = path.join(store.paths.migrationsDir, d, 'manifest.json');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/**
 * Undoes a migration: restores every rewritten card byte for byte (refusing a card edited since, unless
 * forced) and the previous `repo.json`. With `downgradeCards`, also rewrites any remaining v2 card of this
 * repository as v1 (dropping the new fields, backed up next to the manifest) so an older plugin can read it.
 */
export function rollbackMigration(store: LocalMarkdownSqliteStore, options: { manifestFile?: string; force?: boolean; downgradeCards?: boolean } = {}): {
  restored: string[]; skipped: Array<{ file: string; reason: string }>; downgraded: string[];
} {
  const manifestFile = options.manifestFile ?? latestMigrationManifest(store);
  const restored: string[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  const downgraded: string[] = [];
  if (manifestFile) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as MigrationManifest;
    for (const f of [...manifest.files].reverse()) {
      const now = fs.existsSync(f.file) ? sha256Hex(fs.readFileSync(f.file, 'utf8')) : null;
      if (now !== f.sha256After && !options.force) {
        skipped.push({ file: f.file, reason: '迁移后又被修改过，未覆盖（可加 --force）' });
        continue;
      }
      writeFileAtomicSync(f.file, fs.readFileSync(f.backup, 'utf8'));
      restored.push(f.file);
    }
    if (manifest.repoProfile.createdByMigration) fs.rmSync(manifest.repoProfile.file, { force: true });
    else if (manifest.repoProfile.previous !== null) writeFileAtomicSync(manifest.repoProfile.file, manifest.repoProfile.previous);
    fs.renameSync(manifestFile, `${manifestFile}.rolled-back`);
  }
  if (options.downgradeCards) {
    const backupDir = path.join(store.paths.migrationsDir, `downgrade-${new Date().toISOString().replace(/[:.]/g, '')}-${store.workspaceId}`);
    for (const dir of [store.paths.projectEntriesDir, store.paths.projectRulesDir, store.paths.probationDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
        const file = path.join(dir, name);
        const raw = fs.readFileSync(file, 'utf8');
        if (!/^format_version: 2$/m.test(raw)) continue;
        const v1 = serializeEntryMarkdown(stripV2Fields(parseEntryMarkdown(raw, file)));
        fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(path.join(backupDir, name), raw, 'utf8');
        writeFileAtomicSync(file, v1);
        downgraded.push(file);
      }
    }
  }
  store.initializeAndReconcile();
  return { restored, skipped, downgraded };
}
