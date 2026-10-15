# mcp-evals M1 (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working offline evaluation harness: load a suite YAML, run every server × model × task × repeat through our own agent loop against real MCP servers, grade deterministically, aggregate into a versioned `results.json`, and print a table from `mcp-evals run` — using a scripted mock model (OpenRouter arrives in M2).

**Architecture:** pnpm monorepo. `packages/core` holds pure, separately tested units (suite loader, graders, aggregator, tool converter, mock provider, fixture manager, MCP connectors, agent loop, runner) that meet only through the shared types in `types.ts`. `packages/cli` is a thin commander wrapper that wires core together and formats output.

**Tech Stack:** Node ≥20, TypeScript 5 (strict, ESM), pnpm 10.33.0, vitest 2, tsup 8, `@modelcontextprotocol/sdk` ^1.29.0, zod ^4.4.1, yaml ^2.8.0, commander ^12.1.0.

**Spec:** `docs/superpowers/specs/2026-10-15-mcp-evals-design.md` (read §3–§7 and §10 before starting any task).

## Global Constraints

- Node `>=20`; ESM only (`"type": "module"`); TypeScript extends `tsconfig.base.json` exactly as given in Task 1 (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` → use `import type` for types).
- Package manager `pnpm@10.33.0`. Dependency versions: `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.4.1`, `yaml ^2.8.0`, `commander ^12.1.0`, `vitest ^2.1.0`, `tsup ^8.3.0`, `typescript ^5.6.0`, `@types/node ^20.11.0`. Add no other runtime dependencies in M1.
- **Tests never touch the network or spend money.** Models are `MockProvider`; MCP servers are the fake server in `packages/core/test/fixtures/fake-server.mjs`; git fixtures are local repos created in temp dirs.
- `results.json` has `schemaVersion: 1` and must validate against `ResultsSchema` (Task 4).
- Fairness (spec §5.3): one shared `SYSTEM_PROMPT`; tools converted by one function (`convertTools`) and sorted by name; default temperature 0; fresh workspace and fresh server process per run.
- Infra errors (`InfraError`) are never counted as model failures: outcome `error`, excluded from success rate (spec §7).
- License MIT. Workspace package names `@mcp-evals/core` and `@mcp-evals/cli` are `"private": true` in M1 (npm name is decided before M3).
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Deliberate M1 scope cuts** (spec items that land later): `answer_json_schema` and `llm_judge` graders → M2; OpenRouter provider, `compare`, `report`, `--resume` → M2; URL (Streamable HTTP) servers → M2 (loader accepts them, connector rejects with a clear non-retryable error); real tokenizer → M2 (M1 uses `ceil(chars/4)`).

**Spec refinements made here:** `toolAccuracy` is `number | null` (null when a cell has no tool graders); `fixture` is `null` when a suite has none; cells carry `runs`; `runKey` also hashes the suite name.

## Review Focus

1. **MCP tool names that are illegal as model function names** (`dotted.name`, `github/search`): must be sanitized for the model and mapped back to the real MCP name when called — tests in Task 5 and Task 8.
2. **Typos in `--models` / `--servers` or in a task's `servers:`**: must fail loudly before any spend instead of silently running nothing — tests in Task 2 and Task 9.
3. **The MCP server process crashing mid-task**: must become an `error` outcome (retried, stderr captured), never a model `fail` — tests in Task 7 and Task 10.
4. **`fs_state` paths that escape the workspace** (`../x`, `/etc/passwd`): rejected when the suite loads — test in Task 2.
5. **Invalid regex in `answer_matches`**: rejected when the suite loads, not as a crash mid-run after money is spent — test in Task 2.

## Execution notes (parallel agents)

Dependency waves — tasks in the same wave touch disjoint files and can run in parallel, each in its own git worktree/branch, merged after review:

| Wave | Tasks | Depends on |
|---|---|---|
| A | 1 | — |
| B | 2, 3, 4, 5, 6, 7 (parallel) | 1 |
| C | 8 | 5, 7 |
| D | 9 | 2, 3, 4, 6, 8 |
| E | 10 | 9 |

Rules for wave B agents: do **not** edit `package.json`, `pnpm-lock.yaml`, or `packages/core/src/index.ts` (Task 1 installs every core dependency; Task 9 writes the public exports). Import siblings by relative path.

## File Structure

```
mcp-evals/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.config.ts  .gitignore   (Task 1)
  packages/core/
    package.json  tsconfig.json  tsup.config.ts                                         (Task 1)
    src/index.ts            public exports (Task 1 creates, Task 9 completes)
    src/types.ts            all shared types (Task 1)
    src/errors.ts           ProviderError, InfraError, ConfigError (Task 1)
    src/util.ts             tokens, runKey, stats, vars, hashing (Task 1)
    src/suite/load.ts       YAML → validated Suite (Task 2)
    src/graders.ts          deterministic + budget graders, pass rules (Task 3)
    src/results/wilson.ts   Wilson CI (Task 4)
    src/results/schema.ts   ResultsSchema (Task 4)
    src/results/aggregate.ts RunRecord[] → Results (Task 4)
    src/tools/convert.ts    MCP tools → model function tools (Task 5)
    src/providers/mock.ts   scripted MockProvider (Task 5)
    src/fixtures/manager.ts pinned git fixtures → per-run workspaces (Task 6)
    src/mcp/connection.ts   stdio + in-memory connectors (Task 7)
    src/mcp/setup.ts        server setup command (Task 7)
    src/agent/loop.ts       the agent loop (Task 8)
    src/runner/run.ts       orchestration, retries, budget (Task 9)
    test/fixtures/fake-server.mjs (+ .d.mts)  fake MCP server, in-memory or stdio (Task 7)
  packages/cli/
    package.json  tsconfig.json  tsup.config.ts                                         (Task 10)
    src/index.ts  src/version.ts  src/commands/run.ts  src/report/table.ts              (Task 10)
```

---

### Task 1: Monorepo scaffold, shared types, errors, utilities

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/tsup.config.ts`
- Create: `packages/core/src/types.ts`, `packages/core/src/errors.ts`, `packages/core/src/util.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/util.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every type in `types.ts` (used by all tasks); `ProviderError(message, retryable, status?)`, `InfraError(kind, message, retryable)`, `ConfigError(message)`; `estimateTokens(text): number`, `runKey(parts): string`, `mean(xs): number`, `median(xs): number`, `substituteVars(s, vars): string`, `isPlainObject(v): v is JsonObject`, `sha256Hex(data): string`, `sleep(ms): Promise<void>`.

- [ ] **Step 1: Write root config files**

`package.json`:
```json
{
  "name": "mcp-evals-monorepo",
  "version": "0.0.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "packageManager": "pnpm@10.33.0",
  "scripts": {
    "build": "pnpm -r --filter \"./packages/*\" build",
    "test": "vitest run",
    "typecheck": "pnpm --filter @mcp-evals/core build && pnpm -r --filter \"./packages/*\" typecheck"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "tsup": "^8.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - apps/*
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "exclude": ["node_modules", "dist"]
}
```

`vitest.config.ts`:
```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@mcp-evals/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
```

`.gitignore`:
```
node_modules/
dist/
coverage/
.mcp-evals/
*.tsbuildinfo
```

`LICENSE`: the standard MIT license text with `Copyright (c) 2026 Shekhar Kumar`.

- [ ] **Step 2: Write `packages/core` package files**

`packages/core/package.json`:
```json
{
  "name": "@mcp-evals/core",
  "version": "0.0.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "yaml": "^2.8.0",
    "zod": "^4.4.1"
  }
}
```

`packages/core/tsconfig.json` (no `rootDir`: tests import `../../test/fixtures`):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*", "test/**/*"]
}
```

`packages/core/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
});
```

- [ ] **Step 3: Install dependencies**

Run: `cd ~/Desktop/mcp-evals && pnpm install`
Expected: lockfile created, no errors.

- [ ] **Step 4: Write `packages/core/src/types.ts`**

```ts
export type JsonObject = Record<string, unknown>;

// ---- Suites --------------------------------------------------------------
export interface FixtureSpec {
  git: string;
  ref: string;
}

export interface ServerSpec {
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  setup?: string;
}

interface GraderBase {
  /** When set, the grader only applies to runs against this server; otherwise it is skipped. */
  server?: string;
}

export type GraderSpec =
  | (GraderBase & { type: 'answer_contains_all'; values: string[]; caseSensitive: boolean })
  | (GraderBase & { type: 'answer_matches'; pattern: string; flags: string })
  | (GraderBase & { type: 'tool_called'; tool: string })
  | (GraderBase & { type: 'tool_not_called'; tool: string })
  | (GraderBase & { type: 'tool_args_match'; tool: string; args: JsonObject })
  | (GraderBase & { type: 'fs_state'; path: string; exists?: boolean; contains?: string; unchanged?: boolean })
  | (GraderBase & { type: 'max_steps'; value: number; strict: boolean })
  | (GraderBase & { type: 'max_context_tokens'; value: number; strict: boolean });

export type GraderType = GraderSpec['type'];

export interface TaskSpec {
  id: string;
  prompt: string;
  servers?: string[];
  maxSteps?: number;
  timeoutS?: number;
  graders: GraderSpec[];
}

export interface RunDefaults {
  repeats: number;
  maxSteps: number;
  timeoutS: number;
  temperature: number;
}

export interface Suite {
  name: string;
  version: number;
  /** Path (or label) the suite was loaded from. */
  source: string;
  fixture?: FixtureSpec;
  servers: Record<string, ServerSpec>;
  models: string[];
  defaults: RunDefaults;
  tasks: TaskSpec[];
}

// ---- Models --------------------------------------------------------------
export interface ToolCall {
  id: string;
  /** Function name as the model sees it (sanitized). */
  name: string;
  /** Raw JSON string exactly as the model produced it. */
  arguments: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonObject;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  temperature: number;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  latencyMs: number;
}

export interface ModelProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

// ---- MCP -----------------------------------------------------------------
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

export interface McpConnection {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: JsonObject, timeoutMs: number): Promise<ToolCallResult>;
  /** Captured server stderr (stdio servers only; '' otherwise). */
  stderr(): string;
  /** Never throws. */
  close(): Promise<void>;
}

export interface ConnectContext {
  cwd: string;
  vars: Record<string, string>;
}

export type Connector = (server: ServerSpec, ctx: ConnectContext) => Promise<McpConnection>;

// ---- Traces & records ----------------------------------------------------
/** `t` is milliseconds since the run started. `step` is the 1-based model-call number. */
export type TraceEvent =
  | { type: 'model_call'; step: number; t: number; latencyMs: number; promptTokens: number; completionTokens: number; costUsd: number }
  | { type: 'tool_call'; step: number; t: number; callId: string; tool: string; args: JsonObject | null; rawArgs: string }
  | { type: 'tool_result'; step: number; t: number; callId: string; tool: string; isError: boolean; tokens: number; latencyMs: number; preview: string }
  | { type: 'final_answer'; step: number; t: number; text: string }
  | { type: 'error'; step: number; t: number; kind: string; message: string };

export type LoopEnd = 'final_answer' | 'max_steps' | 'timeout' | 'budget' | 'invalid_tool_call' | 'infra_error';

export interface GraderResult {
  type: GraderType;
  pass: boolean;
  /** Not applicable to this run's server. */
  skipped: boolean;
  /** Budget graders are recorded but do not decide pass/fail unless strict. */
  budget: boolean;
  detail: string;
}

export type Outcome = 'pass' | 'fail' | 'error';

export interface Trace {
  runKey: string;
  suite: string;
  server: string;
  model: string;
  task: string;
  repeat: number;
  events: TraceEvent[];
  serverStderr: string;
}

export interface RunRecord {
  runKey: string;
  suite: string;
  server: string;
  model: string;
  task: string;
  repeat: number;
  outcome: Outcome;
  end: LoopEnd | null;
  failReason?: string;
  graders: GraderResult[];
  toolSelectionOk: boolean | null;
  steps: number;
  contextTokens: number;
  latencyMs: number;
  costUsd: number;
  attempts: number;
  trace: Trace;
}
```

- [ ] **Step 5: Write `packages/core/src/errors.ts`**

```ts
export type InfraKind = 'provider' | 'server' | 'setup' | 'fixture';

/** Thrown by ModelProvider implementations. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Infrastructure failure: never counted as a model failure. */
export class InfraError extends Error {
  override readonly name = 'InfraError';
  constructor(
    readonly kind: InfraKind,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Bad user input (flags, filters) detected before any spend. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}
```

- [ ] **Step 6: Write the failing test `packages/core/src/util.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { estimateTokens, isPlainObject, mean, median, runKey, sha256Hex, substituteVars } from './util.js';

describe('estimateTokens', () => {
  it('is ceil(chars / 4) and 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abcdefghi')).toBe(3);
  });
});

describe('runKey', () => {
  const base = { suite: 's', server: 'srv', model: 'a/b', task: 't', repeat: 0 };
  it('is a stable 16-char hex hash', () => {
    expect(runKey(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(runKey(base)).toBe(runKey({ ...base }));
  });
  it('differs when any part differs', () => {
    const keys = new Set([
      runKey(base),
      runKey({ ...base, suite: 's2' }),
      runKey({ ...base, server: 'x' }),
      runKey({ ...base, model: 'a/c' }),
      runKey({ ...base, task: 'u' }),
      runKey({ ...base, repeat: 1 }),
    ]);
    expect(keys.size).toBe(6);
  });
});

describe('mean / median', () => {
  it('handles empty, odd, and even inputs', () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
    expect(mean([1, 2, 3, 6])).toBe(3);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('substituteVars', () => {
  it('replaces known {vars} and leaves unknown ones', () => {
    expect(substituteVars('{fixture}/src {other}', { fixture: '/w' })).toBe('/w/src {other}');
  });
});

describe('isPlainObject / sha256Hex', () => {
  it('detects plain objects only', () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
  });
  it('hashes strings and buffers identically', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'));
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/util.test.ts`
Expected: FAIL — cannot resolve `./util.js`.

- [ ] **Step 8: Write `packages/core/src/util.ts`**

```ts
import { createHash } from 'node:crypto';
import type { JsonObject } from './types.js';

/** M1 token estimate; replaced by a real tokenizer in M2. */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

export function runKey(parts: { suite: string; server: string; model: string; task: string; repeat: number }): string {
  return createHash('sha256')
    .update([parts.suite, parts.server, parts.model, parts.task, String(parts.repeat)].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Replaces `{name}` for every name present in `vars`; leaves others untouched. */
export function substituteVars(s: string, vars: Record<string, string>): string {
  return s.replace(/\{([a-z_]+)\}/g, (match, name: string) => vars[name] ?? match);
}

export function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 9: Write `packages/core/src/index.ts`** (Task 9 extends it)

```ts
export * from './types.js';
export * from './errors.js';
export * from './util.js';
```

- [ ] **Step 10: Run tests and typecheck**

Run: `pnpm vitest run packages/core/src/util.test.ts && pnpm --filter @mcp-evals/core typecheck`
Expected: all tests PASS; typecheck exits 0.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo with core types, errors, and utils

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Suite loader

**Files:**
- Create: `packages/core/src/suite/load.ts`
- Test: `packages/core/src/suite/load.test.ts`

**Interfaces:**
- Consumes: `Suite`, `ServerSpec`, `TaskSpec`, `GraderSpec` from `../types.js`.
- Produces: `parseSuite(text: string, source?: string): Suite`, `loadSuite(path: string): Promise<Suite>`, `class SuiteError extends Error { source: string; issues: string[] }`.

YAML uses snake_case (`max_steps`, `timeout_s`, `case_sensitive`); the returned `Suite` uses camelCase. The top-level YAML key `suite` becomes `Suite.name`.

- [ ] **Step 1: Write the failing test `packages/core/src/suite/load.test.ts`**

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSuite, parseSuite, SuiteError } from './load.js';

interface Parts {
  fixture?: string;
  servers?: string;
  models?: string;
  tasks?: string;
}

function yaml(p: Parts = {}): string {
  return [
    'suite: demo',
    'version: 1',
    p.fixture ?? '',
    p.servers ?? 'servers:\n  fake: { command: node, args: ["server.mjs"] }',
    p.models ?? 'models: [mock/model-a, mock/model-b]',
    p.tasks ??
      [
        'tasks:',
        '  - id: echo',
        '    prompt: "Say hi using echo"',
        '    max_steps: 4',
        '    graders:',
        '      - { type: answer_contains_all, values: [hi] }',
        '      - { type: max_steps, value: 3 }',
      ].join('\n'),
  ].join('\n');
}

function issuesOf(text: string): string {
  try {
    parseSuite(text, 't');
  } catch (e) {
    if (e instanceof SuiteError) return e.issues.join('\n');
    throw e;
  }
  throw new Error('expected SuiteError');
}

const task = (graders: string, extra = '') =>
  `tasks:\n  - id: t1\n    prompt: p${extra}\n    graders:\n${graders}`;

describe('parseSuite', () => {
  it('parses a valid suite, applies defaults, and maps to camelCase', () => {
    const s = parseSuite(yaml(), 'demo.yaml');
    expect(s.name).toBe('demo');
    expect(s.source).toBe('demo.yaml');
    expect(s.defaults).toEqual({ repeats: 3, maxSteps: 12, timeoutS: 120, temperature: 0 });
    expect(s.servers.fake).toEqual({ command: 'node', args: ['server.mjs'], env: {}, headers: {} });
    expect(s.tasks[0]!.maxSteps).toBe(4);
    expect(s.tasks[0]!.graders).toEqual([
      { type: 'answer_contains_all', values: ['hi'], caseSensitive: false },
      { type: 'max_steps', value: 3, strict: false },
    ]);
    expect(s.fixture).toBeUndefined();
  });

  it('accepts a pinned fixture and {fixture} in server args', () => {
    const s = parseSuite(
      yaml({
        fixture: 'fixture: { git: "https://example.com/r.git", ref: "0123abcd" }',
        servers: 'servers:\n  fs: { command: npx, args: ["srv", "{fixture}"] }',
      }),
    );
    expect(s.fixture).toEqual({ git: 'https://example.com/r.git', ref: '0123abcd' });
  });

  it('rejects YAML syntax errors', () => {
    expect(issuesOf('suite: [unclosed')).toMatch(/YAML/);
  });

  it('rejects unknown grader types', () => {
    expect(issuesOf(yaml({ tasks: task('      - { type: vibes }') }))).toMatch(/tasks\.0\.graders\.0/);
  });

  it('rejects duplicate task ids', () => {
    const tasks = 'tasks:\n  - { id: a, prompt: x }\n  - { id: a, prompt: y }';
    expect(issuesOf(yaml({ tasks }))).toMatch(/duplicate task id "a"/);
  });

  it('rejects unknown servers referenced by tasks and graders', () => {
    expect(issuesOf(yaml({ tasks: task('      - { type: tool_called, tool: x }', '\n    servers: [nope]') }))).toMatch(
      /tasks\.t1\.servers: unknown server "nope"/,
    );
    expect(issuesOf(yaml({ tasks: task('      - { type: tool_called, tool: x, server: ghost }') }))).toMatch(
      /tasks\.t1\.graders\[0\]\.server: unknown server "ghost"/,
    );
  });

  it('rejects placeholder, unpinned, and malformed model ids', () => {
    expect(issuesOf(yaml({ models: 'models: ["anthropic/<sonnet>"]' }))).toMatch(/unresolved placeholder/);
    expect(issuesOf(yaml({ models: 'models: [openrouter/auto]' }))).toMatch(/not pinned/);
    expect(issuesOf(yaml({ models: 'models: [openai/gpt-latest]' }))).toMatch(/not pinned/);
    expect(issuesOf(yaml({ models: 'models: [gpt4]' }))).toMatch(/not a provider\/model id/);
  });

  it('rejects unpinned fixture refs and placeholder fixture urls', () => {
    expect(issuesOf(yaml({ fixture: 'fixture: { git: "https://x/r.git", ref: main }' }))).toMatch(/commit sha/);
    expect(issuesOf(yaml({ fixture: 'fixture: { git: "https://github.com/<org>/r", ref: "0123abcd" }' }))).toMatch(
      /fixture\.git contains an unresolved placeholder/,
    );
  });

  it('rejects {fixture} when the suite has no fixture', () => {
    expect(issuesOf(yaml({ servers: 'servers:\n  fs: { command: npx, args: ["{fixture}"] }' }))).toMatch(
      /servers\.fs uses \{fixture\} but the suite has no fixture/,
    );
  });

  it('rejects servers with neither or both of command and url', () => {
    expect(issuesOf(yaml({ servers: 'servers:\n  x: { args: [] }' }))).toMatch(/exactly one of command or url/);
  });

  // Review Focus 4
  it('rejects fs_state paths that escape the workspace', () => {
    expect(issuesOf(yaml({ tasks: task('      - { type: fs_state, path: ../secret }') }))).toMatch(
      /must be relative and stay inside the workspace/,
    );
    expect(issuesOf(yaml({ tasks: task('      - { type: fs_state, path: /etc/passwd }') }))).toMatch(
      /must be relative and stay inside the workspace/,
    );
  });

  // Review Focus 5
  it('rejects invalid regex in answer_matches', () => {
    expect(issuesOf(yaml({ tasks: task('      - { type: answer_matches, pattern: "([a-z" }') }))).toMatch(/invalid regex/);
  });
});

describe('loadSuite', () => {
  it('reads a file and records its path as source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suite-'));
    const path = join(dir, 's.yaml');
    await writeFile(path, yaml());
    const s = await loadSuite(path);
    expect(s.source).toBe(path);
    expect(s.tasks).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/suite/load.test.ts`
Expected: FAIL — cannot resolve `./load.js`.

- [ ] **Step 3: Write `packages/core/src/suite/load.ts`**

```ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/core/src/suite/load.test.ts && pnpm --filter @mcp-evals/core typecheck`
Expected: all PASS; typecheck exits 0. If a zod issue message differs from a regex in the test, fix the code's own messages (the semantic ones above are exact); only the "unknown grader type" test matches on the path, which zod always includes.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/suite
git commit -m "feat(core): suite loader with validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Graders and pass rules

**Files:**
- Create: `packages/core/src/graders.ts`
- Test: `packages/core/src/graders.test.ts`

**Interfaces:**
- Consumes: `GraderSpec`, `GraderResult`, `LoopEnd`, `TraceEvent`, `JsonObject` from `./types.js`; `isPlainObject`, `sha256Hex` from `./util.js`.
- Produces:
  - `interface GradeContext { server: string; finalAnswer: string | null; events: TraceEvent[]; steps: number; contextTokens: number; workspace: { dir: string; snapshot: Map<string, string> } }` — `snapshot` maps posix relative path → sha256 hex of the file **before** the run.
  - `runGraders(specs: GraderSpec[], ctx: GradeContext): Promise<GraderResult[]>`
  - `taskPassed(results: GraderResult[], end: LoopEnd | null): boolean` — true iff `end === 'final_answer'` and every non-skipped, non-budget grader passed (a task with no applicable graders passes on any final answer).
  - `toolSelectionOk(results: GraderResult[], end: LoopEnd | null): boolean | null` — false if `end === 'invalid_tool_call'`; null if no applicable `tool_called`/`tool_args_match` graders; else whether all of those passed.
  - `describeFailures(results: GraderResult[]): string`

- [ ] **Step 1: Write the failing test `packages/core/src/graders.test.ts`**

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeFailures, runGraders, taskPassed, toolSelectionOk, type GradeContext } from './graders.js';
import type { GraderSpec, TraceEvent } from './types.js';
import { sha256Hex } from './util.js';

