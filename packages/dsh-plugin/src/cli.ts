#!/usr/bin/env node
import * as path from 'node:path';
import {
  OpenAiCompatibleLlmClient,
  runArchaeologyBootstrap,
  scanGitHistorySignals,
} from '@accremind/core';
import { createAccreMindRuntime, startAccreMindWebuiServer } from './index.ts';

function getFlag(args: string[], flag: string, fallback?: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return fallback;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function main(): Promise<void> {
  const [, , subcommand = 'status', ...rest] = process.argv;
  const repoRoot = path.resolve(getFlag(rest, '--repo', process.cwd())!);
  const globalDir = getFlag(rest, '--global-dir', '~/.dsh/accremind')!;

  if (subcommand === 'ui' || subcommand === 'serve-ui') {
    const port = Number.parseInt(getFlag(rest, '--port', '3180')!, 10);
    const runtime = createAccreMindRuntime({ projectRoot: repoRoot, globalDir });
    const server = await startAccreMindWebuiServer(runtime, { port });
    console.log(
      `[AccreMind WebUI] 本地工作台已启动: ${server.url} (工作区: ${runtime.store.workspaceId})`,
    );
    console.log('按 Ctrl+C 安全退出。');

    const shutdown = async () => {
      await server.close();
      runtime.dispose();
      process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
    return;
  }

  const runtime = createAccreMindRuntime({ projectRoot: repoRoot, globalDir });
  try {
    switch (subcommand) {
      case 'init':
      case 'status': {
        const overview = await runtime.rpcHandlers['accremind.dashboard.overview']!({});
        const staleness = runtime.stalenessScanner.scanWorkspace();
        console.log(JSON.stringify({ overview, staleness }, null, 2));
        break;
      }

      case 'search': {
        const positionalQuery = rest.find((a) => !a.startsWith('--')) ?? '';
        const query = getFlag(rest, '--query', positionalQuery) ?? '';
        const res = runtime.store.search({
          workspaceId: runtime.store.workspaceId,
          query,
          filePath: getFlag(rest, '--file'),
          limit: Number.parseInt(getFlag(rest, '--limit', '5')!, 10),
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'get': {
        const id = rest.find((a) => !a.startsWith('--')) ?? '';
        if (!id) {
          throw new Error('用法: pnpm accremind get <K-xxxx>');
        }
        const detail = await runtime.rpcHandlers['accremind.kb.get']!({ id });
        console.log(JSON.stringify(detail, null, 2));
        break;
      }

      case 'rebuild': {
        const out = await runtime.rpcHandlers['accremind.gov.rebuildIndex']!({});
        console.log(JSON.stringify(out, null, 2));
        break;
      }

      case 'bootstrap': {
        const topK = Number.parseInt(getFlag(rest, '--top', '10')!, 10);
        const shouldExtract = hasFlag(rest, '--extract');
        const mode =
          getFlag(rest, '--mode', 'single_pass') === 'isolated_p0'
            ? 'isolated_p0'
            : 'single_pass';

        if (!shouldExtract) {
          const candidates = scanGitHistorySignals({ repoRoot, topK });
          console.log(
            JSON.stringify(
              {
                mode: 'deterministic_signal_scan_only',
                hint: '传入 --extract 并配置 DEEPSEEK_API_KEY 可自动执行 LLM 代码对照与五路分流落盘',
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
          break;
        }

        const llm = new OpenAiCompatibleLlmClient();
        const result = await runArchaeologyBootstrap({
          store: runtime.store,
          triageEngine: runtime.triageEngine,
          llm,
          mode,
          topK,
        });
        console.log(
          JSON.stringify(
            {
              mode: `llm_extract_${mode}`,
              minedCount: result.minedCommits.length,
              dispositionCounts: result.triageReport.dispositionCounts,
              persistedEntries: result.triageReport.persistedExperienceEntries.map((e) => ({
                id: e.id,
                title: e.title,
                status: e.status,
                priority: e.priority,
              })),
            },
            null,
            2,
          ),
        );
        break;
      }

      default:
        throw new Error(
          `未知子命令 "${subcommand}"。可用命令: status | search | get | rebuild | bootstrap | ui`,
        );
    }
  } finally {
    runtime.dispose();
  }
}

main().catch((err) => {
  console.error('[AccreMind CLI Error]', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
