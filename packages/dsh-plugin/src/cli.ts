#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applyMigration,
  autoTuneStatus,
  rollbackTuning,
  runAutoTune,
  runEvaluation,
  OpenAiCompatibleLlmClient,
  planMigration,
  rollbackMigration,
  runArchaeologyBootstrap,
  scanGitHistorySignals,
  normalizeExcludePaths,
  LlmUsageMeter,
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
  // `--repo` and `--global-dir` may come before the subcommand too (`accremind --repo ../pay status`).
  const argv = process.argv.slice(2);
  const leading: string[] = [];
  while (argv[0] === '--repo' || argv[0] === '--global-dir') leading.push(...argv.splice(0, 2));
  const [subcommand = 'status', ...afterCommand] = argv;
  const rest = [...afterCommand, ...leading];
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
        const scopeFlag = getFlag(rest, '--scope', 'auto');
        const res = runtime.store.search({
          workspaceId: runtime.store.workspaceId,
          query,
          filePath: getFlag(rest, '--file'),
          limit: Number.parseInt(getFlag(rest, '--limit', '5')!, 10),
          scope: scopeFlag === 'repo' || scopeFlag === 'all' ? scopeFlag : 'auto',
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

        if (!runtime.store.repoSettings().capture) {
          console.log(JSON.stringify({ mode: 'repository_excluded', repoRoot, scannedCandidatesCount: 0, candidates: [],
            message: '本项目已排除沉淀（settings.enabled: false），Git 雷达与提炼已暂停。' }, null, 2));
          break;
        }

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

      // Cross-repository knowledge: `migrate` (default dry run) pins this repository's ID in .accremind/repo.json,
      // tags its domain cards and lists near-duplicates across repositories; `--apply` does it, `--rollback` undoes it.
      case 'migrate': {
        const domainsFlag = getFlag(rest, '--domains');
        const domains = domainsFlag ? domainsFlag.split(',').map((d) => d.trim()).filter(Boolean) : undefined;
        if (hasFlag(rest, '--rollback')) {
          const out = rollbackMigration(runtime.store, {
            manifestFile: getFlag(rest, '--manifest'), force: hasFlag(rest, '--force'), downgradeCards: hasFlag(rest, '--downgrade-cards'),
          });
          console.log(JSON.stringify({ mode: 'rollback', ...out }, null, 2));
        } else if (hasFlag(rest, '--apply')) {
          const out = applyMigration(runtime.store, { domains });
          console.log(JSON.stringify({ mode: 'apply', ...out, hint: '请提交 .accremind/repo.json 与被打标的卡片，让每个克隆使用同一仓库标识' }, null, 2));
        } else {
          console.log(JSON.stringify({ mode: 'dry_run', plan: planMigration(runtime.store, { domains }), hint: '确认后加 --apply 执行；可用 --domains a,b 指定业务领域' }, null, 2));
        }
        break;
      }

      // Model usage: how many calls and tokens the automatic extraction and topic tagging actually spent.
      // Reads the same append-only counter the workbench digest shows; --days N sets the window (default 7).
      case 'usage': {
        const days = Number.parseInt(getFlag(rest, '--days', '7')!, 10);
        const meter = new LlmUsageMeter(path.join(runtime.store.paths.globalRoot, 'usage', 'llm-usage.jsonl'));
        console.log(JSON.stringify({ file: meter.file, ...meter.read(Number.isFinite(days) ? days : 7) }, null, 2));
        break;
      }

      // Replays recorded feedback (and .accremind/eval/cases.jsonl) through the reminder path; --grid tries
      // variations of the retrieval settings, --apply saves the best to ~/.dsh/accremind/tuning.json.
      // eval auto: one automatic tuning round now (judges a change on watch, else looks for a better setting);
      // eval history: changes so far; eval rollback: undo the latest change still in effect.
      case 'eval': {
        const evalAction = rest[0] && !rest[0].startsWith('-') ? rest[0] : undefined;
        if (evalAction === 'auto') {
          console.log(JSON.stringify(await runAutoTune(runtime.store, { force: true, casesFile: getFlag(rest, '--cases') }), null, 2));
          break;
        }
        if (evalAction === 'history') {
          console.log(JSON.stringify(autoTuneStatus(runtime.store), null, 2));
          break;
        }
        if (evalAction === 'rollback') {
          console.log(JSON.stringify(rollbackTuning(runtime.store, getFlag(rest, '--note')), null, 2));
          break;
        }
        const report = runEvaluation(runtime.store, { casesFile: getFlag(rest, '--cases'), grid: hasFlag(rest, '--grid'), apply: hasFlag(rest, '--apply') });
        console.log(JSON.stringify(report, null, 2));
        break;
      }

      // Automatic demotions: list (in effect; --all includes undone ones) | restore <entry id>
      case 'demotions': {
        const [action = 'list', target] = rest.filter((a) => !a.startsWith('--'));
        if (action === 'restore') {
          if (!target) throw new Error('用法: accremind demotions restore <经验编号>');
          console.log(JSON.stringify(runtime.store.restoreAutoDemotion(target, getFlag(rest, '--note')), null, 2));
        } else {
          console.log(JSON.stringify({ demotions: runtime.store.listAutoDemotions({ includeReverted: hasFlag(rest, '--all') }) }, null, 2));
        }
        break;
      }

      // Rule document sets: list | import <file|dir> --category <c> [--domains a,b] | proposals | accept <id> | reject <id> | changes
      case 'docs': {
        const [action = 'list', target] = rest.filter((a) => !a.startsWith('--'));
        const docs = runtime.store.docs;
        if (action === 'import') {
          if (!target) {
            throw new Error('用法: accremind docs import <文件或目录> --category domain|business_rules|project_norms|project_profile|personal_preferences'
              + ' [--scope project|domain|personal] [--domains a,b] [--home kb|repo] [--audience core|all] [--subproject id] [--new-domain]');
          }
          const category = getFlag(rest, '--category') as never;
          const domains = getFlag(rest, '--domains')?.split(',').map((d) => d.trim()).filter(Boolean);
          const scope = getFlag(rest, '--scope') as 'project' | 'domain' | 'personal' | undefined;
          const home = getFlag(rest, '--home') as 'kb' | 'repo' | undefined;
          const audience = getFlag(rest, '--audience') as 'core' | 'all' | undefined;
          const abs = path.resolve(target);
          const files = fs.statSync(abs).isDirectory()
            ? fs.readdirSync(abs).filter((f) => /\.(md|markdown)$/i.test(f)).map((f) => path.join(abs, f)) : [abs];
          const out = files.map((f) => docs.importDoc({ content: fs.readFileSync(f, 'utf8'), fileName: path.basename(f), category, domains,
            replace: hasFlag(rest, '--replace'), scope, home, audience, subproject: getFlag(rest, '--subproject'), createDomains: hasFlag(rest, '--new-domain') }));
          console.log(JSON.stringify({ imported: out }, null, 2));
        } else if (action === 'proposals') {
          console.log(JSON.stringify({ proposals: docs.listProposals('pending'), tagProposals: docs.listTagProposals('pending') }, null, 2));
        } else if (action === 'accept' || action === 'reject') {
          if (!target) throw new Error(`用法: accremind docs ${action} <提议编号>`);
          const out = target.startsWith('VP-') ? docs.decideTag(target, action) : docs.decide(target, action, { note: getFlag(rest, '--note'), force: hasFlag(rest, '--force') });
          console.log(JSON.stringify(out, null, 2));
        } else if (action === 'changes') {
          console.log(JSON.stringify({ changes: docs.listChanges({ docId: target, limit: 100 }) }, null, 2));
        } else if (action === 'search') {
          const query = rest.filter((a) => !a.startsWith('--'))[1];
          if (!query) throw new Error('用法: accremind docs search <关键词> [--limit 10]');
          console.log(JSON.stringify({ hits: runtime.store.searchDocs({ query, limit: Number(getFlag(rest, '--limit') ?? 10) }) }, null, 2));
        } else {
          // docs list [--scope project|domain|personal] [--domain 退款] [--category business_rules] [--query 关键词]
          const scope = getFlag(rest, '--scope');
          const category = getFlag(rest, '--category');
          const domain = getFlag(rest, '--domain');
          const query = getFlag(rest, '--query')?.toLowerCase();
          const catalog = runtime.store.domainCatalog;
          const domainId = domain ? catalog.resolve(domain) ?? domain : null;
          const list = docs.listDocs().filter((d) => (!scope || d.scope === scope) && (!category || d.category === category)
            && (!domainId || d.domains.some((x) => (catalog.resolve(x) ?? x) === domainId
              || catalog.lineage(catalog.resolve(x) ?? x).some((l) => l.id === domainId)))
            && (!query || [d.title, d.docId, ...d.domains, ...d.tags].some((t) => t.toLowerCase().includes(query))));
          console.log(JSON.stringify({ docs: list }, null, 2));
        }
        break;
      }

      // Team knowledge base: team (where it is) | team set <folder> | team unset
      case 'team': {
        const [action, target] = rest.filter((a) => !a.startsWith('--'));
        if (action === 'set') {
          if (!target) throw new Error('用法: accremind team set <团队知识库仓库目录>');
          console.log(JSON.stringify(await runtime.rpcHandlers['accremind.knowledge.mount']!({ path: path.resolve(target) }), null, 2));
        } else if (action === 'unset') {
          console.log(JSON.stringify(await runtime.rpcHandlers['accremind.knowledge.mount']!({ path: null }), null, 2));
        } else {
          console.log(JSON.stringify(await runtime.rpcHandlers['accremind.knowledge.info']!({}), null, 2));
        }
        break;
      }

      // Domain catalog: domains [list] | add <name> [--id x] [--aliases a,b] [--parent p] [--owners a,b] [--desc text]
      //   | join <domain> [--role core|consumer] [--subproject id] [--new-domain] | leave <domain>
      case 'domains': {
        const [action = 'list', target] = rest.filter((a) => !a.startsWith('--') && !['--id', '--aliases', '--parent', '--owners', '--desc', '--role', '--subproject']
          .includes(rest[rest.indexOf(a) - 1] ?? ''));
        const list = (flag: string) => getFlag(rest, flag)?.split(',').map((x) => x.trim()).filter(Boolean);
        let out: unknown;
        if (action === 'add') {
          if (!target) throw new Error('用法: accremind domains add <名称> [--id payment] [--aliases 支付,pay] [--parent 上级] [--owners a@x.com]');
          out = await runtime.rpcHandlers['accremind.domains.upsert']!({ name: target, id: getFlag(rest, '--id'), aliases: list('--aliases'),
            parent: getFlag(rest, '--parent'), owners: list('--owners'), description: getFlag(rest, '--desc') });
        } else if (action === 'join') {
          if (!target) throw new Error('用法: accremind domains join <领域> [--role consumer] [--subproject id]');
          out = await runtime.rpcHandlers['accremind.domains.join']!({ domain: target, role: getFlag(rest, '--role'), subproject: getFlag(rest, '--subproject'),
            create: hasFlag(rest, '--new-domain') });
        } else if (action === 'leave') {
          if (!target) throw new Error('用法: accremind domains leave <领域>');
          out = await runtime.rpcHandlers['accremind.domains.leave']!({ domain: target });
        } else {
          out = await runtime.rpcHandlers['accremind.domains.list']!({});
        }
        console.log(JSON.stringify(out, null, 2));
        break;
      }

      // Repository scope: repo [status] | pause | resume | exclude <前缀…> | unexclude <前缀…>
      // Everything is committed in .accremind/repo.json, so teammates inherit the same exclusions.
      case 'repo': {
        const domainsFlag = getFlag(rest, '--domains');
        const positional = rest.filter((a) => !a.startsWith('--'));
        const action = positional[0];
        const scopePaths = positional.slice(1);
        if (domainsFlag !== undefined) {
          const out = await runtime.rpcHandlers['accremind.repo.setDomains']!({ domains: domainsFlag.split(','), create: hasFlag(rest, '--new-domain') });
          console.log(JSON.stringify(out, null, 2));
        } else if (action === 'pause' || action === 'resume') {
          const settings = runtime.store.setProjectSettings({ enabled: action === 'resume' });
          console.log(JSON.stringify({ paused: settings.enabled === false, file: runtime.store.paths.repoProfileFile }, null, 2));
        } else if (action === 'exclude' || action === 'unexclude') {
          if (!scopePaths.length) throw new Error('用法: accremind repo exclude <仓库内路径前缀…>');
          const current = normalizeExcludePaths(runtime.store.projectSettings().excludePaths);
          const requested = normalizeExcludePaths(scopePaths);
          const next = action === 'exclude'
            ? normalizeExcludePaths([...current, ...requested])
            : current.filter((p) => !requested.includes(p));
          const settings = runtime.store.setProjectSettings({ excludePaths: next });
          console.log(JSON.stringify({ excludePaths: normalizeExcludePaths(settings.excludePaths) }, null, 2));
        } else {
          const profile = await runtime.rpcHandlers['accremind.repo.profile']!({});
          console.log(JSON.stringify({
            ...(profile as Record<string, unknown>),
            scope: { paused: runtime.store.projectSettings().enabled === false,
              excludePaths: normalizeExcludePaths(runtime.store.projectSettings().excludePaths) },
          }, null, 2));
        }
        break;
      }

      case 'subprojects': {
        const [action = 'list', target] = rest.filter((a) => !a.startsWith('--') && !['--paths', '--name', '--domains', '--owners']
          .includes(rest[rest.indexOf(a) - 1] ?? ''));
        const list = (flag: string) => getFlag(rest, flag)?.split(',').map((x) => x.trim()).filter(Boolean);
        let out: unknown;
        if (action === 'add' || action === 'set') {
          if (!target) throw new Error('用法: accremind subprojects add <id> --paths services/pay/,libs/pay/ [--name 支付服务] [--domains payment] [--owners a@x.com]');
          out = await runtime.rpcHandlers['accremind.repo.upsertSubproject']!({ id: target, paths: list('--paths') ?? [], name: getFlag(rest, '--name'),
            domains: list('--domains'), owners: list('--owners') });
        } else if (action === 'remove' || action === 'rm') {
          if (!target) throw new Error('用法: accremind subprojects remove <id>');
          out = await runtime.rpcHandlers['accremind.repo.removeSubproject']!({ id: target });
        } else {
          out = { subprojects: (await runtime.rpcHandlers['accremind.repo.profile']!({}) as { subprojects: unknown }).subprojects };
        }
        console.log(JSON.stringify(out, null, 2));
        break;
      }

      case 'digest': {
        const days = Number(getFlag(rest, '--days') ?? 7);
        const out = await runtime.rpcHandlers['accremind.digest']!({ days }) as { markdown: string };
        console.log(hasFlag(rest, '--json') ? JSON.stringify(out, null, 2) : out.markdown);
        break;
      }

      default:
        throw new Error(
          `未知子命令 "${subcommand}"。可用命令: status | search | get | rebuild | bootstrap | migrate | repo | subprojects | eval | usage | demotions | docs | team | domains | digest | ui`,
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
