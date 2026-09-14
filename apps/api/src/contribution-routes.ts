import type { FastifyInstance } from 'fastify';
import type { PrincipalContext } from '@accremind/domain';
import type { SchemaTypes } from '@accremind/contracts';
import type { PostgresContributionService } from './contributions.js';
import { ContributionError } from './contribution-errors.js';

export const schema = (name: string) => ({ $ref: `urn:accremind:contracts:v2#/$defs/${name}` });
export const uuid = { type: 'string', format: 'uuid' };
export const idParams = {
  type: 'object',
  additionalProperties: false,
  properties: { id: uuid },
  required: ['id'],
};
export const envelope = (name: string) => ({
  type: 'object',
  additionalProperties: false,
  properties: { request_id: uuid, data: schema(name) },
  required: ['request_id', 'data'],
});

/** resolvePrincipal is server-owned, never derived from caller-supplied headers/JSON.
 * Until real login exists main.ts only supplies an explicitly opted-in fixed synthetic identity.
 */
export function registerContributionRoutes(
  app: FastifyInstance,
  service: PostgresContributionService | undefined,
  resolvePrincipal: () => Promise<PrincipalContext | undefined>,
) {
  async function context() {
    const ctx = await resolvePrincipal();
    if (!ctx)
      throw new ContributionError(
        'UNAUTHENTICATED',
        401,
        'Contribution access requires an enabled synthetic development identity',
      );
    if (!service)
      throw new ContributionError(
        'TEMPORARILY_UNAVAILABLE',
        503,
        'Contribution storage is unavailable',
      );
    return ctx;
  }
  app.post<{ Body: SchemaTypes['TaskCreate'] }>(
    '/api/v1/tasks',
    { schema: { body: schema('TaskCreate'), response: { 201: envelope('Task') } } },
    async (request, reply) => {
      const ctx = await context();
      return reply
        .code(201)
        .send({ request_id: request.id, data: await service!.createTask(ctx, request.body) });
    },
  );
  app.post(
    '/api/v1/contributions',
    { schema: { body: schema('IngestRequest'), response: { 202: envelope('IngestResult') } } },
    async (request, reply) => {
      const ctx = await context();
      const data = await service!.ingest(ctx, request.body);
      return reply.code(202).send({ request_id: request.id, data });
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/v1/contributions/:id',
    { schema: { params: idParams, response: { 200: envelope('Contribution') } } },
    async (request) => {
      const ctx = await context();
      return { request_id: request.id, data: await service!.get(ctx, request.params.id) };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { revision: string } }>(
    '/api/v1/evidence/:id',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { revision: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } },
          required: ['revision'],
        },
        response: { 200: envelope('Evidence') },
      },
    },
    async (request) => {
      const ctx = await context();
      return {
        request_id: request.id,
        data: await service!.getEvidence(ctx, request.params.id, Number(request.query.revision)),
      };
    },
  );
  app.get<{ Querystring: { cursor?: string; limit?: string; scope_id?: string } }>(
    '/api/v1/contributions',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cursor: { type: 'string', minLength: 1, maxLength: 1024 },
            limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
            scope_id: uuid,
          },
        },
        response: { 200: envelope('ContributionPage') },
      },
    },
    async (request) => {
      const ctx = await context();
      return {
        request_id: request.id,
        data: await service!.list(ctx, {
          ...request.query,
          limit: Number(request.query.limit ?? 20),
        }),
      };
    },
  );
}
