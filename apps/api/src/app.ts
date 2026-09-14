import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AnySchema } from 'ajv';
import { assertSchema, compileSchema, getValidator } from '@accremind/contracts';
import type { ErrorEnvelope, SchemaTypes } from '@accremind/contracts';
import { syntheticPrincipal } from '@accremind/domain';
import type { DevelopmentConfig } from '@accremind/domain';
import type { PrincipalContext } from '@accremind/domain';
import type { PostgresContributionService } from './contributions.js';
import { registerContributionRoutes } from './contribution-routes.js';
import { ContributionError } from './contribution-errors.js';
import { AccessDeniedError } from './database.js';
import type { PostgresAssessmentService } from './assessments.js';
import { registerAssessmentRoutes } from './assessment-routes.js';
import type { PostgresGovernanceService } from './governance.js';
import type { PostgresKnowledgeGovernance } from './knowledge-governance.js';
import { registerGovernanceRoutes } from './governance-routes.js';
import type { PostgresRetrievalService } from './retrieval.js';
import { registerRetrievalRoutes } from './retrieval-routes.js';
import { registerValidationRoutes } from './validation-routes.js';
import type { PostgresValidationService } from './validations.js';
import type { PostgresConfigurationService } from './configurations.js';
import { registerConfigurationRoutes } from './configuration-routes.js';
export interface Dependencies {
  checkDatabase: () => Promise<boolean>;
  contributions?: PostgresContributionService;
  assessments?: PostgresAssessmentService;
  governance?: PostgresGovernanceService;
  knowledge?: PostgresKnowledgeGovernance;
  retrieval?: PostgresRetrievalService;
  validations?: PostgresValidationService;
  configurations?: PostgresConfigurationService;
  resolvePrincipal?: () => Promise<PrincipalContext | undefined>;
  getPrincipal?: () => Promise<SchemaTypes['Me']>;
}
export function createApp(config: DevelopmentConfig, dependencies: Dependencies) {
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });
  app.setValidatorCompiler(({ schema }) => compileSchema(schema as AnySchema));
  app.setSerializerCompiler(({ schema }) => {
    const validate = compileSchema(schema as AnySchema);
    return (value) => {
      if (!validate(value)) throw new Error('Response contract mismatch');
      return JSON.stringify(value);
    };
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-ID', request.id).header('Cache-Control', 'no-store');
    if (request.headers.authorization || request.headers.cookie) {
      const error: ErrorEnvelope = {
        request_id: request.id,
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Synthetic mode does not accept real credentials',
          retryable: false,
          details: [],
        },
      };
      return reply.code(401).send(error);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const oversized = error instanceof Error && 'statusCode' in error && error.statusCode === 413;
    const invalid =
      error instanceof Error && 'validation' in error && Array.isArray(error.validation);
    const known = error instanceof ContributionError;
    const inaccessible = error instanceof AccessDeniedError;
    const malformed = error instanceof Error && 'statusCode' in error && error.statusCode === 400;
    const status = known
      ? error.statusCode
      : inaccessible
        ? 404
        : oversized
          ? 413
          : invalid || malformed
            ? 400
            : 503;
    const envelope: ErrorEnvelope = {
      request_id: request.id,
      error: {
        code: known
          ? error.code
          : inaccessible
            ? 'NOT_FOUND_OR_INACCESSIBLE'
            : status === 413
              ? 'PAYLOAD_TOO_LARGE'
              : status === 400
                ? 'INVALID_INPUT'
                : 'TEMPORARILY_UNAVAILABLE',
        message: known
          ? error.message
          : inaccessible
            ? 'Resource is unavailable'
            : status === 400
              ? 'Request contract mismatch'
              : 'Request could not be completed',
        retryable: status === 503,
        details: [],
      },
    };
    assertSchema('Error', envelope);
    void reply.code(status).send(envelope);
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      request_id: request.id,
      error: {
        code: 'NOT_FOUND_OR_INACCESSIBLE',
        message: 'Resource is unavailable',
        retryable: false,
        details: [],
      },
    } satisfies ErrorEnvelope);
  });
  app.get('/healthz', async () => ({
    status: 'ok',
    mode: config.mode,
    stage: 'engineering-scaffold',
  }));
  app.get('/readyz', async (_request, reply) => {
    let database: boolean;
    try {
      database = await dependencies.checkDatabase();
    } catch {
      database = false;
    }
    if (!database)
      return reply
        .code(503)
        .send({ status: 'not_ready', database: 'unavailable', stage: 'engineering-scaffold' });
    return {
      status: 'ready',
      database: 'connected',
      mode: config.mode,
      business_capabilities: dependencies.configurations
        ? 'synthetic_versioned_configuration'
        : dependencies.validations
          ? 'synthetic_independent_validation'
          : dependencies.retrieval
            ? 'synthetic_authorized_retrieval'
            : dependencies.governance
              ? 'synthetic_review_publication'
              : dependencies.assessments
                ? 'synthetic_human_assessment'
                : dependencies.contributions
                  ? 'synthetic_contribution_receive'
                  : 'not_implemented',
    };
  });
  app.get('/api/v1/me', async (request) => {
    const data = dependencies.getPrincipal
      ? await dependencies.getPrincipal()
      : syntheticPrincipal();
    if (!getValidator('Me')(data)) throw new Error('Synthetic principal mismatch');
    return { request_id: request.id, data };
  });
  registerConfigurationRoutes(
    app,
    dependencies.configurations,
    dependencies.resolvePrincipal ?? (async () => undefined),
  );
  registerValidationRoutes(
    app,
    dependencies.validations,
    dependencies.resolvePrincipal ?? (async () => undefined),
  );
  registerContributionRoutes(
    app,
    dependencies.contributions,
    dependencies.resolvePrincipal ?? (async () => undefined),
  );
  registerAssessmentRoutes(
    app,
    dependencies.assessments,
    dependencies.resolvePrincipal ?? (async () => undefined),
    dependencies.governance,
  );
  registerGovernanceRoutes(
    app,
    dependencies.governance,
    dependencies.knowledge,
    dependencies.resolvePrincipal ?? (async () => undefined),
  );
  registerRetrievalRoutes(
    app,
    dependencies.retrieval,
    dependencies.resolvePrincipal ?? (async () => undefined),
  );
  return app;
}
