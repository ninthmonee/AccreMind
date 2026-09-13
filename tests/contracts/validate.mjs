import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';
import { load, root } from '../../scripts/generate-contracts.mjs';
import { buildFixtures, uid } from './fixtures.mjs';

const api = load('openapi.json'), bundle = load('schemas.json'), mcp = load('mcp-tools.json');
await SwaggerParser.validate(structuredClone(api), { resolve: { external: false } });
console.log('OpenAPI 3.1 semantic validator passed');
const options = { strict: true, removeAdditional: false, coerceTypes: false, useDefaults: false, allErrors: true };
const ajv = new Ajv2020(options); addFormats(ajv); ajv.addSchema(bundle);
const validators = new Map();
for (const name of Object.keys(bundle.$defs)) validators.set(name, ajv.getSchema(`${bundle.$id}#/$defs/${name}`));
console.log(`Compiled ${validators.size} domain schemas with Ajv2020`);
for (const tool of mcp) {
  assert.equal(tool.inputSchema.type, 'object', `${tool.name} input root must be object`);
  assert.equal(tool.outputSchema.type, 'object', `${tool.name} output root must be object`);
  ajv.compile(tool.inputSchema); ajv.compile(tool.outputSchema);
}
console.log(`Compiled ${mcp.length} MCP request/response schemas`);

// Deterministic sample generator only supplies synthetic mandatory fields.
function sampleSchema(schema) {
  if (schema.$ref) return sampleSchema(bundle.$defs[schema.$ref.replace('#/$defs/', '')]);
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return sampleSchema(schema.anyOf.find(x => x.type === 'null') ?? schema.anyOf[0]);
  if (schema.oneOf) return sampleSchema(schema.oneOf[0]);
  if (schema.type === 'null') return null;
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map(k => [k, sampleSchema(schema.properties[k])]));
  if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 0 }, () => sampleSchema(schema.items));
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 1;
  if (schema.type === 'boolean') return false;
  if (schema.format === 'uuid') return uid(1);
  if (schema.format === 'date-time') return '2026-09-12T00:00:00Z';
  if (schema.pattern === '^[a-f0-9]{64}$') return 'a'.repeat(64);
  return 'synthetic'.padEnd(schema.minLength ?? 1, 'x');
}
const sample = name => sampleSchema(bundle.$defs[name]);
const cases = buildFixtures(sample);
for (const test of cases) {
  const before = structuredClone(test.value), validate = validators.get(test.schema);
  assert.equal(validate(test.value), test.valid, `${test.label}: ${JSON.stringify(validate.errors)}`);
  assert.deepEqual(test.value, before, `${test.label}: validator mutated input`);
}
console.log(`${cases.length} positive/negative fixtures passed; no coercion, defaults or silent field removal`);

const operations = [];
let wireSchemas = 0;
function wire(schema) {
  if (Array.isArray(schema)) return schema.map(wire);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, k === '$ref'
    ? v.replace('#/components/schemas/', `${bundle.$id}#/$defs/`) : wire(v)]));
}
for (const [path, item] of Object.entries(api.paths)) for (const [method, op] of Object.entries(item)) {
  if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
  operations.push(op.operationId);
  assert.ok(op['x-capability']);
  const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
  assert.deepEqual((op.parameters ?? []).filter(p => p.in === 'path').map(p => p.name).sort(), placeholders.sort());
  for (const param of op.parameters ?? []) ajv.compile(param.schema);
  if (op.requestBody) { ajv.compile(wire(op.requestBody.content['application/json'].schema)); wireSchemas++; }
  for (const response of Object.values(op.responses)) {
    if (response.content?.['application/json']?.schema) { ajv.compile(wire(response.content['application/json'].schema)); wireSchemas++; }
  }
}
assert.equal(new Set(operations).size, operations.length);
assert.equal(new Set(mcp.map(t => t.name)).size, 8);
for (const path of ['/auth/cli/start', '/auth/cli/exchange', '/auth/refresh']) {
  assert.equal(api.paths[path].post['x-capability'], 'public:auth');
  assert.deepEqual(api.paths[path].post.security, []);
}
for (const path of ['/auth/cli/tickets/{id}', '/auth/cli/tickets/{id}/decision']) {
  assert.deepEqual(Object.values(api.paths[path])[0].security, [{ sessionCookie: [] }]);
}
const evidenceVersion = api.paths['/evidence/{id}'].get.parameters.find(p => p.name === 'revision');
assert.equal(evidenceVersion.required, true);
const checkRevision = ajv.compile(evidenceVersion.schema);
assert.equal(checkRevision(2), true); assert.equal(checkRevision('2'), false); assert.equal(checkRevision(0), false);
console.log(`${Object.keys(api.paths).length} paths / ${operations.length} operations: unique IDs, path parameters and authentication boundary passed`);
console.log(`Compiled ${wireSchemas} HTTP request/response wire schemas with Ajv2020`);

