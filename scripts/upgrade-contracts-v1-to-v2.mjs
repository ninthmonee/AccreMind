// One-time design migration. The generated source is authoritative thereafter.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = `${root}docs/architecture/contracts/`;
if (existsSync(`${dir}source/openapi.json`))
  throw new Error('v2 source already exists; edit it directly');
const api = JSON.parse(readFileSync(`${dir}openapi.json`, 'utf8'));
const s = api.components.schemas;
const clone = (x) => structuredClone(x);
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const id = () => ({ type: 'string', format: 'uuid' });
const rev = () => ({ type: 'integer', minimum: 1 });
const text = (max = 4096) => ({ type: 'string', minLength: 1, maxLength: max });
const hash = () => ({ type: 'string', pattern: '^[a-f0-9]{64}$' });
const date = () => ({ type: 'string', format: 'date-time' });
const en = (...values) => ({ type: 'string', enum: values });
const arr = (items, max = 100) => ({ type: 'array', items, maxItems: max });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const obj = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const add = (name, properties, required = Object.keys(properties)) => {
  Object.assign(s[name].properties, properties);
  s[name].required = [...new Set([...s[name].required, ...required])];
};
api.info.version = '2.0.0';
api.info.description +=
  ' Contract v2 is a pre-implementation breaking revision; see B20 and the v2 migration guide.';
api.jsonSchemaDialect = 'https://json-schema.org/draft/2020-12/schema';

// R1/R6: separate search, management, detail and historical shapes.
s.SearchHit = clone(s.KnowledgeItem);
s.SearchHit.description =
  'Budgeted search segment; revision is content revision. Not a complete detail.';
s.KnowledgeSummary = obj({
  id: id(),
  aggregate_revision: rev(),
  content_revision: rev(),
  title: text(200),
  type: clone(s.CandidateBody.properties.type),
  knowledge_role: clone(s.CandidateBody.properties.knowledge_role),
  scope: ref('Scope'),
  owner_id: id(),
  publication_status: ref('Publication'),
  serving_status: ref('Serving'),
  maturity: ref('Maturity'),
  freshness: ref('Freshness'),
});
s.KnowledgeDetail = obj({
  id: id(),
  aggregate_revision: rev(),
  content_revision: rev(),
  body: ref('CandidateBody'),
  capture_assessment_id: id(),
  capture_assessment_revision: rev(),
  knowledge_delta: arr(ref('Delta')),
  source_refs: arr(ref('EvidenceRef')),
  publication_status: ref('Publication'),
  serving_status: ref('Serving'),
  maturity: ref('Maturity'),
  freshness: ref('Freshness'),
  created_at: date(),
  review_due_at: nullable(date()),
  last_validated_at: nullable(date()),
  is_current: { type: 'boolean' },
  usage_mode: en('current_guidance', 'historical_reference'),
});
s.KnowledgeDetail.description =
  'Full versioned body; maturity/freshness belong to requested content revision, publication/serving and aggregate_revision are current aggregate state. Historical content never implies current applicability.';
s.KnowledgeRevisionSummary = obj({
  id: id(),
  aggregate_revision: rev(),
  content_revision: rev(),
  title: text(200),
  created_at: date(),
  is_current: { type: 'boolean' },
  revision_status: en('current', 'superseded'),
  publication_status: ref('Publication'),
  serving_status: ref('Serving'),
});
s.KnowledgeSummaryPage = clone(s.KnowledgeItemPage);
s.KnowledgeSummaryPage.properties.items.items = ref('KnowledgeSummary');
s.KnowledgeRevisionPage = clone(s.KnowledgeItemPage);
s.KnowledgeRevisionPage.properties.items.items = ref('KnowledgeRevisionSummary');
s.ReadComplete = obj({
  kind: { const: 'complete' },
  item: ref('KnowledgeDetail'),
  budget: ref('Budget'),
});
s.ReadBudgetLimited = obj({
  kind: { const: 'budget_limited' },
  id: id(),
  content_revision: rev(),
  title: text(200),
  source_refs: arr(ref('EvidenceRef')),
  needs_expansion: { const: true },
  reason: en('token_budget_exceeded', 'read_budget_exhausted'),
  budget: ref('Budget'),
});
s.ReadResult = { oneOf: [ref('ReadComplete'), ref('ReadBudgetLimited')] };
s.SearchResult.properties.items.items = ref('SearchHit');
s.ReviewView.properties.related_entries.items = ref('SearchHit');
delete s.KnowledgeItem;
delete s.KnowledgeItemPage;

