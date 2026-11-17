import * as path from 'node:path';

const BLOCKED_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx|keystore|jks)$/i,
  /(?:^|\/)id_(?:rsa|ed25519|ecdsa)$/i,
  /(?:^|\/)credentials(?:\.json|\.ya?ml)?$/i,
];

const SECRET_REGEXES: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'PrivateKeyBlock',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END [^-]+-----/g,
  },
  {
    name: 'BearerToken',
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi,
  },
  {
    name: 'VendorApiKey',
    pattern: /\b(?:sk|rk|pk|ghp|gho|github_pat|xoxb|xoxp|AKIA|AIza)[-_A-Za-z0-9]{16,}\b/g,
  },
  {
    name: 'DatabaseUriPassword',
    pattern: /\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:)([^@\s]+)(@)/gi,
  },
  {
    name: 'GenericSecretAssignment',
    pattern:
      /\b((?:api[_-]?key|secret|password|passwd|access[_-]?token|private[_-]?key)\s*[:=]\s*["']?)([^\s"',;]{8,})(["']?)/gi,
  },
];

export const MAX_CAPTURE_PAYLOAD_BYTES = 256 * 1024;

export function isSensitiveFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);
  if (normalized.includes('/.ssh/') || normalized.startsWith('~/.ssh/')) {
    return true;
  }
  return BLOCKED_FILE_PATTERNS.some((rx) => rx.test(base) || rx.test(normalized));
}

export interface RedactionResult {
  redactedText: string;
  redactedCount: number;
  matchedCategories: string[];
}

export function redactSensitiveText(input: string): RedactionResult {
  let text = input;
  let redactedCount = 0;
  const matched = new Set<string>();

  for (const { name, pattern } of SECRET_REGEXES) {
    pattern.lastIndex = 0;
    if (name === 'DatabaseUriPassword' || name === 'GenericSecretAssignment') {
      text = text.replace(pattern, (_full, prefix: string, _secret: string, suffix: string) => {
        redactedCount += 1;
        matched.add(name);
        return `${prefix}[REDACTED_SECRET]${suffix}`;
      });
    } else {
      text = text.replace(pattern, () => {
        redactedCount += 1;
        matched.add(name);
        return '[REDACTED_SECRET]';
      });
    }
  }

  return {
    redactedText: text,
    redactedCount,
    matchedCategories: [...matched],
  };
}

/**
 * Enforces the 256KB UTF-8 capture package limit (PRD §6.4), preserving head context and tail
 * error/verification trace rather than silently dropping preconditions at the end.
 */
export function enforceCapturePayloadLimit(text: string, maxBytes = MAX_CAPTURE_PAYLOAD_BYTES): {
  content: string;
  truncated: boolean;
} {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return { content: text, truncated: false };
  }

  const marker = '\n...[TRUNCATED_MIDDLE_TO_FIT_256KB_BUDGET]...\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const half = Math.floor((maxBytes - markerBytes) / 2);
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(buf.byteLength - half).toString('utf8');
  return {
    content: `${head}${marker}${tail}`,
    truncated: true,
  };
}