// Contract-level rehearsal: schema-check hand-authored request/response bindings.
// These assertions are not mocks of AuthorizationService or PublicationService.
const mapping = { client_evidence_id: uid(11), evidence_ref: { id: uid(12), revision: 2, locator: 'L1-L3' } };
assert.equal(validators.get('EvidenceMapping')(mapping), true);
const approval = sample('ReviewRecord');
Object.assign(approval, { review_id: uid(13), candidate_id: uid(14), candidate_revision: 3, assessment_revision: 2,
  evidence_set_hash: 'b'.repeat(64), action: 'approve', disposition: 'knowledge_candidate', mirror_approval: false, validity: 'valid' });
assert.equal(validators.get('ReviewRecord')(approval), true);
const publish = { operation_id: uid(15), expected_revision: approval.candidate_revision, assessment_revision: approval.assessment_revision,
  review_id: approval.review_id, evidence_set_hash: approval.evidence_set_hash };
assert.equal(validators.get('PublishRequest')(publish), true);
const binding = { target_knowledge_id: uid(16), base_content_revision: 1, base_aggregate_revision: 2 };
assert.equal(validators.get('RevisionBinding')(binding), true);
const revisionPublish = { ...publish, expected_target_revision: binding.base_aggregate_revision };
assert.equal(validators.get('PublishRequest')(revisionPublish), true);
const refreshedTarget = { content_revision: 1, aggregate_revision: 3 };
assert.notEqual(revisionPublish.expected_target_revision, refreshedTarget.aggregate_revision, 'status-only change must invalidate target CAS');
const firstActivated = { content_revision: 2, aggregate_revision: 3 };
assert.notEqual(binding.base_content_revision, firstActivated.content_revision, 'second competing revision must rebase');
const stale = { ...approval, validity: 'stale', stale_reasons: ['CANDIDATE_REVISION_CHANGED'] };
assert.equal(validators.get('ReviewRecord')(stale), true);
console.log('Contract rehearsal: evidence ID/version → named approval → publish → revision CAS/competing revision/stale approval bindings passed');

// Check portable local Markdown targets (line suffixes are app citation metadata).
const documents = ['01-工具端架构设计.md', '02-前端架构设计.md', '03-后端架构设计.md', '04-开发任务与验收计划.md',
  'contracts/README.md', 'verification/2026-09-11-architecture-review.md', 'verification/2026-09-12-phase-a-validation.md',
  'verification/2026-09-12-phase-b-validation.md', '../../README.md', '../decisions/0001-engineering-baseline.md', '../pilot-startup.md'];
let links = 0;
for (const name of documents) {
  const path = resolve(root, 'docs/architecture', name);
  const content = readFileSync(path, 'utf8');
  assert.equal(content.includes('/Users/admin/'), false, `Stale link in ${name}`);
  for (const match of content.matchAll(/\]\((?:<([^>]+)>|([^\)]+))\)/g)) {
    const target = (match[1] ?? match[2]).split('#')[0].replace(/:\d+$/, '');
    if (!target || /^[a-z]+:/i.test(target)) continue;
    assert.ok(existsSync(resolve(dirname(path), target)), `Broken link: ${name} -> ${target}`); links++;
  }
}
console.log(`${links} local Markdown links resolve`);
console.log('Stage A design checks passed; no real API, PostgreSQL, OIDC, browser or host result is implied');
