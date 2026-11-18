import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomicSync } from '../codec/atomic-fs.ts';
import {
  scanGitHistorySignals,
  type ArchaeologyCommitCandidate,
} from '../governance/git-archaeology.ts';
import type { LocalMarkdownSqliteStore } from '../store/local-store.ts';
import { DeltaAssessor } from './delta-assessor.ts';
import { collectEvidenceBundle } from './evidence-collector.ts';
import type { LlmInferenceAdapter } from './llm-client.ts';
import {
  evaluateSessionSignals,
  type SessionSignalSnapshot,
  type SignalDetectionResult,
} from './signal-detector.ts';
import type { BatchTriageReport, SingleTriageOutcome, TriageEngine } from './triage-engine.ts';

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
const MAX_AUTO_RETRIES = 5;

export interface QueuedCaptureJob {
  jobId: string;
  sessionId: string;
  sourceType: 'session_turn' | 'git_commit';
  sourceRef: string;
  touchedFiles: string[];
  rawCandidateContext: string;
  attempts: number;
  lastError: string | null;
  nextRetryAtMs: number;
  createdAtIso: string;
}

interface MutableSessionTracker {
  userMessages: string[];
  assistantMessages: string[];
  fileEditCounts: Map<string, number>;
  hadCommandFailure: boolean;
  hadSubsequentCommandSuccess: boolean;
  totalToolCalls: number;
  capturedInSession: boolean;
}

export class AutoCaptureCoordinator {
  private readonly store: LocalMarkdownSqliteStore;
  private readonly triageEngine: TriageEngine;
  private llm: LlmInferenceAdapter | null;
  private readonly assessmentMode: 'single_pass' | 'isolated_p0';
  private readonly sessions = new Map<string, MutableSessionTracker>();
  private draining = false;

  constructor(options: {
    store: LocalMarkdownSqliteStore;
    triageEngine: TriageEngine;
    llm?: LlmInferenceAdapter | null;
    assessmentMode?: 'single_pass' | 'isolated_p0';
  }) {
    this.store = options.store;
    this.triageEngine = options.triageEngine;
    this.llm = options.llm ?? null;
    this.assessmentMode = options.assessmentMode ?? 'single_pass';
    this.pruneExpiredQueueJobs();
  }

  setLlmAdapter(llm: LlmInferenceAdapter | null): void {
    this.llm = llm;
  }

