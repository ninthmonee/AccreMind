import * as fs from 'node:fs';
import type { TurnReceipts } from './turn-receipts.ts';
import type { DshToolDefinition } from './cordis-types.ts';
import { createDemoHandlers, DEMO_ENTRY_IDS } from './demo-seed.ts';
import { decideReview, reviewMissingFields } from './candidate-review.ts';
import * as path from 'node:path';
import {
  GovernanceService,
  KNOWLEDGE_LAYERS,
  isCapturableLayer,
  autoTuneStatus,
  rollbackTuning,
  runAutoTune,
  runEvaluation,
  writeRepoProfile,
  exportEntryToDshSkill,
  runArchaeologyBootstrap,
  scanGitHistorySignals,
  serializeEntryMarkdown,
  sha256Hex,
  type AccreMindConfig,
  type AutoCaptureCoordinator,
  type CaptureAssessment,
  type Disposition,
  type EntryStatus,
  type Freshness,
  type GitStalenessScanner,
  type KnowledgeEntry,
  type KnowledgeLayer,
  type KnowledgeType,
  type LlmInferenceAdapter,
  type LocalMarkdownSqliteStore,
  type ServingStatus,
  type TriageEngine,
  type ViewCompiler,
} from '@accremind/core';

export type RpcHandlerMap = Record<
  string,
  (params: Record<string, unknown>) => Promise<unknown> | unknown
>;

function emptyScopeCounts(): Record<KnowledgeLayer, number> {
  return Object.fromEntries(KNOWLEDGE_LAYERS.map(layer => [layer, 0])) as Record<KnowledgeLayer, number>;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.2);
}


/**
 * Complete Host RPC Router for the AccreMind V3.1 Creative Observatory WebUI.
 * Browser views NEVER touch `node:sqlite`, `fs`, or OS processes directly.
 */
