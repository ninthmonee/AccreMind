import type { SchemaTypes } from '@accremind/contracts';

/** Counts a matching set of independent task, submitter and proof identities, not raw event volume. */
export function validationMaturity(
  proofs: readonly { task: string; actor: string; repo: string; proof: string }[],
  crossProject: boolean,
): SchemaTypes['Maturity'] {
  if (!proofs.length) return 'draft';
  for (let i = 0; i < proofs.length; i++)
    for (let j = i + 1; j < proofs.length; j++) {
      const a = proofs[i]!,
        b = proofs[j]!;
      if (
        a.task !== b.task &&
        a.actor !== b.actor &&
        a.proof !== b.proof &&
        (!crossProject || a.repo !== b.repo)
      )
        return 'proven';
    }
  return 'verified';
}

/** A plain suite/build command contains no conclusion-specific method. Detailed human methods are reviewed independently. */
export function genericMethod(method: string) {
  return /^(?:(?:npm|pnpm|yarn)(?: run)? (?:build|test)|make(?: (?:test|build))?|(?:整体|全量|全部)(?:构建|测试)(?:通过|成功)?|all tests passed|build passed)$/i.test(
    method.trim(),
  );
}