// R2: immutable target/base binding, rebase is an explicit candidate revision.
s.RevisionBinding = obj({
  target_knowledge_id: id(),
  base_content_revision: rev(),
  base_aggregate_revision: rev(),
});
add('Candidate', {
  creation_kind: en('new', 'revision'),
  revision_binding: nullable(ref('RevisionBinding')),
});
s.Candidate.properties.assessment_id = nullable(id());
s.Candidate.properties.assessment_revision = nullable(rev());
s.Candidate.allOf = [
  {
    if: { properties: { creation_kind: { const: 'new' } }, required: ['creation_kind'] },
    then: { properties: { revision_binding: { type: 'null' } } },
    else: { properties: { revision_binding: ref('RevisionBinding') } },
  },
  {
    oneOf: [
      { properties: { assessment_id: { type: 'null' }, assessment_revision: { type: 'null' } } },
      { properties: { assessment_id: id(), assessment_revision: rev() } },
    ],
  },
];
s.RevisionCreate = obj({
  operation_id: id(),
  expected_revision: rev(),
  base_content_revision: rev(),
  contribution_id: id(),
  body: ref('CandidateBody'),
});
s.RevisionCreate.properties.expected_revision.description =
  'Current target knowledge aggregate_revision, not candidate or content revision.';
s.RevisionRebase = obj({
  operation_id: id(),
  expected_revision: rev(),
  expected_target_revision: rev(),
  base_content_revision: rev(),
  body: ref('CandidateBody'),
});
add('PublishRequest', { expected_target_revision: rev() }, []);
s.PublishRequest.properties.expected_revision.description =
  'Candidate revision. Revision candidates additionally require expected_target_revision equal to stored base_aggregate_revision.';
add('PublishResult', { aggregate_revision: rev() }, []);

// R3: durable client upload mapping; evidence versions are explicit.
add('EvidenceInput', { client_evidence_id: id() });
s.EvidenceMapping = obj({ client_evidence_id: id(), evidence_ref: ref('EvidenceRef') });
add('IngestResult', { evidence_mappings: arr(ref('EvidenceMapping'), 30) });
add('Contribution', { evidence_mappings: arr(ref('EvidenceMapping'), 30) });
add('Evidence', { evidence_kind: en('raw', 'retained'), status: en('available') });

// R7/R8: named audit record and recoverable current approval, including mirrors.
s.ReviewRecord = obj({
  review_id: id(),
  candidate_id: id(),
  candidate_revision: rev(),
  assessment_id: id(),
  assessment_revision: rev(),
  evidence_set_hash: hash(),
  scope: ref('Scope'),
  reviewer_id: id(),
  action: clone(s.ReviewRequest.properties.action),
  disposition: ref('Disposition'),
  reason: text(),
  mirror_approval: { type: 'boolean' },
  created_at: date(),
  validity: en('valid', 'stale'),
  stale_reasons: arr(text(256)),
});
add('ReviewRequest', { mirror_approval: { type: 'boolean', default: false } }, []);
add('ReviewView', {
  current_approval: nullable(ref('ReviewRecord')),
  latest_review: nullable(ref('ReviewRecord')),
});
s.ReviewView.properties.assessment = nullable(ref('AssessmentRecord'));

