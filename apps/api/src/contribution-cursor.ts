import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrincipalContext } from '@accremind/domain';
import { canonicalJson } from './contribution-input.js';
import { invalidInput } from './contribution-errors.js';

export class ContributionCursor {
  constructor(private readonly key = randomBytes(32)) {}

  encode(
    ctx: PrincipalContext,
    scope: string | undefined,
    position: { date: string; id: string },
  ): string {
    const payload = Buffer.from(canonicalJson({ ctx, scope: scope ?? '', ...position })).toString(
      'base64url',
    );
    return `${payload}.${createHmac('sha256', this.key).update(payload).digest('base64url')}`;
  }

  decode(
    ctx: PrincipalContext,
    scope: string | undefined,
    token: string,
  ): { date: string; id: string } {
    const [payload, signature, ...extra] = token.split('.');
    if (!payload || !signature || extra.length || token.length > 1024)
      invalidInput('Invalid contribution cursor');
    const expected = createHmac('sha256', this.key).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      invalidInput('Invalid contribution cursor');
    let parsed: { ctx: PrincipalContext; scope: string; date: string; id: string };
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof parsed;
    } catch {
      invalidInput('Invalid contribution cursor');
    }
    if (
      !parsed ||
      canonicalJson(parsed.ctx) !== canonicalJson(ctx) ||
      parsed.scope !== (scope ?? '') ||
      typeof parsed.date !== 'string' ||
      !Number.isFinite(Date.parse(parsed.date)) ||
      typeof parsed.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(parsed.id)
    )
      invalidInput('Contribution cursor scope changed');
    return { date: parsed.date, id: parsed.id };
  }
}
