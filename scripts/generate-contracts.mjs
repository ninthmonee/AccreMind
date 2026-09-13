import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const dir = `${root}docs/architecture/contracts/`;
export const load = (name) => JSON.parse(readFileSync(`${dir}${name}`, 'utf8'));
export function generate() {
  const api = load('source/openapi.json');
  const tools = load('source/mcp-tools.json');
  function expand(value, stack = []) {
    if (Array.isArray(value)) return value.map((x) => expand(x, stack));
    if (!value || typeof value !== 'object') return value;
    if (value.$ref) {
      const name = value.$ref.replace('#/components/schemas/', '');
      if (!api.components.schemas[name]) throw new Error(`Unresolved ${value.$ref}`);
      if (stack.includes(name)) throw new Error(`MCP inline schema cycle: ${name}`);
      const { $ref, ...siblings } = value;
      return {
        ...expand(api.components.schemas[name], [...stack, name]),
        ...expand(siblings, stack),
      };
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, stack)]));
  }
  const operations = new Map();
  for (const path of Object.values(api.paths))
    for (const [method, op] of Object.entries(path)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      if (operations.has(op.operationId)) throw new Error(`Duplicate operation ${op.operationId}`);
      operations.set(op.operationId, op);
    }
  const mcp = tools.map((tool) => {
    const op = operations.get(tool.operationId);
    if (!op) throw new Error(`Missing tool operation: ${tool.name}`);
    const body = op.requestBody?.content['application/json'].schema;
    let inputSchema;
    if (body) inputSchema = expand(body);
    else {
      const parameters = op.parameters ?? [];
      inputSchema = {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(parameters.map((p) => [p.name, expand(p.schema)])),
        required: parameters.filter((p) => p.required).map((p) => p.name),
      };
    }
    const response = Object.entries(op.responses).find(([code]) => /^2\d\d$/.test(code))?.[1];
    const data = response?.content['application/json'].schema.properties.data;
    if (!data) throw new Error(`Missing JSON success data: ${tool.name}`);
    return { ...tool, inputSchema, outputSchema: expand(data) };
  });
  const rewrite = (v) => {
    if (Array.isArray(v)) return v.map(rewrite);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        k === '$ref' ? x.replace('#/components/schemas/', '#/$defs/') : rewrite(x),
      ]),
    );
  };
  return {
    'openapi.json': api,
    'schemas.json': {
      $schema: api.jsonSchemaDialect,
      $id: 'urn:accremind:contracts:v2',
      $defs: rewrite(api.components.schemas),
    },
    'mcp-tools.json': mcp,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputs = generate();
  const check = process.argv.includes('--check');
  for (const [name, value] of Object.entries(outputs)) {
    const expected = JSON.stringify(value, null, 2) + '\n';
    if (check) {
      if (readFileSync(`${dir}${name}`, 'utf8') !== expected)
        throw new Error(`Contract drift: ${name}; run npm run contracts:generate`);
    } else writeFileSync(`${dir}${name}`, expected);
  }
  console.log(
    check ? 'Contract artifacts match source' : 'Generated OpenAPI, Schema bundle and 8 MCP tools',
  );
}
