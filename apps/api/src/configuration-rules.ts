import type { SchemaTypes } from '@accremind/contracts';
import { canonicalJson } from './contribution-input.js';
import { invalidInput } from './contribution-errors.js';
import { versionMatches } from './retrieval-rules.js';

export function stableHostVersion(value: string): boolean {
  if (!/^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) return false;
  return value
    .replace(/^v/, '')
    .split('.')
    .every((part) => Number.isSafeInteger(Number(part)));
}
export function compatibleHost(actual: string, minimum: string): boolean {
  return (
    stableHostVersion(actual) &&
    stableHostVersion(minimum) &&
    versionMatches(actual, `>=${minimum}`) === true
  );
}
/** Keep the complete structured rule, including conditions, exceptions and evidence, as inert text. */
export function mandatoryRuleText(body: SchemaTypes['CandidateBody']): string {
  const text = canonicalJson(body);
  if (text.length > 16000)
    invalidInput('A complete mandatory rule exceeds the configuration text limit');
  return text;
}
