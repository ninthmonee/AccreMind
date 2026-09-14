import { assertSchema } from '@accremind/contracts';
import type { SchemaTypes } from '@accremind/contracts';
import { ContributionError, invalidInput } from './contribution-errors.js';
import { sha256 } from './evidence-store.js';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

// Defense in depth for explicit selected input; this is not a universal DLP guarantee.
const secrets =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\b(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token)\s*[=:]\s*["']?[^\s"',;]{4,}/i;

export function assertSelectedInputSafe(item: unknown): void {
  if (typeof item === 'string' && secrets.test(item))
    invalidInput('Sensitive content must be removed before submission');
  if (Array.isArray(item)) item.forEach(assertSelectedInputSafe);
  else if (item !== null && typeof item === 'object')
    Object.entries(item).forEach(([key, value]) => {
      assertSelectedInputSafe(key);
      assertSelectedInputSafe(value);
    });
}

export function validateContribution(value: unknown): SchemaTypes['IngestRequest'] {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 256 * 1024)
    throw new ContributionError('PAYLOAD_TOO_LARGE', 413, 'Contribution exceeds 256KB');
  try {
    assertSchema('IngestRequest', value);
  } catch {
    invalidInput('Contribution does not match the shared contract');
  }
  // Freeze a JSON snapshot before any await, including caller-owned nested arrays.
  const input = JSON.parse(serialized) as SchemaTypes['IngestRequest'];
  if (new Set(input.evidence.map((item) => item.client_evidence_id)).size !== input.evidence.length)
    invalidInput('Duplicate client evidence identities');
  if (new Set(input.source_event_ids).size !== input.source_event_ids.length)
    invalidInput('Duplicate source event identities');
  assertSelectedInputSafe(input);
  for (const evidence of input.evidence) {
    if (sha256(evidence.content) !== evidence.sha256) invalidInput('Evidence checksum mismatch');
    let source: string;
    try {
      source = decodeURIComponent(evidence.source_ref).replaceAll('\\', '/');
    } catch {
      invalidInput('Invalid source reference');
    }
    if (
      /(?:^|\/)(?:\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.claude|\.env(?:\.[^/]*)?)(?:\/|$)|^(?:~\/|\/Users\/|\/home\/)|(?:^|[/:])personal(?:\/|:|$)/i.test(
        source,
      )
    )
      invalidInput('Personal or credential sources are excluded');
    if (URL.canParse(source)) {
      const url = new URL(source);
      if (url.username || url.password)
        invalidInput('Source references cannot contain credentials');
    }
  }
  return input;
}

export function candidateEvidence(
  body: SchemaTypes['CandidateBody'],
): SchemaTypes['EvidenceRef'][] {
  return [
    ...body.rationale.evidence_refs,
    ...body.alternatives.flatMap((item) => item.rejection_reason.evidence_refs),
    ...(body.mirror ? [body.mirror.authority_ref] : []),
  ];
}
