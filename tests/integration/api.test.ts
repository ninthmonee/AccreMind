import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../../apps/api/src/app.js';
import { loadDevelopmentConfig } from '@accremind/domain';
import { assertSchema, createApiClient, getValidator, ApiClientError } from '@accremind/contracts';
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
    assert.equal(hidden.statusCode, 404);
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
