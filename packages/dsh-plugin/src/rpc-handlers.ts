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
  mountKnowledgeBase,
  gitShareStatus,
  browseDirs,
  inspectProjectDir,
  LocalMarkdownSqliteStore,
  buildDigest,
  pendingNotice,
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
  type ServingStatus,
  type TriageEngine,
  type ViewCompiler,
} from '@accremind/core';

export type RpcHandlerMap = Record<
  string,
  (params: Record<string, unknown>) => Promise<unknown> | unknown
>;

/** Why a reminder did not fit, as offered next to the feedback buttons; the label is kept with the detail. */
export const FEEDBACK_REASONS: Record<string, string> = {
  wrong_domain: '领域不对',
  wrong_project: '不是这个项目或子项目',
  wrong_version: '版本不对',
  outdated: '已过时',
  unrelated: '和这次问题无关',
};

function feedbackDetail(reason: unknown, detail: string): string {
  const label = typeof reason === 'string' ? FEEDBACK_REASONS[reason] : undefined;
  if (!label) return detail;
  return detail.trim() ? `[${label}] ${detail.trim()}` : `[${label}]`;
}

function domainFilterKeys(store: LocalMarkdownSqliteStore, domain: string): Set<string> {
  const catalog = store.domainCatalog;
  const id = catalog.resolve(domain);
  if (!id) return new Set([domain.trim().toLowerCase()]);
  const keys = new Set<string>();
  for (const d of catalog.list()) {
    if (!catalog.lineage(d.id).some((x) => x.id === id)) continue;
    for (const k of [d.id, d.name, ...d.aliases]) keys.add(k.trim().toLowerCase());
  }
  return keys;
}

function importDocParams(store: LocalMarkdownSqliteStore, params: Record<string, unknown>) {
  return store.docs.importDoc({
    content: String(params.content ?? ''), fileName: String(params.fileName ?? 'doc.md'), category: params.category as never,
    title: typeof params.title === 'string' ? params.title : undefined,
    domains: Array.isArray(params.domains) ? params.domains.map(String) : undefined,
    tags: Array.isArray(params.tags) ? params.tags.map(String) : undefined, replace: params.replace === true,
    scope: params.scope === 'project' || params.scope === 'domain' || params.scope === 'personal' ? params.scope : undefined,
    home: params.home === 'kb' || params.home === 'repo' ? params.home : undefined,
    audience: params.audience === 'core' || params.audience === 'all' ? params.audience : undefined,
    subproject: typeof params.subproject === 'string' && params.subproject ? params.subproject : undefined,
    createDomains: params.createDomains === true,
  });
}