const call = (tool: string, args: Record<string, unknown> | null): TraceEvent => ({
  type: 'tool_call', step: 1, t: 0, callId: 'c', tool, args, rawArgs: JSON.stringify(args),
});

function ctx(over: Partial<GradeContext> = {}): GradeContext {
  return {
    server: 'fake',
    finalAnswer: 'Found it in src/A.ts and src/b.ts',
    events: [],
    steps: 2,
    contextTokens: 100,
    workspace: { dir: tmpdir(), snapshot: new Map() },
    ...over,
  };
}

async function one(spec: GraderSpec, c: GradeContext = ctx()) {
  const [r] = await runGraders([spec], c);
  return r!;
}

describe('answer graders', () => {
  it('answer_contains_all is case-insensitive by default and lists missing values', async () => {
    expect((await one({ type: 'answer_contains_all', values: ['SRC/a.ts', 'src/b.ts'], caseSensitive: false })).pass).toBe(true);
    const r = await one({ type: 'answer_contains_all', values: ['src/a.ts', 'src/c.ts'], caseSensitive: true });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('src/a.ts');
    expect(r.detail).toContain('src/c.ts');
  });
  it('fails answer graders when there is no final answer', async () => {
    const r = await one({ type: 'answer_matches', pattern: '.*', flags: '' }, ctx({ finalAnswer: null }));
    expect(r.pass).toBe(false);
    expect(r.detail).toBe('no final answer');
  });
  it('answer_matches uses the regex and flags', async () => {
    expect((await one({ type: 'answer_matches', pattern: 'found IT', flags: 'i' })).pass).toBe(true);
    expect((await one({ type: 'answer_matches', pattern: '^nope$', flags: '' })).pass).toBe(false);
  });
});

describe('tool graders', () => {
  const events = [call('echo', { text: 'hi', opts: { loud: true, n: 2 } }), call('read_file', null)];
  it('tool_called / tool_not_called', async () => {
    expect((await one({ type: 'tool_called', tool: 'echo' }, ctx({ events }))).pass).toBe(true);
    expect((await one({ type: 'tool_called', tool: 'big' }, ctx({ events }))).pass).toBe(false);
    expect((await one({ type: 'tool_not_called', tool: 'big' }, ctx({ events }))).pass).toBe(true);
  });
  it('tool_args_match does deep partial matching and ignores calls with invalid args', async () => {
    expect((await one({ type: 'tool_args_match', tool: 'echo', args: { opts: { loud: true } } }, ctx({ events }))).pass).toBe(true);
    expect((await one({ type: 'tool_args_match', tool: 'echo', args: { opts: { loud: false } } }, ctx({ events }))).pass).toBe(false);
    expect((await one({ type: 'tool_args_match', tool: 'read_file', args: {} }, ctx({ events }))).pass).toBe(false);
  });
  it('skips graders bound to another server', async () => {
    const r = await one({ type: 'tool_called', tool: 'echo', server: 'other' }, ctx({ events }));
    expect(r).toMatchObject({ skipped: true, pass: true });
  });
});

describe('fs_state', () => {
  it('checks exists, contains, and unchanged against the snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-'));
    await writeFile(join(dir, 'a.txt'), 'hello world');
    await writeFile(join(dir, 'same.txt'), 'x');
    const snapshot = new Map([['same.txt', sha256Hex('x')], ['a.txt', sha256Hex('old')]]);
    const c = ctx({ workspace: { dir, snapshot } });
    expect((await one({ type: 'fs_state', path: 'a.txt' }, c)).pass).toBe(true);
    expect((await one({ type: 'fs_state', path: 'missing.txt' }, c)).pass).toBe(false);
    expect((await one({ type: 'fs_state', path: 'missing.txt', exists: false }, c)).pass).toBe(true);
    expect((await one({ type: 'fs_state', path: 'a.txt', contains: 'world' }, c)).pass).toBe(true);
    expect((await one({ type: 'fs_state', path: './same.txt', unchanged: true }, c)).pass).toBe(true);
    expect((await one({ type: 'fs_state', path: 'a.txt', unchanged: true }, c)).pass).toBe(false);
  });
});

describe('budget graders', () => {
  it('are recorded as budget unless strict', async () => {
    const r = await one({ type: 'max_steps', value: 1, strict: false });
    expect(r).toMatchObject({ pass: false, budget: true });
    expect((await one({ type: 'max_context_tokens', value: 50, strict: true })).budget).toBe(false);
  });
});

