import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AnySchema } from 'ajv';
import { assertSchema, compileSchema, getValidator } from '@accremind/contracts';
import type { ErrorEnvelope } from '@accremind/contracts';
import { syntheticPrincipal } from '@accremind/domain';
import type { DevelopmentConfig } from '@accremind/domain';
export interface Dependencies {
  checkDatabase: () => Promise<boolean>;
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
    const status = oversized ? 413 : invalid ? 400 : 503;
    const envelope: ErrorEnvelope = {
      request_id: request.id,
      error: {
        code:
          status === 413
            ? 'PAYLOAD_TOO_LARGE'
            : status === 400
              ? 'INVALID_INPUT'
              : 'TEMPORARILY_UNAVAILABLE',
        message: status === 400 ? 'Request contract mismatch' : 'Request could not be completed',
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
      business_capabilities: 'not_implemented',
    };
  });
  app.get('/api/v1/me', async (request) => {
    const data = syntheticPrincipal();
    if (!getValidator('Me')(data)) throw new Error('Synthetic principal mismatch');
    return { request_id: request.id, data };
  });
  return app;
}
