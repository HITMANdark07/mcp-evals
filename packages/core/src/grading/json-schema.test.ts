import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../types.js';
import { extractJson, JsonSchemaSchema, validateJson } from './json-schema.js';

const schema: JsonSchema = {
  type: 'object',
  required: ['name', 'tags'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', enum: ['hono'] },
    count: { type: 'integer' },
    tags: { type: 'array', minItems: 2, items: { type: 'string' } },
  },
};

describe('extractJson', () => {
  it('parses plain JSON and the first fenced block', () => {
    expect(extractJson(' {"a": 1} ')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('Here you go:\n```json\n{"a": 2}\n```\nDone.')).toEqual({ ok: true, value: { a: 2 } });
    expect(extractJson('```\n[1, 2]\n```')).toEqual({ ok: true, value: [1, 2] });
    expect(extractJson('no json here')).toMatchObject({ ok: false, error: expect.stringMatching(/not JSON/) });
  });
});

describe('validateJson', () => {
  it('accepts a matching value', () => {
    expect(validateJson({ name: 'hono', count: 3, tags: ['a', 'b'] }, schema)).toEqual([]);
  });

  it('reports type, enum, required, additionalProperties, minItems and items errors with paths', () => {
    expect(validateJson([], schema)).toEqual(['$: expected object, got array']);
    expect(validateJson({ name: 'express', count: 1.5, tags: ['a', 3], extra: true }, schema)).toEqual([
      '$.name: must be one of ["hono"]',
      '$.count: expected integer, got number',
      '$.tags[1]: expected string, got number',
      '$: unexpected property "extra"',
    ]);
    expect(validateJson({ tags: ['a'] }, schema)).toEqual([
      '$: missing required property "name"',
      '$.tags: expected at least 2 items, got 1',
    ]);
    expect(validateJson(null, { type: 'null' })).toEqual([]);
    expect(validateJson(2, { type: 'number' })).toEqual([]);
  });
});

describe('validateJson own properties', () => {
  it('ignores inherited names for required and properties', () => {
    expect(validateJson({}, { type: 'object', required: ['constructor'] })).toEqual(['$: missing required property "constructor"']);
    expect(validateJson({}, { type: 'object', properties: { toString: { type: 'string' } } } as JsonSchema)).toEqual([]);
    expect(validateJson(JSON.parse('{"constructor":"x"}'), { type: 'object', required: ['constructor'], properties: { constructor: { type: 'string' } } } as JsonSchema)).toEqual([]);
  });
});

describe('JsonSchemaSchema', () => {
  it('accepts the supported subset and rejects other keywords', () => {
    expect(JsonSchemaSchema.safeParse(schema).success).toBe(true);
    expect(JsonSchemaSchema.safeParse({ type: 'array', maxItems: 3 }).success).toBe(false);
    expect(JsonSchemaSchema.safeParse({ type: 'object', properties: { a: { pattern: 'x' } } }).success).toBe(false);
  });
});
