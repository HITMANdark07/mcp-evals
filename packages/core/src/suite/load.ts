import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { GraderSpec, ServerSpec, Suite, TaskSpec } from '../types.js';

export class SuiteError extends Error {
  override readonly name = 'SuiteError';
  constructor(
    readonly source: string,
    readonly issues: string[],
  ) {
    super(`Invalid suite ${source}:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  }
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const PLACEHOLDER = /<[^<>\s]*>/;
const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;
const UNPINNED = /([:-]latest$)|(^openrouter\/auto$)/i;

const serverRef = { server: z.string().optional() };
const budget = { value: z.number().int().positive(), strict: z.boolean().default(false), ...serverRef };

const GraderSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('answer_contains_all'), values: z.array(z.string().min(1)).min(1), case_sensitive: z.boolean().default(false), ...serverRef }).strict(),
  z.object({ type: z.literal('answer_matches'), pattern: z.string().min(1), flags: z.string().regex(/^[imsu]*$/, 'flags may only contain i, m, s, u').default(''), ...serverRef }).strict(),
  z.object({ type: z.literal('tool_called'), tool: z.string().min(1), ...serverRef }).strict(),
  z.object({ type: z.literal('tool_not_called'), tool: z.string().min(1), ...serverRef }).strict(),
  z.object({ type: z.literal('tool_args_match'), tool: z.string().min(1), args: z.record(z.string(), z.unknown()), ...serverRef }).strict(),
  z.object({ type: z.literal('fs_state'), path: z.string().min(1), exists: z.boolean().optional(), contains: z.string().optional(), unchanged: z.boolean().optional(), ...serverRef }).strict(),
  z.object({ type: z.literal('max_steps'), ...budget }).strict(),
  z.object({ type: z.literal('max_context_tokens'), ...budget }).strict(),
]);

const ServerSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    url: z.url().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    setup: z.string().min(1).optional(),
  })
  .strict()
  .refine((s) => (s.command === undefined) !== (s.url === undefined), { message: 'server needs exactly one of command or url' });

const TaskSchema = z
  .object({
    id: z.string().regex(NAME, 'task id must be lowercase letters, digits, - or _'),
    prompt: z.string().min(1),
    servers: z.array(z.string()).min(1).optional(),
    max_steps: z.number().int().positive().optional(),
    timeout_s: z.number().positive().optional(),
    graders: z.array(GraderSchema).default([]),
  })
  .strict();

const SuiteSchema = z
  .object({
    suite: z.string().regex(NAME, 'suite name must be lowercase letters, digits, - or _'),
    version: z.number().int().positive(),
    fixture: z
      .object({ git: z.string().min(1), ref: z.string().regex(/^[0-9a-f]{7,40}$/, 'fixture.ref must be a commit sha') })
      .strict()
      .optional(),
    servers: z.record(z.string().regex(NAME, 'server name must be lowercase letters, digits, - or _'), ServerSchema),
    models: z.array(z.string()).min(1),
    defaults: z
      .object({
        repeats: z.number().int().min(1).default(3),
        max_steps: z.number().int().min(1).default(12),
        timeout_s: z.number().positive().default(120),
        temperature: z.number().min(0).max(2).default(0),
      })
      .strict()
      .default({ repeats: 3, max_steps: 12, timeout_s: 120, temperature: 0 }),
    tasks: z.array(TaskSchema).min(1),
  })
  .strict();

type RawSuite = z.infer<typeof SuiteSchema>;
type RawGrader = z.infer<typeof GraderSchema>;

export function parseSuite(text: string, source = 'inline'): Suite {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new SuiteError(source, [`YAML: ${(e as Error).message}`]);
  }
  const parsed = SuiteSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SuiteError(
      source,
      parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`),
    );
  }
  const issues = semanticIssues(parsed.data);
  if (Object.keys(parsed.data.servers).length === 0) issues.push('servers: at least one server is required');
  if (issues.length > 0) throw new SuiteError(source, issues);
  return toSuite(parsed.data, source);
}

export async function loadSuite(path: string): Promise<Suite> {
  return parseSuite(await readFile(path, 'utf8'), path);
}

