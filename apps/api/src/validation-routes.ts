import type { FastifyInstance } from 'fastify';
import type { PrincipalContext } from '@accremind/domain';
import type { SchemaTypes } from '@accremind/contracts';
import { ContributionError } from './contribution-errors.js';
import { schema, envelope, idParams } from './contribution-routes.js';
import type { PostgresValidationService } from './validations.js';

export function registerValidationRoutes(
  app: FastifyInstance,
  service: PostgresValidationService | undefined,
  resolve: () => Promise<PrincipalContext | undefined>,
) {
  async function context() {
    const ctx = await resolve();
    if (!ctx)
      throw new ContributionError(
        'UNAUTHENTICATED',
        401,
        'Validation requires an enabled synthetic identity',
      );
    if (!service)
      throw new ContributionError(
        'TEMPORARILY_UNAVAILABLE',
        503,
        'Validation storage is unavailable',
      );
    return ctx;
  }
  app.post<{ Body: SchemaTypes['UsageRequest'] }>(
    '/api/v1/usage-events',
    { schema: { body: schema('UsageRequest'), response: { 200: envelope('EventResult') } } },
    async (request) => {
      const ctx = await context();
      return { request_id: request.id, data: await service!.usage(ctx, request.body) };
    },
  );
  app.post<{ Body: SchemaTypes['FeedbackRequest'] }>(
    '/api/v1/feedback',
    { schema: { body: schema('FeedbackRequest'), response: { 200: envelope('EventResult') } } },
    async (request) => {
      const ctx = await context();
      return { request_id: request.id, data: await service!.feedback(ctx, request.body) };
    },
  );
  app.post<{ Body: SchemaTypes['ValidationRequest'] }>(
    '/api/v1/validations',
    { schema: { body: schema('ValidationRequest'), response: { 202: envelope('Validation') } } },
    async (request, reply) => {
      const ctx = await context();
      return reply
        .code(202)
        .send({ request_id: request.id, data: await service!.submit(ctx, request.body) });
    },
  );
  app.post<{ Params: { id: string }; Body: SchemaTypes['ValidationReview'] }>(
    '/api/v1/validations/:id/review',
    {
      schema: {
        params: idParams,
        body: schema('ValidationReview'),
        response: { 200: envelope('Validation') },
      },
    },
    async (request) => {
      const ctx = await context();
      return {
        request_id: request.id,
        data: await service!.review(ctx, request.params.id, request.body),
      };
    },
  );
  app.get<{ Querystring: { scope_id?: string; limit?: string; cursor?: string } }>(
    '/api/v1/validations',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope_id: { type: 'string', format: 'uuid' },
            limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
            cursor: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
        response: { 200: envelope('ValidationPage') },
      },
    },
    async (request) => {
      const ctx = await context();
      return {
        request_id: request.id,
        data: await service!.list(ctx, {
          ...(request.query.scope_id === undefined ? {} : { scope_id: request.query.scope_id }),
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
          ...(request.query.limit === undefined ? {} : { limit: Number(request.query.limit) }),
        }),
      };
    },
  );
}
