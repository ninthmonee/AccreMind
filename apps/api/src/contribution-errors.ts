import type { ErrorEnvelope } from '@accremind/contracts';

export class ContributionError extends Error {
  constructor(
    readonly code: ErrorEnvelope['error']['code'],
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function invalidInput(message: string): never {
  throw new ContributionError('INVALID_INPUT', 400, message);
}

export function conflict(): never {
  throw new ContributionError('IDEMPOTENCY_CONFLICT', 409, 'Operation or source event conflicts');
}
