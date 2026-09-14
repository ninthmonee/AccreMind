import type { FastifyInstance } from 'fastify';
import type { SchemaTypes } from '@accremind/contracts';
import type { PrincipalContext } from '@accremind/domain';
import type { PostgresRetrievalService } from './retrieval.js';
import { ContributionError } from './contribution-errors.js';
import { schema, envelope } from './contribution-routes.js';

export function registerRetrievalRoutes(
  app: FastifyInstance,
  service: PostgresRetrievalService | undefined,
  resolve: () => Promise<PrincipalContext | undefined>,
) {
  async function context() {
    const ctx = await resolve();
    if (!ctx)
      throw new ContributionError(
        'UNAUTHENTICATED',
        401,
        'Retrieval requires an enabled synthetic identity',
      );
    if (!service)
      throw new ContributionError('TEMPORARILY_UNAVAILABLE', 503, 'Retrieval is unavailable');
    return ctx;
  }
  app.post<{ Body: SchemaTypes['SearchRequest'] }>(
    '/api/v1/knowledge/search',
    { schema: { body: schema('SearchRequest'), response: { 200: envelope('SearchResult') } } },
    async (request) => {
      const ctx = await context();
      return { request_id: request.id, data: await service!.search(ctx, request.body) };
    },
  );
  app.post<{ Body: SchemaTypes['ReadRequest'] }>(
    '/api/v1/knowledge/read',
    { schema: { body: schema('ReadRequest'), response: { 200: envelope('ReadResult') } } },
    async (request) => {
      const ctx = await context();
      return { request_id: request.id, data: await service!.read(ctx, request.body) };
    },
  );
}
