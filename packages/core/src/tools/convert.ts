import type { JsonObject, McpTool, ToolDef } from '../types.js';

export interface ToolMapping {
  defs: ToolDef[];
  toMcpName(fnName: string): string | undefined;
}

export function sanitizeToolName(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return s.length > 0 ? s : 'tool';
}

/** Single conversion point for every model (fairness: identical, name-sorted tool lists). */
export function convertTools(tools: McpTool[]): ToolMapping {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const byFn = new Map<string, string>();
  const defs: ToolDef[] = [];
  for (const tool of sorted) {
    const base = sanitizeToolName(tool.name);
    let fn = base;
    for (let n = 2; byFn.has(fn); n++) {
      const suffix = `_${n}`;
      fn = base.slice(0, 64 - suffix.length) + suffix;
    }
    byFn.set(fn, tool.name);
    defs.push({ name: fn, description: tool.description ?? '', parameters: normalizeSchema(tool.inputSchema) });
  }
  return { defs, toMcpName: (fnName) => byFn.get(fnName) };
}

function normalizeSchema(schema: JsonObject | undefined): JsonObject {
  const s: JsonObject = schema ?? {};
  return { ...s, type: 'object', properties: (s.properties as JsonObject | undefined) ?? {} };
}
