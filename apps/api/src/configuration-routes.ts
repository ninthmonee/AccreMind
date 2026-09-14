import type { FastifyInstance } from 'fastify';
import type { PrincipalContext } from '@accremind/domain';
import type { SchemaTypes } from '@accremind/contracts';
import { ContributionError } from './contribution-errors.js';
import { schema, envelope, idParams } from './contribution-routes.js';
import type { PostgresConfigurationService } from './configurations.js';

export function registerConfigurationRoutes(
  app: FastifyInstance,
  service: PostgresConfigurationService | undefined,
  resolve: () => Promise<PrincipalContext | undefined>,
) {
  async function context() {
    const ctx = await resolve();
    if (!ctx)
      throw new ContributionError(
        'UNAUTHENTICATED',
        401,
        'Configuration requires an enabled synthetic identity',
      );
    if (!service)
      throw new ContributionError(
        'TEMPORARILY_UNAVAILABLE',
        503,
        'Configuration storage unavailable',
      );
    return ctx;
  }
  app.get<{
    Querystring: { repo_id: string; client_version: string; current_config_version?: string };
  }>(
    '/api/v1/config',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['repo_id', 'client_version'],
          properties: {
            repo_id: { type: 'string', format: 'uuid' },
            client_version: { type: 'string', minLength: 1, maxLength: 64 },
            current_config_version: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
          },
        },
        response: { 200: envelope('Config') },
      },
    },
    async (request) => {
      const ctx = await context();
      return {
        request_id: request.id,
        data: await service!.get(ctx, {
          repo_id: request.query.repo_id,
          client_version: request.query.client_version,
          ...(request.query.current_config_version === undefined
            ? {}
            : { current_config_version: Number(request.query.current_config_version) }),
        }),
      };
    },
  );
  app.get<{ Querystring: { scope_id?: string; cursor?: string; limit?: string } }>(
    '/api/v1/config/versions',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope_id: { type: 'string', format: 'uuid' },
            cursor: { type: 'string', minLength: 1, maxLength: 1024 },
            limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
          },
        },
        response: { 200: envelope('ConfigPage') },
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
  app.post<{ Body: SchemaTypes['ConfigWrite'] }>(
    '/api/v1/config/versions',
    { schema: { body: schema('ConfigWrite'), response: { 201: envelope('Config') } } },
    async (request, reply) => {
      const ctx = await context();
      return reply
        .code(201)
        .send({ request_id: request.id, data: await service!.create(ctx, request.body) });
    },
  );
  app.post<{ Params: { id: string }; Body: SchemaTypes['Mutation'] }>(
    '/api/v1/config/:id/activate',
    {
      schema: { params: idParams, body: schema('Mutation'), response: { 200: envelope('Config') } },
    },
    async (request) => {
      const ctx = await context();
      return {
        request_id: request.id,
        data: await service!.activate(ctx, request.params.id, request.body),
      };
    },
  );
}
