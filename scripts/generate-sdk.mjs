import openapiTS, { astToString } from 'openapi-typescript';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { root, load } from './generate-contracts.mjs';
const api = load('source/openapi.json');
const ast = await openapiTS(api, { alphabetize: true });
const manifest = {};
for (const [path, item] of Object.entries(api.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    const success = Object.entries(operation.responses).find(([status]) =>
      /^2\d\d$/.test(status),
    )?.[1];
    const schemaName = (schema) => schema?.$ref?.replace('#/components/schemas/', '') ?? null;
    manifest[operation.operationId] = {
      method: method.toUpperCase(),
      path,
      capability: operation['x-capability'],
      requestSchema: schemaName(operation.requestBody?.content['application/json'].schema),
      responseSchema: schemaName(success?.content['application/json'].schema.properties.data),
      parameters: operation.parameters ?? [],
    };
    if (!manifest[operation.operationId].responseSchema)
      throw new Error(`No success data for ${operation.operationId}`);
  }
}
const files = {
  'api.ts': `/** Generated from contracts/source/openapi.json. Do not edit. */\n${astToString(ast)}`,
  'operations.json': JSON.stringify(manifest, null, 2) + '\n',
  'schemas.json': readFileSync(`${root}docs/architecture/contracts/schemas.json`, 'utf8'),
  'mcp-tools.json': readFileSync(`${root}docs/architecture/contracts/mcp-tools.json`, 'utf8'),
};
const directory = `${root}packages/contracts/src/generated/`;
if (!process.argv.includes('--check')) mkdirSync(directory, { recursive: true });
for (const [file, expected] of Object.entries(files)) {
  if (process.argv.includes('--check')) {
    if (readFileSync(`${directory}${file}`, 'utf8') !== expected)
      throw new Error(`Generated SDK drift: ${file}`);
  } else writeFileSync(`${directory}${file}`, expected);
}
console.log(
  'Shared TypeScript, operation map, runtime Schema and MCP artifacts match contract source',
);
