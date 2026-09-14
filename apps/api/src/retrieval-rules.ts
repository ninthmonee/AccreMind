import type { SchemaTypes } from '@accremind/contracts';
import type { TokenCounter } from '@accremind/domain';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export const indexVersion = 'zh-segmenter-exact-v1';
/** Segment Chinese and retain exact identifiers/paths as additional lexemes. Never build SQL from input. */
export function keywords(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const words = [...segmenter.segment(normalized)]
    .filter((s) => s.isWordLike)
    .map((s) => s.segment);
  const exact = normalized.match(/[a-z0-9_][a-z0-9_./:-]*/g) ?? [];
  return [...new Set([...words, ...exact])]
    .filter((w) => Buffer.byteLength(w) <= 256)
    .slice(0, 10000);
}
/** Conservative deterministic budget units: one UTF-8 byte per token, never a claimed model tokenizer. */
export class Utf8TokenCounter implements TokenCounter {
  readonly version = 'utf8-bytes-v1';
  count(text: string) {
    return Buffer.byteLength(text, 'utf8');
  }
}
type Version = [number, number, number];
function version(value: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return;
  const parts = match.slice(1).map(Number);
  if (parts.some((n) => !Number.isSafeInteger(n))) return;
  return parts as Version;
}
function compare(a: Version, b: Version) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
/** Bounded grammar: exact identifiers or stable numeric semver comparisons, ^, ~ and AND ranges.
 * Unknown range syntax is clarification, never guessed applicability.
 */
export function versionMatches(actual: string, range: string): boolean | undefined {
  if (actual === range || range === '*') return true;
  const a = version(actual);
  if (!a) return /^v?\d+\.\d+\.\d+$/.test(range) ? false : undefined;
  const terms = range.trim().split(/\s+/);
  if (!terms.length || terms.length > 10) return;
  let match = true;
  for (const term of terms) {
    const parsed = /^(\^|~|>=|<=|>|<|=)?(v?\d+\.\d+\.\d+)$/.exec(term);
    if (!parsed) return;
    const b = version(parsed[2]!);
    if (!b) return;
    const n = compare(a, b);
    let result: boolean;
    switch (parsed[1] ?? '=') {
      case '^': {
        const upper: Version =
          b[0] > 0 ? [b[0] + 1, 0, 0] : b[1] > 0 ? [0, b[1] + 1, 0] : [0, 0, b[2] + 1];
        result = n >= 0 && compare(a, upper) < 0;
        break;
      }
      case '~':
        result = n >= 0 && compare(a, [b[0], b[1] + 1, 0]) < 0;
        break;
      case '>=':
        result = n >= 0;
        break;
      case '<=':
        result = n <= 0;
        break;
      case '>':
        result = n > 0;
        break;
      case '<':
        result = n < 0;
        break;
      default:
        result = n === 0;
    }
    match = match && result;
  }
  return match;
}
export function applicability(
  body: SchemaTypes['CandidateBody'],
  environment: SchemaTypes['Environment'],
) {
  const questions: string[] = [];
  let mismatch = false;
  for (const c of body.context.dependency_constraints) {
    const actual = environment.dependencies[c.name];
    if (!actual) {
      questions.push(`请提供依赖 ${c.name} 的版本，以核对 ${c.version_range}`);
      continue;
    }
    const matches = versionMatches(actual, c.version_range);
    if (matches === undefined)
      questions.push(`依赖 ${c.name} 的范围 ${c.version_range} 需人工确认`);
    else if (!matches) mismatch = true;
  }
  return { matches: !mismatch && !questions.length, questions: mismatch ? [] : questions };
}
export function searchHit(
  detail: SchemaTypes['KnowledgeDetail'],
  reason: string,
): SchemaTypes['SearchHit'] {
  return {
    id: detail.id,
    revision: detail.content_revision,
    title: detail.body.title,
    claim: detail.body.claim,
    context: detail.body.context,
    scope: detail.body.scope,
    knowledge_delta: detail.knowledge_delta,
    rationale: detail.body.rationale,
    maturity: detail.maturity,
    freshness: detail.freshness,
    source_refs: detail.source_refs,
    match_reason: reason,
    truncated: false,
  };
}
