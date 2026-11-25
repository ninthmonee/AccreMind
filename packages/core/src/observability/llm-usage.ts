import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LlmInferenceAdapter, LlmCompletionRequest, LlmCompletionResponse } from '../capture/llm-client.ts';

/** Which part of the product spent the tokens: topic tagging, capture/extraction, or anything else. */
export type LlmCallKind = 'tag' | 'capture' | 'other';

export interface LlmUsageRecord {
  at: string;
  kind: LlmCallKind;
  calls: number;
  tokens: number;
  model?: string;
}

export interface LlmUsageSummary {
  since: string;
  until: string;
  calls: number;
  tokens: number;
  /** Calls that reported no token count (some host adapters do not) — kept visible instead of counted as zero cost. */
  callsWithoutTokens: number;
  byKind: Record<string, { calls: number; tokens: number }>;
  byDay: Array<{ day: string; calls: number; tokens: number }>;
}

/**
 * Append-only counter for the model calls AccreMind makes on its own. Automatic extraction and topic tagging are
 * the only features that spend tokens; this file answers "how many calls, how many tokens" without a dashboard.
 * One JSON object per line under `<global>/usage/llm-usage.jsonl`; a write never breaks a turn.
 */
export class LlmUsageMeter {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  record(record: { kind: LlmCallKind; calls?: number; tokens?: number; model?: string; now?: Date }): void {
    const entry: LlmUsageRecord = {
      at: (record.now ?? new Date()).toISOString(),
      kind: record.kind,
      calls: record.calls ?? 1,
      tokens: Math.max(0, Math.round(record.tokens ?? 0)),
      ...(record.model ? { model: record.model } : {}),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Usage counting is diagnostic: a full disk or a read-only home must never fail a capture or a turn.
    }
  }

  read(days = 7, now: Date = new Date()): LlmUsageSummary {
    const windowDays = Math.max(1, Math.min(365, Math.floor(days)));
    const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
    const summary: LlmUsageSummary = {
      since, until: now.toISOString(), calls: 0, tokens: 0, callsWithoutTokens: 0, byKind: {}, byDay: [],
    };
    if (!fs.existsSync(this.file)) return summary;
    const days_ = new Map<string, { calls: number; tokens: number }>();
    for (const line of fs.readFileSync(this.file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec: LlmUsageRecord;
      try {
        rec = JSON.parse(line) as LlmUsageRecord;
      } catch {
        continue;
      }
      if (!rec.at || rec.at < since || rec.at > summary.until) continue;
      const calls = Number(rec.calls) || 0;
      const tokens = Number(rec.tokens) || 0;
      summary.calls += calls;
      summary.tokens += tokens;
      if (tokens === 0) summary.callsWithoutTokens += calls;
      const kind = summary.byKind[rec.kind] ?? { calls: 0, tokens: 0 };
      kind.calls += calls;
      kind.tokens += tokens;
      summary.byKind[rec.kind] = kind;
      const day = rec.at.slice(0, 10);
      const bucket = days_.get(day) ?? { calls: 0, tokens: 0 };
      bucket.calls += calls;
      bucket.tokens += tokens;
      days_.set(day, bucket);
    }
    summary.byDay = [...days_.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day));
    return summary;
  }
}

/**
 * Wraps an inference adapter so every call lands in the meter. The caller labels the kind, because the adapter
 * itself cannot tell a topic tag from an extraction.
 */
export function meterLlm(adapter: LlmInferenceAdapter, meter: LlmUsageMeter, kind: LlmCallKind, model?: string): LlmInferenceAdapter {
  return {
    async completeJson(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
      try {
        const res = await adapter.completeJson(req);
        meter.record({ kind, tokens: res.tokenUsed, ...(model ? { model } : {}) });
        return res;
      } catch (error) {
        meter.record({ kind, tokens: 0, ...(model ? { model } : {}) });
        throw error;
      }
    },
  };
}
