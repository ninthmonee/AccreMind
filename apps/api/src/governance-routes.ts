import type { FastifyInstance } from 'fastify';
import type { SchemaTypes } from '@accremind/contracts';
import type { PrincipalContext } from '@accremind/domain';
import type { PostgresGovernanceService } from './governance.js';
import type { PostgresKnowledgeGovernance } from './knowledge-governance.js';
import { ContributionError } from './contribution-errors.js';
import { envelope, idParams, schema } from './contribution-routes.js';

export function registerGovernanceRoutes(
  app: FastifyInstance,
  service: PostgresGovernanceService | undefined,
  knowledge: PostgresKnowledgeGovernance | undefined,
  resolve: () => Promise<PrincipalContext | undefined>,
) {
  async function context() {
    const ctx = await resolve();
    if (!ctx)
      throw new ContributionError(
        'UNAUTHENTICATED',
        401,
        'Governance requires an enabled synthetic identity',
      );
    if (!service)
      throw new ContributionError(
        'TEMPORARILY_UNAVAILABLE',
        503,
        'Governance storage is unavailable',
      );
    return ctx;
  }
  app.post<{ Params: { id: string }; Body: SchemaTypes['RetainRequest'] }>(
    '/api/v1/evidence/:id/retain',
    {
      schema: {
        params: idParams,
        body: schema('RetainRequest'),
        response: { 200: envelope('Evidence') },
      },
    },
    async (request) => {
      const ctx = await context();
      return {
        request_id: request.id,
        data: await service!.retain(ctx, request.params.id, request.body),
      };
    },
  );
  app.post<{ Params: { id: string }; Body: SchemaTypes['ReviewRequest'] }>(
    '/api/v1/candidates/:id/review',
    {
      schema: {
        params: idParams,
        body: schema('ReviewRequest'),
        response: { 200: envelope('ReviewRecord') },
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
  app.post<{ Params: { id: string }; Body: SchemaTypes['PublishRequest'] }>(
    '/api/v1/candidates/:id/publish',
    {
      schema: {
        params: idParams,
        body: schema('PublishRequest'),
        response: { 202: envelope('PublishResult') },
      },
    },
    async (request, reply) => {
      const ctx = await context();
      return reply.code(202).send({
        request_id: request.id,
        data: await service!.request(ctx, request.params.id, request.body),
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/v1/publications/:id',
    { schema: { params: idParams, response: { 200: envelope('PublishResult') } } },
    async (request) => {
      const ctx = await context();
      return {
        request_id: request.id,
        data: await service!.getPublication(ctx, request.params.id),
      };
    },
  );
  for (const action of ['suspend', 'withdraw', 'archive'] as const)
    app.post<{ Params: { id: string }; Body: SchemaTypes['Mutation'] }>(
      `/api/v1/knowledge/:id/${action}`,
      {
        schema: {
          params: idParams,
          body: schema('Mutation'),
          response: { 200: envelope('MutationResult') },
        },
      },
      async (request) => {
        const ctx = await context();
        return {
          request_id: request.id,
          data: await service!.mutateKnowledge(ctx, request.params.id, action, request.body),
        };
      },
    );
  async function knowledgeContext() {
    const ctx = await context();
    if (!knowledge)
      throw new ContributionError(
        'TEMPORARILY_UNAVAILABLE',
        503,
        'Knowledge versions are unavailable',
      );
    return ctx;
  }
  app.post<{ Params: { id: string }; Body: SchemaTypes['RevisionCreate'] }>(
    '/api/v1/knowledge/:id/revisions',
    {
      schema: {
        params: idParams,
        body: schema('RevisionCreate'),
        response: { 201: envelope('Candidate') },
      },
    },
    async (request, reply) => {
      const ctx = await knowledgeContext();
      return reply.code(201).send({
        request_id: request.id,
        data: await knowledge!.createRevision(ctx, request.params.id, request.body),
      });
    },
  );
  app.post<{ Params: { id: string }; Body: SchemaTypes['RevisionRebase'] }>(
    '/api/v1/candidates/:id/rebase',
    {
      schema: {
        params: idParams,
        body: schema('RevisionRebase'),
        response: { 200: envelope('Candidate') },
      },
    },
    async (request) => {
      const ctx = await knowledgeContext();
      return {
        request_id: request.id,
        data: await knowledge!.rebase(ctx, request.params.id, request.body),
      };
    },
  );
  const positive = { type: 'string', pattern: '^[1-9][0-9]{0,14}$' };
  app.get<{ Querystring: { scope_id?: string; cursor?: string; limit?: string } }>(
    '/api/v1/knowledge',
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
        response: { 200: envelope('KnowledgeSummaryPage') },
      },
    },
    async (request) => {
      const ctx = await knowledgeContext();
      return {
        request_id: request.id,
        data: await knowledge!.list(ctx, {
          ...(request.query.scope_id === undefined ? {} : { scope_id: request.query.scope_id }),
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
          ...(request.query.limit === undefined ? {} : { limit: Number(request.query.limit) }),
        }),
      };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { revision?: string } }>(
    '/api/v1/knowledge/:id',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { revision: positive },
        },
        response: { 200: envelope('KnowledgeDetail') },
      },
    },
    async (request) => {
      const ctx = await knowledgeContext();
      return {
        request_id: request.id,
        data: await knowledge!.detail(
          ctx,
          request.params.id,
          request.query.revision ? Number(request.query.revision) : undefined,
        ),
      };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>(
    '/api/v1/knowledge/:id/revisions',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
            cursor: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
        response: { 200: envelope('KnowledgeRevisionPage') },
      },
    },
    async (request) => {
      const ctx = await knowledgeContext();
      return {
        request_id: request.id,
        data: await knowledge!.history(ctx, request.params.id, {
          ...request.query,
          limit: Number(request.query.limit ?? 20),
        }),
      };
    },
  );
}