  private getSession(sessionId: string): MutableSessionTracker {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        userMessages: [],
        assistantMessages: [],
        fileEditCounts: new Map(),
        hadCommandFailure: false,
        hadSubsequentCommandSuccess: false,
        totalToolCalls: 0,
        capturedInSession: false,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  recordTurnConversation(
    sessionId: string,
    userText?: string,
    assistantText?: string,
  ): void {
    const s = this.getSession(sessionId);
    if (userText?.trim()) s.userMessages.push(userText.trim());
    if (assistantText?.trim()) s.assistantMessages.push(assistantText.trim());
  }

  recordToolActivity(options: {
    sessionId: string;
    toolName: string;
    editedRelPath?: string | null;
    isCommandOrTest?: boolean;
    failed?: boolean;
  }): void {
    const s = this.getSession(sessionIdFrom(options.sessionId));
    s.totalToolCalls += 1;

    if (options.editedRelPath) {
      s.fileEditCounts.set(
        options.editedRelPath,
        (s.fileEditCounts.get(options.editedRelPath) ?? 0) + 1,
      );
    }

    if (options.isCommandOrTest) {
      if (options.failed) {
        s.hadCommandFailure = true;
        s.hadSubsequentCommandSuccess = false;
      } else if (s.hadCommandFailure && s.fileEditCounts.size > 0) {
        s.hadSubsequentCommandSuccess = true;
      }
    }
  }

  /**
   * Evaluates accumulated session signals; if qualified, writes a durable job to
   * `~/.dsh/accremind/queue/` without blocking the active turn (L2 Iron Law).
   */
  checkAndEnqueueSession(sessionId: string): {
    signalResult: SignalDetectionResult;
    enqueuedJob: QueuedCaptureJob | null;
  } {
    const s = this.getSession(sessionId);
    let maxEdits = 0;
    for (const c of s.fileEditCounts.values()) {
      if (c > maxEdits) maxEdits = c;
    }

    const snapshot: SessionSignalSnapshot = {
      userMessages: s.userMessages,
      assistantMessages: s.assistantMessages,
      editedFiles: [...s.fileEditCounts.keys()],
      hadCommandFailure: s.hadCommandFailure,
      hadSubsequentCommandSuccess: s.hadSubsequentCommandSuccess,
      totalToolCalls: s.totalToolCalls,
      maxEditsOnSingleFile: maxEdits,
    };

    const signalResult = evaluateSessionSignals(snapshot);
    if (!signalResult.shouldCapture || s.capturedInSession) {
      return { signalResult, enqueuedJob: null };
    }

    s.capturedInSession = true;
    const contextSummary = [
      `触发信号: ${signalResult.strongSignals.join(', ') || signalResult.weakReasons.join(', ')}`,
      `用户关键输入:\n${s.userMessages.slice(-4).join('\n---\n')}`,
      `助手排障与结论摘要:\n${s.assistantMessages.slice(-3).join('\n---\n')}`,
    ].join('\n\n');

    const job = this.enqueueJob({
      sessionId,
      sourceType: 'session_turn',
      sourceRef: sessionId,
      touchedFiles: snapshot.editedFiles,
      rawCandidateContext: contextSummary,
    });

    return { signalResult, enqueuedJob: job };
  }

  enqueueJob(input: {
    sessionId: string;
    sourceType: 'session_turn' | 'git_commit';
    sourceRef: string;
    touchedFiles: string[];
    rawCandidateContext: string;
  }): QueuedCaptureJob {
    const job: QueuedCaptureJob = {
      jobId: `JOB-${Date.now()}-${randomUUID().slice(0, 6)}`,
      sessionId: input.sessionId,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      touchedFiles: input.touchedFiles,
      rawCandidateContext: input.rawCandidateContext,
      attempts: 0,
      lastError: null,
      nextRetryAtMs: 0,
      createdAtIso: new Date().toISOString(),
    };

    const jobPath = path.join(this.store.paths.queueDir, `${job.jobId}.json`);
    writeFileAtomicSync(jobPath, `${JSON.stringify(job, null, 2)}\n`);
    return job;
  }

  listQueuedJobs(): QueuedCaptureJob[] {
    this.pruneExpiredQueueJobs();
    if (!fs.existsSync(this.store.paths.queueDir)) return [];
    return fs
      .readdirSync(this.store.paths.queueDir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort()
      .map((f) => {
        const raw = fs.readFileSync(path.join(this.store.paths.queueDir, f), 'utf8');
        return JSON.parse(raw) as QueuedCaptureJob;
      });
  }

  deleteQueuedJob(jobId: string): boolean {
    const p = path.join(this.store.paths.queueDir, `${jobId}.json`);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      return true;
    }
    return false;
  }

  /**
   * Enforces PRD §9.4 & §10.2: Unsent/pending local queue items expire after 7 days.
   */
  pruneExpiredQueueJobs(nowMs = Date.now()): number {
    if (!fs.existsSync(this.store.paths.queueDir)) return 0;
    let pruned = 0;
    for (const file of fs.readdirSync(this.store.paths.queueDir)) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      const fullPath = path.join(this.store.paths.queueDir, file);
      try {
        const job = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as QueuedCaptureJob;
        if (nowMs - Date.parse(job.createdAtIso) > SEVEN_DAYS_MS) {
          fs.unlinkSync(fullPath);
          pruned += 1;
        }
      } catch {
        // leave malformed file untouched
      }
    }
    return pruned;
  }