export function createWebuiRpcHandlers(deps: {
  receipts: TurnReceipts;
  tools: DshToolDefinition<any>[];
  demoMode?: boolean;
  store: LocalMarkdownSqliteStore;
  viewCompiler: ViewCompiler;
  budgets: AccreMindConfig['budgets'];
  stalenessScanner: GitStalenessScanner;
  triageEngine: TriageEngine;
  autoCapture: AutoCaptureCoordinator;
  getLlmAdapter: () => LlmInferenceAdapter | null;
}): RpcHandlerMap {
  const {
    store,
    viewCompiler,
    budgets,
    stalenessScanner,
    triageEngine,
    autoCapture,
    getLlmAdapter,
  } = deps;

  function currentEntry(params: Record<string, unknown>) {
    const found = store.getEntry(String(params.id ?? ''), { recordUsage: false, includeHistoryOrSuspended: true });
    if (!found.found || !found.servable) throw new Error('未找到条目');
    deps.receipts.checkReference(params, found.entry);
    return found.entry;
  }

  const governance = new GovernanceService(store);

  function governanceQueue() {
    const entries = store.listEntriesForAdmin().map(item => item.entry);
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    return {
      staleEntries: entries.filter(entry => entry.freshness !== 'current' && (entry.status === 'active' || entry.status === 'probation')),
      suspendedEntries: entries.filter(entry => entry.serving === 'suspended' && (entry.status === 'active' || entry.status === 'probation')),
      corruptedFiles: store.listCorruptedFiles(),
      attentionItems: store.listAttentionItems().map(item => ({ ...item, entry: byId.get(item.entry_id) ?? null })),
      // Shared entries to re-check here (e.g. a dependency they rely on had a major upgrade in this repository).
      sharedReviews: store.listSharedReviews().flatMap(r => {
        const found = store.getEntry(r.entryId, { recordUsage: false, includeHistoryOrSuspended: true });
        return found.found && found.servable && found.entry.revision === r.revision ? [{ ...r, entry: found.entry }] : [];
      }),
    };
  }

  return {
    'accremind.gov.markStale': (params) => governance.markStale(currentEntry(params), String(params.reason ?? '')),
    'accremind.gov.resolveConflict': (params) => governance.resolveConflict(currentEntry(params), String(params.reason ?? '')),
    'accremind.turn.list': (params) => ({
      receipts: deps.receipts.list(typeof params.sessionId === 'string' ? params.sessionId : undefined,
        typeof params.turnId === 'string' ? params.turnId : undefined, Number(params.limit ?? 20)),
    }),
    'accremind.capture.manual': async (params) => {
      const capture = deps.tools.find((tool) => tool.name === 'accremind_capture')!;
      const out = await capture.execute(params, { sessionId: 'webui-manual' });
      if (out.isError) throw new Error(out.content[0]?.text ?? '捕获失败');
      return JSON.parse(out.content[0]!.text);
    },
    'accremind.attention.list': () => {
      const items = store.listAttentionItems();
      const byId = new Map(items.length ? store.listEntriesForAdmin().map(hit => [hit.entry.id, hit]) : []);
      return { items: items.map(item => {
        const found = byId.get(item.entry_id);
        return { ...item, title: found?.entry.title ?? item.entry_id, type: found?.entry.type ?? null };
      }) };
    },
    'accremind.insights.overview': (params) => store.insights(
      Math.min(90, Math.max(7, Number(params.days ?? 28))),
      new Date(),
      typeof params.tzOffsetMinutes === 'number' ? params.tzOffsetMinutes : undefined,
    ),

    'accremind.dashboard.overview': () => {
      const all = store.listEntriesForAdmin();
      const pendingCount = store.countAssessments('pending');
      const corrupted = store.listCorruptedFiles();
      const queuedJobs = autoCapture.listQueuedJobs();

      let activeCount = 0;
      let rulesCount = 0;
      let projectActiveCount = 0;
      let probationCount = 0;
      let reviewDueCount = 0;
      let suspendedCount = 0;
      let governanceQueueCount = 0;
      let verifiedOrProvenCount = 0;
      const byScope = emptyScopeCounts();
      const byType: Record<string, number> = {
        pitfall: 0,
        decision: 0,
        guideline: 0,
        model: 0,
        process: 0,
      };

      for (const { entry, storageZone } of all) {
        if (storageZone === 'project' && entry.status === 'active') projectActiveCount += 1;
        if (storageZone === 'rules') rulesCount += 1;
        if (entry.status === 'active') activeCount += 1;
        if (entry.status === 'probation') probationCount += 1;
        if (entry.freshness === 'review_due') reviewDueCount += 1;
        if (entry.serving === 'suspended') suspendedCount += 1;
        if (entry.freshness !== 'current' || (entry.serving === 'suspended' &&
            (entry.status === 'active' || entry.status === 'probation'))) governanceQueueCount += 1;
        if (entry.maturity === 'verified' || entry.maturity === 'proven') {
          verifiedOrProvenCount += 1;
        }
        byScope[entry.layer] = (byScope[entry.layer] ?? 0) + 1;
        byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      }

      const hasDemoSeeded = deps.demoMode === true && all.some((i) => DEMO_ENTRY_IDS.includes(i.entry.id));

      return {
        workspaceId: store.workspaceId,
        projectName: path.basename(store.paths.projectRoot),
        projectDir: store.paths.projectAccreMindDir,
        globalDir: store.paths.globalRoot,
        maxProbationExposures: store.maxProbationExposures,
        budgets,
        hasDemoSeeded,
        counts: {
          totalEntries: all.length,
          byScope,
          byCategory: byType,
          activeCount,
          projectActiveCount,
          rulesCount,
          probationCount,
          reviewDueCount,
          suspendedCount,
          // Inapplicable reports already suspend the entry (counted above); silent trials are new work.
          governanceQueueCount: governanceQueueCount + corrupted.length +
            store.listAttentionItems().filter(item => item.kind === 'probation_silent').length,
          verifiedOrProvenCount,
          pendingReviewCount: pendingCount,
          corruptedCount: corrupted.length,
          queuedCaptureJobs: queuedJobs.length,
          navigationItemsCount: store.listNavigationItems().length,
        },
        byType,
      };
    },

    'accremind.kb.list': (params) => {
      if (params.adminView === true) {
        const items = store.listEntriesForAdmin({
          status: (params.status as EntryStatus | undefined) || undefined,
          freshness: (params.freshness as Freshness | undefined) || undefined,
          serving: (params.serving as ServingStatus | undefined) || undefined,
          type: (params.type as KnowledgeType | undefined) || undefined,
          query: typeof params.query === 'string' ? params.query : undefined,
        });
        const matching = items.filter(({ entry, storageZone }) =>
          (!params.storageZone || storageZone === params.storageZone) &&
          (!params.maturity || (params.maturity === 'verified_or_proven'
            ? entry.maturity === 'verified' || entry.maturity === 'proven'
            : entry.maturity === params.maturity)),
        );
        const scopeCounts = emptyScopeCounts();
        for (const {entry} of matching) {
          scopeCounts[entry.layer] = (scopeCounts[entry.layer] ?? 0) + 1;
        }
        const filtered = params.layer ? matching.filter(({entry}) => entry.layer === params.layer) : matching;
        return {
          scopeCounts,
          items: filtered.map((i) => ({
            entry: i.entry,
            storageZone: i.storageZone,
            probationExposures: i.probationExposures,
            score: 1,
            matchReasons: [],
            truncated: false,
          })),
          zeroReason: filtered.length === 0 ? 'no_applicable_entry' : 'none',
          tokenUsed: 0,
        };
      }

      return store.search({
        workspaceId: store.workspaceId,
        query: typeof params.query === 'string' ? params.query : undefined,
        type: (params.type as KnowledgeType | undefined) || undefined,
        layer: (params.layer as KnowledgeLayer | undefined) || undefined,
        filePath: typeof params.filePath === 'string' ? params.filePath : undefined,
        includeProbation: params.includeProbation !== false,
        limit: typeof params.limit === 'number' ? params.limit : 20,
      });
    },

    'accremind.kb.get': (params) => {
      const id = String(params.id ?? '');
      const outcome = store.getEntry(id, {
        recordUsage: false,
        includeHistoryOrSuspended: true,
      });
      if (!outcome.found || !outcome.servable) {
        return outcome;
      }
      const assessment = outcome.entry.capture_assessment_id
        ? store.getAssessment(outcome.entry.capture_assessment_id)
        : null;
      const validations = store.listValidations(id);
      const rawMarkdown = serializeEntryMarkdown(outcome.entry);
      const records = store.ledger.read(id);
      return {
        ...outcome,
        assessment,
        validations,
        rawMarkdown,
        // Snapshot per piece of evidence (newest first) and the ledger as the shared rules read it.
        snapshots: store.snapshots.list(outcome.entry),
        ledger: { shared: store.ledger.isShared, standing: store.ledgerStanding(outcome.entry), records: records.slice(-50).reverse() },
      };
    },

    'accremind.kb.saveRevision': (params) => {
      const id = String(params.id ?? '');
      if (params.expectedRevision !== undefined) currentEntry({ id, revision: params.expectedRevision });
      const patch = (params.patch ?? {}) as Partial<KnowledgeEntry>;
      const editableStrings = ['title', 'claim', 'rationale', 'knowledge_delta'];
      const editableLists = ['search_aliases', 'invalidation_triggers', 'preconditions', 'domains', 'portable_patterns'];
      for (const [name, value] of Object.entries(patch)) {
        if (name === 'layer' && isCapturableLayer(value)) continue;
        if (name === 'applies_to' && value && typeof value === 'object' && !Array.isArray(value)) continue;
        if (name === 'overrides' && Array.isArray(value) && value.every(v => v && typeof v === 'object')) continue;
        if (editableStrings.includes(name) && typeof value === 'string') continue;
        if (editableLists.includes(name) && Array.isArray(value) && value.every(v => typeof v === 'string')) continue;
        throw new Error(`无法通过正文修订修改字段 ${name}`);
      }
      const revisionImpact =
        params.revisionImpact === 'editorial' ? 'editorial' : 'substantive';
      return store.saveRevision({ id, patch, revisionImpact });
    },

    'accremind.kb.withdraw': (params) => {
      const entry = currentEntry(params);
      const reason = String(params.reason ?? '');
      const supersedes = typeof params.supersedes === 'string' ? params.supersedes : null;
      return { entry: governance.withdraw(entry, reason, supersedes), reason: reason.trim() };
    },

    'accremind.probation.decide': (params) => governance.decideProbation(currentEntry(params), String(params.action ?? '')),

    'accremind.feedback.submit': (params) => governance.submitFeedback(currentEntry(params), {
      kind: String(params.kind ?? ''),
      detail: typeof params.detail === 'string' ? params.detail : '',
      sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
      turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
      taskFingerprint: typeof params.taskFingerprint === 'string' ? params.taskFingerprint : undefined,
    }),

    'accremind.sim.compile': (params) => {
      const userPrompt = typeof params.userPrompt === 'string' ? params.userPrompt : '';
      const errorOutput = typeof params.errorOutput === 'string' ? params.errorOutput : '';
      const activeFile = typeof params.activeFile === 'string' ? params.activeFile.trim() : '';
      const midTurnToolFile =
        typeof params.midTurnToolFile === 'string' ? params.midTurnToolFile.trim() : '';

      const simSurfaced = new Set<string>();
      const turnView = viewCompiler.compileTurnView(
        {
          sessionId: 'webui-simulator',
          preview: true,
          userPrompt,
          errorOutput,
          activeFiles: activeFile ? [activeFile] : [],
        },
        simSurfaced,
      );

      const jitOut = midTurnToolFile
        ? viewCompiler.compileFileToolGuard({
            sessionId: 'webui-simulator',
            preview: true,
            filePath: midTurnToolFile,
            sessionSurfacedIds: simSurfaced,
          })
        : { guardBlock: '', newlySurfacedIds: [] };

      return {
        residentPrefix: turnView.residentPrefix,
        residentRuleIds: turnView.residentRuleIds,
        residentDroppedIds: turnView.residentDroppedIds,
        residentSha256: turnView.residentPrefix
          ? sha256Hex(turnView.residentPrefix).slice(0, 16)
          : 'empty',
        residentTokens: estimateTokens(turnView.residentPrefix),
        radarBlock: turnView.radarBlock,
        radarTokens: estimateTokens(turnView.radarBlock),
        radarSurfacedIds: turnView.surfacedIds,
        guardBlock: jitOut.guardBlock,
        guardTokens: estimateTokens(jitOut.guardBlock),
        guardSurfacedIds: jitOut.newlySurfacedIds,
        budgets,
      };
    },

    'accremind.review.listQueue': (params) => {
      const reviewState =
        (params.reviewState as 'pending' | 'decided' | 'all' | undefined) ?? 'all';
      const limit = typeof params.limit === 'number' && Number.isInteger(params.limit)
        ? Math.max(1, Math.min(200, params.limit)) : 50;
      const offset = typeof params.offset === 'number' && Number.isInteger(params.offset)
        ? Math.max(0, params.offset) : 0;
      const total = store.countAssessments(reviewState);
      return {
        offset, limit, total, hasMore: offset + limit < total,
        items: store.listAssessments({reviewState, limit, offset}).map(item => ({
          ...item, missingFields: reviewMissingFields(item),
        })),
        navigationItems: store.listNavigationItems(),
      };
    },

    'accremind.review.decide': (params) => decideReview(store, params),

    // Checking the code (git) is a write and can be slow; reading the queue is cheap. Diffs are fetched
    // one entry at a time, only when someone opens it.
    'accremind.gov.scanStaleness': () => ({ scan: stalenessScanner.scanWorkspace(), ...governanceQueue() }),

    'accremind.gov.reviewQueue': () => governanceQueue(),

    'accremind.gov.clearSharedReview': (params) => {
      const id = String(params.id ?? '');
      if (!store.listSharedReviews().some((r) => r.entryId === id)) throw new Error('这条经验在本仓库没有待核对项');
      store.clearSharedReview(id);
      return governanceQueue();
    },

    // Diff plus, per piece of evidence, what it said when last approved/confirmed vs what it says now.
    'accremind.gov.reviewDetails': (params) => {
      const entry = currentEntry(params);
      const latest = store.snapshots.latest(entry);
      const evidence = entry.evidence.map((ev) => {
        const then = latest.get(ev.id) ?? null;
        const now = store.snapshots.read(ev);
        return {
          evidenceId: ev.id,
          locator: ev.locator,
          summary: ev.summary,
          then,
          now: { excerpt: now.excerpt, sourceSha256: now.sourceSha256, commit: now.commit, truncated: now.truncated },
          changed: then ? then.sourceSha256 !== now.sourceSha256 : null,
          verification: then ? store.snapshots.verify(then) : null,
        };
      });
      return { ...stalenessScanner.reviewDetails(entry), evidence };
    },

    'accremind.evidence.capture': (params) => {
      const entry = currentEntry(params);
      return { snapshots: store.snapshots.capture(entry) };
    },

    'accremind.gov.requestReview': (params) => governance.requestReview(currentEntry(params), String(params.reason ?? '')),

    'accremind.gov.readAnchor': (params) => {
      const entry = currentEntry(params);
      return stalenessScanner.readAnchor(entry, String(params.filePath ?? ''), String(params.symbolName ?? ''));
    },

    'accremind.gov.rebindAnchor': (params) => {
      const entry = currentEntry(params);
      if (params.revision !== entry.revision) throw new Error('条目版本已经变更，请刷新并重新核对');
      return {entry:stalenessScanner.rebindAnchor(entry, String(params.oldFilePath ?? ''), String(params.oldSymbolName ?? ''),
        String(params.filePath ?? '').trim(), String(params.symbolName ?? '').trim())};
    },

    'accremind.gov.confirmFresh': (params) => {
      const id = String(params.id ?? '');
      const found = store.getEntry(id, { recordUsage: false, includeHistoryOrSuspended: true });
      if (!found.found || !found.servable) throw new Error(`未找到条目: ${id}`);
      if (params.revision !== undefined && params.revision !== found.entry.revision) {
        throw new Error('条目版本已经变更，请刷新后重新核对');
      }
      if (typeof params.reviewToken === 'string' && params.reviewToken !== stalenessScanner.reviewDetails(found.entry).reviewToken) {
        throw new Error('对照代码已经变化，请刷新差异后再次核对');
      }
      return stalenessScanner.confirmFresh(found.entry);
    },

    'accremind.gov.bootstrapHistory': async (params) => {
      const maxCommits = typeof params.maxCommits === 'number' ? params.maxCommits : 150;
      const topK = typeof params.topK === 'number' ? params.topK : 10;
      const extractWithLlm = Boolean(params.extractWithLlm);
      const llm = getLlmAdapter();

      if (extractWithLlm && llm) {
        const result = await runArchaeologyBootstrap({
          store,
          triageEngine,
          llm,
          maxCommitsToScan: maxCommits, topK,
          commitShas: Array.isArray(params.commitShas) ? params.commitShas.map(String) : undefined,
        });
        return {...result, modelAvailable:true};
      }

      const minedCommits = scanGitHistorySignals({
        repoRoot: store.paths.projectRoot,
        maxCommitsToScan: maxCommits,
        topK,
      });
      return {
        minedCommits, modelAvailable: Boolean(llm),
        message: extractWithLlm && !llm ? '当前未连接提炼模型，仅扫描提交；尚未生成候选。' : undefined,
        triageReport: null as null | { dispositionCounts: Record<Disposition, number> },
      };
    },

    'accremind.gov.exportSkill': (params) => {
      const id = String(params.id ?? '');
      const skillSlug = String(params.skillSlug ?? '');
      return exportEntryToDshSkill({ store, entryId: id, skillSlug, confirmRepositoryCopy: params.confirmRepositoryCopy === true });
    },

    // ---- rule document sets ----
    'accremind.docs.list': () => ({ docs: store.docs.listDocs(), docsDir: store.docs.docsDir }),
    'accremind.docs.get': (params) => {
      const doc = store.docs.getDoc(String(params.id ?? ''));
      if (!doc) throw new Error('未找到文档');
      return { ...doc, file: path.relative(store.paths.projectRoot, doc.file), changes: store.docs.listChanges({ docId: doc.meta.id, limit: 50 }) };
    },
    'accremind.docs.import': (params) => store.docs.importDoc({
      content: String(params.content ?? ''), fileName: String(params.fileName ?? 'doc.md'), category: params.category as never,
      title: typeof params.title === 'string' ? params.title : undefined,
      domains: Array.isArray(params.domains) ? params.domains.map(String) : undefined,
      tags: Array.isArray(params.tags) ? params.tags.map(String) : undefined, replace: params.replace === true,
    }),
    'accremind.docs.search': (params) => ({ hits: store.searchDocs({ query: String(params.query ?? ''), limit: Number(params.limit ?? 10) }) }),
    'accremind.docs.propose': (params) => store.docs.propose({
      docId: typeof params.docId === 'string' ? params.docId : null, category: params.category as never,
      docTitle: typeof params.docTitle === 'string' ? params.docTitle : undefined, section: String(params.section ?? ''),
      op: params.op as never, content: String(params.content ?? ''), rationale: String(params.rationale ?? ''),
      evidence: typeof params.evidence === 'string' ? params.evidence : undefined, source: 'human',
    }),
    'accremind.docs.proposals': (params) => ({
      proposals: store.docs.listProposals((params.status as never) ?? 'pending'),
      tagProposals: store.docs.listTagProposals('pending'),
    }),
    'accremind.docs.decide': (params) => store.docs.decide(String(params.id ?? ''), params.decision === 'accept' ? 'accept' : 'reject', {
      content: typeof params.content === 'string' ? params.content : undefined, note: typeof params.note === 'string' ? params.note : undefined,
      force: params.force === true,
    }),
    'accremind.docs.changes': (params) => ({ changes: store.docs.listChanges({
      docId: typeof params.docId === 'string' ? params.docId : undefined, limit: Number(params.limit ?? 100) }) }),
    'accremind.vocab.list': () => ({ tags: store.docs.vocabulary().tags, file: store.docs.vocabularyFile }),
    'accremind.vocab.decide': (params) => store.docs.decideTag(String(params.id ?? ''), params.decision === 'accept' ? 'accept' : 'reject', {
      label: typeof params.label === 'string' ? params.label : undefined,
      aliases: Array.isArray(params.aliases) ? params.aliases.map(String) : undefined,
    }),

    'accremind.eval.run': (params) => runEvaluation(store, { grid: params.grid === true, apply: params.apply === true }),
    'accremind.tuning.status': () => autoTuneStatus(store),
    'accremind.tuning.auto': async () => runAutoTune(store, { force: true }),
    'accremind.tuning.rollback': (params) => rollbackTuning(store, typeof params.note === 'string' ? params.note : ''),
    'accremind.gov.autoDemotions': (params) => ({ demotions: store.listAutoDemotions({ includeReverted: params.includeReverted === true }) }),
    'accremind.gov.restoreAutoDemotion': (params) => {
      const entry = store.restoreAutoDemotion(String(params.entryId ?? ''), typeof params.note === 'string' ? params.note : '');
      return { entry: { id: entry.id, status: entry.status, serving: entry.serving } };
    },

    // Repository identity and business domains: the domains decide which other repositories' domain
    // knowledge is served here. Saving writes `.accremind/repo.json` (commit it so every clone agrees).
    'accremind.repo.profile': () => {
      const ctx = store.sessionContext();
      return {
        repoId: store.workspaceId, idSource: store.identity.source, name: store.identity.name, remote: store.identity.remote,
        org: store.identity.org, domains: store.identity.domains, languages: ctx.languages,
        dependencies: Object.keys(ctx.dependencies).length, profileFile: store.paths.repoProfileFile,
        knownRepositories: store.registry.list().map((r) => ({ repoId: r.repo_id, name: r.name, domains: r.domains, lastSeen: r.last_seen })),
      };
    },
    'accremind.repo.setDomains': (params) => {
      const domains = Array.isArray(params.domains) ? params.domains.map(String).map((d) => d.trim()).filter(Boolean) : null;
      if (!domains) throw new Error('请提供业务领域列表');
      if (domains.some((d) => !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(d))) throw new Error('领域标识只能使用小写字母、数字、连字符和下划线');
      const written = writeRepoProfile(store.paths.projectRoot, path.basename(store.paths.projectAccreMindDir), {
        repo_id: store.workspaceId, domains,
        ...(store.identity.org ? { org: store.identity.org } : {}),
      });
      store.updateRepoProfile({ domains });
      return { repoId: store.workspaceId, domains: written.domains ?? [], profileFile: store.paths.repoProfileFile };
    },

    'accremind.gov.rebuildIndex': () => {
      const stats = store.rebuildIndexFromScratch();
      return {
        ...stats,
        corruptedFiles: store.listCorruptedFiles(),
      };
    },

    'accremind.queue.list': () => {
      return { jobs: autoCapture.listQueuedJobs() };
    },

    'accremind.queue.drain': async () => {
      const outcomes = await autoCapture.processPendingQueue();
      return { processed: outcomes.length, outcomes };
    },

    ...createDemoHandlers({ store, stalenessScanner, demoMode: deps.demoMode === true }),
  };
}
