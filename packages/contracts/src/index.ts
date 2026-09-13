import schemaData from './generated/schemas.json' with { type: 'json' };
import toolData from './generated/mcp-tools.json' with { type: 'json' };
import operationData from './generated/operations.json' with { type: 'json' };
import type { components, operations } from './generated/api.js';
import type { AnySchema, ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';

export type { components, operations, paths } from './generated/api.js';
export type SchemaTypes = components['schemas'];
export type SchemaName = keyof SchemaTypes;
export type Disposition = SchemaTypes['Disposition'];
export type Discoverability = SchemaTypes['Discoverability'];
export type ErrorEnvelope = SchemaTypes['Error'];
export type JsonSchema = AnySchema;
export const contractVersion = '2.0.0' as const;
export const validatorOptions = {
  strict: true,
  removeAdditional: false,
  coerceTypes: false,
  useDefaults: false,
  allErrors: true,
} as const;
const bundle = schemaData as unknown as { $id: string; $defs: Record<string, AnySchema> };
const ajv = new Ajv2020(validatorOptions);
(formatsPlugin as unknown as FormatsPlugin)(ajv);
ajv.addSchema(schemaData);
export const dispositions = Object.freeze([
  ...schemaData.$defs.Disposition.enum,
]) as readonly Disposition[];
export const discoverabilities = Object.freeze([
  ...schemaData.$defs.Discoverability.enum,
]) as readonly Discoverability[];
export interface ToolDefinition {
  name: string;
  operationId: keyof operations;
  description: string;
  inputSchema: AnySchema;
  outputSchema: AnySchema;
}
export const mcpTools = toolData as unknown as readonly ToolDefinition[];
export interface OperationDefinition {
  method: string;
  path: string;
  capability: string;
  requestSchema: SchemaName | null;
  responseSchema: SchemaName;
  parameters: { name: string; in: string; required: boolean; schema: AnySchema }[];
}
export const operationManifest = operationData as unknown as Record<
  keyof operations,
  OperationDefinition
>;
export function compileSchema<T = unknown>(schema: AnySchema): ValidateFunction<T> {
  return ajv.compile<T>(schema);
}
export function getValidator<N extends SchemaName>(name: N): ValidateFunction<SchemaTypes[N]> {
  const validate = ajv.getSchema<SchemaTypes[N]>(`${bundle.$id}#/$defs/${name}`);
  if (!validate) throw new Error(`Missing contract schema: ${name}`);
  return validate;
}
export class ContractValidationError extends Error {
  constructor(readonly schemaName: string) {
    super(`Contract validation failed: ${schemaName}`);
    this.name = 'ContractValidationError';
  }
}
export function assertSchema<N extends SchemaName>(
  name: N,
  value: unknown,
): asserts value is SchemaTypes[N] {
  if (!getValidator(name)(value)) throw new ContractValidationError(name);
}
export { createApiClient, ApiClientError } from './client.js';