  /**
   * Drains eligible queued jobs via `EvidenceCollector -> DeltaAssessor -> TriageEngine`.
   * Transient LLM failures apply exponential backoff + jitter up to 5 attempts (PRD §9.4).
   */
  async processPendingQueue(nowMs = Date.now()): Promise<SingleTriageOutcome[]> {
    if (this.draining || !this.llm) return [];
    this.draining = true;
    const outcomes: SingleTriageOutcome[] = [];

    try {
      const assessor = new DeltaAssessor({
        llm: this.llm,
        workspaceId: this.store.workspaceId,
      });

      const jobs = this.listQueuedJobs();
      for (const job of jobs) {
        if (job.attempts >= MAX_AUTO_RETRIES) continue;
        if (job.nextRetryAtMs > nowMs) continue;

        const jobFile = path.join(this.store.paths.queueDir, `${job.jobId}.json`);
        try {
          const bundle = collectEvidenceBundle({
            repoRoot: this.store.paths.projectRoot,
            touchedFiles: job.touchedFiles,
            rawCandidateContext: job.rawCandidateContext,
            sourceType: job.sourceType,
            sourceRef: job.sourceRef,
          });

          const triagedInput = await assessor.assess(bundle, this.assessmentMode);
          const outcome = this.triageEngine.processCandidate(triagedInput);
          outcomes.push(outcome);

          if (fs.existsSync(jobFile)) {
            fs.unlinkSync(jobFile);
          }
        } catch (err) {
          const nextAttempts = job.attempts + 1;
          const jitter = Math.floor(Math.random() * 300);
          const backoff = Math.min(60_000, 1000 * 2 ** job.attempts) + jitter;
          const updatedJob: QueuedCaptureJob = {
            ...job,
            attempts: nextAttempts,
            lastError: err instanceof Error ? err.message : String(err),
            nextRetryAtMs: Date.now() + backoff,
          };
          writeFileAtomicSync(jobFile, `${JSON.stringify(updatedJob, null, 2)}\n`);
        }
      }
    } finally {
      this.draining = false;
    }

    return outcomes;
  }
}

function sessionIdFrom(raw: string): string {
  return raw.trim() || 'default-session';
}

/**
 * End-to-End Git Archaeology Cold-Start Pipeline (`accremind bootstrap --extract`):
 * Mines top high-signal historical commits, extracts code/doc evidence bundles, runs
 * `DeltaAssessor`, and pipes results through `TriageEngine`!
 */
export async function runArchaeologyBootstrap(options: {
  store: LocalMarkdownSqliteStore;
  triageEngine: TriageEngine;
  llm: LlmInferenceAdapter;
  mode?: 'single_pass' | 'isolated_p0';
  maxCommitsToScan?: number;
  topK?: number;
  commitShas?: string[];
}): Promise<{
  minedCommits: ArchaeologyCommitCandidate[];
  triageReport: BatchTriageReport;
}> {
  const scanned = scanGitHistorySignals({
    repoRoot: options.store.paths.projectRoot,
    maxCommitsToScan: options.maxCommitsToScan ?? 200,
    topK: options.topK ?? 10,
  });

  const selected = options.commitShas && new Set(options.commitShas);
  const minedCommits = selected ? scanned.filter((commit) => selected.has(commit.commitSha)) : scanned;
  if (selected && (selected.size === 0 || selected.size !== minedCommits.length)) {
    throw new Error('所选提交已不在当前扫描结果中，请重新扫描后选择');
  }
  const assessor = new DeltaAssessor({
    llm: options.llm,
    workspaceId: options.store.workspaceId,
  });

  const candidateInputs = [];
  for (const commit of minedCommits) {
    const rawContext = [
      `Commit: ${commit.commitSha} (${commit.committedAtIso})`,
      `Subject: ${commit.subject}`,
      commit.body ? `Body:\n${commit.body}` : '',
      `Signal Reasons: ${commit.signalReasons.join('; ')}`,
      `Patch Preview:\n${commit.diffPreview}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const bundle = collectEvidenceBundle({
      repoRoot: options.store.paths.projectRoot,
      touchedFiles: commit.touchedFiles,
      rawCandidateContext: rawContext,
      sourceType: 'git_commit',
      sourceRef: commit.commitSha.slice(0, 12),
    });

    const assessed = await assessor.assess(bundle, options.mode ?? 'single_pass');
    candidateInputs.push(assessed);
  }

  const triageReport = options.triageEngine.processBatch(candidateInputs);
  return { minedCommits, triageReport };
}
