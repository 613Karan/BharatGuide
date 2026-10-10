/** zod -> JSON schema for tool definitions (shared by both planners). */
import { z } from 'zod';
import type { ToolDef } from './types';

export function jsonSchemaFor(tool: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  if (schema.type !== 'object') return { type: 'object', properties: {}, additionalProperties: false };
  if (!schema.properties) schema.properties = {};
  return schema;
}
