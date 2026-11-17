#!/usr/bin/env node
import * as path from 'node:path';
import {
  GitStalenessScanner,
  LocalMarkdownSqliteStore,
  scanGitHistorySignals,
} from './index.ts';

function parseArgFlag(args: string[], flag: string, fallback?: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return fallback;
}

function main(): void {
  const [, , subcommand = 'status', ...rest] = process.argv;
  const repoRoot = path.resolve(parseArgFlag(rest, '--repo', process.cwd())!);
  const globalDir = parseArgFlag(rest, '--global-dir', '~/.dsh/accremind');

  if (subcommand === 'bootstrap') {
    const topK = Number.parseInt(parseArgFlag(rest, '--top', '10')!, 10);
    const candidates = scanGitHistorySignals({ repoRoot, topK });
    console.log(
      JSON.stringify(
        {
          repoRoot,
          scannedCandidatesCount: candidates.length,
          candidates: candidates.map((c) => ({
            commitSha: c.commitSha.slice(0, 8),
            committedAtIso: c.committedAtIso,
            signalScore: c.signalScore,
            subject: c.subject,
            touchedFiles: c.touchedFiles.slice(0, 6),
            signalReasons: c.signalReasons,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const store = new LocalMarkdownSqliteStore({ projectRoot: repoRoot, globalDir });
  try {
    if (subcommand === 'init' || subcommand === 'status') {
      const syncStats = store.initializeAndReconcile();
      const staleness = new GitStalenessScanner(store).scanWorkspace();
      console.log(
        JSON.stringify(
          {
            workspaceId: store.workspaceId,
            projectAccreMindDir: store.paths.projectAccreMindDir,
            sqlitePath: store.paths.sqlitePath,
            syncedEntries: syncStats.syncedCount,
            corruptedFiles: syncStats.corruptedCount,
            stalenessCheck: staleness,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (subcommand === 'rebuild') {
      const stats = store.rebuildIndexFromScratch();
      console.log(
        JSON.stringify(
          {
            rebuilt: true,
            workspaceId: store.workspaceId,
            ...stats,
            corrupted: store.listCorruptedFiles(),
          },
          null,
          2,
        ),
      );
      return;
    }

    console.error(`Unknown subcommand "${subcommand}". Supported: init | status | rebuild | bootstrap`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main();
