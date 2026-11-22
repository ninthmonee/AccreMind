import { randomBytes } from 'node:crypto';

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Coordination-free entry IDs: `K-` + 8 time chars (base36 ms) + 6 random chars (~2.2 billion per millisecond).
 * Sortable by creation time and safe across branches, machines and teammates.
 * Legacy 4–6 digit IDs stay valid for existing repositories.
 */
export function generateEntryId(prefix: 'K' | 'R' | 'P' = 'K', now = Date.now()): string {
  const time = now.toString(36).toUpperCase().padStart(8, '0').slice(-8);
  const bytes = randomBytes(6);
  let rand = '';
  for (const b of bytes) rand += BASE36[b % 36];
  return `${prefix}-${time}${rand}`;
}

export const ENTRY_ID_PATTERN = /^(K|R|P)-(\d{4,6}|[0-9A-Z]{14})$/;
