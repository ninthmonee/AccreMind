import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../../apps/api/src/app.js';
import { loadDevelopmentConfig } from '@accremind/domain';
import { assertSchema, createApiClient, getValidator, ApiClientError } from '@accremind/contracts';
test('B03 routes require server-owned identity and strictly validate revision and page limits', async () => {
  const app = createApp(loadDevelopmentConfig({}), { checkDatabase: async () => false });
  const id = '00000000-0000-4000-8000-000000000001';
  try {
    for (const url of [
      '/api/v1/contributions',
      `/api/v1/contributions/${id}`,
      `/api/v1/evidence/${id}?revision=1`,
      `/api/v1/candidates/${id}`,
      '/api/v1/reviews',
      `/api/v1/publications/${id}`,
      `/api/v1/knowledge/${id}`,
      `/api/v1/knowledge/${id}/revisions`,
      `/api/v1/navigation?scope_id=${id}`,
      `/api/v1/config?repo_id=${id}&client_version=2.10.0`,
      '/api/v1/config/versions',
      '/api/v1/knowledge',
    ]) {
      const response = await app.inject(url);
      assert.equal(response.statusCode, 401);
      assertSchema('Error', response.json());
    }
    for (const url of [
      `/api/v1/evidence/${id}`,
      `/api/v1/evidence/${id}?revision=0`,
      '/api/v1/contributions?limit=101',
      '/api/v1/contributions?actor_id=forged',
      '/api/v1/navigation',
      '/api/v1/reviews?limit=0',
      '/api/v1/reviews?actor_id=forged',
      '/api/v1/config/versions?limit=0',
      '/api/v1/knowledge?limit=0',
      '/api/v1/knowledge?actor_id=forged',
      `/api/v1/config?repo_id=${id}&client_version=2.10.0&current_config_version=0`,
      `/api/v1/config?repo_id=${id}&client_version=2.10.0&actor_id=forged`,
    ])
      assert.equal((await app.inject(url)).statusCode, 400);
    const search = {
      task_id: id,
      operation_id: id,
      query: '事务顺序',
      repo_id: id,
      environment: { commit: 'synthetic', dependencies: {} },
      scope: 'repo',
    };
    const read = { task_id: id, operation_id: id, id };
    for (const [url, payload] of [
      ['/api/v1/knowledge/search', search],
      ['/api/v1/knowledge/read', read],
    ] as const) {
      assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 401);
      assert.equal(
        (await app.inject({ method: 'POST', url, payload: { ...payload, actor_id: id } }))
          .statusCode,
        400,
      );
    }
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/v1/contributions',
      payload: { content: 'x'.repeat(256 * 1024) },
    });
    assert.equal(oversized.statusCode, 413);
    assertSchema('Error', oversized.json());
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/contributions',
      payload: '{broken',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(malformed.statusCode, 400);
  } finally {
    await app.close();
  }
});
test('API distinguishes liveness/readiness and exposes only synthetic identity', async () => {
  const app = createApp(loadDevelopmentConfig({}), { checkDatabase: async () => false });
  try {
    assert.equal((await app.inject('/healthz')).statusCode, 200);
    assert.equal((await app.inject('/readyz')).statusCode, 503);
    const response = await app.inject('/api/v1/me');
    const envelope: unknown = response.json();
    assert.ok(typeof envelope === 'object' && envelope !== null && 'data' in envelope);
    assertSchema('Me', envelope.data);
    assert.deepEqual(envelope.data.capabilities, []);
    assert.match(response.headers['x-request-id'] as string, /^[a-f0-9-]{36}$/);
    assert.equal(response.headers['cache-control'], 'no-store');
    const hidden = await app.inject({
      method: 'POST',
      url: '/api/v1/candidates/forged/publish',
      payload: { actor_id: 'forged' },
    });
    assert.equal(hidden.statusCode, 400);
    assert.equal(getValidator('Error')(hidden.json()), true);
    const credentials = await app.inject({
      url: '/api/v1/me',
      headers: { authorization: 'Bearer synthetic-forged-token' },
    });
    assert.equal(credentials.statusCode, 401);
  } finally {
    await app.close();
  }
});
test('Fastify custom Ajv compiler rejects extras instead of deleting them', async () => {
  const app = createApp(loadDevelopmentConfig({}), { checkDatabase: async () => true });
  app.post(
    '/_test/contract',
    {
      schema: {
        body: { $ref: 'urn:accremind:contracts:v2#/$defs/Mutation' },
        response: { 200: { $ref: 'urn:accremind:contracts:v2#/$defs/Mutation' } },
      },
    },
    async (request) => request.body,
  );
  try {
    const body = {
      operation_id: '00000000-0000-4000-8000-000000000001',
      expected_revision: 1,
      reason: 'synthetic',
    };
    assert.equal(
      (await app.inject({ method: 'POST', url: '/_test/contract', payload: body })).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/_test/contract',
          payload: { ...body, maturity: 'proven' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/_test/contract',
          payload: { ...body, expected_revision: '1' },
        })
      ).statusCode,
      400,
    );
    assert.equal((await app.inject('/readyz')).statusCode, 200);
  } finally {
    await app.close();
  }
});
test('generated shared client validates success and preserves zero permissions', async () => {
  const app = createApp(loadDevelopmentConfig({}), { checkDatabase: async () => true });
  const client = createApiClient({
    baseUrl: 'http://127.0.0.1/api/v1',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const result = await app.inject({ method: init?.method as 'GET', url: url.pathname });
      return new Response(result.body, { status: result.statusCode });
    },
  });
  try {
    assert.deepEqual((await client.request('getMe')).capabilities, []);
  } finally {
    await app.close();
  }
});
test('transport failure never becomes an empty knowledge result', async () => {
  const client = createApiClient({
    baseUrl: 'http://127.0.0.1/api/v1',
    fetch: async () => {
      throw new Error('private transport detail');
    },
  });
  await assert.rejects(
    client.request('getMe'),
    (error: unknown) =>
      error instanceof ApiClientError &&
      error.code === 'TEMPORARILY_UNAVAILABLE' &&
      !error.message.includes('private'),
  );
});