// R4/R5: session-only approval and token-family rotation history.
s.AuthStart.properties.state_hash = hash();
s.TicketTenant = obj({ tenant_id: id(), display_name: text(200) });
s.AuthTicketView = obj({
  ticket_id: id(),
  client_name: text(128),
  state_hash: hash(),
  status: en('pending', 'approved', 'denied', 'expired', 'consumed'),
  expires_at: date(),
  eligible_tenants: arr(ref('TicketTenant')),
  requested_capabilities: arr(text(64)),
  approved_tenant_id: nullable(id()),
});
s.AuthTicketDecision = obj(
  { operation_id: id(), state_hash: hash(), decision: en('approve', 'deny'), tenant_id: id() },
  ['operation_id', 'state_hash', 'decision'],
);
s.AuthTicketDecision.allOf = [
  {
    if: { properties: { decision: { const: 'approve' } }, required: ['decision'] },
    then: { required: ['tenant_id'] },
    else: { not: { required: ['tenant_id'] } },
  },
];
add('AuthResult', { session_id: id(), refresh_expires_at: date() }, []);
s.AuthResult.allOf = [
  {
    if: { properties: { status: { const: 'approved' } }, required: ['status'] },
    then: {
      required: ['access_token', 'refresh_token', 'expires_at', 'session_id', 'refresh_expires_at'],
    },
    else: {
      not: {
        anyOf: [
          'access_token',
          'refresh_token',
          'expires_at',
          'session_id',
          'refresh_expires_at',
        ].map((k) => ({ required: [k] })),
      },
    },
  },
];
s.AuthResult.properties.session_id.description =
  'Tool session ID is also its refresh-token family ID; absolute family expiry is at most 7 days.';

// Navigation consumption remains outside the 8 MCP tools.
s.NavigationItem = obj({
  id: id(),
  scope: ref('Scope'),
  kind: en('index_only', 'link_existing'),
  title: text(200),
  source_ref: text(1024),
  source_revision: text(128),
  locator: text(512),
  assessment_id: id(),
  assessment_revision: rev(),
});
s.NavigationPage = obj({
  items: arr(ref('NavigationItem')),
  next_cursor: { type: 'string', maxLength: 1024 },
});

const success = (op, schema) => {
  const code = Object.keys(op.responses).find((x) => /^2\d\d$/.test(x));
  op.responses[code].content['application/json'].schema.properties.data = ref(schema);
};
success(api.paths['/knowledge'].get, 'KnowledgeSummaryPage');
success(api.paths['/knowledge/{id}/revisions'].get, 'KnowledgeRevisionPage');
api.paths['/knowledge/{id}/revisions'].post.requestBody.content['application/json'].schema =
  ref('RevisionCreate');
success(api.paths['/candidates/{id}/review'].post, 'ReviewRecord');
const operation = ({
  operationId,
  capability,
  response,
  body,
  parameters = [],
  method = 'get',
  sessionOnly = false,
}) => {
  const op = clone(
    api.paths[method === 'get' ? '/evidence/{id}' : '/candidates/{id}/review'][method],
  );
  op.operationId = operationId;
  op.summary = operationId;
  op['x-capability'] = capability;
  op.parameters = parameters;
  if (sessionOnly) op.security = [{ sessionCookie: [] }];
  if (body)
    op.requestBody = { required: true, content: { 'application/json': { schema: ref(body) } } };
  else delete op.requestBody;
  success(op, response);
  return op;
};
const param = (name, where, schema, required = true) => ({ name, in: where, required, schema });
api.paths['/evidence/{id}'].get.parameters.push(param('revision', 'query', rev()));
api.paths['/evidence/{id}'].get.description =
  'Read exactly the requested available evidence version after scope authorization; inaccessible, missing, quarantined, expired or deleted versions return unified 404.';
