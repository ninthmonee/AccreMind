import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const dateFmt = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}

/** “3 天前 / 12 天后”这类相对时间，用于时效提示。 */
export function relativeDays(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = Math.round((new Date(iso).getTime() - now) / 86_400_000);
  if (Number.isNaN(diff)) return '—';
  if (diff === 0) return '今天';
  return diff > 0 ? `${diff} 天后` : `${-diff} 天前`;
}

export function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

export function shortSha(sha: string): string {
  return /^[0-9a-f]{12,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}
