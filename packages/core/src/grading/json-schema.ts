import { z } from 'zod';
import type { JsonSchema } from '../types.js';
import { isPlainObject } from '../util.js';

/** The supported subset; any other keyword is rejected when the suite loads (before any spend). */
export const JsonSchemaSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z
    .object({
      type: z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']).optional(),
      properties: z.record(z.string(), JsonSchemaSchema).optional(),
      required: z.array(z.string()).optional(),
      items: JsonSchemaSchema.optional(),
      enum: z.array(z.unknown()).min(1).optional(),
      minItems: z.number().int().nonnegative().optional(),
      additionalProperties: z.boolean().optional(),
    })
    .strict(),
);

export type ExtractResult = { ok: true; value: unknown } | { ok: false; error: string };

const FENCE = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/i;

/** The final answer as JSON: the whole text, or else the first fenced code block. */
export function extractJson(text: string): ExtractResult {
  const candidates = [text.trim()];
  const fenced = FENCE.exec(text)?.[1];
  if (fenced !== undefined) candidates.push(fenced.trim());
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: 'final answer is not JSON (plain, or in a fenced code block)' };
}

/** Every way `value` violates `schema`, as "path: problem" strings (empty when valid). */
export function validateJson(value: unknown, schema: JsonSchema, path = '$'): string[] {
  if (schema.type !== undefined && !hasType(value, schema.type)) return [`${path}: expected ${schema.type}, got ${typeName(value)}`];
  const errors: string[] = [];
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validateJson(value[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} items, got ${value.length}`);
    }
    const items = schema.items;
    if (items !== undefined) value.forEach((v: unknown, i) => errors.push(...validateJson(v, items, `${path}[${i}]`)));
  }
  return errors;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function hasType(v: unknown, t: NonNullable<JsonSchema['type']>): boolean {
  switch (t) {
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'object':
      return isPlainObject(v);
    case 'array':
      return Array.isArray(v);
    case 'null':
      return v === null;
    case 'string':
    case 'boolean':
      return typeof v === t;
  }
}