function semanticIssues(s: RawSuite): string[] {
  const issues: string[] = [];
  const servers = new Set(Object.keys(s.servers));

  if (s.fixture && PLACEHOLDER.test(s.fixture.git)) issues.push('fixture.git contains an unresolved placeholder');

  for (const [name, srv] of Object.entries(s.servers)) {
    const fields = [srv.command, srv.url, srv.setup, ...srv.args, ...Object.values(srv.env)].filter(
      (f): f is string => f !== undefined,
    );
    if (fields.some((f) => PLACEHOLDER.test(f))) issues.push(`servers.${name} contains an unresolved placeholder`);
    if (!s.fixture && fields.some((f) => f.includes('{fixture}'))) {
      issues.push(`servers.${name} uses {fixture} but the suite has no fixture`);
    }
  }

  const seenModels = new Set<string>();
  for (const m of s.models) {
    if (PLACEHOLDER.test(m)) issues.push(`models: "${m}" contains an unresolved placeholder`);
    else if (!MODEL_ID.test(m)) issues.push(`models: "${m}" is not a provider/model id`);
    else if (UNPINNED.test(m)) issues.push(`models: "${m}" is not pinned`);
    if (seenModels.has(m)) issues.push(`models: "${m}" is listed twice`);
    seenModels.add(m);
  }

  const seenTasks = new Set<string>();
  for (const t of s.tasks) {
    if (seenTasks.has(t.id)) issues.push(`duplicate task id "${t.id}"`);
    seenTasks.add(t.id);
    for (const ref of t.servers ?? []) {
      if (!servers.has(ref)) issues.push(`tasks.${t.id}.servers: unknown server "${ref}"`);
    }
    t.graders.forEach((g, i) => {
      const at = `tasks.${t.id}.graders[${i}]`;
      if (g.server !== undefined && !servers.has(g.server)) issues.push(`${at}.server: unknown server "${g.server}"`);
      if (g.type === 'answer_matches') {
        try {
          new RegExp(g.pattern, g.flags);
        } catch (e) {
          issues.push(`${at}: invalid regex: ${(e as Error).message}`);
        }
      }
      if (g.type === 'fs_state') {
        const segments = g.path.split(/[\\/]+/);
        if (isAbsolute(g.path) || g.path.startsWith('\\') || segments.includes('..')) {
          issues.push(`${at}.path must be relative and stay inside the workspace`);
        }
      }
    });
  }
  return issues;
}

function toSuite(s: RawSuite, source: string): Suite {
  const servers: Record<string, ServerSpec> = {};
  for (const [name, srv] of Object.entries(s.servers)) {
    servers[name] = {
      ...(srv.command !== undefined ? { command: srv.command } : {}),
      args: srv.args,
      env: srv.env,
      ...(srv.url !== undefined ? { url: srv.url } : {}),
      headers: srv.headers,
      ...(srv.setup !== undefined ? { setup: srv.setup } : {}),
    };
  }
  const tasks: TaskSpec[] = s.tasks.map((t) => ({
    id: t.id,
    prompt: t.prompt,
    ...(t.servers ? { servers: t.servers } : {}),
    ...(t.max_steps !== undefined ? { maxSteps: t.max_steps } : {}),
    ...(t.timeout_s !== undefined ? { timeoutS: t.timeout_s } : {}),
    graders: t.graders.map(toGrader),
  }));
  return {
    name: s.suite,
    version: s.version,
    source,
    ...(s.fixture ? { fixture: s.fixture } : {}),
    servers,
    models: s.models,
    defaults: {
      repeats: s.defaults.repeats,
      maxSteps: s.defaults.max_steps,
      timeoutS: s.defaults.timeout_s,
      temperature: s.defaults.temperature,
    },
    tasks,
  };
}

function toGrader(g: RawGrader): GraderSpec {
  const server = g.server !== undefined ? { server: g.server } : {};
  switch (g.type) {
    case 'answer_contains_all':
      return { type: g.type, values: g.values, caseSensitive: g.case_sensitive, ...server };
    case 'answer_matches':
      return { type: g.type, pattern: g.pattern, flags: g.flags, ...server };
    case 'tool_called':
    case 'tool_not_called':
      return { type: g.type, tool: g.tool, ...server };
    case 'tool_args_match':
      return { type: g.type, tool: g.tool, args: g.args, ...server };
    case 'fs_state':
      return {
        type: g.type,
        path: g.path,
        ...(g.exists !== undefined ? { exists: g.exists } : {}),
        ...(g.contains !== undefined ? { contains: g.contains } : {}),
        ...(g.unchanged !== undefined ? { unchanged: g.unchanged } : {}),
        ...server,
      };
    case 'max_steps':
    case 'max_context_tokens':
      return { type: g.type, value: g.value, strict: g.strict, ...server };
  }
}