/** Paths from the workbench must be absolute: they name folders on this machine, never relative to the server. */
function requireAbsolute(value: unknown): string {
  const p = typeof value === 'string' ? value.trim() : '';
  if (!p || !path.isAbsolute(p)) throw new Error('请提供文件夹的完整路径');
  return path.resolve(p);
}

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
  const projectDirName = () => path.basename(deps.store.paths.projectAccreMindDir);
  /**
   * A project document for a project other than the one open here: that project's own store writes it (into
   * its `.accremind/docs/`, with its change log), so it is indexed and served there like any other.
   */
  const importIntoOtherProject = (root: string, params: Record<string, unknown>) => {
    const info = inspectProjectDir(root, projectDirName());
    if (!info.exists) throw new Error(`目录不存在：${root}`);
    if (params.scope && params.scope !== 'project') throw new Error('只有“本项目”范围的文档可以挂到其他项目；领域文档请选择领域，个人偏好只属于你');
    const target = new LocalMarkdownSqliteStore({ projectRoot: root, globalDir: deps.store.paths.globalRoot, projectDirName: projectDirName() });
    try {
      target.initializeAndReconcile();
      const out = importDocParams(target, { ...params, scope: 'project', domains: [] });
      return { ...out, file: path.isAbsolute(out.file) ? out.file : path.join(root, out.file), project: { root, name: target.identity.name, repoId: target.workspaceId, isGit: info.isGit } };
    } finally {
      target.close();
    }
  };
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
        // A domain filter also matches the domain's other spellings and its sub-domains (as retrieval does).
        const domainKeys = typeof params.domain === 'string' && params.domain ? domainFilterKeys(store, params.domain) : null;
        const subproject = typeof params.subproject === 'string' && params.subproject ? params.subproject : null;
        const matching = items.filter(({ entry, storageZone }) =>
          (!domainKeys || (entry.domains ?? []).some((d) => domainKeys.has(d.trim().toLowerCase()))) &&
          (!subproject || (subproject === '__none__' ? !entry.subproject : entry.subproject === subproject)) &&
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
      detail: feedbackDetail(params.reason, typeof params.detail === 'string' ? params.detail : ''),
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

      // 被排除沉淀的项目：不扫描、不提炼，直接说明原因（避免误以为环境坏了）。
      if (!store.repoSettings().capture) {
        return {
          minedCommits: [], modelAvailable: Boolean(llm),
          message: '本项目已在 .accremind/repo.json 里排除沉淀（capture: false），雷达不会扫描。改回 true 或删掉该字段即可恢复。',
          triageReport: null as null | { dispositionCounts: Record<Disposition, number> },
        };
      }

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
    'accremind.docs.list': () => ({ docs: store.docs.listDocs(), docsDir: store.docs.docsDir, duplicates: store.docs.duplicateDocIds() }),
    'accremind.docs.get': (params) => {
      const doc = store.docs.getDoc(String(params.id ?? ''));
      if (!doc) throw new Error('未找到文档');
      return { ...doc, file: path.relative(store.paths.projectRoot, doc.file), changes: store.docs.listChanges({ docId: doc.meta.id, limit: 50 }) };
    },
    // Which project a document is mounted on: the one open in the host, another known one, or any folder.
    // What AccreMind wrote that has not reached the team yet (it never commits or pushes by itself).
    'accremind.share.status': () => {
      const kb = store.knowledgeBase;
      return {
        project: { root: store.paths.projectRoot, ...gitShareStatus(store.paths.projectRoot, path.relative(store.paths.projectRoot, store.paths.projectAccreMindDir) || undefined) },
        knowledgeBase: kb.kind === 'team' ? { root: kb.root, ...gitShareStatus(kb.root) } : null,
      };
    },
    'accremind.projects.list': () => {
      const current = path.resolve(store.paths.projectRoot);
      const others = store.registry.list()
        .filter((r) => path.resolve(r.root) !== current && fs.existsSync(r.root))
        .sort((a, b) => b.last_seen.localeCompare(a.last_seen))
        .map((r) => ({ root: r.root, name: r.name, repoId: r.repo_id, domains: r.domains, lastSeen: r.last_seen }));
      return { current: { ...inspectProjectDir(current, projectDirName()), name: store.identity.name, repoId: store.workspaceId }, others };
    },
    'accremind.projects.inspect': (params) => inspectProjectDir(requireAbsolute(params.root), projectDirName()),
    'accremind.fs.browse': (params) => browseDirs(typeof params.path === 'string' && params.path
      ? requireAbsolute(params.path) : path.dirname(path.resolve(store.paths.projectRoot)), projectDirName()),

    'accremind.docs.import': (params) => {
      const targetRoot = typeof params.projectRoot === 'string' && params.projectRoot
        ? requireAbsolute(params.projectRoot) : null;
      if (targetRoot && targetRoot !== path.resolve(store.paths.projectRoot)) return importIntoOtherProject(targetRoot, params);
      return importDocParams(store, params);
    },
    'accremind.docs.citedBy': (params) => ({ entries: store.docs.citedBy(String(params.docId ?? ''), typeof params.sectionId === 'string' ? params.sectionId : undefined) }),

    // The knowledge base outside this project (a mounted team repository) and its domain catalog.
    'accremind.knowledge.info': () => {
      const kb = store.knowledgeBase;
      return { root: kb.root, kind: kb.kind, catalogFile: store.domainCatalog.file, docsDir: store.docs.kbDocsDir,
        domains: store.domainCatalog.list().length, personalDocsDir: store.docs.personalDocsDir };
    },
    'accremind.knowledge.mount': (params) => {
      mountKnowledgeBase(store.paths.globalRoot, typeof params.path === 'string' && params.path ? params.path : null);
      const kb = store.refreshKnowledgeBase();
      store.docs.reconcile();
      return { root: kb.root, kind: kb.kind };
    },
    'accremind.domains.list': () => {
      const names = new Map(store.registry.list().map((r) => [r.repo_id, r.name]));
      const membership = store.domainMembership();
      return {
        catalogFile: store.domainCatalog.file,
        knowledgeBase: store.knowledgeBase,
        domains: store.domainCatalog.list().map((d) => ({
          ...d,
          members: d.members.map((m) => ({ ...m, name: names.get(m.repo) ?? m.repo, isThisRepo: m.repo === store.workspaceId })),
          myRole: membership.find((m) => m.id === d.id)?.role ?? null,
        })),
        mine: membership,
        unknown: membership.filter((m) => !m.known).map((m) => m.id),
      };
    },
    'accremind.domains.upsert': (params) => store.domainCatalog.upsert({
      ...(typeof params.id === 'string' && params.id ? { id: params.id } : {}),
      ...(typeof params.name === 'string' && params.name ? { name: params.name } : {}),
      ...(Array.isArray(params.aliases) ? { aliases: params.aliases.map(String) } : {}),
      ...(typeof params.parent === 'string' ? { parent: params.parent || null } : {}),
      ...(Array.isArray(params.owners) ? { owners: params.owners.map(String) } : {}),
      ...(typeof params.description === 'string' ? { description: params.description } : {}),
    }),
    'accremind.domains.join': (params) => {
      const domain = String(params.domain ?? '');
      const role = params.role === 'consumer' ? 'consumer' : 'core';
      const subproject = typeof params.subproject === 'string' && params.subproject ? params.subproject : undefined;
      if (subproject) return { domain: store.domainCatalog.addMember(domain, { repo: store.workspaceId, role, subproject }) };
      const current = store.domainMembership().filter((m) => m.known || m.id !== domain).map((m) => (m.role === 'consumer' ? `${m.id}:consumer` : m.id));
      const id = store.domainCatalog.resolve(domain) ?? domain;
      const next = [...current.filter((d) => d.replace(/:consumer$/, '') !== id), role === 'consumer' ? `${id}:consumer` : id];
      return store.setDomains(next, { create: params.create === true });
    },
    'accremind.domains.leave': (params) => {
      const id = store.domainCatalog.resolve(String(params.domain ?? '')) ?? String(params.domain ?? '');
      const next = store.domainMembership().filter((m) => m.id !== id).map((m) => (m.role === 'consumer' ? `${m.id}:consumer` : m.id));
      return store.setDomains(next, { create: true });
    },
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
        membership: store.domainMembership(), subprojects: store.subprojects(), owners: store.repoOwners(),
        settings: store.projectSettings(), knowledgeBase: store.knowledgeBase,
        dependencies: Object.keys(ctx.dependencies).length, profileFile: store.paths.repoProfileFile,
        ...store.repoSettings(),
        knownRepositories: store.registry.list().map((r) => ({ repoId: r.repo_id, name: r.name, domains: r.domains, lastSeen: r.last_seen })),
      };
    },
    // 项目级排除：capture=false 不沉淀，share=false 与其它仓库互不共享。开关写进 .accremind/repo.json，随仓库一起提交。
    'accremind.repo.setSettings': (params) => {
      const patch: { capture?: boolean; share?: boolean } = {};
      if (typeof params.capture === 'boolean') patch.capture = params.capture;
      if (typeof params.share === 'boolean') patch.share = params.share;
      if (!Object.keys(patch).length) throw new Error('请提供 capture 或 share 的布尔值');
      const settings = store.setRepoSettings(patch);
      return { repoId: store.workspaceId, ...settings, profileFile: store.paths.repoProfileFile };
    },
    'accremind.repo.setDomains': (params) => {
      const domains = Array.isArray(params.domains) ? params.domains.map(String).map((d) => d.trim()).filter(Boolean) : null;
      if (!domains) throw new Error('请提供业务领域列表');
      if (domains.some((d) => d.length > 60)) throw new Error('领域名称过长');
      const out = store.setDomains(domains, { create: params.create === true });
      return { repoId: store.workspaceId, ...out, profileFile: store.paths.repoProfileFile, catalogFile: store.domainCatalog.file };
    },

    'accremind.repo.upsertSubproject': (params) => ({
      subproject: store.upsertSubproject({
        id: String(params.id ?? ''),
        name: typeof params.name === 'string' ? params.name : undefined,
        paths: Array.isArray(params.paths) ? params.paths.map(String) : [],
        domains: Array.isArray(params.domains) ? params.domains.map(String) : undefined,
        owners: Array.isArray(params.owners) ? params.owners.map(String) : undefined,
      }),
      subprojects: store.subprojects(),
    }),
    'accremind.repo.removeSubproject': (params) => ({ removed: store.removeSubproject(String(params.id ?? '')), subprojects: store.subprojects() }),

    // What needs people (the reader's own first) and what changed by itself, for the workbench and the CLI.
    'accremind.digest': (params) => buildDigest(store, { days: Number(params.days ?? 7) || 7 }),
    // The one-line reminder a host shows (to the person, never to the model) when decisions are waiting.
    'accremind.inbox.summary': () => pendingNotice(store),

    'accremind.gov.rebuildIndex': () => {
      const stats = store.rebuildIndexFromScratch();
      return {
        ...stats,
        corruptedFiles: store.listCorruptedFiles(),
      };
    },

    'accremind.queue.list': () => {
      const jobs = autoCapture.listQueuedJobs().map((j) => ({ ...j, failed: j.attempts >= 5 }));
      return { jobs, failed: jobs.filter((j) => j.failed).length, modelAvailable: Boolean(deps.getLlmAdapter()) };
    },

    'accremind.queue.drain': async () => {
      if (!deps.getLlmAdapter()) throw new Error('没有可用的模型，无法提炼。请在设置中配置模型或使用 DSH 内置模型。');
      const before = autoCapture.listQueuedJobs().length;
      const outcomes = await autoCapture.processPendingQueue(Date.now(), { force: true });
      const failed = autoCapture.failedJobs().length;
      const left = autoCapture.listQueuedJobs().length;
      return { processed: outcomes.length, remaining: left, failed, attempted: before };
    },
    'accremind.queue.retry': async (params) => {
      if (!autoCapture.retryJob(String(params.jobId ?? ''))) throw new Error('任务已不存在');
      const outcomes = deps.getLlmAdapter() ? await autoCapture.processPendingQueue(Date.now(), { force: true }) : [];
      return { processed: outcomes.length, failed: autoCapture.failedJobs().length };
    },
    'accremind.queue.discard': (params) => ({ discarded: autoCapture.discardJob(String(params.jobId ?? '')) }),

    ...createDemoHandlers({ store, stalenessScanner, demoMode: deps.demoMode === true }),
  };
}
