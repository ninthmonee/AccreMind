import type { FastifyInstance } from 'fastify';
import type { PrincipalContext } from '@accremind/domain';
import type { SchemaTypes } from '@accremind/contracts';
import type { PostgresAssessmentService } from './assessments.js';
import { ContributionError } from './contribution-errors.js';
import { schema, uuid, idParams, envelope } from './contribution-routes.js';

import type { PostgresGovernanceService } from './governance.js';

const pageProperties = {
  cursor: { type: 'string', minLength: 1, maxLength: 1024 },
  limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
  scope_id: uuid,
};
export function registerAssessmentRoutes(
  app: FastifyInstance,
  service: PostgresAssessmentService | undefined,
  resolvePrincipal: () => Promise<PrincipalContext | undefined>,
  governance?: PostgresGovernanceService,
) {
  async function context() {
    const ctx = await resolvePrincipal();
    if (!ctx)
      throw new ContributionError(
        'UNAUTHENTICATED',
        401,
        'Manual checks require an enabled synthetic development identity',
      );
    if (!service)
      throw new ContributionError(
        'TEMPORARILY_UNAVAILABLE',
        503,
        'Manual assessment storage is unavailable',
      );
    return ctx;
  }
  app.put<{ Params: { id: string }; Body: SchemaTypes['AssessmentWrite'] }>(
    '/api/v1/candidates/:id/assessment',
    {
      schema: {
        params: idParams,
        body: schema('AssessmentWrite'),
        response: { 200: envelope('AssessmentRecord') },
      },
    },
    async (request) => {
      const ctx = await context();
      return {
        request_id: request.id,
        data: await service!.saveHumanCheck(ctx, request.params.id, request.body),
      };
    },
  );
  app.patch<{ Params: { id: string }; Body: SchemaTypes['CandidatePatch'] }>(
    '/api/v1/candidates/:id',
    {
      schema: {
        params: idParams,
        body: schema('CandidatePatch'),
        response: { 200: envelope('Candidate') },
      },
    },
    async (request) => {
      const ctx = await context();
      return {
        request_id: request.id,
        data: await service!.updateCandidate(ctx, request.params.id, request.body),
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/v1/candidates/:id',
    { schema: { params: idParams, response: { 200: envelope('ReviewView') } } },
    async (request) => {
      const ctx = await context();
      const view = await service!.getReview(ctx, request.params.id);
      return {
        request_id: request.id,
        data:
          governance && !view.blocking_reasons.some((b) => b.code === 'EVIDENCE_UNAVAILABLE')
            ? await governance.decorateReview(ctx, view)
            : view,
      };
    },
  );
  app.get<{ Querystring: { cursor?: string; limit?: string; scope_id?: string } }>(
    '/api/v1/reviews',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: pageProperties },
        response: { 200: envelope('CandidatePage') },
      },
    },
    async (request) => {
      const ctx = await context();
      return {
        request_id: request.id,
        data: await service!.listReviews(ctx, {
          ...request.query,
          limit: Number(request.query.limit ?? 20),
        }),
      };
    },
  );
  app.get<{ Querystring: { scope_id: string; query?: string; cursor?: string; limit?: string } }>(
    '/api/v1/navigation',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...pageProperties,
            query: { type: 'string', minLength: 1, maxLength: 2000 },
          },
          required: ['scope_id'],
        },
        response: { 200: envelope('NavigationPage') },
      },
    },
    async (request) => {
      const ctx = await context();
      return {
        request_id: request.id,
        data: await service!.listNavigation(ctx, {
          ...request.query,
          limit: Number(request.query.limit ?? 20),
        }),
      };
    },
  );
}
