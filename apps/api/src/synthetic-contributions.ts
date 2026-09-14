import { syntheticPrincipal } from '@accremind/domain';
import type { DevelopmentConfig } from '@accremind/domain';
import { PostgresAuthorizationService } from './authorization.js';
import type { TransactionPool } from './database.js';

export const syntheticReviewerId = '00000000-0000-4000-8000-000000000006';
export const syntheticRepoId = '00000000-0000-4000-8000-000000000004';
export const syntheticScopeId = '00000000-0000-4000-8000-000000000005';
export const syntheticCapabilities = [
  'knowledge:read',
  'knowledge:contribute',
  'evidence:read',
  'knowledge:assess',
  'knowledge:review',
  'knowledge:publish',
  'knowledge:validation-review',
  'knowledge:history',
  'config:read',
  'config:manage',
] as const;

export function syntheticContributionsEnabled(
  env: Record<string, string | undefined>,
  config: DevelopmentConfig,
): boolean {
  const flag = env.AKB_SYNTHETIC_CONTRIBUTIONS;
  if (flag && flag !== '0' && flag !== '1') throw new Error('Invalid AKB_SYNTHETIC_CONTRIBUTIONS');
  if (flag !== '1') return false;
  if (!config.databaseUrl)
    throw new Error('Synthetic contributions require a local synthetic database');
  const url = new URL(config.databaseUrl);
  if (
    url.pathname !== '/accremind_dev' ||
    decodeURIComponent(url.username) !== 'akb_api' ||
    decodeURIComponent(url.password) !== 'synthetic-only'
  )
    throw new Error('Synthetic contributions require the accremind_dev synthetic API role');
  return true;
}

export function syntheticContributionIdentity(pool: TransactionPool, actor = 'contributor') {
  if (!['contributor', 'reviewer'].includes(actor)) throw new Error('Invalid synthetic actor');
  const me = {
    ...syntheticPrincipal(),
    ...(actor === 'reviewer' ? { principal_id: syntheticReviewerId } : {}),
  };
  const ctx = { tenantId: me.tenant_id, actorId: me.principal_id, authzVersion: me.authz_version };
  const auth = new PostgresAuthorizationService(pool);
  return {
    resolvePrincipal: async () => ({ ...ctx }),
    getPrincipal: async () => {
      const capabilities: string[] = [];
      for (const capability of syntheticCapabilities)
        if ((await auth.allowedScopes(ctx, capability)).has(syntheticScopeId))
          capabilities.push(capability);
      return { ...me, capabilities };
    },
  };
}
