import type { SchemaTypes } from '@accremind/contracts';
export interface PrincipalContext {
  tenantId: string;
  actorId: string;
  authzVersion: number;
}
export interface VersionBinding {
  candidateRevision: number;
  assessmentRevision: number;
  evidenceSetHash: string;
  expectedTargetRevision?: number;
}
export interface LeasedJob {
  id: string;
  generation: number;
  leaseOwner: string;
}
export interface ContentRef {
  commit: string;
  path: string;
  hash: string;
}
export interface AuthorizationService {
  allowedScopes(ctx: PrincipalContext, capability: string): Promise<ReadonlySet<string>>;
  assertEvidenceReadable(
    ctx: PrincipalContext,
    refs: readonly SchemaTypes['EvidenceRef'][],
  ): Promise<void>;
}
export interface AssessmentService {
  saveHumanCheck(
    ctx: PrincipalContext,
    input: SchemaTypes['AssessmentWrite'],
  ): Promise<SchemaTypes['AssessmentRecord']>;
}
export interface PublicationService {
  request(
    ctx: PrincipalContext,
    candidateId: string,
    input: SchemaTypes['PublishRequest'],
  ): Promise<SchemaTypes['PublishResult']>;
  activate(job: LeasedJob, binding: VersionBinding, contentRef: string): Promise<void>;
}
export interface ContentStore {
  writeImmutable(tenantId: string, publicationId: string, body: string): Promise<ContentRef>;
  read(tenantId: string, ref: ContentRef): Promise<string>;
}
export interface DevelopmentConfig {
  mode: 'synthetic';
  host: '127.0.0.1' | '::1';
  port: number;
  databaseUrl: string | undefined;
}
export function loadDevelopmentConfig(env: Record<string, string | undefined>): DevelopmentConfig {
  if (env.NODE_ENV === 'production')
    throw new Error('Production deployment is disabled until authentication is implemented');
  const mode = env.AKB_MODE ?? 'synthetic';
  if (mode !== 'synthetic')
    throw new Error('Production authentication is not implemented; refuse startup');
  const host = env.HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1')
    throw new Error('Synthetic identity requires loopback binding');
  const port = Number(env.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const databaseUrl = env.DATABASE_URL || undefined;
  if (databaseUrl) {
    if (!URL.canParse(databaseUrl)) throw new Error('Invalid DATABASE_URL');
    const parsed = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    )
      throw new Error('Synthetic database must be a loopback PostgreSQL instance');
  }
  if (env.MODEL_ENDPOINT || env.MODEL_ID)
    throw new Error('Model integration is disabled in the engineering scaffold');
  return { mode, host, port, databaseUrl };
}
export function syntheticPrincipal(): SchemaTypes['Me'] {
  return {
    tenant_id: '00000000-0000-4000-8000-000000000001',
    principal_id: '00000000-0000-4000-8000-000000000002',
    authz_version: 1,
    capabilities: [],
  };
}
/** SIGINT and SIGTERM may arrive together when a launcher stops its children. */
export function createShutdown(cleanup: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= Promise.resolve().then(cleanup));
}