describe('pass rules', () => {
  const r = (over: Partial<import('./types.js').GraderResult>) => ({ type: 'tool_called' as const, pass: true, skipped: false, budget: false, detail: '', ...over });
  it('taskPassed requires a final answer and all non-budget graders', () => {
    expect(taskPassed([], 'final_answer')).toBe(true);
    expect(taskPassed([], 'max_steps')).toBe(false);
    expect(taskPassed([r({ pass: false, budget: true })], 'final_answer')).toBe(true);
    expect(taskPassed([r({ pass: false, skipped: true })], 'final_answer')).toBe(true);
    expect(taskPassed([r({ pass: false })], 'final_answer')).toBe(false);
  });
  it('toolSelectionOk', () => {
    expect(toolSelectionOk([], 'final_answer')).toBeNull();
    expect(toolSelectionOk([], 'invalid_tool_call')).toBe(false);
    expect(toolSelectionOk([r({ pass: true })], 'final_answer')).toBe(true);
    expect(toolSelectionOk([r({ pass: false })], 'final_answer')).toBe(false);
  });
  it('describeFailures lists failing decisive graders', () => {
    expect(describeFailures([r({ pass: false, detail: 'echo not called' }), r({ pass: false, budget: true })])).toBe(
      'tool_called: echo not called',
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/graders.test.ts`
Expected: FAIL — cannot resolve `./graders.js`.

- [ ] **Step 3: Write `packages/core/src/graders.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { GraderResult, GraderSpec, LoopEnd, TraceEvent } from './types.js';
import { isPlainObject, sha256Hex } from './util.js';

export interface GradeContext {
  server: string;
  finalAnswer: string | null;
  events: TraceEvent[];
  steps: number;
  contextTokens: number;
  workspace: { dir: string; snapshot: Map<string, string> };
}

const TOOL_TYPES = new Set<GraderResult['type']>(['tool_called', 'tool_args_match']);

export async function runGraders(specs: GraderSpec[], ctx: GradeContext): Promise<GraderResult[]> {
  const results: GraderResult[] = [];
  for (const spec of specs) {
    if (spec.server !== undefined && spec.server !== ctx.server) {
      results.push({ type: spec.type, pass: true, skipped: true, budget: false, detail: `only applies to server "${spec.server}"` });
      continue;
    }
    results.push(await gradeOne(spec, ctx));
  }
  return results;
}

export function taskPassed(results: GraderResult[], end: LoopEnd | null): boolean {
  if (end !== 'final_answer') return false;
  return results.filter((r) => !r.skipped && !r.budget).every((r) => r.pass);
}

export function toolSelectionOk(results: GraderResult[], end: LoopEnd | null): boolean | null {
  if (end === 'invalid_tool_call') return false;
  const tool = results.filter((r) => !r.skipped && TOOL_TYPES.has(r.type));
  if (tool.length === 0) return null;
  return tool.every((r) => r.pass);
}

export function describeFailures(results: GraderResult[]): string {
  return results
    .filter((r) => !r.skipped && !r.budget && !r.pass)
    .map((r) => `${r.type}: ${r.detail}`)
    .join('; ');
}

function result(spec: GraderSpec, pass: boolean, detail: string): GraderResult {
  const budget = (spec.type === 'max_steps' || spec.type === 'max_context_tokens') && !spec.strict;
  return { type: spec.type, pass, skipped: false, budget, detail };
}

function toolCalls(events: TraceEvent[]) {
  return events.filter((e): e is Extract<TraceEvent, { type: 'tool_call' }> => e.type === 'tool_call');
}

async function gradeOne(spec: GraderSpec, ctx: GradeContext): Promise<GraderResult> {
  switch (spec.type) {
    case 'answer_contains_all': {
      if (ctx.finalAnswer === null) return result(spec, false, 'no final answer');
      const norm = (s: string) => (spec.caseSensitive ? s : s.toLowerCase());
      const hay = norm(ctx.finalAnswer);
      const missing = spec.values.filter((v) => !hay.includes(norm(v)));
      return result(spec, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'all values present');
    }
    case 'answer_matches': {
      if (ctx.finalAnswer === null) return result(spec, false, 'no final answer');
      const ok = new RegExp(spec.pattern, spec.flags).test(ctx.finalAnswer);
      return result(spec, ok, ok ? `matches /${spec.pattern}/` : `does not match /${spec.pattern}/`);
    }
    case 'tool_called': {
      const n = toolCalls(ctx.events).filter((c) => c.tool === spec.tool).length;
      return result(spec, n > 0, n > 0 ? `${spec.tool} called ${n} time(s)` : `${spec.tool} not called`);
    }
    case 'tool_not_called': {
      const n = toolCalls(ctx.events).filter((c) => c.tool === spec.tool).length;
      return result(spec, n === 0, n === 0 ? `${spec.tool} not called` : `${spec.tool} called ${n} time(s)`);
    }
    case 'tool_args_match': {
      const ok = toolCalls(ctx.events).some((c) => c.tool === spec.tool && c.args !== null && partialMatch(spec.args, c.args));
      return result(spec, ok, ok ? `${spec.tool} called with matching args` : `no ${spec.tool} call with matching args`);
    }
    case 'fs_state': {
      const rel = posix.normalize(spec.path.split('\\').join('/'));
      const buf = await readFile(join(ctx.workspace.dir, rel)).catch(() => null);
      const failures: string[] = [];
      const asserted = spec.exists !== undefined || spec.contains !== undefined || spec.unchanged !== undefined;
      if (!asserted && buf === null) failures.push('expected file to exist');
      if (spec.exists !== undefined && (buf !== null) !== spec.exists) failures.push(`expected exists=${spec.exists}`);
      if (spec.contains !== undefined && !(buf !== null && buf.toString('utf8').includes(spec.contains))) {
        failures.push(`does not contain ${JSON.stringify(spec.contains)}`);
      }
      if (spec.unchanged) {
        const before = ctx.workspace.snapshot.get(rel);
        const after = buf === null ? undefined : sha256Hex(buf);
        if (before !== after) failures.push('file changed');
      }
      return result(spec, failures.length === 0, failures.length ? `${rel}: ${failures.join(', ')}` : `${rel}: ok`);
    }
    case 'max_steps':
      return result(spec, ctx.steps <= spec.value, `${ctx.steps} steps (limit ${spec.value})`);
    case 'max_context_tokens':
      return result(spec, ctx.contextTokens <= spec.value, `${ctx.contextTokens} context tokens (limit ${spec.value})`);
  }
}

function partialMatch(expected: unknown, actual: unknown): boolean {
  if (isPlainObject(expected)) {
    return isPlainObject(actual) && Object.entries(expected).every(([k, v]) => partialMatch(v, actual[k]));
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((v, i) => partialMatch(v, actual[i]));
  }
  return Object.is(expected, actual);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/core/src/graders.test.ts && pnpm --filter @mcp-evals/core typecheck`
Expected: all PASS; exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/graders.ts packages/core/src/graders.test.ts
git commit -m "feat(core): deterministic and budget graders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Results schema, Wilson CI, aggregator

**Files:**
- Create: `packages/core/src/results/wilson.ts`, `packages/core/src/results/schema.ts`, `packages/core/src/results/aggregate.ts`
- Test: `packages/core/src/results/aggregate.test.ts`

**Interfaces:**
- Consumes: `RunRecord`, `Suite` from `../types.js`; `mean`, `median` from `../util.js`.
- Produces: `wilson(successes: number, n: number, z?: number): [number, number]`; `ResultsSchema` (zod) and `type Results`; `interface AggregateInput { records: RunRecord[]; suites: Suite[]; providerName: string; harnessVersion: string; runId: string; startedAt: string; finishedAt: string; partial: boolean; totalCostUsd: number }`; `aggregate(input: AggregateInput): Results`.

Cell rules: `runs` = all records in the cell; `successRate = passes / (passes + fails)` (errors excluded; 0 with CI `[0, 1]` when there are no completed runs); `errorRate = errors / runs`; token/step/latency/cost stats over completed (non-error) runs; `toolAccuracy` = share of `true` among non-null `toolSelectionOk`, or null; cells ordered by suite server order then model order; tasks ordered by suite task order; `traceRef` = runKey of the lowest repeat.

- [ ] **Step 1: Write the failing test `packages/core/src/results/aggregate.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { RunRecord, Suite } from '../types.js';
import { aggregate } from './aggregate.js';
import { ResultsSchema } from './schema.js';
import { wilson } from './wilson.js';

describe('wilson', () => {
  it('matches reference values', () => {
    const [lo1, hi1] = wilson(5, 10);
    expect(lo1).toBeCloseTo(0.2366, 4);
    expect(hi1).toBeCloseTo(0.7634, 4);
    const [lo2, hi2] = wilson(0, 10);
    expect(lo2).toBe(0);
    expect(hi2).toBeCloseTo(0.2775, 4);
    const [lo3, hi3] = wilson(10, 10);
    expect(lo3).toBeCloseTo(0.7225, 4);
    expect(hi3).toBe(1);
  });
  it('returns [0, 1] when n is 0', () => {
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});

const suite: Suite = {
  name: 'demo',
  version: 2,
  source: 'demo.yaml',
  servers: {
    fake: { command: 'node', args: [], env: {}, headers: {} },
    other: { command: 'node', args: [], env: {}, headers: {} },
  },
  models: ['m/a', 'm/b'],
  defaults: { repeats: 2, maxSteps: 5, timeoutS: 10, temperature: 0 },
  tasks: [
    { id: 't1', prompt: 'p', graders: [] },
    { id: 't2', prompt: 'q', graders: [] },
  ],
};

let n = 0;
function rec(over: Partial<RunRecord>): RunRecord {
  const key = `k${n++}`;
  return {
    runKey: key, suite: 'demo', server: 'fake', model: 'm/a', task: 't1', repeat: 0,
    outcome: 'pass', end: 'final_answer', graders: [], toolSelectionOk: null,
    steps: 2, contextTokens: 100, latencyMs: 50, costUsd: 0.01, attempts: 1,
    trace: { runKey: key, suite: 'demo', server: 'fake', model: 'm/a', task: 't1', repeat: 0, events: [], serverStderr: '' },
    ...over,
  };
}

const meta = {
  providerName: 'mock', harnessVersion: '0.0.0', runId: 'r1',
  startedAt: '2026-10-15T00:00:00.000Z', finishedAt: '2026-10-15T00:01:00.000Z', partial: false, totalCostUsd: 0.05,
};

describe('aggregate', () => {
  it('builds cells with success, CI, tool accuracy, stats, errors, and tasks', () => {
    const records = [
      rec({ task: 't1', repeat: 1, runKey: 'r-t1-1', toolSelectionOk: true, contextTokens: 100, steps: 2 }),
      rec({ task: 't1', repeat: 0, runKey: 'r-t1-0', toolSelectionOk: false, contextTokens: 300, steps: 4, outcome: 'fail', end: 'max_steps' }),
      rec({ task: 't2', repeat: 0, runKey: 'r-t2-0', contextTokens: 200, steps: 3 }),
      rec({ task: 't2', repeat: 1, runKey: 'r-t2-1', outcome: 'error', end: 'infra_error', contextTokens: 9999 }),
      rec({ model: 'm/b', task: 't1' }),
    ];
    const results = aggregate({ records, suites: [suite], ...meta });
    expect(() => ResultsSchema.parse(results)).not.toThrow();
    expect(results.schemaVersion).toBe(1);
    expect(results.suites[0]!.fixture).toBeNull();
    expect(results.suites[0]!.models).toEqual([{ id: 'm/a', provider: 'mock' }, { id: 'm/b', provider: 'mock' }]);

    const cells = results.suites[0]!.cells;
    expect(cells.map((c) => `${c.server}|${c.model}`)).toEqual(['fake|m/a', 'fake|m/b']);
    const a = cells[0]!;
    expect(a.runs).toBe(4);
    expect(a.successRate).toBeCloseTo(2 / 3, 6);
    expect(a.successCi95).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));
    expect(a.errorRate).toBe(0.25);
    expect(a.toolAccuracy).toBe(0.5);
    expect(a.contextTokensPerTask).toEqual({ mean: 200, median: 200 });
    expect(a.stepsPerTask).toBe(3);
    expect(a.tasks).toEqual([
      { id: 't1', passes: 1, fails: 1, errors: 0, traceRef: 'r-t1-0' },
      { id: 't2', passes: 1, fails: 0, errors: 1, traceRef: 'r-t2-0' },
    ]);
    expect(cells[1]!.toolAccuracy).toBeNull();
  });

  it('reports 0 success with CI [0,1] when every run errored', () => {
    const results = aggregate({ records: [rec({ outcome: 'error', end: 'infra_error' })], suites: [suite], ...meta });
    const c = results.suites[0]!.cells[0]!;
    expect(c.successRate).toBe(0);
    expect(c.successCi95).toEqual([0, 1]);
    expect(c.errorRate).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/results/aggregate.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Write `packages/core/src/results/wilson.ts`**

```ts
/** Wilson score interval for a binomial proportion (95% by default). */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
```

- [ ] **Step 4: Write `packages/core/src/results/schema.ts`**

```ts
import { z } from 'zod';

export const ResultsSchema = z.object({
  schemaVersion: z.literal(1),
  harnessVersion: z.string(),
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  partial: z.boolean(),
  totalCostUsd: z.number().nonnegative(),
  suites: z.array(
    z.object({
      suite: z.string(),
      suiteVersion: z.number().int(),
      fixture: z.object({ git: z.string(), ref: z.string() }).nullable(),
      servers: z.record(z.string(), z.object({ command: z.string().optional(), url: z.string().optional() })),
      models: z.array(z.object({ id: z.string(), provider: z.string() })),
      cells: z.array(
        z.object({
          server: z.string(),
          model: z.string(),
          runs: z.number().int().nonnegative(),
          successRate: z.number().min(0).max(1),
          successCi95: z.tuple([z.number(), z.number()]),
          toolAccuracy: z.number().min(0).max(1).nullable(),
          contextTokensPerTask: z.object({ mean: z.number(), median: z.number() }),
          stepsPerTask: z.number(),
          latencyMsP50: z.number(),
          costUsdPerTask: z.number(),
          errorRate: z.number().min(0).max(1),
          tasks: z.array(
            z.object({
              id: z.string(),
              passes: z.number().int(),
              fails: z.number().int(),
              errors: z.number().int(),
              traceRef: z.string(),
            }),
          ),
        }),
      ),
    }),
  ),
});

export type Results = z.infer<typeof ResultsSchema>;
```

- [ ] **Step 5: Write `packages/core/src/results/aggregate.ts`**

```ts
import type { RunRecord, Suite } from '../types.js';
import { mean, median } from '../util.js';
import type { Results } from './schema.js';
import { wilson } from './wilson.js';

export interface AggregateInput {
  records: RunRecord[];
  suites: Suite[];
  providerName: string;
  harnessVersion: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  partial: boolean;
  totalCostUsd: number;
}

type Cell = Results['suites'][number]['cells'][number];

export function aggregate(input: AggregateInput): Results {
  return {
    schemaVersion: 1,
    harnessVersion: input.harnessVersion,
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    partial: input.partial,
    totalCostUsd: input.totalCostUsd,
    suites: input.suites.map((suite) => {
      const recs = input.records.filter((r) => r.suite === suite.name);
      const cells: Cell[] = [];
      for (const server of Object.keys(suite.servers)) {
        for (const model of suite.models) {
          const rs = recs.filter((r) => r.server === server && r.model === model);
          if (rs.length > 0) cells.push(buildCell(suite, server, model, rs));
        }
      }
      return {
        suite: suite.name,
        suiteVersion: suite.version,
        fixture: suite.fixture ?? null,
        servers: Object.fromEntries(
          Object.entries(suite.servers).map(([name, s]) => [
            name,
            { ...(s.command !== undefined ? { command: s.command } : {}), ...(s.url !== undefined ? { url: s.url } : {}) },
          ]),
        ),
        models: suite.models.map((id) => ({ id, provider: input.providerName })),
        cells,
      };
    }),
  };
}

function buildCell(suite: Suite, server: string, model: string, rs: RunRecord[]): Cell {
  const completed = rs.filter((r) => r.outcome !== 'error');
  const passes = completed.filter((r) => r.outcome === 'pass').length;
  const n = completed.length;
  const toolVals = completed.map((r) => r.toolSelectionOk).filter((v): v is boolean => v !== null);
  const ctx = completed.map((r) => r.contextTokens);
  const tasks: Cell['tasks'] = [];
  for (const task of suite.tasks) {
    const tr = rs.filter((r) => r.task === task.id).sort((a, b) => a.repeat - b.repeat);
    if (tr.length === 0) continue;
    tasks.push({
      id: task.id,
      passes: tr.filter((r) => r.outcome === 'pass').length,
      fails: tr.filter((r) => r.outcome === 'fail').length,
      errors: tr.filter((r) => r.outcome === 'error').length,
      traceRef: tr[0]!.runKey,
    });
  }
  return {
    server,
    model,
    runs: rs.length,
    successRate: n === 0 ? 0 : passes / n,
    successCi95: wilson(passes, n),
    toolAccuracy: toolVals.length === 0 ? null : toolVals.filter(Boolean).length / toolVals.length,
    contextTokensPerTask: { mean: mean(ctx), median: median(ctx) },
    stepsPerTask: mean(completed.map((r) => r.steps)),
    latencyMsP50: median(completed.map((r) => r.latencyMs)),
    costUsdPerTask: mean(completed.map((r) => r.costUsd)),
    errorRate: (rs.length - n) / rs.length,
    tasks,
  };
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm vitest run packages/core/src/results && pnpm --filter @mcp-evals/core typecheck`
Expected: all PASS; exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/results
git commit -m "feat(core): results schema, Wilson CI, and aggregator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Tool schema converter and MockProvider

**Files:**
- Create: `packages/core/src/tools/convert.ts`, `packages/core/src/providers/mock.ts`
- Test: `packages/core/src/tools/convert.test.ts`, `packages/core/src/providers/mock.test.ts`

**Interfaces:**
- Consumes: `McpTool`, `ToolDef`, `JsonObject`, `ChatRequest`, `ChatResponse`, `ModelProvider`, `ToolCall` from `../types.js`; `ProviderError` from `../errors.js`; `estimateTokens` from `../util.js`.
- Produces:
  - `sanitizeToolName(name: string): string`; `interface ToolMapping { defs: ToolDef[]; toMcpName(fnName: string): string | undefined }`; `convertTools(tools: McpTool[]): ToolMapping` — defs sorted by MCP name, names sanitized to `[a-zA-Z0-9_-]{1,64}`, collisions suffixed `_2`, `_3`…; parameters always `type: 'object'` with `properties`.
  - `type MockScript`, `parseMockScript(json: unknown): MockScript`, `loadMockScript(path: string): Promise<MockScript>`, `DEFAULT_MOCK_COST_USD = 0.001`, `class MockProvider implements ModelProvider { name = 'mock' }`.

Mock script format (JSON): `{ "entries": [ { "match": "<substring of the task prompt>", "model": "<optional model id>", "steps": [ step, ... ] } ] }`, where a step is `{ "content"?: string, "toolCalls"?: [{ "name": string, "arguments"?: object | string }], "usage"?: { "promptTokens"?, "completionTokens"?, "costUsd"? }, "error"?: { "message": string, "retryable"?: boolean (default true), "status"?: number } }`. The provider is stateless: the step index is the number of assistant messages already in the request. No matching entry, or steps exhausted, yields a final answer `(mock: no script entry matches)` / `(mock: script exhausted)`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/tools/convert.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { convertTools, sanitizeToolName } from './convert.js';

describe('convertTools', () => {
  // Review Focus 1
  it('sanitizes illegal names and maps them back', () => {
    const m = convertTools([
      { name: 'github/search', description: 'Search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'dotted.name', inputSchema: {} },
    ]);
    expect(m.defs.map((d) => d.name)).toEqual(['dotted_name', 'github_search']);
    expect(m.toMcpName('github_search')).toBe('github/search');
    expect(m.toMcpName('dotted_name')).toBe('dotted.name');
    expect(m.toMcpName('nope')).toBeUndefined();
    expect(m.defs[0]).toEqual({ name: 'dotted_name', description: '', parameters: { type: 'object', properties: {} } });
  });

  it('disambiguates collisions deterministically', () => {
    const m = convertTools([{ name: 'a.b', inputSchema: {} }, { name: 'a/b', inputSchema: {} }]);
    expect(m.defs.map((d) => d.name)).toEqual(['a_b', 'a_b_2']);
    expect(m.toMcpName('a_b')).toBe('a.b');
    expect(m.toMcpName('a_b_2')).toBe('a/b');
  });

  it('is order-independent (fairness)', () => {
    const tools = [{ name: 'b', inputSchema: {} }, { name: 'a', inputSchema: {} }];
    expect(convertTools(tools).defs).toEqual(convertTools([...tools].reverse()).defs);
  });

  it('truncates to 64 characters', () => {
    expect(sanitizeToolName('x'.repeat(80))).toHaveLength(64);
    expect(sanitizeToolName('')).toBe('tool');
  });
});
```

`packages/core/src/providers/mock.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.js';
import type { ChatMessage, ChatRequest } from '../types.js';
import { DEFAULT_MOCK_COST_USD, MockProvider, parseMockScript } from './mock.js';

const script = parseMockScript({
  entries: [
    { match: 'only for b', model: 'm/b', steps: [{ content: 'b answer' }] },
    {
      match: 'echo',
      steps: [
        { toolCalls: [{ name: 'echo', arguments: { text: 'hi' } }] },
        { toolCalls: [{ name: 'echo', arguments: 'not json' }], usage: { costUsd: 0.5 } },
        { content: 'done' },
      ],
    },
    { match: 'flaky', steps: [{ error: { message: 'rate limited', status: 429 } }] },
  ],
});

function req(prompt: string, assistantTurns = 0, model = 'm/a'): ChatRequest {
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: prompt }];
  for (let i = 0; i < assistantTurns; i++) messages.push({ role: 'assistant', content: null, toolCalls: [] });
  return { model, messages, tools: [], temperature: 0 };
}

describe('MockProvider', () => {
  const p = new MockProvider(script);

  it('plays steps by assistant-turn count', async () => {
    const s0 = await p.chat(req('please echo'));
    expect(s0.toolCalls).toEqual([{ id: 'call_0_0', name: 'echo', arguments: '{"text":"hi"}' }]);
    expect(s0.usage.costUsd).toBe(DEFAULT_MOCK_COST_USD);
    const s1 = await p.chat(req('please echo', 1));
    expect(s1.toolCalls[0]!.arguments).toBe('not json');
    expect(s1.usage.costUsd).toBe(0.5);
    const s2 = await p.chat(req('please echo', 2));
    expect(s2).toMatchObject({ content: 'done', toolCalls: [] });
    expect((await p.chat(req('please echo', 3))).content).toBe('(mock: script exhausted)');
  });

  it('respects model filters and falls back when nothing matches', async () => {
    expect((await p.chat(req('only for b', 0, 'm/b'))).content).toBe('b answer');
    expect((await p.chat(req('only for b', 0, 'm/a'))).content).toBe('(mock: no script entry matches)');
  });

  it('throws ProviderError for error steps (retryable by default)', async () => {
    const err = await p.chat(req('flaky')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: true, status: 429 });
  });

  it('rejects malformed scripts', () => {
    expect(() => parseMockScript({ entries: [{ match: 'x', steps: [] }] })).toThrow();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/core/src/tools packages/core/src/providers`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Write `packages/core/src/tools/convert.ts`**

```ts
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
```

- [ ] **Step 4: Write `packages/core/src/providers/mock.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ProviderError } from '../errors.js';
import type { ChatRequest, ChatResponse, ModelProvider, ToolCall } from '../types.js';
import { estimateTokens } from '../util.js';

const StepSchema = z
  .object({
    content: z.string().optional(),
    toolCalls: z
      .array(z.object({ name: z.string().min(1), arguments: z.union([z.record(z.string(), z.unknown()), z.string()]).default({}) }).strict())
      .optional(),
    usage: z.object({ promptTokens: z.number(), completionTokens: z.number(), costUsd: z.number() }).partial().optional(),
    error: z.object({ message: z.string(), retryable: z.boolean().default(true), status: z.number().optional() }).strict().optional(),
  })
  .strict();

const ScriptSchema = z
  .object({
    entries: z.array(z.object({ match: z.string(), model: z.string().optional(), steps: z.array(StepSchema).min(1) }).strict()),
  })
  .strict();

export type MockScript = z.infer<typeof ScriptSchema>;
type MockStep = z.infer<typeof StepSchema>;

export const DEFAULT_MOCK_COST_USD = 0.001;

export function parseMockScript(json: unknown): MockScript {
  return ScriptSchema.parse(json);
}

export async function loadMockScript(path: string): Promise<MockScript> {
  return parseMockScript(JSON.parse(await readFile(path, 'utf8')));
}

export class MockProvider implements ModelProvider {
  readonly name = 'mock';

  constructor(private readonly script: MockScript) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const prompt = req.messages.find((m) => m.role === 'user')?.content ?? '';
    const step = req.messages.filter((m) => m.role === 'assistant').length;
    const promptTokens = estimateTokens(req.messages.map((m) => m.content ?? '').join('\n'));
    const entry = this.script.entries.find((e) => prompt.includes(e.match) && (e.model === undefined || e.model === req.model));
    if (!entry) return respond({ content: '(mock: no script entry matches)' }, promptTokens, step);
    const s = entry.steps[step];
    if (!s) return respond({ content: '(mock: script exhausted)' }, promptTokens, step);
    if (s.error) throw new ProviderError(s.error.message, s.error.retryable, s.error.status);
    return respond(s, promptTokens, step);
  }
}

function respond(s: MockStep, promptTokens: number, step: number): ChatResponse {
  const toolCalls: ToolCall[] = (s.toolCalls ?? []).map((c, i) => ({
    id: `call_${step}_${i}`,
    name: c.name,
    arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments),
  }));
  return {
    content: s.content ?? null,
    toolCalls,
    usage: {
      promptTokens: s.usage?.promptTokens ?? promptTokens,
      completionTokens: s.usage?.completionTokens ?? 10,
      costUsd: s.usage?.costUsd ?? DEFAULT_MOCK_COST_USD,
    },
    latencyMs: 1,
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run packages/core/src/tools packages/core/src/providers && pnpm --filter @mcp-evals/core typecheck`
Expected: all PASS; exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools packages/core/src/providers
git commit -m "feat(core): tool schema converter and scripted MockProvider

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Fixture manager

**Files:**
- Create: `packages/core/src/fixtures/manager.ts`
- Test: `packages/core/src/fixtures/manager.test.ts`

**Interfaces:**
- Consumes: `FixtureSpec` from `../types.js`; `InfraError` from `../errors.js`; `sha256Hex` from `../util.js`.
- Produces: `interface Workspace { dir: string; snapshot: Map<string, string>; dispose(): Promise<void> }`; `interface FixtureManagerOptions { cacheDir: string; workRoot?: string }`; `class FixtureManager { constructor(opts); cachePath(spec): string; prepare(spec): Promise<string>; createWorkspace(spec?: FixtureSpec): Promise<Workspace> }`; `snapshotDir(root: string): Promise<Map<string, string>>`.

`prepare` clones once into `cacheDir/<hash>` and checks out the pinned ref (skipped if already at that ref). `createWorkspace` copies the cached checkout **without `.git`** into a fresh temp dir (or creates an empty dir when `spec` is undefined) and records a sha256 snapshot of every file. Fetch failures throw `InfraError('fixture', …, false)`.

- [ ] **Step 1: Write the failing test `packages/core/src/fixtures/manager.test.ts`**

```ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { InfraError } from '../errors.js';
import { sha256Hex } from '../util.js';
import { FixtureManager } from './manager.js';

let repo: string;
let firstSha: string;
let secondSha: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'fixture-src-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  firstSha = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
  git(repo, 'commit', '-qam', 'two');
  secondSha = git(repo, 'rev-parse', 'HEAD');
});

async function manager() {
  const root = await mkdtemp(join(tmpdir(), 'fixture-mgr-'));
  return new FixtureManager({ cacheDir: join(root, 'cache'), workRoot: join(root, 'work') });
}

describe('FixtureManager', () => {
  it('checks out the pinned ref, not HEAD', async () => {
    const m = await manager();
    const ws = await m.createWorkspace({ git: repo, ref: firstSha });
    expect(await readFile(join(ws.dir, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(existsSync(join(ws.dir, '.git'))).toBe(false);
    expect(ws.snapshot.get('src/a.ts')).toBe(sha256Hex('export const a = 1;\n'));
    await ws.dispose();
    expect(existsSync(ws.dir)).toBe(false);
  });

  it('accepts short shas and gives each run an isolated workspace', async () => {
    const m = await manager();
    const spec = { git: repo, ref: secondSha.slice(0, 8) };
    const a = await m.createWorkspace(spec);
    const b = await m.createWorkspace(spec);
    expect(a.dir).not.toBe(b.dir);
    await writeFile(join(a.dir, 'src', 'a.ts'), 'mutated');
    expect(await readFile(join(b.dir, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('reuses the cache for the same ref', async () => {
    const m = await manager();
    const spec = { git: repo, ref: firstSha };
    const p1 = await m.prepare(spec);
    const p2 = await m.prepare(spec);
    expect(p1).toBe(p2);
    expect(p1).toBe(m.cachePath(spec));
  });

  it('creates an empty workspace without a fixture', async () => {
    const ws = await (await manager()).createWorkspace();
    expect(ws.snapshot.size).toBe(0);
    await ws.dispose();
  });

  it('throws a non-retryable InfraError for an unknown ref', async () => {
    const err = await (await manager()).prepare({ git: repo, ref: 'deadbeef' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toMatchObject({ kind: 'fixture', retryable: false });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/fixtures`
Expected: FAIL — cannot resolve `./manager.js`.

- [ ] **Step 3: Write `packages/core/src/fixtures/manager.ts`**

```ts
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { InfraError } from '../errors.js';
import type { FixtureSpec } from '../types.js';
import { sha256Hex } from '../util.js';

const execFileP = promisify(execFile);

export interface Workspace {
  dir: string;
  /** posix relative path → sha256 hex, taken before the run. */
  snapshot: Map<string, string>;
  dispose(): Promise<void>;
}

export interface FixtureManagerOptions {
  cacheDir: string;
  workRoot?: string;
}

export class FixtureManager {
  constructor(private readonly opts: FixtureManagerOptions) {}

  cachePath(spec: FixtureSpec): string {
    const key = createHash('sha256').update(`${spec.git}@${spec.ref}`).digest('hex').slice(0, 16);
    return join(this.opts.cacheDir, key);
  }

  async prepare(spec: FixtureSpec): Promise<string> {
    const dir = this.cachePath(spec);
    if (await isCheckedOutAt(dir, spec.ref)) return dir;
    await rm(dir, { recursive: true, force: true });
    await mkdir(this.opts.cacheDir, { recursive: true });
    try {
      await execFileP('git', ['clone', '--quiet', '--no-checkout', spec.git, dir]);
      await execFileP('git', ['-C', dir, 'checkout', '--quiet', '--detach', spec.ref]);
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw new InfraError('fixture', `failed to fetch fixture ${spec.git}@${spec.ref}: ${(e as Error).message}`, false);
    }
    return dir;
  }

  async createWorkspace(spec?: FixtureSpec): Promise<Workspace> {
    const root = this.opts.workRoot ?? tmpdir();
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, 'mcp-evals-ws-'));
    if (spec) {
      const src = await this.prepare(spec);
      await cp(src, dir, { recursive: true, filter: (p) => relative(src, p).split(sep)[0] !== '.git' });
    }
    const snapshot = await snapshotDir(dir);
    return { dir, snapshot, dispose: () => rm(dir, { recursive: true, force: true }) };
  }
}

async function isCheckedOutAt(dir: string, ref: string): Promise<boolean> {
  if (!existsSync(join(dir, '.git'))) return false;
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'rev-parse', 'HEAD']);
    return stdout.trim().startsWith(ref);
  } catch {
    return false;
  }
}

export async function snapshotDir(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.set(relative(root, full).split(sep).join('/'), sha256Hex(await readFile(full)));
    }
  }
  await walk(root);
  return out;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/core/src/fixtures && pnpm --filter @mcp-evals/core typecheck`
Expected: all PASS; exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/fixtures
git commit -m "feat(core): pinned git fixture manager with per-run workspaces

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: MCP connectors, setup command, fake MCP server

**Files:**
- Create: `packages/core/test/fixtures/fake-server.mjs`, `packages/core/test/fixtures/fake-server.d.mts`
- Create: `packages/core/src/mcp/connection.ts`, `packages/core/src/mcp/setup.ts`
- Test: `packages/core/src/mcp/connection.test.ts`

**Interfaces:**
- Consumes: `Connector`, `ConnectContext`, `McpConnection`, `McpTool`, `ServerSpec`, `JsonObject` from `../types.js`; `InfraError` from `../errors.js`; `substituteVars` from `../util.js`.
- Produces:
  - `stdioConnector: Connector` — spawns `command args` (with `{vars}` substituted in command, args, env values) in `ctx.cwd`, captures up to 64 KB of stderr; URL servers → `InfraError('server', …, false)`; start failure → `InfraError('server', …, true)`.
  - `createInMemoryConnector(build: (ctx: ConnectContext) => McpServer): Connector` (tests only).
  - `contentToText(content: unknown): string` — text items joined by `\n`, other items JSON-stringified.
  - `callTool` error mapping: tool-level errors and protocol errors (e.g. unknown tool, invalid params) → `{ isError: true }`; connection closed (server crashed) → `InfraError('server', …, true)`; request timeout → `InfraError('server', …, false)`.
  - `runSetup(command: string, cwd: string, timeoutMs?: number): Promise<void>` — runs `sh -c command`; failure → `InfraError('setup', …, false)`.
  - Fake server tools: `echo {text}`, `big {size}`, `fail {}`, `read_file {path}`, `write_file {path, content}`, `slow {ms}`, `shout {text}` (writes text to stderr), `dotted.name {}`, and — only when `allowCrash` — `crash {}` (exits the process).

- [ ] **Step 1: Write the fake server `packages/core/test/fixtures/fake-server.mjs`**

```js
// Fake MCP server for tests. Import buildFakeServer() for in-memory use,
// or run `node fake-server.mjs` to serve over stdio (crash tool enabled).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const text = (t) => ({ content: [{ type: 'text', text: t }] });

export function buildFakeServer(cwd = process.cwd(), opts = {}) {
  const server = new McpServer({ name: 'fake', version: '1.0.0' });
  server.registerTool('echo', { description: 'Echo text back', inputSchema: { text: z.string() } }, async ({ text: t }) => text(t));
  server.registerTool('big', { description: 'Return size characters', inputSchema: { size: z.number().int().min(0) } }, async ({ size }) => text('x'.repeat(size)));
  server.registerTool('fail', { description: 'Always returns a tool error' }, async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }));
  server.registerTool('read_file', { description: 'Read a file relative to cwd', inputSchema: { path: z.string() } }, async ({ path }) => text(readFileSync(resolve(cwd, path), 'utf8')));
  server.registerTool('write_file', { description: 'Write a file relative to cwd', inputSchema: { path: z.string(), content: z.string() } }, async ({ path, content }) => {
    writeFileSync(resolve(cwd, path), content);
    return text('ok');
  });
  server.registerTool('slow', { description: 'Sleep then answer', inputSchema: { ms: z.number().int().min(0) } }, async ({ ms }) => {
    await new Promise((r) => setTimeout(r, ms));
    return text('done');
  });
  server.registerTool('shout', { description: 'Write text to stderr', inputSchema: { text: z.string() } }, async ({ text: t }) => {
    process.stderr.write(`${t}\n`);
    return text('shouted');
  });
  server.registerTool('dotted.name', { description: 'Tool whose name is illegal for model function names' }, async () => text('dotted'));
  if (opts.allowCrash) {
    server.registerTool('crash', { description: 'Exit the server process' }, async () => process.exit(1));
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildFakeServer(process.cwd(), { allowCrash: true }).connect(new StdioServerTransport());
}
```

`packages/core/test/fixtures/fake-server.d.mts`:
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export declare function buildFakeServer(cwd?: string, opts?: { allowCrash?: boolean }): McpServer;
```

- [ ] **Step 2: Write the failing test `packages/core/src/mcp/connection.test.ts`**

```ts
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildFakeServer } from '../../test/fixtures/fake-server.mjs';
import { InfraError } from '../errors.js';
import type { ServerSpec } from '../types.js';
import { contentToText, createInMemoryConnector, stdioConnector } from './connection.js';
import { runSetup } from './setup.js';

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-server.mjs', import.meta.url));
const stdioSpec: ServerSpec = { command: process.execPath, args: [FAKE], env: {}, headers: {} };
const memory = createInMemoryConnector((ctx) => buildFakeServer(ctx.cwd));

async function tmp() {
  return mkdtemp(join(tmpdir(), 'conn-'));
}

describe('in-memory connector', () => {
  it('lists tools and calls them', async () => {
    const conn = await memory(stdioSpec, { cwd: await tmp(), vars: {} });
    const names = (await conn.listTools()).map((t) => t.name).sort();
    expect(names).toEqual(['big', 'dotted.name', 'echo', 'fail', 'read_file', 'shout', 'slow', 'write_file']);
    expect(await conn.callTool('echo', { text: 'hi' }, 5000)).toEqual({ text: 'hi', isError: false });
    expect((await conn.callTool('big', { size: 100 }, 5000)).text).toHaveLength(100);
    expect(await conn.callTool('fail', {}, 5000)).toEqual({ text: 'boom', isError: true });
    await conn.close();
  });

  it('maps unknown tools and bad arguments to tool errors, not exceptions', async () => {
    const conn = await memory(stdioSpec, { cwd: await tmp(), vars: {} });
    expect((await conn.callTool('nope', {}, 5000)).isError).toBe(true);
    expect((await conn.callTool('echo', { text: 42 }, 5000)).isError).toBe(true);
    await conn.close();
  });

  it('turns tool timeouts into non-retryable InfraErrors', async () => {
    const conn = await memory(stdioSpec, { cwd: await tmp(), vars: {} });
    const err = await conn.callTool('slow', { ms: 500 }, 50).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toMatchObject({ kind: 'server', retryable: false });
    await conn.close();
  });
});

describe('stdio connector', () => {
  it('spawns the server in ctx.cwd and captures stderr', async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, 'note.txt'), 'from cwd');
    const conn = await stdioConnector(stdioSpec, { cwd, vars: {} });
    expect((await conn.callTool('read_file', { path: 'note.txt' }, 5000)).text).toBe('from cwd');
    await conn.callTool('shout', { text: 'hello-stderr' }, 5000);
    await vi.waitFor(() => expect(conn.stderr()).toContain('hello-stderr'));
    await conn.close();
  });

  it('substitutes {vars} in args', async () => {
    const cwd = await tmp();
    const spec: ServerSpec = { ...stdioSpec, args: ['{fake}'] };
    const conn = await stdioConnector(spec, { cwd, vars: { fake: FAKE } });
    expect((await conn.callTool('echo', { text: 'ok' }, 5000)).text).toBe('ok');
    await conn.close();
  });

  // Review Focus 3
  it('turns a crashing server into a retryable InfraError', async () => {
    const conn = await stdioConnector(stdioSpec, { cwd: await tmp(), vars: {} });
    const err = await conn.callTool('crash', {}, 5000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toMatchObject({ kind: 'server', retryable: true });
    await conn.close();
  });

  it('fails clearly for a command that cannot start', async () => {
    const err = await stdioConnector({ ...stdioSpec, command: '/definitely/not/here' }, { cwd: await tmp(), vars: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InfraError);
  });

  it('rejects url servers until M2', async () => {
    const err = await stdioConnector({ args: [], env: {}, headers: {}, url: 'https://x.test/mcp' }, { cwd: await tmp(), vars: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ kind: 'server', retryable: false });
  });
});

describe('contentToText', () => {
  it('joins text and stringifies other content', () => {
    expect(contentToText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x', mimeType: 'image/png' }])).toBe(
      'a\n{"type":"image","data":"x","mimeType":"image/png"}',
    );
    expect(contentToText(undefined)).toBe('');
  });
});

describe('runSetup', () => {
  it('runs in cwd and throws InfraError on failure', async () => {
    const cwd = await tmp();
    await runSetup('echo hi > setup.txt', cwd);
    expect(existsSync(join(cwd, 'setup.txt'))).toBe(true);
    const err = await runSetup('exit 3', cwd).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'setup', retryable: false });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/mcp`
Expected: FAIL — cannot resolve `./connection.js`.

- [ ] **Step 4: Write `packages/core/src/mcp/connection.ts`**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { InfraError } from '../errors.js';
import type { ConnectContext, Connector, JsonObject, McpConnection, McpTool } from '../types.js';
import { substituteVars } from '../util.js';

const STDERR_LIMIT = 64 * 1024;
const CLIENT_INFO = { name: 'mcp-evals', version: '0.0.0' };

export function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: unknown) => {
      const item = c as { type?: unknown; text?: unknown };
      return item && item.type === 'text' && typeof item.text === 'string' ? item.text : JSON.stringify(c);
    })
    .join('\n');
}

function wrap(client: Client, getStderr: () => string): McpConnection {
  return {
    async listTools() {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of page.tools) tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as JsonObject });
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args, timeoutMs) {
      try {
        const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
        return { text: contentToText((res as { content?: unknown }).content), isError: (res as { isError?: unknown }).isError === true };
      } catch (e) {
        if (e instanceof McpError && e.code === ErrorCode.ConnectionClosed) {
          throw new InfraError('server', `${name}: server connection closed (crashed?): ${e.message}`, true);
        }
        if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) {
          throw new InfraError('server', `${name}: tool call timed out after ${timeoutMs}ms`, false);
        }
        if (e instanceof McpError) return { text: `Error: ${e.message}`, isError: true };
        throw new InfraError('server', `${name}: ${(e as Error).message}`, true);
      }
    },
    stderr: getStderr,
    async close() {
      try {
        await client.close();
      } catch {
        // already closed
      }
    },
  };
}

export const stdioConnector: Connector = async (server, ctx) => {
  if (server.command === undefined) {
    throw new InfraError('server', 'remote (url) servers are not supported until M2; use a command', false);
  }
  const sub = (s: string) => substituteVars(s, ctx.vars);
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const [k, v] of Object.entries(server.env)) env[k] = sub(v);
  const transport = new StdioClientTransport({
    command: sub(server.command),
    args: server.args.map(sub),
    cwd: ctx.cwd,
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8').slice(0, STDERR_LIMIT - stderr.length);
  });
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(transport);
  } catch (e) {
    await transport.close().catch(() => {});
    throw new InfraError('server', `failed to start ${server.command}: ${(e as Error).message}\n${stderr}`, true);
  }
  return wrap(client, () => stderr);
};

export function createInMemoryConnector(build: (ctx: ConnectContext) => McpServer): Connector {
  return async (_server, ctx) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpServer = build(ctx);
    await mcpServer.connect(serverTransport);
    const client = new Client(CLIENT_INFO);
    await client.connect(clientTransport);
    const conn = wrap(client, () => '');
    return {
      ...conn,
      async close() {
        await conn.close();
        await mcpServer.close().catch(() => {});
      },
    };
  };
}
```

- [ ] **Step 5: Write `packages/core/src/mcp/setup.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InfraError } from '../errors.js';

const execFileP = promisify(execFile);

export async function runSetup(command: string, cwd: string, timeoutMs = 120_000): Promise<void> {
  try {
    await execFileP('sh', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    const err = e as Error & { stderr?: string; code?: number | string };
    throw new InfraError('setup', `setup command failed (${err.code ?? 'unknown'}): ${command}\n${(err.stderr ?? '').slice(-2000)}`, false);
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm vitest run packages/core/src/mcp && pnpm --filter @mcp-evals/core typecheck`
Expected: all PASS; exit 0. If the "bad arguments" test shows the SDK throwing a non-`McpError`, keep the mapping in `callTool` as written and adjust only the expectation to `isError: true` or an `InfraError` — whichever the SDK 1.29 actually produces — and note it in the commit message.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/mcp packages/core/test
git commit -m "feat(core): stdio and in-memory MCP connectors, setup runner, fake server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Agent loop

**Files:**
- Create: `packages/core/src/agent/loop.ts`
- Test: `packages/core/src/agent/loop.test.ts`

**Interfaces:**
- Consumes: `ModelProvider`, `McpConnection`, `ChatMessage`, `ChatResponse`, `ToolCallResult`, `TraceEvent`, `LoopEnd`, `JsonObject` from `../types.js`; `ProviderError`, `InfraError` from `../errors.js`; `ToolMapping` from `../tools/convert.js` (Task 5); `estimateTokens`, `isPlainObject` from `../util.js`. Tests use `MockProvider`/`parseMockScript` (Task 5) and `createInMemoryConnector` (Task 7).
- Produces:
  - `SYSTEM_PROMPT: string`, `DEFAULT_TOOL_TIMEOUT_MS = 60_000`
  - `interface AgentLoopOptions { provider: ModelProvider; connection: McpConnection; tools: ToolMapping; model: string; prompt: string; maxSteps: number; timeoutMs: number; temperature: number; systemPrompt?: string; toolTimeoutMs?: number; shouldStop?: (loopCostUsd: number) => boolean; now?: () => number }`
  - `interface AgentRunResult { end: LoopEnd; finalAnswer: string | null; failReason?: string; infraError?: InfraError; events: TraceEvent[]; steps: number; costUsd: number; contextTokens: number; latencyMs: number }`
  - `runAgentLoop(o: AgentLoopOptions): Promise<AgentRunResult>`

Loop order each iteration: budget check (`shouldStop(costSoFar)`) → `max_steps` → deadline → model call. A response with no tool calls is the final answer. Unknown tool name or non-object/invalid JSON arguments end the loop as `invalid_tool_call` (a model fail). `ProviderError` and connection `InfraError` end the loop as `infra_error` carrying an `InfraError`. Tool-level errors (`isError`) are fed back to the model and the loop continues.

- [ ] **Step 1: Write the failing test `packages/core/src/agent/loop.test.ts`**

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFakeServer } from '../../test/fixtures/fake-server.mjs';
import { createInMemoryConnector } from '../mcp/connection.js';
import { MockProvider, parseMockScript } from '../providers/mock.js';
import { convertTools } from '../tools/convert.js';
import type { ModelProvider } from '../types.js';
import { estimateTokens } from '../util.js';
import { runAgentLoop, type AgentLoopOptions } from './loop.js';

const connect = createInMemoryConnector((ctx) => buildFakeServer(ctx.cwd));

async function setup(steps: unknown[], over: Partial<AgentLoopOptions> = {}) {
  const connection = await connect({ args: [], env: {}, headers: {}, command: 'x' }, { cwd: await mkdtemp(join(tmpdir(), 'loop-')), vars: {} });
  const tools = convertTools(await connection.listTools());
  const provider = new MockProvider(parseMockScript({ entries: [{ match: 'TASK', steps }] }));
  const opts: AgentLoopOptions = { provider, connection, tools, model: 'm/a', prompt: 'TASK', maxSteps: 5, timeoutMs: 5000, temperature: 0, ...over };
  return { opts, connection };
}

describe('runAgentLoop', () => {
  it('calls tools, counts context tokens, and returns the final answer', async () => {
    const { opts, connection } = await setup([
      { toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }, { name: 'big', arguments: { size: 40 } }] },
      { content: 'all done' },
    ]);
    const r = await runAgentLoop(opts);
    expect(r.end).toBe('final_answer');
    expect(r.finalAnswer).toBe('all done');
    expect(r.steps).toBe(2);
    expect(r.contextTokens).toBe(estimateTokens('hello') + estimateTokens('x'.repeat(40)));
    expect(r.costUsd).toBeCloseTo(0.002, 6);
    expect(r.events.map((e) => e.type)).toEqual(['model_call', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'model_call', 'final_answer']);
    await connection.close();
  });

  it('feeds tool errors back and continues', async () => {
    const { opts } = await setup([{ toolCalls: [{ name: 'fail' }] }, { content: 'recovered' }]);
    const r = await runAgentLoop(opts);
    expect(r.end).toBe('final_answer');
    expect(r.events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true, tool: 'fail' });
  });

  // Review Focus 1
  it('maps sanitized function names back to MCP names', async () => {
    const { opts } = await setup([{ toolCalls: [{ name: 'dotted_name' }] }, { content: 'ok' }]);
    const r = await runAgentLoop(opts);
    expect(r.events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'dotted.name', isError: false });
  });

  it('stops at max_steps', async () => {
    const step = { toolCalls: [{ name: 'echo', arguments: { text: 'again' } }] };
    const { opts } = await setup([step, step, step, step], { maxSteps: 3 });
    const r = await runAgentLoop(opts);
    expect(r).toMatchObject({ end: 'max_steps', steps: 3, finalAnswer: null });
  });

  it('ends with invalid_tool_call for unknown tools and invalid JSON args', async () => {
    const unknown = await runAgentLoop((await setup([{ toolCalls: [{ name: 'nope' }] }])).opts);
    expect(unknown.end).toBe('invalid_tool_call');
    expect(unknown.failReason).toMatch(/unknown tool "nope"/);
    const badJson = await runAgentLoop((await setup([{ toolCalls: [{ name: 'echo', arguments: '{oops' }] }])).opts);
    expect(badJson.end).toBe('invalid_tool_call');
    expect(badJson.failReason).toMatch(/invalid JSON arguments/);
  });

  it('turns ProviderErrors into infra_error', async () => {
    const r = await runAgentLoop((await setup([{ error: { message: 'rate limited', retryable: true } }])).opts);
    expect(r.end).toBe('infra_error');
    expect(r.infraError).toMatchObject({ kind: 'provider', retryable: true });
  });

  it('respects the budget check before each model call', async () => {
    const { opts } = await setup([{ content: 'never' }], { shouldStop: () => true });
    const r = await runAgentLoop(opts);
    expect(r).toMatchObject({ end: 'budget', steps: 0 });
  });

  it('times out a hanging model call', async () => {
    const { opts } = await setup([{ content: 'unused' }]);
    const hang: ModelProvider = { name: 'hang', chat: () => new Promise(() => {}) };
    const r = await runAgentLoop({ ...opts, provider: hang, timeoutMs: 50 });
    expect(r.end).toBe('timeout');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/agent`
Expected: FAIL — cannot resolve `./loop.js`.

- [ ] **Step 3: Write `packages/core/src/agent/loop.ts`**

```ts
import { InfraError, ProviderError } from '../errors.js';
import type { ToolMapping } from '../tools/convert.js';
import type { ChatMessage, ChatResponse, JsonObject, LoopEnd, McpConnection, ModelProvider, ToolCallResult, TraceEvent } from '../types.js';
import { estimateTokens, isPlainObject } from '../util.js';

export const SYSTEM_PROMPT =
  'You are an agent completing a task with the tools provided. Use tools when they help. ' +
  'When you are finished, reply with your final answer as plain text and do not call any more tools.';

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export interface AgentLoopOptions {
  provider: ModelProvider;
  connection: McpConnection;
  tools: ToolMapping;
  model: string;
  prompt: string;
  maxSteps: number;
  timeoutMs: number;
  temperature: number;
  systemPrompt?: string;
  toolTimeoutMs?: number;
  /** Called before each model call with this loop's spend so far; return true to stop. */
  shouldStop?: (loopCostUsd: number) => boolean;
  now?: () => number;
}

export interface AgentRunResult {
  end: LoopEnd;
  finalAnswer: string | null;
  failReason?: string;
  infraError?: InfraError;
  events: TraceEvent[];
  steps: number;
  costUsd: number;
  contextTokens: number;
  latencyMs: number;
}

class LoopTimeout extends Error {}

export async function runAgentLoop(o: AgentLoopOptions): Promise<AgentRunResult> {
  const now = o.now ?? Date.now;
  const start = now();
  const deadline = start + o.timeoutMs;
  const t = () => now() - start;
  const events: TraceEvent[] = [];
  const messages: ChatMessage[] = [
    { role: 'system', content: o.systemPrompt ?? SYSTEM_PROMPT },
    { role: 'user', content: o.prompt },
  ];
  let steps = 0;
  let costUsd = 0;
  let contextTokens = 0;

  const finish = (end: LoopEnd, extra: Partial<AgentRunResult> = {}): AgentRunResult => ({
    end,
    finalAnswer: null,
    events,
    steps,
    costUsd,
    contextTokens,
    latencyMs: t(),
    ...extra,
  });

  for (;;) {
    if (o.shouldStop?.(costUsd)) return finish('budget', { failReason: 'budget exhausted' });
    if (steps >= o.maxSteps) return finish('max_steps', { failReason: `reached max_steps (${o.maxSteps})` });
    const remaining = deadline - now();
    if (remaining <= 0) return finish('timeout', { failReason: `timed out after ${o.timeoutMs}ms` });

    steps++;
    const controller = new AbortController();
    let res: ChatResponse;
    try {
      res = await withTimeout(
        o.provider.chat({ model: o.model, messages, tools: o.tools.defs, temperature: o.temperature, signal: controller.signal }),
        remaining,
        controller,
      );
    } catch (e) {
      if (e instanceof LoopTimeout) return finish('timeout', { failReason: `timed out after ${o.timeoutMs}ms` });
      if (e instanceof ProviderError) {
        events.push({ type: 'error', step: steps, t: t(), kind: 'provider', message: e.message });
        return finish('infra_error', { infraError: new InfraError('provider', e.message, e.retryable), failReason: e.message });
      }
      throw e;
    }

    costUsd += res.usage.costUsd;
    events.push({
      type: 'model_call', step: steps, t: t(), latencyMs: res.latencyMs,
      promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens, costUsd: res.usage.costUsd,
    });

    if (res.toolCalls.length === 0) {
      const text = res.content ?? '';
      events.push({ type: 'final_answer', step: steps, t: t(), text });
      return finish('final_answer', { finalAnswer: text });
    }

    messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      const tool = o.tools.toMcpName(call.name);
      const args = parseArgs(call.arguments);
      events.push({ type: 'tool_call', step: steps, t: t(), callId: call.id, tool: tool ?? call.name, args, rawArgs: call.arguments });
      if (tool === undefined) return finish('invalid_tool_call', { failReason: `model called unknown tool "${call.name}"` });
      if (args === null) return finish('invalid_tool_call', { failReason: `model sent invalid JSON arguments to "${tool}"` });

      const t0 = now();
      let result: ToolCallResult;
      try {
        result = await o.connection.callTool(tool, args, o.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
      } catch (e) {
        if (e instanceof InfraError) {
          events.push({ type: 'error', step: steps, t: t(), kind: e.kind, message: e.message });
          return finish('infra_error', { infraError: e, failReason: e.message });
        }
        throw e;
      }
      const tokens = estimateTokens(result.text);
      contextTokens += tokens;
      events.push({
        type: 'tool_result', step: steps, t: t(), callId: call.id, tool,
        isError: result.isError, tokens, latencyMs: now() - t0, preview: result.text.slice(0, 500),
      });
      messages.push({ role: 'tool', toolCallId: call.id, content: result.text });
    }
  }
}

function parseArgs(raw: string): JsonObject | null {
  if (raw.trim() === '') return {};
  try {
    const v: unknown = JSON.parse(raw);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LoopTimeout());
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/core/src/agent && pnpm --filter @mcp-evals/core typecheck`
Expected: all PASS; exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent
git commit -m "feat(core): agent loop with limits, invalid-call handling, and tracing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Runner (orchestration, retries, budget) and public exports

**Files:**
- Create: `packages/core/src/runner/run.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/runner/run.test.ts`

**Interfaces:**
- Consumes: `runAgentLoop`, `AgentRunResult` (Task 8); `runGraders`, `taskPassed`, `toolSelectionOk`, `describeFailures` (Task 3); `FixtureManager`, `Workspace` (Task 6); `runSetup` (Task 7); `convertTools` (Task 5); `InfraError`, `ConfigError` (Task 1); `runKey`, `sleep`, `substituteVars` (Task 1).
- Produces:
  - `interface RunSuitesOptions { suites: Suite[]; provider: ModelProvider; connector: Connector; fixtures: FixtureManager; models?: string[]; servers?: string[]; repeats?: number; budgetUsd?: number; retries?: number; sleep?: (ms: number) => Promise<void>; onRecord?: (r: RunRecord) => void; now?: () => Date }`
  - `interface RunSuitesOutput { records: RunRecord[]; partial: boolean; totalCostUsd: number; startedAt: string; finishedAt: string }`
  - `runSuites(o: RunSuitesOptions): Promise<RunSuitesOutput>`
  - Public API exported from `@mcp-evals/core` (see Step 5).

Behavior: validate `--models`/`--servers` filters before any work (each value must exist in at least one suite, else `ConfigError`); for each suite → prepare fixture once → for each server × model × task (honouring `task.servers`) × repeat: fresh workspace → setup → connect → list & convert tools → loop → grade. `InfraError` with `retryable` is retried up to `retries` (default 3) times with backoff `500 * 2^(attempt-1)` ms; non-retryable or exhausted → outcome `error`. A loop ending in `budget` records outcome `error` (reason `budget exhausted`), marks `partial`, and stops scheduling. Before each run, if spent ≥ budget → `partial = true` and stop. Spend includes every attempt's model cost. Workspaces and connections are always cleaned up.

- [ ] **Step 1: Write the failing test `packages/core/src/runner/run.test.ts`**

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildFakeServer } from '../../test/fixtures/fake-server.mjs';
import { ConfigError, ProviderError } from '../errors.js';
import { FixtureManager } from '../fixtures/manager.js';
import { createInMemoryConnector } from '../mcp/connection.js';
import { MockProvider, parseMockScript, type MockScript } from '../providers/mock.js';
import { parseSuite } from '../suite/load.js';
import type { Connector, ModelProvider } from '../types.js';
import { runSuites, type RunSuitesOptions } from './run.js';

const SUITE = `
suite: demo
version: 1
servers:
  fake: { command: unused, setup: "echo prepared > setup.txt" }
models: [mock/a, mock/b]
defaults: { repeats: 2, max_steps: 4, timeout_s: 10 }
tasks:
  - id: echo
    prompt: "ECHO task"
    graders:
      - { type: tool_called, tool: echo }
      - { type: answer_contains_all, values: [hello] }
  - id: write
    prompt: "WRITE task"
    graders:
      - { type: fs_state, path: out.txt, contains: written }
      - { type: fs_state, path: setup.txt, contains: prepared }
`;

const SCRIPT: MockScript = parseMockScript({
  entries: [
    { match: 'ECHO', model: 'mock/a', steps: [{ toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }] }, { content: 'hello' }] },
    { match: 'ECHO', model: 'mock/b', steps: [{ content: 'I did not use tools' }] },
    { match: 'WRITE', steps: [{ toolCalls: [{ name: 'write_file', arguments: { path: 'out.txt', content: 'written' } }] }, { content: 'ok' }] },
  ],
});

const memory: Connector = createInMemoryConnector((ctx) => buildFakeServer(ctx.cwd));

async function opts(over: Partial<RunSuitesOptions> = {}): Promise<RunSuitesOptions> {
  const root = await mkdtemp(join(tmpdir(), 'runner-'));
  return {
    suites: [parseSuite(SUITE, 'demo.yaml')],
    provider: new MockProvider(SCRIPT),
    connector: memory,
    fixtures: new FixtureManager({ cacheDir: join(root, 'cache'), workRoot: join(root, 'work') }),
    sleep: vi.fn(async () => {}),
    ...over,
  };
}

describe('runSuites', () => {
  it('runs every server × model × task × repeat and grades each run', async () => {
    const out = await runSuites(await opts());
    expect(out.records).toHaveLength(8);
    expect(new Set(out.records.map((r) => r.runKey)).size).toBe(8);
    const byModelTask = (m: string, t: string) => out.records.filter((r) => r.model === m && r.task === t).map((r) => r.outcome);
    expect(byModelTask('mock/a', 'echo')).toEqual(['pass', 'pass']);
    expect(byModelTask('mock/b', 'echo')).toEqual(['fail', 'fail']);
    expect(byModelTask('mock/a', 'write')).toEqual(['pass', 'pass']);
    const failed = out.records.find((r) => r.model === 'mock/b' && r.task === 'echo')!;
    expect(failed.failReason).toMatch(/tool_called/);
    expect(failed.toolSelectionOk).toBe(false);
    expect(out.partial).toBe(false);
    expect(out.totalCostUsd).toBeCloseTo(out.records.reduce((s, r) => s + r.costUsd, 0), 9);
  });

  it('applies model, server, and repeat filters', async () => {
    const out = await runSuites(await opts({ models: ['mock/a'], repeats: 1 }));
    expect(out.records).toHaveLength(2);
  });

  // Review Focus 2
  it('rejects unknown model or server filters before running anything', async () => {
    const o = await opts({ models: ['mock/typo'] });
    await expect(runSuites(o)).rejects.toBeInstanceOf(ConfigError);
    await expect(runSuites(await opts({ servers: ['nope'] }))).rejects.toThrow(/Unknown server/);
  });

  it('retries retryable infra errors, then succeeds', async () => {
    let calls = 0;
    const inner = new MockProvider(SCRIPT);
    const flaky: ModelProvider = {
      name: 'flaky',
      chat: (req) => (calls++ === 0 ? Promise.reject(new ProviderError('503', true, 503)) : inner.chat(req)),
    };
    const sleep = vi.fn(async () => {});
    const out = await runSuites(await opts({ provider: flaky, sleep, models: ['mock/a'], repeats: 1 }));
    expect(out.records[0]).toMatchObject({ outcome: 'pass', attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('records error (not fail) after retries are exhausted or for non-retryable errors', async () => {
    const down: ModelProvider = { name: 'down', chat: () => Promise.reject(new ProviderError('500', true, 500)) };
    const sleep = vi.fn(async () => {});
    const out = await runSuites(await opts({ provider: down, sleep, retries: 2, models: ['mock/a'], repeats: 1 }));
    expect(out.records.every((r) => r.outcome === 'error')).toBe(true);
    expect(out.records[0]!.attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(4);

    const fatal: ModelProvider = { name: 'fatal', chat: () => Promise.reject(new ProviderError('401', false, 401)) };
    const out2 = await runSuites(await opts({ provider: fatal, models: ['mock/a'], repeats: 1 }));
    expect(out2.records[0]).toMatchObject({ outcome: 'error', attempts: 1 });
  });

  it('stops scheduling and marks partial when the budget is spent', async () => {
    const out = await runSuites(await opts({ budgetUsd: 0.0035 }));
    expect(out.partial).toBe(true);
    expect(out.records.length).toBeLessThan(8);
    expect(out.totalCostUsd).toBeLessThanOrEqual(0.0035 + 0.001);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/runner`
Expected: FAIL — cannot resolve `./run.js`.

- [ ] **Step 3: Write `packages/core/src/runner/run.ts`**

```ts
import { runAgentLoop, type AgentRunResult } from '../agent/loop.js';
import { ConfigError, InfraError } from '../errors.js';
import type { FixtureManager, Workspace } from '../fixtures/manager.js';
import { describeFailures, runGraders, taskPassed, toolSelectionOk } from '../graders.js';
import { runSetup } from '../mcp/setup.js';
import { convertTools } from '../tools/convert.js';
import type { Connector, GraderResult, McpConnection, ModelProvider, Outcome, RunRecord, Suite, TaskSpec } from '../types.js';
import { runKey, sleep as realSleep, substituteVars } from '../util.js';

export interface RunSuitesOptions {
  suites: Suite[];
  provider: ModelProvider;
  connector: Connector;
  fixtures: FixtureManager;
  models?: string[];
  servers?: string[];
  repeats?: number;
  budgetUsd?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  onRecord?: (r: RunRecord) => void;
  now?: () => Date;
}

export interface RunSuitesOutput {
  records: RunRecord[];
  partial: boolean;
  totalCostUsd: number;
  startedAt: string;
  finishedAt: string;
}

interface RunTarget {
  suite: Suite;
  serverName: string;
  model: string;
  task: TaskSpec;
  repeat: number;
}

export async function runSuites(o: RunSuitesOptions): Promise<RunSuitesOutput> {
  validateFilters(o);
  const now = o.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const budget = o.budgetUsd ?? Number.POSITIVE_INFINITY;
  const records: RunRecord[] = [];
  let spent = 0;
  let partial = false;

  outer: for (const suite of o.suites) {
    if (suite.fixture) await o.fixtures.prepare(suite.fixture);
    const models = o.models ? suite.models.filter((m) => o.models!.includes(m)) : suite.models;
    const servers = Object.keys(suite.servers).filter((s) => !o.servers || o.servers.includes(s));
    const repeats = o.repeats ?? suite.defaults.repeats;
    for (const serverName of servers) {
      for (const model of models) {
        for (const task of suite.tasks) {
          if (task.servers && !task.servers.includes(serverName)) continue;
          for (let repeat = 0; repeat < repeats; repeat++) {
            if (spent >= budget) {
              partial = true;
              break outer;
            }
            const record = await runOne(o, { suite, serverName, model, task, repeat }, (c) => spent + c >= budget);
            spent += record.costUsd;
            records.push(record);
            o.onRecord?.(record);
            if (record.end === 'budget') {
              partial = true;
              break outer;
            }
          }
        }
      }
    }
  }
  return { records, partial, totalCostUsd: spent, startedAt, finishedAt: now().toISOString() };
}

function validateFilters(o: RunSuitesOptions): void {
  const allModels = new Set(o.suites.flatMap((s) => s.models));
  const allServers = new Set(o.suites.flatMap((s) => Object.keys(s.servers)));
  const badModels = (o.models ?? []).filter((m) => !allModels.has(m));
  const badServers = (o.servers ?? []).filter((s) => !allServers.has(s));
  if (badModels.length) throw new ConfigError(`Unknown model(s): ${badModels.join(', ')}. Suites declare: ${[...allModels].join(', ')}`);
  if (badServers.length) throw new ConfigError(`Unknown server(s): ${badServers.join(', ')}. Suites declare: ${[...allServers].join(', ')}`);
}

async function runOne(o: RunSuitesOptions, target: RunTarget, overBudget: (runCostUsd: number) => boolean): Promise<RunRecord> {
  const { suite, serverName, model, task } = target;
  const server = suite.servers[serverName]!;
  const retries = o.retries ?? 3;
  const sleep = o.sleep ?? realSleep;
  let attempts = 0;
  let costUsd = 0;

  for (;;) {
    attempts++;
    let ws: Workspace | undefined;
    let conn: McpConnection | undefined;
    let result: AgentRunResult | undefined;
    let stderr = '';
    try {
      ws = await o.fixtures.createWorkspace(suite.fixture);
      const vars = { fixture: ws.dir };
      if (server.setup) await runSetup(substituteVars(server.setup, vars), ws.dir);
      conn = await o.connector(server, { cwd: ws.dir, vars });
      const tools = convertTools(await conn.listTools());
      const priorCost = costUsd;
      result = await runAgentLoop({
        provider: o.provider,
        connection: conn,
        tools,
        model,
        prompt: task.prompt,
        maxSteps: task.maxSteps ?? suite.defaults.maxSteps,
        timeoutMs: (task.timeoutS ?? suite.defaults.timeoutS) * 1000,
        temperature: suite.defaults.temperature,
        shouldStop: (loopCost) => overBudget(priorCost + loopCost),
      });
      costUsd += result.costUsd;
      stderr = conn.stderr();
      if (result.end === 'infra_error' && result.infraError) throw result.infraError;
      if (result.end === 'budget') return makeRecord(target, 'error', result, [], 'budget exhausted', stderr, attempts, costUsd);
      const graders = await runGraders(task.graders, {
        server: serverName,
        finalAnswer: result.finalAnswer,
        events: result.events,
        steps: result.steps,
        contextTokens: result.contextTokens,
        workspace: ws,
      });
      const pass = taskPassed(graders, result.end);
      const reason = pass ? undefined : result.end === 'final_answer' ? describeFailures(graders) : result.failReason;
      return makeRecord(target, pass ? 'pass' : 'fail', result, graders, reason, stderr, attempts, costUsd);
    } catch (e) {
      if (!(e instanceof InfraError)) throw e;
      stderr = conn?.stderr() ?? stderr;
      if (e.retryable && attempts <= retries) {
        await sleep(500 * 2 ** (attempts - 1));
        continue;
      }
      return makeRecord(target, 'error', result, [], `${e.kind}: ${e.message}`, stderr, attempts, costUsd);
    } finally {
      if (conn) await conn.close();
      if (ws) await ws.dispose();
    }
  }
}

function makeRecord(
  target: RunTarget,
  outcome: Outcome,
  result: AgentRunResult | undefined,
  graders: GraderResult[],
  failReason: string | undefined,
  serverStderr: string,
  attempts: number,
  costUsd: number,
): RunRecord {
  const key = runKey({ suite: target.suite.name, server: target.serverName, model: target.model, task: target.task.id, repeat: target.repeat });
  const base = { suite: target.suite.name, server: target.serverName, model: target.model, task: target.task.id, repeat: target.repeat };
  return {
    runKey: key,
    ...base,
    outcome,
    end: result?.end ?? null,
    ...(failReason ? { failReason } : {}),
    graders,
    toolSelectionOk: outcome === 'error' ? null : toolSelectionOk(graders, result?.end ?? null),
    steps: result?.steps ?? 0,
    contextTokens: result?.contextTokens ?? 0,
    latencyMs: result?.latencyMs ?? 0,
    costUsd,
    attempts,
    trace: { runKey: key, ...base, events: result?.events ?? [], serverStderr },
  };
}
```

Note: when a retryable error happens on the last allowed attempt, `attempts` equals `retries + 1`; the test with `retries: 2` therefore expects 3 attempts per run and 2 sleeps per run (4 sleeps over its 2 runs: the `echo` and `write` tasks for `mock/a`).

- [ ] **Step 4: Run the runner tests**

Run: `pnpm vitest run packages/core/src/runner`
Expected: all PASS.

- [ ] **Step 5: Write the public exports in `packages/core/src/index.ts`**

```ts
export * from './types.js';
export * from './errors.js';
export * from './util.js';
export { loadSuite, parseSuite, SuiteError } from './suite/load.js';
export { runGraders, taskPassed, toolSelectionOk, describeFailures, type GradeContext } from './graders.js';
export { wilson } from './results/wilson.js';
export { ResultsSchema, type Results } from './results/schema.js';
export { aggregate, type AggregateInput } from './results/aggregate.js';
export { convertTools, sanitizeToolName, type ToolMapping } from './tools/convert.js';
export { MockProvider, parseMockScript, loadMockScript, DEFAULT_MOCK_COST_USD, type MockScript } from './providers/mock.js';
export { FixtureManager, snapshotDir, type Workspace, type FixtureManagerOptions } from './fixtures/manager.js';
export { stdioConnector, createInMemoryConnector, contentToText } from './mcp/connection.js';
export { runSetup } from './mcp/setup.js';
export { runAgentLoop, SYSTEM_PROMPT, DEFAULT_TOOL_TIMEOUT_MS, type AgentLoopOptions, type AgentRunResult } from './agent/loop.js';
export { runSuites, type RunSuitesOptions, type RunSuitesOutput } from './runner/run.js';
```

- [ ] **Step 6: Run the whole core suite, typecheck, and build**

Run: `pnpm vitest run packages/core && pnpm --filter @mcp-evals/core typecheck && pnpm --filter @mcp-evals/core build`
Expected: all PASS; typecheck exits 0; `packages/core/dist/index.js` and `index.d.ts` exist.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runner packages/core/src/index.ts
git commit -m "feat(core): runner with retries, budget cap, and public exports

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: CLI `run` command and table report

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/tsup.config.ts`
- Create: `packages/cli/src/index.ts`, `packages/cli/src/version.ts`, `packages/cli/src/commands/run.ts`, `packages/cli/src/report/table.ts`
- Test: `packages/cli/src/report/table.test.ts`, `packages/cli/src/commands/run.test.ts`

**Interfaces:**
- Consumes: everything exported from `@mcp-evals/core` in Task 9.
- Produces:
  - `pct(x: number): string`, `ci(range: [number, number]): string`, `usd(x: number): string`, `formatTable(results: Results): string`.
  - `interface RunCommandOptions { suites: string[]; provider: string; mockScript?: string; models?: string[]; servers?: string[]; repeats?: number; budgetUsd?: number; out: string; traces?: string; cacheDir: string; retries?: number; connector?: Connector; log?: (line: string) => void }`, `runCommand(o): Promise<{ exitCode: number; results?: Results }>` — exit 0 on a completed run (fails included), 2 on `SuiteError`/`ConfigError`.
  - Binary `mcp-evals run <suites...> --provider mock --mock-script <file> [--models a,b] [--servers x,y] [--repeats n] [--budget-usd n] [--out results.json] [--traces traces.jsonl] [--cache-dir .mcp-evals/cache]`.

- [ ] **Step 1: Write package files**

`packages/cli/package.json`:
```json
{
  "name": "@mcp-evals/cli",
  "version": "0.0.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "bin": { "mcp-evals": "./dist/index.js" },
  "files": ["dist"],
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@mcp-evals/core": "workspace:*",
    "commander": "^12.1.0"
  }
}
```

`packages/cli/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*"]
}
```

`packages/cli/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
});
```

Run: `pnpm install`
Expected: `@mcp-evals/core` linked into `packages/cli/node_modules`.

- [ ] **Step 2: Write `packages/cli/src/version.ts`**

```ts
import { createRequire } from 'node:module';

// Resolves to packages/cli/package.json from both src/ and dist/.
export const CLI_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
```

- [ ] **Step 3: Write the failing tests**

`packages/cli/src/report/table.test.ts`:
```ts
import type { Results } from '@mcp-evals/core';
import { describe, expect, it } from 'vitest';
import { ci, formatTable, pct, usd } from './table.js';

const results: Results = {
  schemaVersion: 1, harnessVersion: '0.0.0', runId: 'run-1',
  startedAt: '2026-10-15T00:00:00.000Z', finishedAt: '2026-10-15T00:00:01.000Z', partial: true, totalCostUsd: 0.012,
  suites: [{
    suite: 'demo', suiteVersion: 1, fixture: null, servers: { fake: { command: 'node' } }, models: [{ id: 'mock/a', provider: 'mock' }],
    cells: [{
      server: 'fake', model: 'mock/a', runs: 4, successRate: 0.75, successCi95: [0.3006, 0.9544], toolAccuracy: null,
      contextTokensPerTask: { mean: 10, median: 12.4 }, stepsPerTask: 2, latencyMsP50: 5, costUsdPerTask: 0.002, errorRate: 0,
      tasks: [],
    }],
  }],
};

describe('formatting helpers', () => {
  it('formats percentages, intervals, and dollars', () => {
    expect(pct(0.756)).toBe('76%');
    expect(ci([0.3006, 0.9544])).toBe('[30–95%]');
    expect(usd(0.002)).toBe('$0.0020');
  });
});

describe('formatTable', () => {
  it('renders a header, one row per cell, the partial notice, and the total', () => {
    const lines = formatTable(results).split('\n');
    expect(lines[0]).toMatch(/^SUITE\s+SERVER\s+MODEL\s+RUNS\s+SUCCESS\s+95% CI\s+TOOL ACC\s+CTX TOK \(med\)\s+STEPS\s+\$\/TASK\s+ERRORS$/);
    expect(lines[1]).toMatch(/^demo\s+fake\s+mock\/a\s+4\s+75%\s+\[30–95%\]\s+–\s+12\s+2\.0\s+\$0\.0020\s+0%$/);
    expect(lines).toContain('PARTIAL: budget cap reached before all runs finished.');
    expect(lines.at(-1)).toBe('total cost $0.0120 · run run-1');
  });
});
```

`packages/cli/src/commands/run.test.ts`:
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResultsSchema } from '@mcp-evals/core';
import { describe, expect, it } from 'vitest';
import { runCommand } from './run.js';

const FAKE = fileURLToPath(new URL('../../../core/test/fixtures/fake-server.mjs', import.meta.url));

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'cli-run-'));
  const suite = join(dir, 'suite.yaml');
  await writeFile(
    suite,
    [
      'suite: e2e',
      'version: 1',
      'servers:',
      `  fake: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE)}] }`,
      'models: [mock/a]',
      'defaults: { repeats: 2, max_steps: 4, timeout_s: 20 }',
      'tasks:',
      '  - id: echo',
      '    prompt: "ECHO please"',
      '    graders: [{ type: tool_called, tool: echo }, { type: answer_contains_all, values: [hello] }]',
      '  - id: crash',
      '    prompt: "CRASH please"',
      '    graders: [{ type: tool_called, tool: crash }]',
    ].join('\n'),
  );
  const script = join(dir, 'script.json');
  await writeFile(
    script,
    JSON.stringify({
      entries: [
        { match: 'ECHO', steps: [{ toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }] }, { content: 'hello' }] },
        { match: 'CRASH', steps: [{ toolCalls: [{ name: 'crash' }] }, { content: 'unreachable' }] },
      ],
    }),
  );
  return { dir, suite, script };
}

describe('runCommand (end-to-end over stdio, mock model)', () => {
  it('runs, writes valid results and traces, and prints a table', async () => {
    const { dir, suite, script } = await workspace();
    const lines: string[] = [];
    const { exitCode, results } = await runCommand({
      suites: [suite], provider: 'mock', mockScript: script,
      out: join(dir, 'out', 'results.json'), traces: join(dir, 'traces.jsonl'),
      cacheDir: join(dir, 'cache'), retries: 0, log: (l) => lines.push(l),
    });
    expect(exitCode).toBe(0);
    const written = ResultsSchema.parse(JSON.parse(await readFile(join(dir, 'out', 'results.json'), 'utf8')));
    expect(written).toEqual(results);
    const cell = written.suites[0]!.cells[0]!;
    expect(cell.runs).toBe(4);
    expect(cell.tasks).toEqual([
      expect.objectContaining({ id: 'echo', passes: 2, fails: 0, errors: 0 }),
      // Review Focus 3: a crashing server is an error, never a model fail
      expect.objectContaining({ id: 'crash', passes: 0, fails: 0, errors: 2 }),
    ]);
    expect(cell.errorRate).toBe(0.5);
    const traces = (await readFile(join(dir, 'traces.jsonl'), 'utf8')).trim().split('\n');
    expect(traces).toHaveLength(4);
    expect(JSON.parse(traces[0]!)).toHaveProperty('events');
    expect(lines.some((l) => l.startsWith('SUITE'))).toBe(true);
  });

  it('exits 2 with a clear message for invalid suites and bad flags', async () => {
    const { dir, suite, script } = await workspace();
    const bad = join(dir, 'bad.yaml');
    await writeFile(bad, 'suite: x\nversion: 1\n');
    const lines: string[] = [];
    const base = { out: join(dir, 'r.json'), cacheDir: join(dir, 'c'), retries: 0, log: (l: string) => lines.push(l) };
    expect((await runCommand({ ...base, suites: [bad], provider: 'mock', mockScript: script })).exitCode).toBe(2);
    expect((await runCommand({ ...base, suites: [suite], provider: 'openrouter' })).exitCode).toBe(2);
    expect((await runCommand({ ...base, suites: [suite], provider: 'mock' })).exitCode).toBe(2);
    expect((await runCommand({ ...base, suites: [suite], provider: 'mock', mockScript: script, models: ['mock/typo'] })).exitCode).toBe(2);
    expect(lines.filter((l) => l.startsWith('error: '))).toHaveLength(4);
    expect(existsSync(join(dir, 'r.json'))).toBe(false);
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm vitest run packages/cli`
Expected: FAIL — cannot resolve `./table.js` / `./run.js`.

- [ ] **Step 5: Write `packages/cli/src/report/table.ts`**

```ts
import type { Results } from '@mcp-evals/core';

export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export const ci = ([lo, hi]: [number, number]): string => `[${Math.round(lo * 100)}–${Math.round(hi * 100)}%]`;
export const usd = (x: number): string => `$${x.toFixed(4)}`;

const HEADER = ['SUITE', 'SERVER', 'MODEL', 'RUNS', 'SUCCESS', '95% CI', 'TOOL ACC', 'CTX TOK (med)', 'STEPS', '$/TASK', 'ERRORS'];

export function formatTable(results: Results): string {
  const rows = results.suites.flatMap((s) =>
    s.cells.map((c) => [
      s.suite,
      c.server,
      c.model,
      String(c.runs),
      pct(c.successRate),
      ci(c.successCi95),
      c.toolAccuracy === null ? '–' : pct(c.toolAccuracy),
      String(Math.round(c.contextTokensPerTask.median)),
      c.stepsPerTask.toFixed(1),
      usd(c.costUsdPerTask),
      pct(c.errorRate),
    ]),
  );
  const widths = HEADER.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  const out = [line(HEADER), ...rows.map(line)];
  if (results.partial) out.push('', 'PARTIAL: budget cap reached before all runs finished.');
  out.push('', `total cost ${usd(results.totalCostUsd)} · run ${results.runId}`);
  return out.join('\n');
}
```

- [ ] **Step 6: Write `packages/cli/src/commands/run.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  aggregate,
  ConfigError,
  FixtureManager,
  loadMockScript,
  loadSuite,
  MockProvider,
  ResultsSchema,
  runSuites,
  stdioConnector,
  SuiteError,
  type Connector,
  type ModelProvider,
  type Results,
} from '@mcp-evals/core';
import { formatTable } from '../report/table.js';
import { CLI_VERSION } from '../version.js';

export interface RunCommandOptions {
  suites: string[];
  provider: string;
  mockScript?: string;
  models?: string[];
  servers?: string[];
  repeats?: number;
  budgetUsd?: number;
  out: string;
  traces?: string;
  cacheDir: string;
  retries?: number;
  connector?: Connector;
  log?: (line: string) => void;
}

export async function runCommand(o: RunCommandOptions): Promise<{ exitCode: number; results?: Results }> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    const provider = await makeProvider(o);
    const suites = await Promise.all(o.suites.map((p) => loadSuite(resolve(p))));
    const run = await runSuites({
      suites,
      provider,
      connector: o.connector ?? stdioConnector,
      fixtures: new FixtureManager({ cacheDir: resolve(o.cacheDir) }),
      ...(o.models ? { models: o.models } : {}),
      ...(o.servers ? { servers: o.servers } : {}),
      ...(o.repeats !== undefined ? { repeats: o.repeats } : {}),
      ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}),
      ...(o.retries !== undefined ? { retries: o.retries } : {}),
      onRecord: (r) =>
        log(`${r.outcome.padEnd(5)} ${r.suite}/${r.server}/${r.model}/${r.task}#${r.repeat}${r.failReason ? ` — ${r.failReason}` : ''}`),
    });
    const results = ResultsSchema.parse(
      aggregate({
        records: run.records,
        suites,
        providerName: provider.name,
        harnessVersion: CLI_VERSION,
        runId: `${run.startedAt.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        partial: run.partial,
        totalCostUsd: run.totalCostUsd,
      }),
    );
    await writeText(o.out, `${JSON.stringify(results, null, 2)}\n`);
    if (o.traces) await writeText(o.traces, run.records.map((r) => JSON.stringify(r.trace)).join('\n') + '\n');
    log('');
    log(formatTable(results));
    return { exitCode: 0, results };
  } catch (e) {
    if (e instanceof SuiteError || e instanceof ConfigError) {
      log(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}

async function makeProvider(o: RunCommandOptions): Promise<ModelProvider> {
  if (o.provider !== 'mock') throw new ConfigError(`unknown provider "${o.provider}" (M1 supports: mock)`);
  if (!o.mockScript) throw new ConfigError('--mock-script is required with --provider mock');
  return new MockProvider(await loadMockScript(resolve(o.mockScript)));
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), text);
}
```

- [ ] **Step 7: Write `packages/cli/src/index.ts`**

```ts
import { Command, InvalidArgumentError } from 'commander';
import { runCommand } from './commands/run.js';
import { CLI_VERSION } from './version.js';

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

function positiveInt(flag: string) {
  return (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError(`${flag} must be a positive integer`);
    return n;
  };
}

function positiveNumber(flag: string) {
  return (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError(`${flag} must be a positive number`);
    return n;
  };
}

const program = new Command().name('mcp-evals').description('Benchmark MCP servers and the models that use them').version(CLI_VERSION);

program
  .command('run')
  .description('Run one or more suites and write results.json')
  .argument('<suites...>', 'suite YAML files')
  .requiredOption('--provider <name>', 'model provider (M1: mock)')
  .option('--mock-script <path>', 'scripted responses for --provider mock')
  .option('--models <ids>', 'comma-separated model ids to run', list)
  .option('--servers <names>', 'comma-separated server names to run', list)
  .option('--repeats <n>', 'override repeats per task', positiveInt('--repeats'))
  .option('--budget-usd <n>', 'hard cost cap for the whole run', positiveNumber('--budget-usd'))
  .option('--out <path>', 'results file', 'results.json')
  .option('--traces <path>', 'write traces as JSONL')
  .option('--cache-dir <path>', 'fixture cache directory', '.mcp-evals/cache')
  .action(async (suites: string[], opts: { provider: string; mockScript?: string; models?: string[]; servers?: string[]; repeats?: number; budgetUsd?: number; out: string; traces?: string; cacheDir: string }) => {
    const { exitCode } = await runCommand({ suites, ...opts });
    process.exitCode = exitCode;
  });

await program.parseAsync();
```

- [ ] **Step 8: Run all tests, typecheck, and build**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: every test PASSES; typecheck exits 0; `packages/cli/dist/index.js` exists.

- [ ] **Step 9: Smoke-test the built binary**

Run (from the repo root; reuses the e2e files via a temp dir):
```bash
D=$(mktemp -d) && FAKE="$PWD/packages/core/test/fixtures/fake-server.mjs" && NODE="$(command -v node)" && \
printf 'suite: smoke\nversion: 1\nservers:\n  fake: { command: "%s", args: ["%s"] }\nmodels: [mock/a]\ndefaults: { repeats: 1 }\ntasks:\n  - id: echo\n    prompt: "ECHO"\n    graders: [{ type: tool_called, tool: echo }]\n' "$NODE" "$FAKE" > "$D/s.yaml" && \
echo '{"entries":[{"match":"ECHO","steps":[{"toolCalls":[{"name":"echo","arguments":{"text":"hi"}}]},{"content":"hi"}]}]}' > "$D/m.json" && \
node packages/cli/dist/index.js run "$D/s.yaml" --provider mock --mock-script "$D/m.json" --out "$D/results.json"; echo "exit=$?"
```
Expected: a `pass  smoke/fake/mock/a/echo#0` line, the table with `100%`, and `exit=0`.

- [ ] **Step 10: Commit**

```bash
git add packages/cli pnpm-lock.yaml
git commit -m "feat(cli): mcp-evals run with mock provider and table report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