api.paths['/knowledge/{id}'] = {
  get: operation({
    operationId: 'getKnowledgeDetail',
    capability: 'knowledge:read',
    response: 'KnowledgeDetail',
    parameters: [param('id', 'path', id()), param('revision', 'query', rev(), false)],
  }),
};
api.paths['/knowledge/{id}'].get.description =
  'Authorized management detail; does not replace budgeted MCP read. Per-principal rate/payload limits apply. Explicit historical revisions additionally require knowledge:history; withdrawn/archived/suspended body requires knowledge:review in the same scope and is historical_reference only.';
api.paths['/candidates/{id}/rebase'] = {
  post: operation({
    operationId: 'rebaseRevisionCandidate',
    capability: 'knowledge:contribute',
    response: 'Candidate',
    body: 'RevisionRebase',
    method: 'post',
    parameters: [param('id', 'path', id())],
  }),
};
api.paths['/auth/cli/tickets/{id}'] = {
  get: operation({
    operationId: 'getCliAuthTicket',
    capability: 'authenticated',
    response: 'AuthTicketView',
    sessionOnly: true,
    parameters: [param('id', 'path', id()), param('state_hash', 'query', hash())],
  }),
};
api.paths['/auth/cli/tickets/{id}/decision'] = {
  post: operation({
    operationId: 'decideCliAuthTicket',
    capability: 'authenticated',
    response: 'AuthTicketView',
    body: 'AuthTicketDecision',
    method: 'post',
    sessionOnly: true,
    parameters: [param('id', 'path', id())],
  }),
};
api.paths['/auth/cli/tickets/{id}/decision'].post.description =
  'Web session only; CSRF token and exact allowed Origin required. Bind current OIDC subject to a server-eligible tenant. State hash and pending/unexpired ticket must match. Same operation replay requires original decision actor and payload; different decisions on a decided ticket return 409.';
for (const path of ['/auth/cli/start', '/auth/cli/exchange', '/auth/refresh']) {
  api.paths[path].post['x-capability'] = 'public:auth';
  api.paths[path].post['x-authentication-mode'] = 'credential-exchange';
}
api.paths['/auth/refresh'].post.description =
  'Atomic consume-and-rotate using stored token hashes and family history. Reuse of consumed token revokes the family. Unknown token gets generic 401. No grace/replay cache: lost rotation response requires fresh browser login, never retry the old token.';
api.paths['/auth/cli/exchange'].post.description =
  'Verify challenge and state then atomically consume approved ticket once. Lost successful response requires a new ticket/login, not a second token issuance.';
api.paths['/navigation'] = {
  get: operation({
    operationId: 'listNavigation',
    capability: 'knowledge:read',
    response: 'NavigationPage',
    parameters: [
      param('scope_id', 'query', id()),
      param('query', 'query', text(2000), false),
      param('cursor', 'query', text(1024), false),
      param('limit', 'query', { type: 'integer', minimum: 1, maximum: 100, default: 20 }, false),
    ],
  }),
};
api.paths['/navigation'].get.description =
  'Authorized navigation only; recheck source access/state before returning title, locator or URL. Does not return advice, grow knowledge counts or bypass source permissions. Cursor binds actor/scope/filter.';
for (const suffix of ['suspend', 'withdraw', 'archive']) {
  api.paths[`/knowledge/{id}/${suffix}`].post.description =
    'expected_revision is the current knowledge aggregate_revision from management reads, not the content revision.';
}
mkdirSync(`${dir}source`, { recursive: true });
writeFileSync(`${dir}source/openapi.json`, JSON.stringify(api, null, 2) + '\n');
const tools = JSON.parse(readFileSync(`${dir}mcp-tools.json`, 'utf8')).map(
  ({ name, operationId, description }) => ({ name, operationId, description }),
);
writeFileSync(`${dir}source/mcp-tools.json`, JSON.stringify(tools, null, 2) + '\n');
console.log(`Created contract v2 source: ${Object.keys(s).length} schemas`);
