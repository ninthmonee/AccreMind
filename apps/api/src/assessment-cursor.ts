import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrincipalContext } from '@accremind/domain';
import { canonicalJson } from './contribution-input.js';
import { invalidInput } from './contribution-errors.js';

type Position = { rank: number; date: string; id: string };
export class AssessmentCursor {
  constructor(private readonly maxRank = 3) {}
  private readonly key = randomBytes(32);
  encode(ctx: PrincipalContext, filter: unknown, position: Position): string {
    const payload = Buffer.from(
      canonicalJson({
        ctx,
        filter,
        position: { rank: position.rank, date: position.date, id: position.id },
      }),
    ).toString('base64url');
    return `${payload}.${createHmac('sha256', this.key).update(payload).digest('base64url')}`;
  }
  decode(ctx: PrincipalContext, filter: unknown, token: string): Position {
    const [payload, signature, ...extra] = token.split('.');
    if (!payload || !signature || extra.length || token.length > 1024)
      invalidInput('Invalid assessment cursor');
    const expected = createHmac('sha256', this.key).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      invalidInput('Invalid assessment cursor');
    let value: { ctx: PrincipalContext; filter: unknown; position: Position };
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof value;
    } catch {
      invalidInput('Invalid assessment cursor');
    }
    if (
      !value ||
      canonicalJson(value.ctx) !== canonicalJson(ctx) ||
      canonicalJson(value.filter) !== canonicalJson(filter) ||
      !value.position ||
      !Number.isSafeInteger(value.position.rank) ||
      value.position.rank < 0 ||
      value.position.rank > this.maxRank ||
      typeof value.position.date !== 'string' ||
      !Number.isFinite(Date.parse(value.position.date)) ||
      typeof value.position.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.position.id)
    )
      invalidInput('Assessment cursor context changed');
    return value.position;
  }
}
