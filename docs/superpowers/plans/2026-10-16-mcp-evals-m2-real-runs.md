# mcp-evals M2 (Real runs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the M1 offline harness into one that produces real, reproducible results: an OpenRouter provider with provider pinning and out-of-credits handling, a model-independent tokenizer, `answer_json_schema` and `llm_judge` graders, a run cache with `--resume`, results schema v2, `compare`/`report`/`publish` commands, cost pre-flight, the two real suites with verified answer keys, and a methodology note — all tested offline.

**Architecture:** Same pnpm monorepo. `packages/core` gains `tokens.ts`, `providers/openrouter.ts`, `runner/cache.ts`, `runner/preflight.ts`, `grading/json-schema.ts`, `grading/judge.ts`, `results/read.ts`, and patches to the loader, graders, loop, connector, runner and aggregator. `packages/cli` gains a testable `program.ts` (commander, exit 2 on usage errors), `.env` loading, OpenRouter pre-flight, `compare`, `report` and `publish`. Tests talk to a local fake OpenRouter HTTP server (`node:http`) and the existing fake MCP server; nothing touches the network.

**Tech Stack:** Node ≥20, TypeScript 5 (strict, ESM), pnpm 10.33.0, vitest 2, tsup 8, `@modelcontextprotocol/sdk` ^1.29.0, zod ^4.4.1, yaml ^2.8.0, commander ^12.1.0, **new:** `gpt-tokenizer` ^4.0.3 (checked with `npm view gpt-tokenizer version` → 4.0.3 on 2026-10-16).

**Spec:** `docs/superpowers/specs/2026-10-15-mcp-evals-m2-design.md` (authoritative for M2), extending `docs/superpowers/specs/2026-10-15-mcp-evals-design.md`. Also read `docs/superpowers/plans/2026-10-15-m1-followups.md`. Read the M2 spec §3–§6 before starting any task.

## Global Constraints

- Node `>=20` (root `engines` unchanged); ESM only; `tsconfig.base.json` unchanged (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` → `import type` for types, `noUnusedLocals`, `noUnusedParameters`).
- Package manager `pnpm@10.33.0`. The **only** new runtime dependency is `gpt-tokenizer` `^4.0.3` in `packages/core` (added by Task 1). No HTTP SDK (use Node `fetch`), no dotenv (use `process.loadEnvFile()`), no JSON-Schema library, no other new dependency.
- Model lineup and provider pins (exact): `anthropic/claude-sonnet-5.5` → `anthropic`; `openai/gpt-6.1-sol` → `openai`; `google/gemini-3.8-flash` → `google-ai-studio`; `qwen/qwen3.8-flash` → `alibaba`. Every OpenRouter request sends `provider: { order: [<slug>], allow_fallbacks: false }`. A model without a pin is a config error for OpenRouter runs.
- Judge model: `anthropic/claude-haiku-5.5` pinned to `anthropic`.
- Headline context metric: `gpt-tokenizer` `o200k_base` (`import { countTokens } from 'gpt-tokenizer/encoding/o200k_base'`), identical for every model; special-token text (`<|endoftext|>`) is counted as plain text, never thrown on. Provider-reported prompt tokens are kept as a secondary column.
- HTTP: Node `fetch` to `https://openrouter.ai/api/v1/chat/completions` and `GET https://openrouter.ai/api/v1/models`. `usage.cost` (credits) is treated as USD. Do not send `usage: { include: true }` (OpenRouter docs: deprecated, usage is always included).
- Code-navigation fixture: `https://github.com/honojs/hono` v4.13.13 @ `08a023cbfde55b434fb0fb30fae35d42e4bf20aa`.
- Servers (exact): `neatcode` — `npx -y @neatcodeai/mcp@0.1.4`, setup `npx -y @neatcodeai/cli@0.1.4 init`; `filesystem` — `npx -y @modelcontextprotocol/server-filesystem@1.0.0 {fixture}`; `memory` — `npx -y @modelcontextprotocol/server-memory@1.0.0` with `MEMORY_FILE_PATH={fixture}/.memory.json`.
- API key only from `OPENROUTER_API_KEY`. The CLI loads `.env` from the working directory at startup with `process.loadEnvFile()`; variables already set in the environment win. The key is never logged, traced, written to results/caches, or included in error messages (redacted). Missing key → `ConfigError` (exit 2) before any work, with a hint to copy `.env.example` to `.env`.
- Errors: 429/5xx/408, network errors, request timeouts → `ProviderError(retryable: true)`; other 4xx → `ProviderError(retryable: false)`; 402 → `OutOfCreditsError`, which stops the whole run (no new runs, results so far kept, `partial: true`). Malformed JSON → non-retryable.
- Budget: first real run **$10 cap**, code-navigation only, 4 models, 2 repeats (~192 runs); the smoke run's spend counts toward the $10. At the cap: no new runs start, the in-flight run stops before its next model call (cost counted, no record), results are written with `partial: true` and incomplete cells `complete: false`. The OpenRouter key has a $20 limit (backstop).
- `results.json` has `schemaVersion: 2` and validates against `ResultsSchema`; `readResults()` accepts v1 and upgrades it.
- Exit codes: `0` success (including a partial run), `1` `compare` found a regression, `2` usage/config errors (bad flags, invalid files, failed pre-flight).
- **Tests never touch the network or spend money.** OpenRouter tests use the local fake server in `packages/core/test/fixtures/fake-openrouter.ts`; no real key. The answer-key tests are skipped unless a checkout of the pinned fixture exists. The live run (wave E) is never part of the test suite.
- Fairness (base spec §5.3) unchanged: one `SYSTEM_PROMPT`, one `convertTools`, temperature 0, fresh workspace and server per run; `{fixture}` is substituted identically for every server.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Spec refinements made here** (decisions the spec leaves open):
- `run` also takes `--tasks <ids>` (needed for the 3-task smoke run), `--estimate-from <results.json>` (the smoke run's measured cost per run, per model; models not in it fall back to catalog prices), and `--runs-dir` (run cache location, default `.mcp-evals/runs`).
- `--budget-usd` on a resumed run caps that invocation's new spend; `totalCostUsd` reports all spend of the run.
- Records with outcome `error` count as finished for `--resume` (matches the `complete` definition); a resume never re-runs them.
- `pass_threshold` on `llm_judge`: the judge also returns `score` (0–1); with a threshold, pass = `score >= pass_threshold`; without one, pass = the judge's `pass`.
- `providerPromptTokensPerTask` = sum of provider-reported `prompt_tokens` over the run's agent model calls (judge calls excluded).
- `compare`: cells with `plannedRuns !== null && !complete` are reported `incomplete` and never count as regressions (like missing cells); v1 cells (unknown completeness) are compared normally. Success drop is in percentage points, context increase in percent of the base median; values are rounded to 1e-6 so a drop exactly at the threshold is not a regression.
- A 402 or budget stop exits 0 with `partial: true` and prints the `--resume` command.
- `{fixture}` is the workspace's real path (`realpath`), so macOS `/var` → `/private/var` symlinks never make the prompt and the filesystem server disagree.
- A `publish` CLI command implements the spec §5.3 layout (so it is tested), instead of an untested script.

## Review Focus

1. **OpenRouter HTTP 200 whose body is an error object** (OpenRouter reports upstream failures and failover exhaustion this way, and `finish_reason: "error"` for interrupted generations): must be classified by `error.code` (5xx retryable, 402 out of credits), never parsed as an empty final answer — test in Task 3.
2. **A response without `usage.cost`**: cost must fall back to catalog prices × tokens so the budget cap still holds, not silently count $0 — test in Task 3.
3. **A run cache whose last line was cut off** (process killed mid-append): `--resume` must drop the partial line, re-run that run, and keep later appends parseable — test in Task 4.
4. **A success drop exactly at `--max-success-drop`** (0.75 → 0.70 with 5 pts is 5.000000000000004 in floating point): must not be a regression; one hair over must be — test in Task 6.
5. **Symlinked temp directories** (macOS `tmpdir()` is under `/var` → `/private/var`): the `{fixture}` path in the prompt and in the server args must be the same real path — test in Task 8.

## Execution notes (parallel agents)

Dependency waves — tasks in the same wave touch disjoint files and can run in parallel, each in its own git worktree/branch, merged after review. Every branch must pass `pnpm test && pnpm typecheck` on its own.

Plan check (2026-10-16): every code block and edit in Tasks 1–12 was applied, in order, to a scratch copy of `main` outside the repo; `pnpm test` (219 passed, 3 answer-key tests skipped offline), `pnpm typecheck`, `pnpm build` and the Task 9 binary smoke test all passed, and the answer-key tests passed against a checkout of the pinned Hono commit. If a step's code does not compile for you, the plan text changed after that check — fix the code, not the test.

| Wave | Tasks | Depends on |
|---|---|---|
| A | 1, then 2 (sequential) | — |
| B | 3, 4, 5, 6, 7 (parallel) | 2 |
| C | 8, then 9 (sequential) | 3, 4, 5, 6, 7 |
| D | 10, 11, 12 (parallel) | 9 |
| E | live run runbook (the user, with their key; not an implementer task) | 10, 11, 12 |

File-ownership rules:
- **`package.json` files and `pnpm-lock.yaml`:** only Task 1 edits them (adds `gpt-tokenizer`). No other task adds or changes dependencies.
- **`packages/core/src/index.ts`:** Task 1 and Task 2 add their own exports (wave A). Wave-B tasks never edit it — they import siblings by relative path, and the CLI-side Task 6 uses only exports that exist after wave A (`readResults`, `ConfigError`, `Results`). Task 8 adds every wave-B/C export in one edit.
- **`packages/core/src/types.ts`:** wave A (Task 1). In wave B only Task 5 edits it, and only the `GraderSpec` union plus the new `JsonSchema` interface.
- **`packages/core/src/suite/load.ts`:** Task 1 (wave A); Task 5 (wave B, grader schemas only).
- **`packages/core/src/agent/loop.ts`:** Task 1 (tokenizer swap), Task 7 (wave B, tool timeouts), Task 8 (wave C, pin/servedBy/out-of-credits).
- **`packages/core/src/runner/run.ts`:** Task 2 (adds `planned`), Task 8.
- **CLI:** Task 2 patches `commands/run.ts` and `report/table.test.ts` for schema v2 (wave A). Task 6 creates `files.ts`, `report/*`, `commands/compare.ts`, `commands/report.ts`, `testing/results-fixture.ts`. Task 9 owns `program.ts`, `index.ts`, `env.ts`, `commands/run.ts`, `commands/preflight.ts`. Task 12 adds `commands/publish.ts` and registers it in `program.ts`.
- Wave D: Task 10 owns `suites/code-navigation.yaml` + `packages/core/test/suite-code-navigation.test.ts`; Task 11 owns `suites/general-tools.yaml` + `packages/core/test/suite-general-tools.test.ts`; Task 12 owns `docs/methodology.md`, `packages/cli/src/commands/publish.ts(+test)`, `packages/cli/src/program.ts`, `packages/cli/src/program.test.ts`.

## File Structure

```
packages/core/
  package.json                       + gpt-tokenizer (Task 1)
  src/tokens.ts                      countTokens (o200k_base) (Task 1)
  src/types.ts                       pins, judge, toolTimeoutS, PlannedCell, servedBy, tool_timeout… (Task 1); grader specs (Task 5)
  src/errors.ts                      + OutOfCreditsError, ToolTimeoutError (Task 1)
  src/suite/load.ts                  model objects, judge, tool_timeout_s, {fixture} in prompts (Task 1); new graders (Task 5)
  src/results/schema.ts              ResultsSchema v2 + ResultsV1Schema (Task 2)
  src/results/aggregate.ts           v2 cells: plannedRuns, complete, provider prompt tokens, versions, pins, judge (Task 2)
  src/results/read.ts                readResults(): v1 → v2 upgrade (Task 2)
  src/providers/openrouter.ts        OpenRouterProvider, fetchModelCatalog (Task 3)
  test/fixtures/fake-openrouter.ts   local fake OpenRouter HTTP server (Task 3)
  src/runner/cache.ts                RunCache: JSONL records + manifest (Task 4)
  src/grading/json-schema.ts         JSON Schema subset validator + extractJson (Task 5)
  src/grading/judge.ts               runJudge (Task 5)
  src/graders.ts                     answer_json_schema, llm_judge ordering, fs_state ENOENT (Task 5)
  src/mcp/connection.ts              ToolTimeoutError, non-retryable unknown errors, serverVersion (Task 7)
  src/agent/loop.ts                  tool_timeout end (Task 7); pin, servedBy, out of credits (Task 8)
  src/runner/run.ts                  planned (Task 2); tasks filter, skip, realpath {fixture}, judge, versions, stop reasons, previewPlan (Task 8)
  src/runner/preflight.ts            checkServers, estimateCost, catalogIssues (Task 8)
  test/suite-code-navigation.test.ts (Task 10)   test/suite-general-tools.test.ts (Task 11)
packages/cli/
  src/files.ts                       fsReason, readResultsFile, writeFileAtomic (Task 6)
  src/report/table.ts                runs/planned, notices, alignColumns (Task 6)
  src/report/markdown.ts             formatMarkdown (Task 6)
  src/report/compare.ts              compareResults, formatComparison (Task 6)
  src/commands/compare.ts, report.ts (Task 6)
  src/testing/results-fixture.ts     Results builders for CLI tests (Task 6)
  src/program.ts                     commander program, exit 2 on usage errors (Task 9; publish added in Task 12)
  src/env.ts                         loadDotEnv (Task 9)
  src/index.ts                       .env + main (Task 9)
  src/commands/run.ts                openrouter default, resume, atomic writes (Task 9)
  src/commands/preflight.ts          OpenRouter pre-flight (Task 9)
  src/commands/publish.ts            data/runs/<runId>/… + data/latest.json (Task 12)
suites/code-navigation.yaml (Task 10)   suites/general-tools.yaml (Task 11)
docs/methodology.md (Task 12)
```

---

### Task 1: Tokenizer, M2 types and errors, suite format additions

**Files:**
- Modify: `packages/core/package.json` (dependencies), `pnpm-lock.yaml`
- Create: `packages/core/src/tokens.ts`, `packages/core/src/tokens.test.ts`, `packages/core/src/errors.test.ts`
- Modify: `packages/core/src/types.ts`, `packages/core/src/errors.ts`, `packages/core/src/util.ts:4-7`, `packages/core/src/util.test.ts:1-11`
- Modify: `packages/core/src/agent/loop.ts:4,126`, `packages/core/src/agent/loop.test.ts:11,34`, `packages/core/src/providers/mock.ts:5,45`
- Modify: `packages/core/src/suite/load.ts` (full replacement below), `packages/core/src/suite/load.test.ts`
- Modify: `packages/core/src/results/aggregate.test.ts:24-38` (Suite literal), `packages/core/src/index.ts`

**Interfaces:**
- Consumes: M1 code as on `main`.
- Produces:
  - `countTokens(text: string): number`, `TOKENIZER = 'gpt-tokenizer o200k_base'` (`tokens.ts`). `estimateTokens` is deleted.
  - `class OutOfCreditsError extends Error` (not a `ProviderError`); `class ToolTimeoutError extends Error { tool: string; timeoutMs: number }`.
  - Types: `RunDefaults.toolTimeoutS: number`; `ModelSpec { id; provider }`; `Suite.modelPins: Record<string, string>`; `Suite.judge?: ModelSpec`; `ChatRequest.providerPin?: string`; `ChatResponse.servedBy?: string`; `model_call` trace event `servedBy?: string`; `LoopEnd` adds `'tool_timeout'`; `McpConnection.serverVersion?(): string | undefined`; `GraderResult.costUsd?: number`; `RunRecord.serverVersion?: string`; `PlannedCell { suite; server; model; runs }`.
  - Loader: `models:` entries are a string or `{ id, provider }`; optional `judge: { id, provider }`; `defaults.tool_timeout_s` (default 60); `{fixture}` in a task prompt requires a fixture.

- [ ] **Step 1: Add the tokenizer dependency (the only dependency change in M2)**

Run: `pnpm --filter @mcp-evals/core add gpt-tokenizer@^4.0.3`
Expected: `packages/core/package.json` `dependencies` now contains `"gpt-tokenizer": "^4.0.3"` and `pnpm-lock.yaml` is updated.

- [ ] **Step 2: Write the failing tests**

`packages/core/src/tokens.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { countTokens, TOKENIZER } from './tokens.js';

describe('countTokens (o200k_base)', () => {
  it('counts with the o200k_base encoding', () => {
    expect(TOKENIZER).toBe('gpt-tokenizer o200k_base');
    expect(countTokens('')).toBe(0);
    expect(countTokens('hello')).toBe(1);
    expect(countTokens('Hello, world!')).toBe(4);
    expect(countTokens('x'.repeat(40))).toBe(5);
  });

  it('counts special-token text as plain text instead of throwing', () => {
    expect(() => countTokens('a <|endoftext|> b')).not.toThrow();
    expect(countTokens('a <|endoftext|> b')).toBe(9);
  });
});
```

`packages/core/src/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { OutOfCreditsError, ProviderError, ToolTimeoutError } from './errors.js';

describe('M2 errors', () => {
  it('OutOfCreditsError is not a ProviderError, so nothing retries it or records it as a run error', () => {
    const e = new OutOfCreditsError('OpenRouter 402: Insufficient credits');
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ProviderError);
    expect(e.name).toBe('OutOfCreditsError');
  });

  it('ToolTimeoutError names the tool and the timeout', () => {
    expect(new ToolTimeoutError('read_file', 50)).toMatchObject({
      name: 'ToolTimeoutError',
      tool: 'read_file',
      timeoutMs: 50,
      message: 'read_file: tool call timed out after 50ms',
    });
  });
});
```

In `packages/core/src/suite/load.test.ts`, change the defaults expectation in `'parses a valid suite, applies defaults, and maps to camelCase'`:
```ts
    expect(s.defaults).toEqual({ repeats: 3, maxSteps: 12, timeoutS: 120, temperature: 0, toolTimeoutS: 60 });
```
and add these tests at the end of `describe('parseSuite', …)`:
```ts
  it('parses pinned model objects, the judge block, and tool_timeout_s', () => {
    const s = parseSuite(
      yaml({
        models: [
          'models:',
          '  - { id: anthropic/claude-sonnet-5.5, provider: anthropic }',
          '  - qwen/qwen3.8-flash',
          'judge: { id: anthropic/claude-haiku-5.5, provider: anthropic }',
          'defaults: { tool_timeout_s: 30 }',
        ].join('\n'),
      }),
    );
    expect(s.models).toEqual(['anthropic/claude-sonnet-5.5', 'qwen/qwen3.8-flash']);
    expect(s.modelPins).toEqual({ 'anthropic/claude-sonnet-5.5': 'anthropic' });
    expect(s.judge).toEqual({ id: 'anthropic/claude-haiku-5.5', provider: 'anthropic' });
    expect(s.defaults.toolTimeoutS).toBe(30);
    expect(s.defaults.repeats).toBe(3);
  });

  it('defaults to no pins, no judge, and a 60 s tool timeout', () => {
    const s = parseSuite(yaml());
    expect(s.modelPins).toEqual({});
    expect(s.judge).toBeUndefined();
    expect(s.defaults.toolTimeoutS).toBe(60);
  });

  it('rejects bad provider slugs, bad judges, and models listed twice in either form', () => {
    expect(issuesOf(yaml({ models: 'models: [{ id: a/b, provider: "Anthropic Inc" }]' }))).toMatch(/models\.0/);
    expect(issuesOf(yaml({ models: 'models: [a/b]\njudge: { id: openrouter/auto, provider: x }' }))).toMatch(
      /judge: "openrouter\/auto" is not pinned/,
    );
    expect(issuesOf(yaml({ models: 'models: [a/b]\njudge: { id: haiku }' }))).toMatch(/judge/);
    expect(issuesOf(yaml({ models: 'models: [a/b, { id: a/b, provider: x }]' }))).toMatch(/models: "a\/b" is listed twice/);
  });

  it('rejects {fixture} in a task prompt when the suite has no fixture', () => {
    expect(issuesOf(yaml({ tasks: 'tasks:\n  - { id: t1, prompt: "look in {fixture}" }' }))).toMatch(
      /tasks\.t1\.prompt uses \{fixture\} but the suite has no fixture/,
    );
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/tokens.test.ts packages/core/src/errors.test.ts packages/core/src/suite/load.test.ts`
Expected: FAIL — `Cannot find module './tokens.js'`, `OutOfCreditsError` is not exported, and the new loader tests fail (`modelPins` undefined, model objects rejected).

- [ ] **Step 4: Write `tokens.ts` and the errors**

`packages/core/src/tokens.ts`:
```ts
import { countTokens as countO200k } from 'gpt-tokenizer/encoding/o200k_base';

/** Recorded in docs/methodology.md: the headline context metric is identical for every model. */
export const TOKENIZER = 'gpt-tokenizer o200k_base';

// Tool output may legitimately contain text such as "<|endoftext|>": count it as text, never throw.
const AS_TEXT = { disallowedSpecial: new Set<string>() };

/** Tokens in `text` under o200k_base. Depends only on the text, so it is comparable across servers and models. */
export function countTokens(text: string): number {
  return text.length === 0 ? 0 : countO200k(text, AS_TEXT);
}
```

Append to `packages/core/src/errors.ts`:
```ts
/** OpenRouter answered 402 (out of credits). Stops the whole run: no new runs, results so far kept, partial. */
export class OutOfCreditsError extends Error {
  override readonly name = 'OutOfCreditsError';
}

/** One MCP tool call exceeded the per-call tool timeout. A model fail (end 'tool_timeout'), never infra. */
export class ToolTimeoutError extends Error {
  override readonly name = 'ToolTimeoutError';
  constructor(
    readonly tool: string,
    readonly timeoutMs: number,
  ) {
    super(`${tool}: tool call timed out after ${timeoutMs}ms`);
  }
}
```

- [ ] **Step 5: Update `types.ts`**

In `packages/core/src/types.ts` make these replacements.

Replace the `RunDefaults` interface and the `Suite` interface with:
```ts
export interface RunDefaults {
  repeats: number;
  maxSteps: number;
  timeoutS: number;
  temperature: number;
  /** Per-call MCP tool timeout (suite defaults.tool_timeout_s, default 60). Hitting it is a model fail. */
  toolTimeoutS: number;
}

/** A model pinned to one OpenRouter provider slug. */
export interface ModelSpec {
  id: string;
  provider: string;
}

export interface Suite {
  name: string;
  version: number;
  /** Path (or label) the suite was loaded from. */
  source: string;
  fixture?: FixtureSpec;
  servers: Record<string, ServerSpec>;
  /** Model ids in suite order. */
  models: string[];
  /** OpenRouter provider slug per model id, for `{ id, provider }` entries. Plain-string entries (mock) have none. */
  modelPins: Record<string, string>;
  /** Pinned judge model for llm_judge graders (the suite's `judge:` block). */
  judge?: ModelSpec;
  defaults: RunDefaults;
  tasks: TaskSpec[];
}
```

Replace `ChatRequest` and `ChatResponse` with:
```ts
export interface ChatRequest {
  model: string;
  /** OpenRouter provider slug that must serve this request (no fallbacks). */
  providerPin?: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  temperature: number;
  signal?: AbortSignal;
}
```
```ts
export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  latencyMs: number;
  /** Provider that actually served the call, when the API reports it. */
  servedBy?: string;
}
```

In `McpConnection`, add after `stderr(): string;`:
```ts
  /** MCP serverInfo.version from initialize, when the server reported one. */
  serverVersion?(): string | undefined;
```

Replace the `model_call` member of `TraceEvent` and the `LoopEnd` type with:
```ts
  | { type: 'model_call'; step: number; t: number; latencyMs: number; promptTokens: number; completionTokens: number; costUsd: number; servedBy?: string }
```
```ts
export type LoopEnd = 'final_answer' | 'max_steps' | 'timeout' | 'tool_timeout' | 'budget' | 'invalid_tool_call' | 'infra_error';
```

In `GraderResult`, add after `detail: string;`:
```ts
  /** Spend of model-graded checks (llm_judge); added to the run's cost. */
  costUsd?: number;
```

In `RunRecord`, add after `attempts: number;`:
```ts
  /** MCP serverInfo.version of the server this run used. */
  serverVersion?: string;
```

Append to the end of the file:
```ts
/** Runs the plan scheduled for one suite × server × model cell. */
export interface PlannedCell {
  suite: string;
  server: string;
  model: string;
  runs: number;
}
```

- [ ] **Step 6: Replace the suite loader**

Replace `packages/core/src/suite/load.ts` with:
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
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

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

const PinnedModelSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().regex(SLUG, 'provider must be an OpenRouter provider slug such as "anthropic"'),
  })
  .strict();

const DEFAULTS = { repeats: 3, max_steps: 12, timeout_s: 120, temperature: 0, tool_timeout_s: 60 };

const SuiteSchema = z
  .object({
    suite: z.string().regex(NAME, 'suite name must be lowercase letters, digits, - or _'),
    version: z.number().int().positive(),
    fixture: z
      .object({ git: z.string().min(1), ref: z.string().regex(/^[0-9a-f]{7,40}$/, 'fixture.ref must be a commit sha') })
      .strict()
      .optional(),
    servers: z.record(z.string().regex(NAME, 'server name must be lowercase letters, digits, - or _'), ServerSchema),
    models: z.array(z.union([z.string(), PinnedModelSchema])).min(1),
    judge: PinnedModelSchema.optional(),
    defaults: z
      .object({
        repeats: z.number().int().min(1).default(DEFAULTS.repeats),
        max_steps: z.number().int().min(1).default(DEFAULTS.max_steps),
        timeout_s: z.number().positive().default(DEFAULTS.timeout_s),
        temperature: z.number().min(0).max(2).default(DEFAULTS.temperature),
        tool_timeout_s: z.number().positive().default(DEFAULTS.tool_timeout_s),
      })
      .strict()
      .default(DEFAULTS),
    tasks: z.array(TaskSchema).min(1),
  })
  .strict();

type RawSuite = z.infer<typeof SuiteSchema>;
type RawGrader = z.infer<typeof GraderSchema>;
type RawModel = RawSuite['models'][number];
type RawPinned = z.infer<typeof PinnedModelSchema>;

const modelId = (m: RawModel): string => (typeof m === 'string' ? m : m.id);

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

function modelIdIssue(id: string, at: string): string | undefined {
  if (PLACEHOLDER.test(id)) return `${at}: "${id}" contains an unresolved placeholder`;
  if (!MODEL_ID.test(id)) return `${at}: "${id}" is not a provider/model id`;
  if (UNPINNED.test(id)) return `${at}: "${id}" is not pinned`;
  return undefined;
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
  for (const m of s.models.map(modelId)) {
    const bad = modelIdIssue(m, 'models');
    if (bad) issues.push(bad);
    if (seenModels.has(m)) issues.push(`models: "${m}" is listed twice`);
    seenModels.add(m);
  }
  if (s.judge) {
    const bad = modelIdIssue(s.judge.id, 'judge');
    if (bad) issues.push(bad);
  }

  const seenTasks = new Set<string>();
  for (const t of s.tasks) {
    if (seenTasks.has(t.id)) issues.push(`duplicate task id "${t.id}"`);
    seenTasks.add(t.id);
    if (!s.fixture && t.prompt.includes('{fixture}')) issues.push(`tasks.${t.id}.prompt uses {fixture} but the suite has no fixture`);
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
  const pinned = s.models.filter((m): m is RawPinned => typeof m !== 'string');
  return {
    name: s.suite,
    version: s.version,
    source,
    ...(s.fixture ? { fixture: s.fixture } : {}),
    servers,
    models: s.models.map(modelId),
    modelPins: Object.fromEntries(pinned.map((m) => [m.id, m.provider])),
    ...(s.judge ? { judge: { id: s.judge.id, provider: s.judge.provider } } : {}),
    defaults: {
      repeats: s.defaults.repeats,
      maxSteps: s.defaults.max_steps,
      timeoutS: s.defaults.timeout_s,
      temperature: s.defaults.temperature,
      toolTimeoutS: s.defaults.tool_timeout_s,
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

- [ ] **Step 7: Swap `estimateTokens` for `countTokens` everywhere**

`packages/core/src/util.ts`: delete lines 4–7 (the `/** M1 token estimate … */` comment and `export function estimateTokens …`).

`packages/core/src/util.test.ts`: change line 2 to
```ts
import { isPlainObject, mean, median, runKey, sha256Hex, substituteVars } from './util.js';
```
and delete the whole `describe('estimateTokens', …)` block (old lines 4–11).

`packages/core/src/agent/loop.ts`: change line 4 to
```ts
import { countTokens } from '../tokens.js';
import { isPlainObject } from '../util.js';
```
and line 126 to
```ts
      const tokens = countTokens(result.text);
```

`packages/core/src/agent/loop.test.ts`: change line 11 to `import { countTokens } from '../tokens.js';` and line 34 to
```ts
    expect(r.contextTokens).toBe(countTokens('hello') + countTokens('x'.repeat(40)));
```

`packages/core/src/providers/mock.ts`: change line 5 to `import { countTokens } from '../tokens.js';` and line 45 to
```ts
    const promptTokens = countTokens(req.messages.map((m) => m.content ?? '').join('\n'));
```

`packages/core/src/results/aggregate.test.ts`: in the `suite` literal (lines 24–38) add `modelPins: {},` after `models: ['m/a', 'm/b'],` and change the defaults line to
```ts
  defaults: { repeats: 2, maxSteps: 5, timeoutS: 10, temperature: 0, toolTimeoutS: 60 },
```

`packages/core/src/index.ts`: add after line 3 (`export * from './util.js';`):
```ts
export { countTokens, TOKENIZER } from './tokens.js';
```

- [ ] **Step 8: Run all core tests and typecheck**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: every test PASSES (including the new tokenizer, errors and loader tests); typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): o200k_base tokenizer, M2 types and errors, pinned models and judge in suites

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: Results schema v2, aggregator v2, `readResults()` v1 upgrade

**Files:**
- Modify: `packages/core/src/results/schema.ts` (full replacement), `packages/core/src/results/aggregate.ts` (full replacement), `packages/core/src/results/aggregate.test.ts` (full replacement)
- Create: `packages/core/src/results/read.ts`, `packages/core/src/results/read.test.ts`
- Modify: `packages/core/src/runner/run.ts` (add `planned` to the output), `packages/core/src/runner/run.test.ts:76`
- Modify: `packages/cli/src/commands/run.ts:59-71`, `packages/cli/src/report/table.test.ts:5-20`
- Modify: `packages/core/src/index.ts:7`
- Modify: `docs/superpowers/specs/2026-10-15-mcp-evals-design.md:113,124` (nullable `successRate`, v2 note — M1 follow-up)

**Interfaces:**
- Consumes: `PlannedCell`, `RunRecord.serverVersion`, `Suite.modelPins`, `Suite.judge` (Task 1).
- Produces:
  - `ResultsSchema` (v2, `schemaVersion: 2`), `type Results`; `ResultsV1Schema`, `type ResultsV1`.
  - Cell fields: `runs`, `plannedRuns: number | null`, `complete: boolean`, `providerPromptTokensPerTask: { mean; median } | null`; suite fields: `servers[name].version: string | null`, `models[].provider` (pinned slug, else the provider name), `judge: { id; provider } | null`.
  - `aggregate(input: AggregateInput): Results` where `AggregateInput` now **requires** `planned: PlannedCell[]` (the full plan). Cells exist for every planned or recorded server × model pair.
  - `readResults(json: unknown): Results` — v2 as is, v1 upgraded (missing fields null/false); otherwise throws `ConfigError`.
  - `RunSuitesOutput.planned: PlannedCell[]` (one entry per suite × server × model in plan order).

- [ ] **Step 1: Write the failing tests**

Replace `packages/core/src/results/aggregate.test.ts` with:
```ts
import { describe, expect, it } from 'vitest';
import type { PlannedCell, RunRecord, Suite, TraceEvent } from '../types.js';
import { aggregate, type AggregateInput } from './aggregate.js';
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
  modelPins: {},
  defaults: { repeats: 2, maxSteps: 5, timeoutS: 10, temperature: 0, toolTimeoutS: 60 },
  tasks: [
    { id: 't1', prompt: 'p', graders: [] },
    { id: 't2', prompt: 'q', graders: [] },
  ],
};

let n = 0;
function rec(over: Partial<RunRecord> = {}, events: TraceEvent[] = []): RunRecord {
  const base = {
    runKey: `k${n++}`, suite: 'demo', server: 'fake', model: 'm/a', task: 't1', repeat: 0,
    outcome: 'pass' as const, end: 'final_answer' as const, graders: [], attempts: 1,
    costUsd: 0.01, steps: 2, contextTokens: 100, latencyMs: 50,
  };
  return { ...base, toolSelectionOk: null, trace: { ...base, events, serverStderr: '' }, ...over };
}

const call = (promptTokens: number): TraceEvent => ({
  type: 'model_call', step: 1, t: 0, latencyMs: 1, promptTokens, completionTokens: 1, costUsd: 0,
});

const plan = (server: string, model: string, runs: number): PlannedCell => ({ suite: 'demo', server, model, runs });

const meta: Omit<AggregateInput, 'records' | 'suites' | 'planned'> = {
  providerName: 'mock', harnessVersion: '0.0.0', runId: 'r1',
  startedAt: '2026-10-15T00:00:00.000Z', finishedAt: '2026-10-15T00:01:00.000Z', partial: false, totalCostUsd: 0.05,
};

describe('aggregate', () => {
  it('builds v2 cells with success, CI, tool accuracy, stats, errors, completeness, and tasks', () => {
    const records = [
      rec({ task: 't1', repeat: 1, runKey: 'r-t1-1', toolSelectionOk: true, contextTokens: 100, steps: 2 }),
      rec({ task: 't1', repeat: 0, runKey: 'r-t1-0', toolSelectionOk: false, contextTokens: 300, steps: 4, outcome: 'fail', end: 'max_steps' }),
      rec({ task: 't2', repeat: 0, runKey: 'r-t2-0', contextTokens: 200, steps: 3 }),
      rec({ task: 't2', repeat: 1, runKey: 'r-t2-1', outcome: 'error', end: 'infra_error', contextTokens: 9999 }),
      rec({ model: 'm/b', task: 't1' }),
    ];
    const results = aggregate({ records, suites: [suite], planned: [plan('fake', 'm/a', 4), plan('fake', 'm/b', 2)], ...meta });
    expect(() => ResultsSchema.parse(results)).not.toThrow();
    expect(results.schemaVersion).toBe(2);
    expect(results.suites[0]!.fixture).toBeNull();
    expect(results.suites[0]!.judge).toBeNull();
    expect(results.suites[0]!.models).toEqual([{ id: 'm/a', provider: 'mock' }, { id: 'm/b', provider: 'mock' }]);

    const cells = results.suites[0]!.cells;
    expect(cells.map((c) => `${c.server}|${c.model}`)).toEqual(['fake|m/a', 'fake|m/b']);
    const a = cells[0]!;
    expect(a).toMatchObject({ runs: 4, plannedRuns: 4, complete: true });
    expect(a.successRate).toBeCloseTo(2 / 3, 6);
    expect(a.successCi95).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));
    expect(a.errorRate).toBe(0.25);
    expect(a.toolAccuracy).toBe(0.5);
    expect(a.contextTokensPerTask).toEqual({ mean: 200, median: 200 });
    expect(a.providerPromptTokensPerTask).toEqual({ mean: 0, median: 0 });
    expect(a.stepsPerTask).toBe(3);
    expect(a.tasks).toEqual([
      { id: 't1', passes: 1, fails: 1, errors: 0, traceRef: 'r-t1-0' },
      { id: 't2', passes: 1, fails: 0, errors: 1, traceRef: 'r-t2-0' },
    ]);
    expect(cells[1]).toMatchObject({ runs: 1, plannedRuns: 2, complete: false, toolAccuracy: null });
  });

  it('reports null success with CI [0,1] when every run errored', () => {
    const results = aggregate({ records: [rec({ outcome: 'error', end: 'infra_error' })], suites: [suite], planned: [plan('fake', 'm/a', 1)], ...meta });
    expect(() => ResultsSchema.parse(results)).not.toThrow();
    const c = results.suites[0]!.cells[0]!;
    expect(c.successRate).toBeNull();
    expect(c.successCi95).toEqual([0, 1]);
    expect(c.errorRate).toBe(1);
    expect(c.complete).toBe(true);
  });

  it('lists planned cells that never ran as incomplete', () => {
    const results = aggregate({ records: [], suites: [suite], planned: [plan('other', 'm/b', 2)], ...meta });
    expect(() => ResultsSchema.parse(results)).not.toThrow();
    expect(results.suites[0]!.cells).toEqual([
      expect.objectContaining({ server: 'other', model: 'm/b', runs: 0, plannedRuns: 2, complete: false, successRate: null, errorRate: 0, tasks: [] }),
    ]);
  });

  it('records provider pins, the judge, server versions, and provider-reported prompt tokens', () => {
    const pinned: Suite = { ...suite, modelPins: { 'm/a': 'acme' }, judge: { id: 'j/judge', provider: 'acme' } };
    const records = [
      rec({ serverVersion: '1.2.3' }, [call(100), call(300)]),
      rec({ repeat: 1 }, [call(1000)]),
      rec({ repeat: 2, outcome: 'error', end: 'infra_error' }, [call(99999)]),
    ];
    const r = aggregate({ records, suites: [pinned], planned: [plan('fake', 'm/a', 3)], ...meta });
    const s = r.suites[0]!;
    expect(s.models).toEqual([{ id: 'm/a', provider: 'acme' }, { id: 'm/b', provider: 'mock' }]);
    expect(s.judge).toEqual({ id: 'j/judge', provider: 'acme' });
    expect(s.servers).toEqual({ fake: { command: 'node', version: '1.2.3' }, other: { command: 'node', version: null } });
    // 100+300 and 1000; the error run is excluded like every other per-task stat.
    expect(s.cells[0]!.providerPromptTokensPerTask).toEqual({ mean: 700, median: 700 });
    expect(s.cells[0]!.complete).toBe(true);
  });
});
```

Create `packages/core/src/results/read.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.js';
import { readResults } from './read.js';
import { ResultsSchema, type ResultsV1 } from './schema.js';

const v1: ResultsV1 = {
  schemaVersion: 1, harnessVersion: '0.0.0', runId: 'r1',
  startedAt: '2026-10-15T00:00:00.000Z', finishedAt: '2026-10-15T00:01:00.000Z', partial: false, totalCostUsd: 0.01,
  suites: [{
    suite: 'demo', suiteVersion: 1, fixture: null, servers: { fake: { command: 'node' } }, models: [{ id: 'm/a', provider: 'mock' }],
    cells: [{
      server: 'fake', model: 'm/a', runs: 2, successRate: 0.5, successCi95: [0.09, 0.91], toolAccuracy: null,
      contextTokensPerTask: { mean: 10, median: 10 }, stepsPerTask: 2, latencyMsP50: 5, costUsdPerTask: 0.005, errorRate: 0,
      tasks: [{ id: 't1', passes: 1, fails: 1, errors: 0, traceRef: 'k1' }],
    }],
  }],
};

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('readResults', () => {
  it('upgrades v1 results to v2, filling the new fields with null/false', () => {
    const r = readResults(copy(v1));
    expect(() => ResultsSchema.parse(r)).not.toThrow();
    expect(r.schemaVersion).toBe(2);
    expect(r.suites[0]!.servers.fake).toEqual({ command: 'node', version: null });
    expect(r.suites[0]!.judge).toBeNull();
    expect(r.suites[0]!.cells[0]).toMatchObject({
      runs: 2, plannedRuns: null, complete: false, providerPromptTokensPerTask: null, successRate: 0.5,
    });
  });

  it('returns v2 results unchanged', () => {
    const v2 = readResults(copy(v1));
    expect(readResults(copy(v2))).toEqual(v2);
  });

  it('rejects unknown versions and invalid content with a ConfigError naming the problem', () => {
    expect(() => readResults({ schemaVersion: 3 })).toThrow(ConfigError);
    expect(() => readResults({ schemaVersion: 3 })).toThrow(/unsupported results schemaVersion 3/);
    expect(() => readResults('nope')).toThrow(/unsupported results schemaVersion null/);
    expect(() => readResults({ ...copy(v1), runId: 42 })).toThrow(/invalid results: runId/);
  });
});
```

In `packages/core/src/runner/run.test.ts`, after line 76 (`expect(out.partial).toBe(false);`) add:
```ts
    expect(out.planned).toEqual([
      { suite: 'demo', server: 'fake', model: 'mock/a', runs: 4 },
      { suite: 'demo', server: 'fake', model: 'mock/b', runs: 4 },
    ]);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/results packages/core/src/runner`
Expected: FAIL — `Cannot find module './read.js'`, `schemaVersion` is 1, `plannedRuns` missing, `out.planned` undefined.

- [ ] **Step 3: Write schema v2**

Replace `packages/core/src/results/schema.ts` with:
```ts
import { z } from 'zod';

const Stat = z.object({ mean: z.number(), median: z.number() });
const TaskCounts = z.object({
  id: z.string(),
  passes: z.number().int().nonnegative(),
  fails: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  traceRef: z.string(),
});
const ModelInfo = z.object({ id: z.string(), provider: z.string() });

/** results.json schema v2 (M2): the source of truth for the CLI, the Action, the leaderboard and the portfolio. */
export const ResultsSchema = z.object({
  schemaVersion: z.literal(2),
  harnessVersion: z.string(),
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  /** true when the budget cap or an out-of-credits stop left planned runs unexecuted. */
  partial: z.boolean(),
  totalCostUsd: z.number().nonnegative(),
  suites: z.array(
    z.object({
      suite: z.string(),
      suiteVersion: z.number().int(),
      fixture: z.object({ git: z.string(), ref: z.string() }).nullable(),
      servers: z.record(
        z.string(),
        z.object({ command: z.string().optional(), url: z.string().optional(), version: z.string().nullable() }),
      ),
      /** Pinned OpenRouter provider slug per model (the provider name for unpinned mock models). */
      models: z.array(ModelInfo),
      judge: ModelInfo.nullable(),
      cells: z.array(
        z.object({
          server: z.string(),
          model: z.string(),
          /** Every record in the cell, including error outcomes. */
          runs: z.number().int().nonnegative(),
          /** Runs the plan scheduled for this cell; null only in results upgraded from v1. */
          plannedRuns: z.number().int().nonnegative().nullable(),
          /** runs === plannedRuns. Always false in results upgraded from v1. */
          complete: z.boolean(),
          /** null when the cell has no completed (pass/fail) runs. */
          successRate: z.number().min(0).max(1).nullable(),
          successCi95: z.tuple([z.number(), z.number()]),
          toolAccuracy: z.number().min(0).max(1).nullable(),
          /** Headline: o200k_base tokens returned by tool calls, per run. */
          contextTokensPerTask: Stat,
          /** Secondary: provider-reported prompt tokens summed over the run's model calls; null when upgraded from v1. */
          providerPromptTokensPerTask: Stat.nullable(),
          stepsPerTask: z.number(),
          latencyMsP50: z.number(),
          costUsdPerTask: z.number(),
          errorRate: z.number().min(0).max(1),
          tasks: z.array(TaskCounts),
        }),
      ),
    }),
  ),
});

export type Results = z.infer<typeof ResultsSchema>;

/** results.json schema v1 (M1); readResults() upgrades it to v2. */
export const ResultsV1Schema = z.object({
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
      models: z.array(ModelInfo),
      cells: z.array(
        z.object({
          server: z.string(),
          model: z.string(),
          runs: z.number().int().nonnegative(),
          successRate: z.number().min(0).max(1).nullable(),
          successCi95: z.tuple([z.number(), z.number()]),
          toolAccuracy: z.number().min(0).max(1).nullable(),
          contextTokensPerTask: Stat,
          stepsPerTask: z.number(),
          latencyMsP50: z.number(),
          costUsdPerTask: z.number(),
          errorRate: z.number().min(0).max(1),
          tasks: z.array(z.object({ id: z.string(), passes: z.number().int(), fails: z.number().int(), errors: z.number().int(), traceRef: z.string() })),
        }),
      ),
    }),
  ),
});

export type ResultsV1 = z.infer<typeof ResultsV1Schema>;
```

- [ ] **Step 4: Write `read.ts`**

`packages/core/src/results/read.ts`:
```ts
import type { z } from 'zod';
import { ConfigError } from '../errors.js';
import { isPlainObject } from '../util.js';
import { ResultsSchema, ResultsV1Schema, type Results, type ResultsV1 } from './schema.js';

/** Validates parsed results.json content and returns it as schema v2, upgrading v1 (missing fields become null/false). */
export function readResults(json: unknown): Results {
  const version = isPlainObject(json) ? json.schemaVersion : undefined;
  if (version === 2) return parse(ResultsSchema, json);
  if (version === 1) return upgradeV1(parse(ResultsV1Schema, json));
  throw new ConfigError(`unsupported results schemaVersion ${JSON.stringify(version ?? null)} (expected 1 or 2)`);
}

function parse<S extends z.ZodType>(schema: S, json: unknown): z.output<S> {
  const r = schema.safeParse(json);
  if (r.success) return r.data;
  const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
  throw new ConfigError(`invalid results: ${issues.join('; ')}`);
}

function upgradeV1(v1: ResultsV1): Results {
  return {
    ...v1,
    schemaVersion: 2,
    suites: v1.suites.map((s) => ({
      ...s,
      servers: Object.fromEntries(Object.entries(s.servers).map(([name, srv]) => [name, { ...srv, version: null }])),
      judge: null,
      cells: s.cells.map((c) => ({ ...c, plannedRuns: null, complete: false, providerPromptTokensPerTask: null })),
    })),
  };
}
```

- [ ] **Step 5: Write aggregator v2**

Replace `packages/core/src/results/aggregate.ts` with:
```ts
import type { PlannedCell, RunRecord, Suite } from '../types.js';
import { mean, median } from '../util.js';
import type { Results } from './schema.js';
import { wilson } from './wilson.js';

export interface AggregateInput {
  records: RunRecord[];
  suites: Suite[];
  /** The full plan, including runs a resumed run took from its cache. */
  planned: PlannedCell[];
  /** Provider label for models without a pin (e.g. "mock"). */
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
    schemaVersion: 2,
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
          const planned = input.planned.find((p) => p.suite === suite.name && p.server === server && p.model === model)?.runs ?? 0;
          if (rs.length > 0 || planned > 0) cells.push(buildCell(suite, server, model, rs, planned));
        }
      }
      return {
        suite: suite.name,
        suiteVersion: suite.version,
        fixture: suite.fixture ?? null,
        servers: Object.fromEntries(
          Object.entries(suite.servers).map(([name, s]) => [
            name,
            {
              ...(s.command !== undefined ? { command: s.command } : {}),
              ...(s.url !== undefined ? { url: s.url } : {}),
              version: recs.find((r) => r.server === name && r.serverVersion !== undefined)?.serverVersion ?? null,
            },
          ]),
        ),
        models: suite.models.map((id) => ({ id, provider: suite.modelPins[id] ?? input.providerName })),
        judge: suite.judge ? { id: suite.judge.id, provider: suite.judge.provider } : null,
        cells,
      };
    }),
  };
}

/** Provider-reported prompt tokens summed over the run's agent model calls (judge calls are not in the trace). */
function providerPromptTokens(r: RunRecord): number {
  return r.trace.events.reduce((sum, e) => (e.type === 'model_call' ? sum + e.promptTokens : sum), 0);
}

function buildCell(suite: Suite, server: string, model: string, rs: RunRecord[], plannedRuns: number): Cell {
  const completed = rs.filter((r) => r.outcome !== 'error');
  const passes = completed.filter((r) => r.outcome === 'pass').length;
  const n = completed.length;
  const toolVals = completed.map((r) => r.toolSelectionOk).filter((v): v is boolean => v !== null);
  const ctx = completed.map((r) => r.contextTokens);
  const prompt = completed.map(providerPromptTokens);
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
    plannedRuns,
    complete: rs.length === plannedRuns,
    successRate: n === 0 ? null : passes / n,
    successCi95: wilson(passes, n),
    toolAccuracy: toolVals.length === 0 ? null : toolVals.filter(Boolean).length / toolVals.length,
    contextTokensPerTask: { mean: mean(ctx), median: median(ctx) },
    providerPromptTokensPerTask: { mean: mean(prompt), median: median(prompt) },
    stepsPerTask: mean(completed.map((r) => r.steps)),
    latencyMsP50: median(completed.map((r) => r.latencyMs)),
    costUsdPerTask: mean(completed.map((r) => r.costUsd)),
    errorRate: rs.length === 0 ? 0 : (rs.length - n) / rs.length,
    tasks,
  };
}
```

- [ ] **Step 6: Report the plan from the runner, and pass it from the CLI**

In `packages/core/src/runner/run.ts`:
- change the types import (line 7) to
```ts
import type { Connector, GraderResult, McpConnection, ModelProvider, Outcome, PlannedCell, RunRecord, Suite, TaskSpec } from '../types.js';
```
- add to `RunSuitesOutput` after `records: RunRecord[];`:
```ts
  /** Runs per suite × server × model in the full plan, in plan order. */
  planned: PlannedCell[];
```
- change the final `return` of `runSuites` to
```ts
  return { records, planned: countPlanned(plan), partial, totalCostUsd: spent, startedAt, finishedAt: now().toISOString() };
```
- add after `planRuns`:
```ts
function countPlanned(plan: RunTarget[]): PlannedCell[] {
  const cells = new Map<string, PlannedCell>();
  for (const t of plan) {
    const key = [t.suite.name, t.serverName, t.model].join('\u0000');
    const cell = cells.get(key);
    if (cell) cell.runs++;
    else cells.set(key, { suite: t.suite.name, server: t.serverName, model: t.model, runs: 1 });
  }
  return [...cells.values()];
}
```

In `packages/cli/src/commands/run.ts`, in the `aggregate({ … })` call add `planned: run.planned,` after `suites,`.

In `packages/cli/src/report/table.test.ts`, replace the `results` fixture (lines 5–20) with:
```ts
const results: Results = {
  schemaVersion: 2, harnessVersion: '0.0.0', runId: 'run-1',
  startedAt: '2026-10-15T00:00:00.000Z', finishedAt: '2026-10-15T00:00:01.000Z', partial: true, totalCostUsd: 0.012,
  suites: [{
    suite: 'demo', suiteVersion: 1, fixture: null, servers: { fake: { command: 'node', version: null } },
    models: [{ id: 'mock/a', provider: 'mock' }], judge: null,
    cells: [{
      server: 'fake', model: 'mock/a', runs: 4, plannedRuns: 4, complete: true, successRate: 0.75, successCi95: [0.3006, 0.9544], toolAccuracy: null,
      contextTokensPerTask: { mean: 10, median: 12.4 }, providerPromptTokensPerTask: null, stepsPerTask: 2, latencyMsP50: 5, costUsdPerTask: 0.002, errorRate: 0,
      tasks: [],
    }, {
      server: 'fake', model: 'mock/b', runs: 2, plannedRuns: 2, complete: true, successRate: null, successCi95: [0, 1], toolAccuracy: null,
      contextTokensPerTask: { mean: 0, median: 0 }, providerPromptTokensPerTask: null, stepsPerTask: 0, latencyMsP50: 0, costUsdPerTask: 0, errorRate: 1,
      tasks: [],
    }],
  }],
};
```

In `packages/core/src/index.ts`, replace line 7 with:
```ts
export { ResultsSchema, ResultsV1Schema, type Results, type ResultsV1 } from './results/schema.js';
export { readResults } from './results/read.js';
```

- [ ] **Step 7: Update the base spec for nullable `successRate` and v2 (M1 follow-up)**

In `docs/superpowers/specs/2026-10-15-mcp-evals-design.md` replace line 113
```
      successRate: number; successCi95: [number, number];
```
with
```
      successRate: number | null; successCi95: [number, number];   // null when the cell has no completed (pass/fail) runs
```
and replace line 124 (`A zod schema is the source of truth; a JSON Schema is exported for the leaderboard and portfolio.`) with
```
A zod schema is the source of truth; a JSON Schema is exported for the leaderboard and portfolio. **Schema v2 (M2)** sets `schemaVersion: 2` and adds, per cell, `plannedRuns`, `complete` (`runs === plannedRuns`) and `providerPromptTokensPerTask`; per suite, `servers.<name>.version` (MCP `serverInfo.version`) and `judge`; `toolAccuracy` is `number | null`. `readResults()` reads v1 files and upgrades them (new fields null/false). See `2026-10-15-mcp-evals-m2-design.md` §3.5.
```

- [ ] **Step 8: Run all tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: every test PASSES; typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/core packages/cli docs/superpowers/specs/2026-10-15-mcp-evals-design.md
git commit -m "feat(core): results schema v2 with completeness, versions, pins and readResults v1 upgrade

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: OpenRouter provider and the fake OpenRouter server

**Files:**
- Create: `packages/core/src/providers/openrouter.ts`
- Create: `packages/core/test/fixtures/fake-openrouter.ts`
- Test: `packages/core/src/providers/openrouter.test.ts`

**Interfaces:**
- Consumes: `ChatRequest.providerPin`, `ChatResponse.servedBy`, `OutOfCreditsError`, `ProviderError`, `ConfigError` (Task 1).
- Produces:
  - `OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'`.
  - `interface ModelPrice { prompt: number; completion: number }` (USD per token).
  - `interface CatalogModel { id: string; supportsTools: boolean; price: ModelPrice | null }`.
  - `interface OpenRouterOptions { apiKey: string; baseUrl?: string; requestTimeoutMs?: number; prices?: Record<string, ModelPrice>; now?: () => number }`.
  - `class OpenRouterProvider implements ModelProvider { readonly name = 'openrouter'; constructor(o: OpenRouterOptions); chat(req: ChatRequest): Promise<ChatResponse> }` — throws `ConfigError` for a request without `providerPin`, `OutOfCreditsError` for 402, `ProviderError` otherwise.
  - `fetchModelCatalog(o: { apiKey: string; baseUrl?: string; requestTimeoutMs?: number }): Promise<Map<string, CatalogModel>>`.
  - Test fixture `packages/core/test/fixtures/fake-openrouter.ts`: `startFakeOpenRouter(o?: { models?: unknown[]; respond?: (body: any) => FakeReply }): Promise<FakeOpenRouter>` with `{ baseUrl, requests, chatRequests(), enqueue(...replies), close() }`; `FakeReply { status?; json?; raw?; delayMs? }`; helpers `completion(message, usage?, provider?)`, `toolCall(id, name, args)`; `DEFAULT_CATALOG` (models `acme/model-a` with tools at $0.000001/$0.000002 per token, `acme/judge`, `acme/no-tools`). Task 9 reuses it.

- [ ] **Step 1: Write the fake OpenRouter server (test fixture)**

`packages/core/test/fixtures/fake-openrouter.ts`:
```ts
// Local stand-in for OpenRouter, for offline tests only. Never point it at the real API.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeReply {
  status?: number;
  /** JSON body (default: an "ok" completion). */
  json?: unknown;
  /** Raw body, sent instead of `json` (for malformed responses). */
  raw?: string;
  /** Wait this long before answering. */
  delayMs?: number;
}

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

export interface FakeOpenRouter {
  /** Pass as `baseUrl`, e.g. http://127.0.0.1:41234/api/v1 */
  baseUrl: string;
  /** Every request received, in order. */
  requests: FakeRequest[];
  chatRequests(): FakeRequest[];
  /** Replies for POST /chat/completions, used first-in first-out before `respond`. */
  enqueue(...replies: FakeReply[]): void;
  close(): Promise<void>;
}

export interface FakeOpenRouterOptions {
  /** `data` for GET /models (default DEFAULT_CATALOG). */
  models?: unknown[];
  /** Answers chat requests when the queue is empty (default: an "ok" completion). */
  respond?: (body: any) => FakeReply;
}

export const DEFAULT_CATALOG = [
  { id: 'acme/model-a', supported_parameters: ['tools', 'temperature'], pricing: { prompt: '0.000001', completion: '0.000002' } },
  { id: 'acme/judge', supported_parameters: ['temperature'], pricing: { prompt: '0.0000001', completion: '0.0000005' } },
  { id: 'acme/no-tools', supported_parameters: ['temperature'], pricing: { prompt: '0.000001', completion: '0.000002' } },
];

export function completion(
  message: { content?: string | null; tool_calls?: unknown[] },
  usage: Record<string, number> = { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 },
  provider = 'Acme',
): unknown {
  return {
    id: 'gen-test',
    provider,
    model: 'acme/model-a',
    choices: [{
      index: 0,
      finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
      message: { role: 'assistant', content: message.content ?? null, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) },
    }],
    usage,
  };
}

export function toolCall(id: string, name: string, args: unknown): unknown {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}

export async function startFakeOpenRouter(o: FakeOpenRouterOptions = {}): Promise<FakeOpenRouter> {
  const queue: FakeReply[] = [];
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: any;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const path = (req.url ?? '').split('?')[0] ?? '';
      requests.push({ method: req.method ?? '', path, headers: req.headers, body });
      let reply: FakeReply;
      if (req.method === 'GET' && path === '/api/v1/models') reply = { json: { data: o.models ?? DEFAULT_CATALOG } };
      else if (req.method === 'POST' && path === '/api/v1/chat/completions') reply = queue.shift() ?? o.respond?.(body) ?? {};
      else reply = { status: 404, json: { error: { code: 404, message: `no route ${path}` } } };
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(reply.raw ?? JSON.stringify(reply.json ?? completion({ content: 'ok' })));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    chatRequests: () => requests.filter((r) => r.path === '/api/v1/chat/completions'),
    enqueue: (...replies) => {
      queue.push(...replies);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 2: Write the failing tests**

`packages/core/src/providers/openrouter.test.ts`:
```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { completion, startFakeOpenRouter, toolCall, type FakeOpenRouter, type FakeOpenRouterOptions } from '../../test/fixtures/fake-openrouter.js';
import { ConfigError, OutOfCreditsError, ProviderError } from '../errors.js';
import type { ChatRequest } from '../types.js';
import { fetchModelCatalog, OpenRouterProvider } from './openrouter.js';

const KEY = 'sk-or-test-SECRET-123';
let fake: FakeOpenRouter | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function setup(opts: FakeOpenRouterOptions = {}, requestTimeoutMs = 2000) {
  const f = await startFakeOpenRouter(opts);
  fake = f;
  return { fake: f, provider: new OpenRouterProvider({ apiKey: KEY, baseUrl: f.baseUrl, requestTimeoutMs }) };
}

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'acme/model-a',
  providerPin: 'acme',
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'find it' }],
  tools: [{ name: 'echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
  temperature: 0,
  ...over,
});

describe('OpenRouterProvider.chat', () => {
  it('sends an OpenAI-format request pinned to one provider and parses the reply', async () => {
    const { fake, provider } = await setup();
    fake.enqueue({
      json: completion(
        { content: 'thinking', tool_calls: [toolCall('call_1', 'echo', { text: 'hi' })] },
        { prompt_tokens: 120, completion_tokens: 7, cost: 0.0021 },
        'Anthropic',
      ),
    });
    const res = await provider.chat(
      req({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'find it' },
          { role: 'assistant', content: null, toolCalls: [{ id: 'call_0', name: 'echo', arguments: '{"text":"a"}' }] },
          { role: 'tool', toolCallId: 'call_0', content: 'a' },
        ],
      }),
    );
    expect(provider.name).toBe('openrouter');
    expect(res).toMatchObject({
      content: 'thinking',
      toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }],
      usage: { promptTokens: 120, completionTokens: 7, costUsd: 0.0021 },
      servedBy: 'Anthropic',
    });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    const [sent] = fake.chatRequests();
    expect(sent!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent!.body).toEqual({
      model: 'acme/model-a',
      temperature: 0,
      provider: { order: ['acme'], allow_fallbacks: false },
      tools: [{ type: 'function', function: { name: 'echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }],
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'find it' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'echo', arguments: '{"text":"a"}' } }] },
        { role: 'tool', tool_call_id: 'call_0', content: 'a' },
      ],
    });
  });

  it('omits tools when the run has none', async () => {
    const { fake, provider } = await setup();
    await provider.chat(req({ tools: [] }));
    expect(fake.chatRequests()[0]!.body).not.toHaveProperty('tools');
  });

  it('classifies HTTP errors: 408/429/5xx retryable, other 4xx not, 402 out of credits', async () => {
    const { fake, provider } = await setup();
    const cases: [number, boolean][] = [[408, true], [429, true], [500, true], [503, true], [400, false], [401, false], [403, false], [404, false]];
    for (const [status, retryable] of cases) {
      fake.enqueue({ status, json: { error: { code: status, message: `status ${status}` } } });
      const err = await provider.chat(req()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ retryable, status });
    }
    fake.enqueue({ status: 402, json: { error: { code: 402, message: 'Insufficient credits' } } });
    const credits = await provider.chat(req()).catch((e: unknown) => e);
    expect(credits).toBeInstanceOf(OutOfCreditsError);
    expect((credits as Error).message).toMatch(/Insufficient credits/);
  });

  it('treats malformed JSON and a missing choices[0].message as non-retryable', async () => {
    const { fake, provider } = await setup();
    fake.enqueue({ raw: '{"choices": [' }, { json: { id: 'x' } });
    for (let i = 0; i < 2; i++) {
      const err = await provider.chat(req()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ retryable: false, message: expect.stringMatching(/malformed/) });
    }
  });

  // Review Focus 1
  it('classifies a 200 whose body is an error (or an interrupted generation) by error.code', async () => {
    const { fake, provider } = await setup();
    const interrupted = completion({ content: 'partial' }) as { choices: Array<{ finish_reason: string }> };
    interrupted.choices[0]!.finish_reason = 'error';
    fake.enqueue(
      { json: { error: { code: 502, message: 'upstream down' } } },
      { json: { error: { code: 402, message: 'out of credits' } } },
      { json: interrupted },
    );
    expect(await provider.chat(req()).catch((e: unknown) => e)).toMatchObject({ name: 'ProviderError', retryable: true, status: 502 });
    expect(await provider.chat(req()).catch((e: unknown) => e)).toBeInstanceOf(OutOfCreditsError);
    expect(await provider.chat(req()).catch((e: unknown) => e)).toMatchObject({ name: 'ProviderError', retryable: true });
  });

  it('times out slow requests as retryable', async () => {
    const { fake, provider } = await setup({}, 50);
    fake.enqueue({ delayMs: 1000 });
    const err = await provider.chat(req()).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ProviderError', retryable: true, message: expect.stringMatching(/timed out after 50ms/) });
  });

  it('honors ChatRequest.signal', async () => {
    const { fake, provider } = await setup();
    fake.enqueue({ delayMs: 1000 });
    const controller = new AbortController();
    const t0 = Date.now();
    const pending = provider.chat(req({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    const err = await pending.catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ProviderError', retryable: false, message: expect.stringMatching(/aborted/) });
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it('reports network errors as retryable', async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const { port } = dead.address() as AddressInfo;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const provider = new OpenRouterProvider({ apiKey: KEY, baseUrl: `http://127.0.0.1:${port}/api/v1` });
    const err = await provider.chat(req()).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ProviderError', retryable: true, message: expect.stringMatching(/network error/) });
  });

  // Review Focus 2
  it('falls back to catalog prices when usage.cost is missing, so the budget cap still holds', async () => {
    const f = await startFakeOpenRouter();
    fake = f;
    const priced = new OpenRouterProvider({ apiKey: KEY, baseUrl: f.baseUrl, prices: { 'acme/model-a': { prompt: 0.000001, completion: 0.000002 } } });
    f.enqueue({ json: completion({ content: 'ok' }, { prompt_tokens: 1000, completion_tokens: 500 }) });
    expect((await priced.chat(req())).usage.costUsd).toBeCloseTo(0.002, 12);
    f.enqueue({ json: completion({ content: 'ok' }, { prompt_tokens: 1000, completion_tokens: 500, cost: 0 }) });
    expect((await priced.chat(req())).usage.costUsd).toBe(0);
  });

  it('refuses a model without a provider pin before sending anything', async () => {
    const { fake, provider } = await setup();
    const err = await provider.chat(req({ providerPin: undefined })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/no provider pin/);
    expect(fake.chatRequests()).toHaveLength(0);
  });

  it('never exposes the API key, even when the server echoes it', async () => {
    const { fake, provider } = await setup();
    fake.enqueue({ status: 401, json: { error: { code: 401, message: `bad key ${KEY}` } } });
    const err = (await provider.chat(req()).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('[redacted]');
    expect(JSON.stringify(provider)).not.toContain(KEY);
    expect(Object.values(provider).join(' ')).not.toContain(KEY);
  });

  it('fills missing tool-call ids and stringifies object arguments', async () => {
    const { fake, provider } = await setup();
    fake.enqueue({
      json: completion({
        tool_calls: [
          { type: 'function', function: { name: 'echo', arguments: { text: 'x' } } },
          { id: '', type: 'function', function: { name: 'echo', arguments: '' } },
        ],
      }),
    });
    const res = await provider.chat(req());
    expect(res.toolCalls.map((c) => c.arguments)).toEqual(['{"text":"x"}', '']);
    expect(res.toolCalls.every((c) => c.id.length > 0)).toBe(true);
    expect(new Set(res.toolCalls.map((c) => c.id)).size).toBe(2);
  });
});

describe('fetchModelCatalog', () => {
  it('reads ids, tool support and per-token prices', async () => {
    const { fake } = await setup();
    const catalog = await fetchModelCatalog({ apiKey: KEY, baseUrl: fake.baseUrl });
    expect(catalog.get('acme/model-a')).toEqual({ id: 'acme/model-a', supportsTools: true, price: { prompt: 0.000001, completion: 0.000002 } });
    expect(catalog.get('acme/no-tools')?.supportsTools).toBe(false);
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/models' });
  });

  it('marks unparseable prices as null', async () => {
    const { fake } = await setup({ models: [{ id: 'x/y', supported_parameters: ['tools'], pricing: { prompt: 'n/a' } }] });
    expect((await fetchModelCatalog({ apiKey: KEY, baseUrl: fake.baseUrl })).get('x/y')).toEqual({ id: 'x/y', supportsTools: true, price: null });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/providers/openrouter.test.ts`
Expected: FAIL — `Cannot find module './openrouter.js'`.

- [ ] **Step 4: Write the provider**

`packages/core/src/providers/openrouter.ts`:
```ts
import { ConfigError, OutOfCreditsError, ProviderError } from '../errors.js';
import type { ChatMessage, ChatRequest, ChatResponse, JsonObject, ModelProvider, ToolCall } from '../types.js';
import { isPlainObject } from '../util.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** USD per token, from the OpenRouter model catalog. */
export interface ModelPrice {
  prompt: number;
  completion: number;
}

export interface CatalogModel {
  id: string;
  supportsTools: boolean;
  price: ModelPrice | null;
}

export interface OpenRouterOptions {
  /** OPENROUTER_API_KEY. Kept in a private field; never logged, traced, or put in error messages. */
  apiKey: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  /** Catalog prices, used only when a response lacks usage.cost (so the budget cap still holds). */
  prices?: Record<string, ModelPrice>;
  now?: () => number;
}

interface Endpoint {
  apiKey: string;
  baseUrl: string;
  requestTimeoutMs: number;
}

export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter';
  readonly #endpoint: Endpoint;
  readonly #prices: Record<string, ModelPrice>;
  readonly #now: () => number;
  #generatedIds = 0;

  constructor(o: OpenRouterOptions) {
    if (o.apiKey.trim() === '') throw new ConfigError('OPENROUTER_API_KEY is empty');
    this.#endpoint = endpoint(o);
    this.#prices = o.prices ?? {};
    this.#now = o.now ?? Date.now;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!req.providerPin) {
      throw new ConfigError(`model "${req.model}" has no provider pin; OpenRouter runs need { id, provider } model entries`);
    }
    const body: JsonObject = {
      model: req.model,
      messages: req.messages.map(toWireMessage),
      temperature: req.temperature,
      provider: { order: [req.providerPin], allow_fallbacks: false },
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    const t0 = this.#now();
    const json = await request(this.#endpoint, 'POST', '/chat/completions', body, req.signal);
    return this.#parseCompletion(json, req.model, this.#now() - t0);
  }

  #parseCompletion(json: unknown, model: string, latencyMs: number): ChatResponse {
    if (!isPlainObject(json)) throw new ProviderError('OpenRouter: malformed response (not a JSON object)', false);
    const error = json.error;
    const choices = json.choices;
    // A 200 can still carry an error: OpenRouter reports upstream failures in the body.
    if (isPlainObject(error) && !Array.isArray(choices)) throw classify(numberOr(error.code, 502), messageOf(error));
    const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
    if (!isPlainObject(choice)) throw new ProviderError('OpenRouter: malformed response (no choices[0].message)', false);
    const msg = choice.message;
    if (!isPlainObject(msg)) throw new ProviderError('OpenRouter: malformed response (no choices[0].message)', false);
    if (choice.finish_reason === 'error') {
      throw new ProviderError(`OpenRouter: generation interrupted: ${isPlainObject(error) ? messageOf(error) : 'unknown error'}`, true, 502);
    }
    const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const usage = isPlainObject(json.usage) ? json.usage : {};
    const promptTokens = numberOr(usage.prompt_tokens, 0);
    const completionTokens = numberOr(usage.completion_tokens, 0);
    const price = this.#prices[model];
    const costUsd =
      typeof usage.cost === 'number' && Number.isFinite(usage.cost)
        ? usage.cost
        : price
          ? promptTokens * price.prompt + completionTokens * price.completion
          : 0;
    const servedBy = json.provider;
    return {
      content: typeof msg.content === 'string' ? msg.content : null,
      toolCalls: rawCalls.map((c: unknown) => this.#toolCall(c)),
      usage: { promptTokens, completionTokens, costUsd },
      latencyMs,
      ...(typeof servedBy === 'string' ? { servedBy } : {}),
    };
  }

  #toolCall(c: unknown): ToolCall {
    const call = isPlainObject(c) ? c : {};
    const fn = isPlainObject(call.function) ? call.function : {};
    const args = fn.arguments;
    return {
      // Some providers omit ids; tool results must still reference a unique one.
      id: typeof call.id === 'string' && call.id !== '' ? call.id : `gen_call_${++this.#generatedIds}`,
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: typeof args === 'string' ? args : args === undefined || args === null ? '' : JSON.stringify(args),
    };
  }
}

/** GET /models: ids, tool support, and per-token prices. */
export async function fetchModelCatalog(o: { apiKey: string; baseUrl?: string; requestTimeoutMs?: number }): Promise<Map<string, CatalogModel>> {
  const json = await request(endpoint(o), 'GET', '/models', undefined);
  const data = isPlainObject(json) ? json.data : undefined;
  if (!Array.isArray(data)) throw new ProviderError('OpenRouter: malformed model catalog (no data array)', false);
  const out = new Map<string, CatalogModel>();
  for (const m of data) {
    if (!isPlainObject(m)) continue;
    const id = m.id;
    if (typeof id !== 'string') continue;
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const pricing = isPlainObject(m.pricing) ? m.pricing : {};
    const prompt = Number(pricing.prompt);
    const completion = Number(pricing.completion);
    out.set(id, {
      id,
      supportsTools: params.includes('tools'),
      price: Number.isFinite(prompt) && Number.isFinite(completion) ? { prompt, completion } : null,
    });
  }
  return out;
}

function endpoint(o: { apiKey: string; baseUrl?: string; requestTimeoutMs?: number }): Endpoint {
  return {
    apiKey: o.apiKey,
    baseUrl: (o.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, ''),
    requestTimeoutMs: o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

async function request(ep: Endpoint, method: 'GET' | 'POST', path: string, body: JsonObject | undefined, signal?: AbortSignal): Promise<unknown> {
  const redact = (s: string) => s.split(ep.apiKey).join('[redacted]');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ep.requestTimeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  let status: number;
  let text: string;
  try {
    const res = await fetch(`${ep.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'mcp-evals' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    if (timedOut) throw new ProviderError(`OpenRouter request timed out after ${ep.requestTimeoutMs}ms`, true);
    if (signal?.aborted) throw new ProviderError('OpenRouter request aborted', false);
    throw new ProviderError(redact(`OpenRouter network error: ${describe(e)}`), true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
  let json: unknown;
  let parsed = true;
  try {
    json = JSON.parse(text);
  } catch {
    parsed = false;
  }
  if (status < 200 || status >= 300) {
    const err = isPlainObject(json) ? json.error : undefined;
    const message = isPlainObject(err) ? messageOf(err) : text.slice(0, 300) || '(empty body)';
    const classified = classify(status, redact(message));
    throw classified;
  }
  if (!parsed) throw new ProviderError(`OpenRouter: malformed response JSON (HTTP ${status})`, false);
  if (isPlainObject(json) && isPlainObject(json.error)) {
    const err = json.error;
    err.message = redact(messageOf(err));
  }
  return json;
}

function classify(status: number, message: string): Error {
  const text = `OpenRouter ${status}: ${message}`;
  if (status === 402) return new OutOfCreditsError(text);
  if (status === 408 || status === 429 || status >= 500) return new ProviderError(text, true, status);
  return new ProviderError(text, false, status);
}

function messageOf(err: JsonObject): string {
  return typeof err.message === 'string' ? err.message : 'unknown error';
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return e.cause instanceof Error ? `${e.message} (${e.cause.message})` : e.message;
}

function toWireMessage(m: ChatMessage): JsonObject {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: m.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/providers && pnpm --filter @mcp-evals/core typecheck`
Expected: every test PASSES; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/providers packages/core/test/fixtures/fake-openrouter.ts
git commit -m "feat(core): OpenRouter provider with provider pinning, error classification and out-of-credits stop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Run cache (JSONL records + manifest) for `--resume`

**Files:**
- Create: `packages/core/src/runner/cache.ts`
- Test: `packages/core/src/runner/cache.test.ts`

**Interfaces:**
- Consumes: `RunRecord`, `Suite` (Task 1), `ConfigError`, `sha256Hex`, `isPlainObject`.
- Produces:
  - `DEFAULT_RUNS_DIR = '.mcp-evals/runs'`.
  - `interface RunIdentity { provider: string; suites: Array<{ name: string; hash: string }>; models: string[] | null; servers: string[] | null; tasks: string[] | null; repeats: number | null }`.
  - `interface RunManifest extends RunIdentity { manifestVersion: 1; runId: string; createdAt: string; harnessVersion: string; unrecordedSpendUsd: number }`.
  - `suiteHash(suite: Suite): string` (ignores `source`); `identityOf(o: { provider: string; suites: Suite[]; models?: string[]; servers?: string[]; tasks?: string[]; repeats?: number }): RunIdentity` (filters sorted; absent → null).
  - `class RunCache { static create(dir, { runId, createdAt, harnessVersion, identity }): Promise<RunCache>; static open(dir, runId): Promise<RunCache>; readonly dir: string; get manifest(): RunManifest; get recordsPath(): string; get manifestPath(): string; assertCompatible(identity: RunIdentity): void; records(): Promise<RunRecord[]>; append(r: RunRecord): Promise<void>; addUnrecordedSpend(usd: number): Promise<void> }`.
  - Files: `<dir>/<runId>.jsonl` (one `RunRecord` per line) and `<dir>/<runId>.manifest.json`. Every failure a user can cause throws `ConfigError`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/runner/cache.test.ts`:
```ts
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.js';
import { parseSuite } from '../suite/load.js';
import type { RunRecord } from '../types.js';
import { identityOf, RunCache, suiteHash } from './cache.js';

const SUITE = `
suite: demo
version: 1
servers:
  fake: { command: unused }
models: [mock/a, mock/b]
tasks:
  - id: t
    prompt: "ECHO"
`;

function rec(runKey: string, costUsd = 0.01): RunRecord {
  const base = {
    runKey, suite: 'demo', server: 'fake', model: 'mock/a', task: 't', repeat: 0,
    outcome: 'pass' as const, end: 'final_answer' as const, graders: [], attempts: 1,
    costUsd, steps: 1, contextTokens: 5, latencyMs: 3,
  };
  return { ...base, toolSelectionOk: null, trace: { ...base, events: [], serverStderr: '' } };
}

async function fresh(runId = 'run-1') {
  const dir = join(await mkdtemp(join(tmpdir(), 'cache-')), 'runs');
  const identity = identityOf({ provider: 'mock', suites: [parseSuite(SUITE, 'a.yaml')], models: ['mock/b', 'mock/a'] });
  const cache = await RunCache.create(dir, { runId, createdAt: '2026-10-16T00:00:00.000Z', harnessVersion: '0.0.0', identity });
  return { dir, identity, cache };
}

describe('identityOf / suiteHash', () => {
  it('sorts filters, uses null for absent ones, and hashes suites by content, not path', () => {
    const a = parseSuite(SUITE, 'a.yaml');
    const moved = parseSuite(SUITE, 'somewhere/else.yaml');
    const edited = parseSuite(SUITE.replace('"ECHO"', '"ECHO now"'), 'a.yaml');
    expect(suiteHash(a)).toBe(suiteHash(moved));
    expect(suiteHash(a)).not.toBe(suiteHash(edited));
    expect(identityOf({ provider: 'mock', suites: [a], models: ['b/x', 'a/x'], repeats: 2 })).toEqual({
      provider: 'mock', suites: [{ name: 'demo', hash: suiteHash(a) }], models: ['a/x', 'b/x'], servers: null, tasks: null, repeats: 2,
    });
  });
});

describe('RunCache', () => {
  it('creates a manifest and an empty record file, and refuses to create the same run twice', async () => {
    const { dir, identity, cache } = await fresh();
    expect(existsSync(cache.recordsPath)).toBe(true);
    expect(JSON.parse(await readFile(cache.manifestPath, 'utf8'))).toEqual({
      manifestVersion: 1, runId: 'run-1', createdAt: '2026-10-16T00:00:00.000Z', harnessVersion: '0.0.0', ...identity, unrecordedSpendUsd: 0,
    });
    await expect(RunCache.create(dir, { runId: 'run-1', createdAt: 'x', harnessVersion: '0', identity })).rejects.toThrow(/already exists/);
  });

  it('round-trips appended records through open(), last write per runKey winning', async () => {
    const { dir, cache } = await fresh();
    await cache.append(rec('k1', 0.01));
    await cache.append(rec('k2', 0.02));
    await cache.append(rec('k1', 0.03));
    const reopened = await RunCache.open(dir, 'run-1');
    const records = await reopened.records();
    expect(records.map((r) => [r.runKey, r.costUsd])).toEqual([['k1', 0.03], ['k2', 0.02]]);
  });

  it('rejects unknown and unsafe run ids with a ConfigError', async () => {
    const { dir } = await fresh();
    await expect(RunCache.open(dir, 'nope')).rejects.toThrow(/no cached run "nope"/);
    await expect(RunCache.open(dir, '../escape')).rejects.toBeInstanceOf(ConfigError);
    await expect(RunCache.open(dir, 'a/b')).rejects.toThrow(/invalid run id/);
  });

  it('accepts the same configuration and names every difference otherwise', async () => {
    const { cache, identity } = await fresh();
    expect(() => cache.assertCompatible(identity)).not.toThrow();
    const edited = parseSuite(SUITE.replace('"ECHO"', '"ECHO now"'), 'a.yaml');
    const changed = identityOf({ provider: 'openrouter', suites: [edited], models: ['mock/a'], repeats: 1 });
    let err: unknown;
    try {
      cache.assertCompatible(changed);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const message = (err as Error).message;
    expect(message).toMatch(/cannot resume run run-1: the configuration changed/);
    expect(message).toMatch(/provider: cached "mock", now "openrouter"/);
    expect(message).toMatch(/suites: cached \[demo@/);
    expect(message).toMatch(/--models: cached \["mock\/a","mock\/b"\], now \["mock\/a"\]/);
    expect(message).toMatch(/--repeats: cached null, now 1/);
  });

  // Review Focus 3
  it('drops a final line cut off mid-append, so that run runs again and later appends stay parseable', async () => {
    const { dir, cache } = await fresh();
    await cache.append(rec('k1'));
    await appendFile(cache.recordsPath, JSON.stringify(rec('k2')).slice(0, 40));
    expect((await (await RunCache.open(dir, 'run-1')).records()).map((r) => r.runKey)).toEqual(['k1']);
    await cache.append(rec('k3'));
    expect((await (await RunCache.open(dir, 'run-1')).records()).map((r) => r.runKey)).toEqual(['k1', 'k3']);
  });

  it('keeps a complete final record that lacks its newline, and terminates it before the next append', async () => {
    const { dir, cache } = await fresh();
    await writeFile(cache.recordsPath, JSON.stringify(rec('k1')));
    expect((await (await RunCache.open(dir, 'run-1')).records()).map((r) => r.runKey)).toEqual(['k1']);
    await cache.append(rec('k2'));
    expect((await (await RunCache.open(dir, 'run-1')).records()).map((r) => r.runKey)).toEqual(['k1', 'k2']);
  });

  it('refuses a corrupt line in the middle of the cache', async () => {
    const { cache } = await fresh();
    await writeFile(cache.recordsPath, `${JSON.stringify(rec('k1'))}\n{oops\n${JSON.stringify(rec('k2'))}\n`);
    await expect(cache.records()).rejects.toThrow(/line 2 is not JSON/);
    await writeFile(cache.recordsPath, `${JSON.stringify({ hello: 'world' })}\n`);
    await expect(cache.records()).rejects.toThrow(/line 1 is not a run record/);
  });

  it('persists spend that has no record (a budget or out-of-credits cut-off)', async () => {
    const { dir, cache } = await fresh();
    await cache.addUnrecordedSpend(0.004);
    await cache.addUnrecordedSpend(0);
    await cache.addUnrecordedSpend(0.001);
    expect((await RunCache.open(dir, 'run-1')).manifest.unrecordedSpendUsd).toBeCloseTo(0.005, 12);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/runner/cache.test.ts`
Expected: FAIL — `Cannot find module './cache.js'`.

- [ ] **Step 3: Write the cache**

`packages/core/src/runner/cache.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../errors.js';
import type { RunRecord, Suite } from '../types.js';
import { isPlainObject, sha256Hex } from '../util.js';

export const DEFAULT_RUNS_DIR = '.mcp-evals/runs';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** What must stay identical between a run and its resumptions. */
export interface RunIdentity {
  provider: string;
  suites: Array<{ name: string; hash: string }>;
  models: string[] | null;
  servers: string[] | null;
  tasks: string[] | null;
  repeats: number | null;
}

export interface RunManifest extends RunIdentity {
  manifestVersion: 1;
  runId: string;
  createdAt: string;
  harnessVersion: string;
  /** Spend with no record: a run cut off by the budget cap or by out-of-credits. */
  unrecordedSpendUsd: number;
}

const ManifestSchema = z.object({
  manifestVersion: z.literal(1),
  runId: z.string(),
  createdAt: z.string(),
  harnessVersion: z.string(),
  provider: z.string(),
  suites: z.array(z.object({ name: z.string(), hash: z.string() })),
  models: z.array(z.string()).nullable(),
  servers: z.array(z.string()).nullable(),
  tasks: z.array(z.string()).nullable(),
  repeats: z.number().int().positive().nullable(),
  unrecordedSpendUsd: z.number().nonnegative(),
});

/** Content hash of a parsed suite. `source` is where the file lives, not what it says, so moving it does not block a resume. */
export function suiteHash(suite: Suite): string {
  return sha256Hex(JSON.stringify({ ...suite, source: undefined }));
}

export function identityOf(o: { provider: string; suites: Suite[]; models?: string[]; servers?: string[]; tasks?: string[]; repeats?: number }): RunIdentity {
  const sorted = (xs?: string[]) => (xs ? [...xs].sort() : null);
  return {
    provider: o.provider,
    suites: o.suites.map((s) => ({ name: s.name, hash: suiteHash(s) })),
    models: sorted(o.models),
    servers: sorted(o.servers),
    tasks: sorted(o.tasks),
    repeats: o.repeats ?? null,
  };
}

export class RunCache {
  private constructor(
    readonly dir: string,
    private current: RunManifest,
  ) {}

  get manifest(): RunManifest {
    return this.current;
  }

  get recordsPath(): string {
    return join(this.dir, `${this.current.runId}.jsonl`);
  }

  get manifestPath(): string {
    return manifestPath(this.dir, this.current.runId);
  }

  static async create(dir: string, init: { runId: string; createdAt: string; harnessVersion: string; identity: RunIdentity }): Promise<RunCache> {
    assertRunId(init.runId);
    if (existsSync(manifestPath(dir, init.runId))) throw new ConfigError(`run "${init.runId}" already exists in ${dir}`);
    await mkdir(dir, { recursive: true });
    const cache = new RunCache(dir, {
      manifestVersion: 1,
      runId: init.runId,
      createdAt: init.createdAt,
      harnessVersion: init.harnessVersion,
      ...init.identity,
      unrecordedSpendUsd: 0,
    });
    await writeFile(cache.recordsPath, '');
    await writeAtomic(cache.manifestPath, `${JSON.stringify(cache.current, null, 2)}\n`);
    return cache;
  }

  static async open(dir: string, runId: string): Promise<RunCache> {
    assertRunId(runId);
    const path = manifestPath(dir, runId);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigError(`no cached run "${runId}" in ${dir} (looked for ${path})`);
      throw e;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ConfigError(`corrupt run manifest ${path}: not JSON`);
    }
    const parsed = ManifestSchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
      throw new ConfigError(`corrupt run manifest ${path}: ${issues.join('; ')}`);
    }
    if (parsed.data.runId !== runId) throw new ConfigError(`corrupt run manifest ${path}: it describes run "${parsed.data.runId}"`);
    return new RunCache(dir, parsed.data);
  }

  /** Throws a ConfigError naming every difference between the cached run and `identity`. */
  assertCompatible(identity: RunIdentity): void {
    const m = this.current;
    const diffs: string[] = [];
    if (m.provider !== identity.provider) diffs.push(`provider: cached "${m.provider}", now "${identity.provider}"`);
    if (JSON.stringify(m.suites) !== JSON.stringify(identity.suites)) {
      const fmt = (s: RunIdentity['suites']) => s.map((x) => `${x.name}@${x.hash.slice(0, 12)}`).join(', ');
      diffs.push(`suites: cached [${fmt(m.suites)}], now [${fmt(identity.suites)}]`);
    }
    for (const key of ['models', 'servers', 'tasks', 'repeats'] as const) {
      if (JSON.stringify(m[key]) !== JSON.stringify(identity[key])) {
        diffs.push(`--${key}: cached ${JSON.stringify(m[key])}, now ${JSON.stringify(identity[key])}`);
      }
    }
    if (diffs.length > 0) {
      throw new ConfigError(`cannot resume run ${m.runId}: the configuration changed:\n  - ${diffs.join('\n  - ')}`);
    }
  }

  /** Finished records, last write per runKey winning. Repairs a final line cut off mid-append. */
  async records(): Promise<RunRecord[]> {
    let text: string;
    try {
      text = await readFile(this.recordsPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const lines = text.split('\n');
    // A file that does not end in a newline was cut off mid-append (the process died).
    const tail = text.endsWith('\n') ? '' : (lines.pop() ?? '');
    const byKey = new Map<string, RunRecord>();
    lines.forEach((line, i) => {
      if (line.trim() === '') return;
      const value = parseLine(line);
      if (value === undefined) throw new ConfigError(`corrupt run cache ${this.recordsPath}: line ${i + 1} is not JSON`);
      if (!isRunRecord(value)) throw new ConfigError(`corrupt run cache ${this.recordsPath}: line ${i + 1} is not a run record`);
      byKey.set(value.runKey, value);
    });
    if (tail.trim() !== '') {
      const value = parseLine(tail);
      if (isRunRecord(value)) {
        byKey.set(value.runKey, value);
        await appendFile(this.recordsPath, '\n');
      } else {
        // Drop the partial line so later appends stay parseable; that run simply runs again.
        await writeAtomic(this.recordsPath, text.slice(0, text.length - tail.length));
      }
    }
    return [...byKey.values()];
  }

  async append(record: RunRecord): Promise<void> {
    await appendFile(this.recordsPath, `${JSON.stringify(record)}\n`);
  }

  async addUnrecordedSpend(usd: number): Promise<void> {
    if (!(usd > 0)) return;
    this.current = { ...this.current, unrecordedSpendUsd: this.current.unrecordedSpendUsd + usd };
    await writeAtomic(this.manifestPath, `${JSON.stringify(this.current, null, 2)}\n`);
  }
}

function manifestPath(dir: string, runId: string): string {
  return join(dir, `${runId}.manifest.json`);
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new ConfigError(`invalid run id "${runId}": use letters, digits, ".", "_" and "-" only`);
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function isRunRecord(v: unknown): v is RunRecord {
  return isPlainObject(v) && typeof v.runKey === 'string' && typeof v.suite === 'string' && typeof v.outcome === 'string' && isPlainObject(v.trace);
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/runner/cache.test.ts && pnpm --filter @mcp-evals/core typecheck`
Expected: every test PASSES; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runner/cache.ts packages/core/src/runner/cache.test.ts
git commit -m "feat(core): run cache with manifest identity checks and crash-safe JSONL records

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `answer_json_schema` and `llm_judge` graders; `fs_state` treats only ENOENT as missing

**Files:**
- Create: `packages/core/src/grading/json-schema.ts`, `packages/core/src/grading/json-schema.test.ts`
- Create: `packages/core/src/grading/judge.ts`, `packages/core/src/grading/judge.test.ts`
- Modify: `packages/core/src/types.ts` (only the `GraderSpec` union and a new `JsonSchema` interface)
- Modify: `packages/core/src/suite/load.ts` (grader schemas, `toGrader`, one semantic check), `packages/core/src/suite/load.test.ts`
- Modify: `packages/core/src/graders.ts` (full replacement), `packages/core/src/graders.test.ts`

**Interfaces:**
- Consumes: `GraderResult.costUsd`, `Suite.judge`, `OutOfCreditsError`, `ProviderError`, `InfraError`, `ConfigError` (Task 1).
- Produces:
  - Types: `interface JsonSchema { type?: 'object'|'array'|'string'|'number'|'integer'|'boolean'|'null'; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; enum?: unknown[]; minItems?: number; additionalProperties?: boolean }`; `GraderSpec` adds `{ type: 'answer_json_schema'; schema: JsonSchema }` and `{ type: 'llm_judge'; rubric: string; passThreshold?: number }`.
  - YAML: `{ type: answer_json_schema, schema: {…} }` (unsupported keywords rejected at load), `{ type: llm_judge, rubric: "…", pass_threshold?: 0..1 }` (requires the suite's `judge:` block).
  - `grading/json-schema.ts`: `JsonSchemaSchema` (zod), `extractJson(text): { ok: true; value: unknown } | { ok: false; error: string }`, `validateJson(value, schema, path = '$'): string[]`.
  - `grading/judge.ts`: `JUDGE_SYSTEM_PROMPT`, `interface JudgeConfig { provider: ModelProvider; model: string; providerPin?: string; retries?: number; sleep?: (ms: number) => Promise<void> }`, `interface JudgeInput { taskPrompt; finalAnswer; rubric; passThreshold? }`, `runJudge(cfg, input): Promise<{ pass: boolean; detail: string; costUsd: number }>`, `judgePrompt(input): string`. Retryable `ProviderError`s are retried with backoff 500·2ⁿ ms (max `retries`, default 3); persistent or non-retryable failures throw `InfraError('provider', …, retryable=false)`; `OutOfCreditsError` propagates.
  - `graders.ts`: `GradeContext` gains optional `taskPrompt?: string` and `judge?: JudgeConfig`; `runGraders` runs `llm_judge` last and only when a final answer exists and every decisive deterministic grader passed (otherwise it records the judge as `skipped`); `gradersCostUsd(results): number`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/grading/json-schema.test.ts`:
```ts
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

describe('JsonSchemaSchema', () => {
  it('accepts the supported subset and rejects other keywords', () => {
    expect(JsonSchemaSchema.safeParse(schema).success).toBe(true);
    expect(JsonSchemaSchema.safeParse({ type: 'array', maxItems: 3 }).success).toBe(false);
    expect(JsonSchemaSchema.safeParse({ type: 'object', properties: { a: { pattern: 'x' } } }).success).toBe(false);
  });
});
```

`packages/core/src/grading/judge.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { InfraError, OutOfCreditsError, ProviderError } from '../errors.js';
import type { ChatRequest, ChatResponse, ModelProvider } from '../types.js';
import { JUDGE_SYSTEM_PROMPT, runJudge } from './judge.js';

function scripted(replies: Array<string | Error>, costUsd = 0.0002) {
  const requests: ChatRequest[] = [];
  const provider: ModelProvider = {
    name: 'stub',
    chat: async (req): Promise<ChatResponse> => {
      requests.push(req);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return { content: next ?? '', toolCalls: [], usage: { promptTokens: 50, completionTokens: 5, costUsd }, latencyMs: 1 };
    },
  };
  return { provider, requests };
}

const input = { taskPrompt: 'Which router is the default?', finalAnswer: 'SmartRouter', rubric: 'Names SmartRouter.' };

describe('runJudge', () => {
  it('sends the task, the answer and the rubric to the pinned judge, and returns its verdict and cost', async () => {
    const { provider, requests } = scripted(['{"pass": true, "score": 0.9, "reason": "correct"}']);
    const v = await runJudge({ provider, model: 'j/judge', providerPin: 'acme' }, input);
    expect(v).toEqual({ pass: true, detail: 'judge pass (score 0.9): correct', costUsd: 0.0002 });
    const [req] = requests;
    expect(req).toMatchObject({ model: 'j/judge', providerPin: 'acme', tools: [], temperature: 0 });
    expect(req!.messages[0]).toEqual({ role: 'system', content: JUDGE_SYSTEM_PROMPT });
    const user = req!.messages[1]!.content ?? '';
    expect(user).toContain('Which router is the default?');
    expect(user).toContain('SmartRouter');
    expect(user).toContain('Names SmartRouter.');
  });

  it('reads fenced verdicts, and fails unparseable ones with the reason', async () => {
    const fenced = scripted(['```json\n{"pass": false, "reason": "wrong router"}\n```']);
    expect(await runJudge({ provider: fenced.provider, model: 'j' }, input)).toMatchObject({ pass: false, detail: 'judge fail: wrong router' });
    const junk = scripted(['I think it passes']);
    expect(await runJudge({ provider: junk.provider, model: 'j' }, input)).toMatchObject({
      pass: false,
      detail: expect.stringMatching(/^unparseable judge verdict/),
      costUsd: 0.0002,
    });
  });

  it('applies pass_threshold to the score', async () => {
    const low = scripted(['{"pass": true, "score": 0.4, "reason": "partly"}']);
    expect(await runJudge({ provider: low.provider, model: 'j' }, { ...input, passThreshold: 0.5 })).toMatchObject({ pass: false });
    const none = scripted(['{"pass": true, "reason": "no score"}']);
    expect(await runJudge({ provider: none.provider, model: 'j' }, { ...input, passThreshold: 0.5 })).toMatchObject({
      pass: false,
      detail: expect.stringMatching(/no score/),
    });
  });

  it('retries retryable provider errors with backoff, then gives up with a non-retryable InfraError', async () => {
    const sleep = vi.fn(async () => {});
    const flaky = scripted([new ProviderError('429', true, 429), '{"pass": true, "reason": "ok"}']);
    expect(await runJudge({ provider: flaky.provider, model: 'j', sleep }, input)).toMatchObject({ pass: true });
    expect(sleep).toHaveBeenCalledWith(500);

    const down = scripted([new ProviderError('503', true, 503), new ProviderError('503', true, 503), new ProviderError('503', true, 503)]);
    const err = await runJudge({ provider: down.provider, model: 'j', sleep, retries: 2 }, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toMatchObject({ kind: 'provider', retryable: false });
    expect(down.requests).toHaveLength(3);

    const denied = scripted([new ProviderError('401', false, 401)]);
    await expect(runJudge({ provider: denied.provider, model: 'j', sleep }, input)).rejects.toMatchObject({ kind: 'provider', retryable: false });
    expect(denied.requests).toHaveLength(1);
  });

  it('lets OutOfCreditsError through so the runner can stop the whole run', async () => {
    const broke = scripted([new OutOfCreditsError('402')]);
    await expect(runJudge({ provider: broke.provider, model: 'j' }, input)).rejects.toBeInstanceOf(OutOfCreditsError);
  });
});
```

Append to `packages/core/src/graders.test.ts` (and change the first import line to add `chmod` and `mkdir`: `import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';`, and add `import { ConfigError } from './errors.js';`, `import type { ModelProvider } from './types.js';`, and `gradersCostUsd` to the `./graders.js` import):
```ts
describe('answer_json_schema', () => {
  const spec: GraderSpec = { type: 'answer_json_schema', schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } };
  it('passes valid JSON (plain or fenced) and fails invalid or missing JSON with the reason', async () => {
    expect((await one(spec, ctx({ finalAnswer: '{"n": 3}' }))).pass).toBe(true);
    expect((await one(spec, ctx({ finalAnswer: 'Result:\n```json\n{"n": 4}\n```' }))).pass).toBe(true);
    expect(await one(spec, ctx({ finalAnswer: '{"n": "3"}' }))).toMatchObject({ pass: false, detail: '$.n: expected integer, got string' });
    expect(await one(spec, ctx({ finalAnswer: 'three' }))).toMatchObject({ pass: false, detail: expect.stringMatching(/not JSON/) });
    expect(await one(spec, ctx({ finalAnswer: null }))).toMatchObject({ pass: false, detail: 'no final answer' });
  });
});

describe('llm_judge ordering', () => {
  function judge(reply = '{"pass": true, "reason": "fine"}') {
    const calls: string[] = [];
    const provider: ModelProvider = {
      name: 'stub',
      chat: async (req) => {
        calls.push(req.model);
        return { content: reply, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.0003 }, latencyMs: 1 };
      },
    };
    return { calls, cfg: { provider, model: 'j/judge' } };
  }
  const specs: GraderSpec[] = [
    { type: 'llm_judge', rubric: 'Mentions src/A.ts.' },
    { type: 'answer_contains_all', values: ['src/A.ts'], caseSensitive: false },
    { type: 'max_steps', value: 1, strict: false },
  ];

  it('runs the judge last, after the deterministic graders passed, and records its cost', async () => {
    const { calls, cfg } = judge();
    const results = await runGraders(specs, ctx({ judge: cfg, taskPrompt: 'Where?' }));
    expect(results.map((r) => r.type)).toEqual(['llm_judge', 'answer_contains_all', 'max_steps']);
    expect(results[0]).toMatchObject({ pass: true, skipped: false, costUsd: 0.0003 });
    expect(calls).toEqual(['j/judge']);
    expect(gradersCostUsd(results)).toBeCloseTo(0.0003, 12);
    expect(taskPassed(results, 'final_answer')).toBe(true);
  });

  it('does not call the judge when a deterministic grader failed or there is no final answer', async () => {
    const { calls, cfg } = judge();
    const failed = await runGraders(specs, ctx({ judge: cfg, finalAnswer: 'nothing useful' }));
    expect(failed[0]).toMatchObject({ skipped: true, detail: 'not run: a deterministic grader failed' });
    const none = await runGraders(specs, ctx({ judge: cfg, finalAnswer: null }));
    expect(none[0]).toMatchObject({ skipped: true, detail: 'not run: no final answer' });
    expect(calls).toEqual([]);
    expect(gradersCostUsd(failed)).toBe(0);
  });

  it('a failing verdict fails the task', async () => {
    const { cfg } = judge('{"pass": false, "reason": "vague"}');
    const results = await runGraders(specs, ctx({ judge: cfg }));
    expect(results[0]).toMatchObject({ pass: false, detail: 'judge fail: vague' });
    expect(taskPassed(results, 'final_answer')).toBe(false);
  });

  it('throws a ConfigError when the suite has no judge', async () => {
    await expect(runGraders(specs, ctx())).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('fs_state edge cases (M1 follow-up)', () => {
  it('counts a directory as existing and a path through a file as missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-'));
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'file.txt'), 'x');
    const c = ctx({ workspace: { dir, snapshot: new Map() } });
    expect((await one({ type: 'fs_state', path: 'sub', exists: true }, c)).pass).toBe(true);
    expect((await one({ type: 'fs_state', path: 'sub' }, c)).pass).toBe(true);
    expect((await one({ type: 'fs_state', path: 'file.txt/inner', exists: false }, c)).pass).toBe(true);
    expect(await one({ type: 'fs_state', path: 'sub', contains: 'x' }, c)).toMatchObject({ pass: false, detail: expect.stringMatching(/is a directory/) });
  });

  it.skipIf(process.getuid?.() === 0)('treats an unreadable file as a failure, never as missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-'));
    await writeFile(join(dir, 'secret.txt'), 'x');
    await chmod(join(dir, 'secret.txt'), 0o000);
    const c = ctx({ workspace: { dir, snapshot: new Map() } });
    expect(await one({ type: 'fs_state', path: 'secret.txt', exists: false }, c)).toMatchObject({ pass: false, detail: expect.stringMatching(/cannot read \(EACCES\)/) });
    await chmod(join(dir, 'secret.txt'), 0o600);
  });
});
```

Append to `describe('parseSuite', …)` in `packages/core/src/suite/load.test.ts`:
```ts
  it('parses answer_json_schema and llm_judge graders', () => {
    const s = parseSuite(
      yaml({
        models: 'models: [mock/a]\njudge: { id: anthropic/claude-haiku-5.5, provider: anthropic }',
        tasks: task(
          [
            '      - { type: answer_json_schema, schema: { type: object, required: [n], properties: { n: { type: integer } } } }',
            '      - { type: llm_judge, rubric: "Explains it.", pass_threshold: 0.7 }',
          ].join('\n'),
        ),
      }),
    );
    expect(s.tasks[0]!.graders).toEqual([
      { type: 'answer_json_schema', schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } },
      { type: 'llm_judge', rubric: 'Explains it.', passThreshold: 0.7 },
    ]);
  });

  it('rejects llm_judge without a suite judge, and unsupported JSON Schema keywords', () => {
    expect(issuesOf(yaml({ tasks: task('      - { type: llm_judge, rubric: "x" }') }))).toMatch(
      /tasks\.t1\.graders\[0\]: llm_judge needs a suite-level judge: block/,
    );
    expect(issuesOf(yaml({ tasks: task('      - { type: answer_json_schema, schema: { type: array, maxItems: 2 } }') }))).toMatch(
      /tasks\.0\.graders\.0\.schema/,
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/grading packages/core/src/graders.test.ts packages/core/src/suite`
Expected: FAIL — `Cannot find module './json-schema.js'` / `'./judge.js'`, `gradersCostUsd` not exported, unknown grader types rejected by the loader.

- [ ] **Step 3: Add the types**

In `packages/core/src/types.ts`, add before `interface GraderBase`:
```ts
/** The JSON Schema subset supported by answer_json_schema. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minItems?: number;
  additionalProperties?: boolean;
}
```
and add two members to the `GraderSpec` union, after the `answer_matches` member:
```ts
  | (GraderBase & { type: 'answer_json_schema'; schema: JsonSchema })
  | (GraderBase & { type: 'llm_judge'; rubric: string; passThreshold?: number })
```

- [ ] **Step 4: Write the JSON Schema validator**

`packages/core/src/grading/json-schema.ts`:
```ts
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
```

Note the expected order in the `validateJson` test: `enum` errors come before property recursion, required-property errors before property errors, and `additionalProperties` last — the implementation above produces exactly that order (`$.name` enum error comes from recursing into `name`, which happens in `properties` order: `name`, `count`, `tags`).

- [ ] **Step 5: Write the judge**

`packages/core/src/grading/judge.ts`:
```ts
import { InfraError, OutOfCreditsError, ProviderError } from '../errors.js';
import type { ChatResponse, ModelProvider } from '../types.js';
import { isPlainObject, sleep as realSleep } from '../util.js';
import { extractJson } from './json-schema.js';

export const JUDGE_SYSTEM_PROMPT =
  'You grade answers produced by an AI agent. Judge only against the rubric. Be strict: vague answers and invented facts fail. ' +
  'Reply with only a JSON object: {"pass": boolean, "score": number between 0 and 1, "reason": string}.';

export interface JudgeConfig {
  provider: ModelProvider;
  model: string;
  providerPin?: string;
  /** Retries for retryable provider errors (default 3). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface JudgeInput {
  taskPrompt: string;
  finalAnswer: string;
  rubric: string;
  passThreshold?: number;
}

export interface JudgeVerdict {
  pass: boolean;
  detail: string;
  costUsd: number;
}

export function judgePrompt(i: JudgeInput): string {
  return [
    'Task given to the agent:',
    '<task>',
    i.taskPrompt,
    '</task>',
    '',
    "The agent's final answer:",
    '<answer>',
    i.finalAnswer,
    '</answer>',
    '',
    'Rubric:',
    '<rubric>',
    i.rubric,
    '</rubric>',
    '',
    'Decide whether the answer satisfies the rubric. Reply with only the JSON object.',
  ].join('\n');
}

export async function runJudge(cfg: JudgeConfig, input: JudgeInput): Promise<JudgeVerdict> {
  const retries = cfg.retries ?? 3;
  const sleep = cfg.sleep ?? realSleep;
  for (let attempt = 1; ; attempt++) {
    let res: ChatResponse;
    try {
      res = await cfg.provider.chat({
        model: cfg.model,
        ...(cfg.providerPin !== undefined ? { providerPin: cfg.providerPin } : {}),
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: judgePrompt(input) },
        ],
        tools: [],
        temperature: 0,
      });
    } catch (e) {
      if (e instanceof OutOfCreditsError) throw e;
      if (e instanceof ProviderError && e.retryable && attempt <= retries) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      // Not retryable by the runner either: re-running the agent would pay for it twice.
      throw new InfraError('provider', `judge ${cfg.model}: ${e instanceof Error ? e.message : String(e)}`, false);
    }
    return { ...parseVerdict(res.content ?? '', input.passThreshold), costUsd: res.usage.costUsd };
  }
}

function parseVerdict(text: string, threshold: number | undefined): { pass: boolean; detail: string } {
  const unparseable = { pass: false, detail: `unparseable judge verdict: ${JSON.stringify(text.slice(0, 200))}` };
  const parsed = extractJson(text);
  if (!parsed.ok || !isPlainObject(parsed.value)) return unparseable;
  const { pass, reason, score } = parsed.value;
  if (typeof pass !== 'boolean') return unparseable;
  const why = typeof reason === 'string' ? reason : '(no reason given)';
  const s = typeof score === 'number' && Number.isFinite(score) ? score : undefined;
  if (threshold !== undefined) {
    if (s === undefined) return { pass: false, detail: `judge gave no score (pass_threshold ${threshold}): ${why}` };
    return { pass: s >= threshold, detail: `judge score ${s} ${s >= threshold ? '>=' : '<'} ${threshold}: ${why}` };
  }
  return { pass, detail: `judge ${pass ? 'pass' : 'fail'}${s !== undefined ? ` (score ${s})` : ''}: ${why}` };
}
```

- [ ] **Step 6: Replace `graders.ts`**

Replace `packages/core/src/graders.ts` with:
```ts
import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { ConfigError } from './errors.js';
import { extractJson, validateJson } from './grading/json-schema.js';
import { runJudge, type JudgeConfig } from './grading/judge.js';
import type { GraderResult, GraderSpec, LoopEnd, TraceEvent } from './types.js';
import { isPlainObject, sha256Hex } from './util.js';

export interface GradeContext {
  server: string;
  finalAnswer: string | null;
  events: TraceEvent[];
  steps: number;
  contextTokens: number;
  workspace: { dir: string; snapshot: Map<string, string> };
  /** The prompt the agent was given; sent to llm_judge. */
  taskPrompt?: string;
  /** Judge for llm_judge graders (from the suite's judge: block). */
  judge?: JudgeConfig;
}

type JudgeSpec = Extract<GraderSpec, { type: 'llm_judge' }>;

const TOOL_TYPES = new Set<GraderResult['type']>(['tool_called', 'tool_args_match']);

export async function runGraders(specs: GraderSpec[], ctx: GradeContext): Promise<GraderResult[]> {
  const results: GraderResult[] = [];
  const judged: Array<{ index: number; spec: JudgeSpec }> = [];
  for (const [index, spec] of specs.entries()) {
    if (spec.server !== undefined && spec.server !== ctx.server) {
      results[index] = { type: spec.type, pass: true, skipped: true, budget: false, detail: `only applies to server "${spec.server}"` };
    } else if (spec.type === 'llm_judge') {
      judged.push({ index, spec });
    } else {
      results[index] = await gradeOne(spec, ctx);
    }
  }
  // llm_judge runs last and only when it can still matter (saves cost).
  const answer = ctx.finalAnswer;
  const blocked =
    answer === null
      ? 'no final answer'
      : results.some((r) => !r.skipped && !r.budget && !r.pass)
        ? 'a deterministic grader failed'
        : undefined;
  for (const { index, spec } of judged) {
    results[index] =
      blocked !== undefined || answer === null
        ? { type: 'llm_judge', pass: false, skipped: true, budget: false, detail: `not run: ${blocked ?? 'no final answer'}` }
        : await judgeOne(spec, ctx, answer);
  }
  return results;
}

/** Spend of model-graded checks, added to the run's cost. */
export function gradersCostUsd(results: GraderResult[]): number {
  return results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
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

async function judgeOne(spec: JudgeSpec, ctx: GradeContext, answer: string): Promise<GraderResult> {
  if (!ctx.judge) throw new ConfigError('llm_judge needs a judge model: add a judge: block to the suite');
  const v = await runJudge(ctx.judge, {
    taskPrompt: ctx.taskPrompt ?? '',
    finalAnswer: answer,
    rubric: spec.rubric,
    ...(spec.passThreshold !== undefined ? { passThreshold: spec.passThreshold } : {}),
  });
  return { type: 'llm_judge', pass: v.pass, skipped: false, budget: false, detail: v.detail, costUsd: v.costUsd };
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
    case 'answer_json_schema': {
      if (ctx.finalAnswer === null) return result(spec, false, 'no final answer');
      const parsed = extractJson(ctx.finalAnswer);
      if (!parsed.ok) return result(spec, false, parsed.error);
      const errors = validateJson(parsed.value, spec.schema);
      return result(spec, errors.length === 0, errors.length ? errors.slice(0, 5).join('; ') : 'valid JSON matching the schema');
    }
    case 'llm_judge':
      throw new Error('llm_judge is graded by runGraders, after the deterministic graders');
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
      const full = join(ctx.workspace.dir, rel);
      let kind: 'missing' | 'file' | 'dir' | 'other' = 'missing';
      let buf: Buffer | null = null;
      try {
        const st = await stat(full);
        kind = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
        if (kind === 'file') buf = await readFile(full);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // Only "not there" counts as missing; anything else (EACCES, EIO, …) fails instead of silently passing.
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return result(spec, false, `${rel}: cannot read (${code ?? 'unknown error'})`);
        kind = 'missing';
        buf = null;
      }
      const exists = kind !== 'missing';
      const failures: string[] = [];
      const asserted = spec.exists !== undefined || spec.contains !== undefined || spec.unchanged !== undefined;
      if (!asserted && !exists) failures.push('expected file to exist');
      if (spec.exists !== undefined && exists !== spec.exists) failures.push(`expected exists=${spec.exists}`);
      if (spec.contains !== undefined && !(buf !== null && buf.toString('utf8').includes(spec.contains))) {
        failures.push(kind === 'dir' ? 'is a directory, cannot check contains' : `does not contain ${JSON.stringify(spec.contains)}`);
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

- [ ] **Step 7: Teach the loader the new graders**

In `packages/core/src/suite/load.ts`:
- add the import `import { JsonSchemaSchema } from '../grading/json-schema.js';`
- add two members to `GraderSchema` after the `answer_matches` member:
```ts
  z.object({ type: z.literal('answer_json_schema'), schema: JsonSchemaSchema, ...serverRef }).strict(),
  z.object({ type: z.literal('llm_judge'), rubric: z.string().min(1), pass_threshold: z.number().min(0).max(1).optional(), ...serverRef }).strict(),
```
- in `semanticIssues`, inside `t.graders.forEach((g, i) => { … })` after the `g.server` check, add:
```ts
      if (g.type === 'llm_judge' && !s.judge) issues.push(`${at}: llm_judge needs a suite-level judge: block`);
```
- in `toGrader`, add after the `answer_matches` case:
```ts
    case 'answer_json_schema':
      return { type: g.type, schema: g.schema, ...server };
    case 'llm_judge':
      return { type: g.type, rubric: g.rubric, ...(g.pass_threshold !== undefined ? { passThreshold: g.pass_threshold } : {}), ...server };
```

- [ ] **Step 8: Run all core tests and typecheck**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: every test PASSES; typecheck exits 0 (the runner still compiles because the new `GradeContext` fields are optional).

- [ ] **Step 9: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): answer_json_schema and llm_judge graders; fs_state only treats ENOENT as missing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `compare` and `report` (CLI), results-file helpers, table v2

**Files:**
- Create: `packages/cli/src/files.ts`, `packages/cli/src/files.test.ts`
- Create: `packages/cli/src/testing/results-fixture.ts`
- Create: `packages/cli/src/report/compare.ts`, `packages/cli/src/report/compare.test.ts`
- Create: `packages/cli/src/report/markdown.ts`, `packages/cli/src/report/markdown.test.ts`
- Modify: `packages/cli/src/report/table.ts` (full replacement), `packages/cli/src/report/table.test.ts` (full replacement)
- Create: `packages/cli/src/commands/compare.ts`, `packages/cli/src/commands/report.ts`, `packages/cli/src/commands/compare-report.test.ts`

**Interfaces:**
- Consumes: `readResults`, `ConfigError`, `type Results` from `@mcp-evals/core` (Task 2).
- Produces:
  - `files.ts`: `fsReason(e: unknown): string`; `readResultsFile(path: string): Promise<Results>` (throws `ConfigError` naming the absolute path); `writeFileAtomic(path: string, data: string | Uint8Array): Promise<void>` (mkdir -p, temp file + rename).
  - `report/table.ts`: `pct`, `ci`, `usd`, `runsText(cell)`, `alignColumns(rows: string[][]): string`, `formatTable(results): string`.
  - `report/markdown.ts`: `formatMarkdown(results: Results): string`.
  - `report/compare.ts`: `interface CompareThresholds { maxSuccessDropPts: number; maxContextIncreasePct: number }`, `type CellStatus = 'ok'|'regression'|'incomplete'|'missing_in_base'|'missing_in_head'`, `interface CellComparison`, `interface Comparison { thresholds; regressions: number; cells: CellComparison[] }`, `compareResults(base, head, t): Comparison`, `formatComparison(c, format: 'table'|'markdown'|'json'): string`.
  - `commands/compare.ts`: `interface CompareCommandOptions { base: string; head: string; maxSuccessDrop: number; maxContextIncrease: number; format: 'table'|'markdown'|'json'; log?: (line: string) => void }`, `compareCommand(o): Promise<{ exitCode: number; comparison?: Comparison }>` → 1 on regression, 0 otherwise, 2 for unreadable/invalid files or bad thresholds.
  - `commands/report.ts`: `interface ReportCommandOptions { results: string; format: 'table'|'markdown'; log? }`, `reportCommand(o): Promise<{ exitCode: number }>`.
  - Task 9 registers both commands in `program.ts`; Task 9 and Task 12 use `files.ts`.

- [ ] **Step 1: Write the test fixture builders**

`packages/cli/src/testing/results-fixture.ts`:
```ts
import type { Results } from '@mcp-evals/core';

export type Cell = Results['suites'][number]['cells'][number];

export function cell(over: Partial<Cell> & Pick<Cell, 'server' | 'model'>): Cell {
  return {
    runs: 4, plannedRuns: 4, complete: true, successRate: 0.75, successCi95: [0.3006, 0.9544], toolAccuracy: null,
    contextTokensPerTask: { mean: 1000, median: 1000 }, providerPromptTokensPerTask: { mean: 5000, median: 5000 },
    stepsPerTask: 3, latencyMsP50: 1200, costUsdPerTask: 0.01, errorRate: 0, tasks: [],
    ...over,
  };
}

export function results(cells: Cell[], over: Partial<Results> = {}): Results {
  return {
    schemaVersion: 2, harnessVersion: '0.0.0', runId: 'run-1',
    startedAt: '2026-10-16T00:00:00.000Z', finishedAt: '2026-10-16T00:10:00.000Z', partial: false, totalCostUsd: 0.04,
    suites: [{
      suite: 'code-navigation', suiteVersion: 1,
      fixture: { git: 'https://github.com/honojs/hono', ref: '08a023cbfde55b434fb0fb30fae35d42e4bf20aa' },
      servers: { neatcode: { command: 'npx', version: '0.1.4' }, filesystem: { command: 'npx', version: null } },
      models: [{ id: 'acme/a', provider: 'acme' }], judge: null, cells,
    }],
    ...over,
  };
}
```

- [ ] **Step 2: Write the failing tests**

`packages/cli/src/files.test.ts`:
```ts
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@mcp-evals/core';
import { describe, expect, it } from 'vitest';
import { readResultsFile, writeFileAtomic } from './files.js';
import { cell, results } from './testing/results-fixture.js';

describe('files', () => {
  it('writes atomically, creating parent directories and leaving no temp files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'files-'));
    await writeFileAtomic(join(dir, 'a', 'b.txt'), 'hello');
    await writeFileAtomic(join(dir, 'a', 'b.txt'), new Uint8Array([104, 105]));
    expect(await readFile(join(dir, 'a', 'b.txt'), 'utf8')).toBe('hi');
    expect(await readdir(join(dir, 'a'))).toEqual(['b.txt']);
  });

  it('reads results files and names the file in every error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'files-'));
    const good = join(dir, 'good.json');
    await writeFile(good, JSON.stringify(results([cell({ server: 'neatcode', model: 'acme/a' })])));
    expect((await readResultsFile(good)).schemaVersion).toBe(2);
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{nope');
    const wrong = join(dir, 'wrong.json');
    await writeFile(wrong, JSON.stringify({ schemaVersion: 9 }));
    for (const path of [join(dir, 'missing.json'), bad, wrong]) {
      const err = await readResultsFile(path).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain(path);
    }
  });
});
```

`packages/cli/src/report/compare.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { cell, results } from '../testing/results-fixture.js';
import { compareResults, formatComparison } from './compare.js';

const t = { maxSuccessDropPts: 5, maxContextIncreasePct: 20 };
const one = (over: Parameters<typeof cell>[0]) => results([cell(over)]);
const nc = { server: 'neatcode', model: 'acme/a' };

describe('compareResults', () => {
  it('is ok when nothing moved', () => {
    const c = compareResults(one(nc), one(nc), t);
    expect(c.regressions).toBe(0);
    expect(c.cells).toEqual([expect.objectContaining({ ...nc, suite: 'code-navigation', status: 'ok', successDeltaPts: 0, contextChangePct: 0, reasons: [] })]);
  });

  // Review Focus 4
  it('flags a success drop above the threshold, but not one exactly at it', () => {
    const base = one({ ...nc, successRate: 0.75 });
    expect(compareResults(base, one({ ...nc, successRate: 0.7 }), t).regressions).toBe(0);
    const c = compareResults(base, one({ ...nc, successRate: 0.6999 }), t);
    expect(c.regressions).toBe(1);
    expect(c.cells[0]).toMatchObject({ status: 'regression', reasons: [expect.stringMatching(/^success dropped 5\.0 pts \(max 5\)$/)] });
  });

  it('flags context growth above the threshold, and skips the check when the base median is 0', () => {
    const base = one({ ...nc, contextTokensPerTask: { mean: 1000, median: 1000 } });
    expect(compareResults(base, one({ ...nc, contextTokensPerTask: { mean: 1200, median: 1200 } }), t).regressions).toBe(0);
    const c = compareResults(base, one({ ...nc, contextTokensPerTask: { mean: 1201, median: 1201 } }), t);
    expect(c.cells[0]).toMatchObject({ status: 'regression', reasons: [expect.stringMatching(/context tokens rose 20\.1%/)] });
    const zero = compareResults(one({ ...nc, contextTokensPerTask: { mean: 0, median: 0 } }), one(nc), t);
    expect(zero.cells[0]).toMatchObject({ status: 'ok', contextChangePct: null });
  });

  it('does not compare null success rates', () => {
    const c = compareResults(one({ ...nc, successRate: null }), one({ ...nc, successRate: 0 }), t);
    expect(c.cells[0]).toMatchObject({ status: 'ok', successDeltaPts: null });
  });

  it('reports cells missing on either side without failing', () => {
    const base = results([cell(nc), cell({ server: 'filesystem', model: 'acme/a' })]);
    const head = results([cell(nc), cell({ server: 'neatcode', model: 'acme/b' })]);
    const c = compareResults(base, head, t);
    expect(c.regressions).toBe(0);
    expect(c.cells.map((x) => `${x.server}/${x.model}:${x.status}`)).toEqual([
      'neatcode/acme/a:ok', 'neatcode/acme/b:missing_in_base', 'filesystem/acme/a:missing_in_head',
    ]);
  });

  it('reports incomplete cells instead of judging them, but compares v1 cells of unknown completeness', () => {
    const c = compareResults(one(nc), one({ ...nc, runs: 2, complete: false, successRate: 0 }), t);
    expect(c.regressions).toBe(0);
    expect(c.cells[0]).toMatchObject({ status: 'incomplete', reasons: ['head incomplete (2/4 runs)'] });
    const v1 = compareResults(one({ ...nc, plannedRuns: null, complete: false }), one({ ...nc, plannedRuns: null, complete: false, successRate: 0.5 }), t);
    expect(v1.cells[0]).toMatchObject({ status: 'regression' });
  });
});

describe('formatComparison', () => {
  const c = compareResults(one(nc), one({ ...nc, successRate: 0.5 }), t);
  it('renders a table with a summary', () => {
    const out = formatComparison(c, 'table');
    expect(out.split('\n')[0]).toMatch(/^SUITE\s+SERVER\s+MODEL\s+STATUS\s+SUCCESS\s+Δ PTS\s+CTX TOK \(med\)\s+Δ CTX\s+NOTES$/);
    expect(out).toMatch(/code-navigation\s+neatcode\s+acme\/a\s+REGRESSION\s+75% → 50%\s+-25\.0/);
    expect(out.split('\n').at(-1)).toBe('1 regression(s) in 1 cell(s) · max success drop 5 pts · max context increase 20%');
  });
  it('renders markdown and json', () => {
    const md = formatComparison(c, 'markdown').split('\n');
    expect(md[0]).toBe('| SUITE | SERVER | MODEL | STATUS | SUCCESS | Δ PTS | CTX TOK (med) | Δ CTX | NOTES |');
    expect(md[1]).toBe('|---|---|---|---|---|---|---|---|---|');
    expect(md[2]).toContain('| REGRESSION |');
    expect(JSON.parse(formatComparison(c, 'json'))).toEqual(c);
  });
});
```

`packages/cli/src/report/markdown.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { cell, results } from '../testing/results-fixture.js';
import { formatMarkdown } from './markdown.js';

describe('formatMarkdown', () => {
  it('renders a heading, pins, versions, one row per cell, and incomplete cells', () => {
    const r = results([cell({ server: 'neatcode', model: 'acme/a' }), cell({ server: 'filesystem', model: 'acme/a', runs: 3, complete: false })], {
      partial: true,
    });
    const lines = formatMarkdown(r).split('\n');
    expect(lines[0]).toBe('## mcp-evals results — run `run-1`');
    expect(lines).toContain('Harness 0.0.0 · 2026-10-16T00:00:00.000Z → 2026-10-16T00:10:00.000Z · total cost $0.0400 · **PARTIAL**');
    expect(lines).toContain('### code-navigation (v1)');
    expect(lines).toContain('Fixture: https://github.com/honojs/hono @ `08a023cbfde55b434fb0fb30fae35d42e4bf20aa`');
    expect(lines).toContain('Models: acme/a (acme)');
    expect(lines).toContain('Servers: neatcode 0.1.4, filesystem');
    expect(lines).toContain('| neatcode | acme/a | 4/4 | 75% | [30–95%] | – | 1000 | 5000 | 3.0 | $0.0100 | 0% |');
    expect(lines).toContain('| filesystem | acme/a | 3/4 | 75% | [30–95%] | – | 1000 | 5000 | 3.0 | $0.0100 | 0% |');
    expect(lines).toContain('Incomplete cells (not every planned run finished): filesystem/acme/a');
  });
});
```

Replace `packages/cli/src/report/table.test.ts` with:
```ts
import { describe, expect, it } from 'vitest';
import { cell, results } from '../testing/results-fixture.js';
import { alignColumns, ci, formatTable, pct, usd } from './table.js';

describe('formatting helpers', () => {
  it('formats percentages, intervals, and dollars', () => {
    expect(pct(0.756)).toBe('76%');
    expect(ci([0.3006, 0.9544])).toBe('[30–95%]');
    expect(usd(0.002)).toBe('$0.0020');
  });
  it('aligns columns', () => {
    expect(alignColumns([['A', 'BB'], ['ccc', 'd']])).toBe('A    BB\nccc  d');
  });
});

describe('formatTable', () => {
  it('renders a header, one row per cell with runs/planned, the notices, and the total', () => {
    const r = results(
      [
        cell({ server: 'neatcode', model: 'acme/a', contextTokensPerTask: { mean: 10, median: 12.4 }, costUsdPerTask: 0.002, stepsPerTask: 2 }),
        cell({ server: 'neatcode', model: 'acme/b', runs: 2, complete: false, successRate: null, successCi95: [0, 1], errorRate: 1 }),
      ],
      { partial: true, totalCostUsd: 0.012 },
    );
    const lines = formatTable(r).split('\n');
    expect(lines[0]).toMatch(/^SUITE\s+SERVER\s+MODEL\s+RUNS\s+SUCCESS\s+95% CI\s+TOOL ACC\s+CTX TOK \(med\)\s+STEPS\s+\$\/TASK\s+ERRORS$/);
    expect(lines[1]).toMatch(/^code-navigation\s+neatcode\s+acme\/a\s+4\/4\s+75%\s+\[30–95%\]\s+–\s+12\s+2\.0\s+\$0\.0020\s+0%$/);
    expect(lines[2]).toMatch(/^code-navigation\s+neatcode\s+acme\/b\s+2\/4\s+–\s+\[0–100%\]\s+–\s+1000\s+3\.0\s+\$0\.0100\s+100%$/);
    expect(lines).toContain('PARTIAL: the budget cap or an out-of-credits stop ended the run before every planned run finished.');
    expect(lines).toContain('INCOMPLETE: 1 cell(s) did not finish every planned run; do not compare them as if complete.');
    expect(lines.at(-1)).toBe('total cost $0.0120 · run run-1');
  });

  it('shows plain run counts for results upgraded from v1', () => {
    const lines = formatTable(results([cell({ server: 'neatcode', model: 'acme/a', plannedRuns: null, complete: false })])).split('\n');
    expect(lines[1]).toMatch(/^code-navigation\s+neatcode\s+acme\/a\s+4\s+75%/);
    expect(lines.some((l) => l.startsWith('INCOMPLETE'))).toBe(false);
  });
});
```

`packages/cli/src/commands/compare-report.test.ts`:
```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Results } from '@mcp-evals/core';
import { describe, expect, it } from 'vitest';
import { cell, results } from '../testing/results-fixture.js';
import { compareCommand } from './compare.js';
import { reportCommand } from './report.js';

async function files(entries: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-cmp-'));
  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(entries)) {
    paths[name] = join(dir, name);
    await writeFile(paths[name]!, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return { dir, paths };
}

const nc = { server: 'neatcode', model: 'acme/a' };
const opts = { maxSuccessDrop: 5, maxContextIncrease: 20, format: 'table' as const };

function v1(r: Results): unknown {
  return {
    ...r,
    schemaVersion: 1,
    suites: r.suites.map(({ judge: _judge, ...s }) => ({
      ...s,
      servers: Object.fromEntries(Object.entries(s.servers).map(([k, v]) => [k, { command: v.command }])),
      cells: s.cells.map(({ plannedRuns: _p, complete: _c, providerPromptTokensPerTask: _t, ...c }) => c),
    })),
  };
}

describe('compareCommand', () => {
  it('exits 1 on a regression and 0 otherwise, printing the comparison', async () => {
    const { paths } = await files({ 'base.json': results([cell(nc)]), 'same.json': results([cell(nc)]), 'worse.json': results([cell({ ...nc, successRate: 0.25 })]) });
    const lines: string[] = [];
    expect((await compareCommand({ ...opts, base: paths['base.json']!, head: paths['same.json']!, log: (l) => lines.push(l) })).exitCode).toBe(0);
    const worse = await compareCommand({ ...opts, base: paths['base.json']!, head: paths['worse.json']!, log: (l) => lines.push(l) });
    expect(worse.exitCode).toBe(1);
    expect(worse.comparison?.regressions).toBe(1);
    expect(lines.join('\n')).toMatch(/REGRESSION/);
  });

  it('accepts v1 results files', async () => {
    const { paths } = await files({ 'old.json': v1(results([cell(nc)])), 'new.json': results([cell(nc)]) });
    expect((await compareCommand({ ...opts, base: paths['old.json']!, head: paths['new.json']!, log: () => {} })).exitCode).toBe(0);
  });

  it('exits 2 naming the file for missing, unparseable, or invalid results, and for bad thresholds', async () => {
    const { dir, paths } = await files({ 'ok.json': results([cell(nc)]), 'bad.json': '{oops', 'v9.json': { schemaVersion: 9 } });
    for (const bad of [join(dir, 'missing.json'), paths['bad.json']!, paths['v9.json']!]) {
      const lines: string[] = [];
      expect((await compareCommand({ ...opts, base: paths['ok.json']!, head: bad, log: (l) => lines.push(l) })).exitCode).toBe(2);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^error: /);
      expect(lines[0]).toContain(bad);
    }
    const lines: string[] = [];
    expect((await compareCommand({ ...opts, maxSuccessDrop: -1, base: paths['ok.json']!, head: paths['ok.json']!, log: (l) => lines.push(l) })).exitCode).toBe(2);
    expect(lines[0]).toMatch(/^error: --max-success-drop/);
  });
});

describe('reportCommand', () => {
  it('prints a table or markdown, and exits 2 for a bad file', async () => {
    const { dir, paths } = await files({ 'r.json': results([cell(nc)]) });
    const lines: string[] = [];
    expect((await reportCommand({ results: paths['r.json']!, format: 'table', log: (l) => lines.push(l) })).exitCode).toBe(0);
    expect(lines[0]).toMatch(/^SUITE/);
    lines.length = 0;
    expect((await reportCommand({ results: paths['r.json']!, format: 'markdown', log: (l) => lines.push(l) })).exitCode).toBe(0);
    expect(lines[0]).toMatch(/^## mcp-evals results/);
    expect((await reportCommand({ results: join(dir, 'nope.json'), format: 'table', log: () => {} })).exitCode).toBe(2);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/cli`
Expected: FAIL — `Cannot find module './files.js'`, `'./compare.js'`, `'./markdown.js'`; table expectations fail.

- [ ] **Step 4: Write `files.ts`**

`packages/cli/src/files.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ConfigError, readResults, type Results } from '@mcp-evals/core';

export function fsReason(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'no such file';
  if (code === 'EACCES') return 'permission denied';
  if (code === 'EISDIR') return 'is a directory';
  return e instanceof Error ? e.message : String(e);
}

/** Reads results.json (v1 or v2) and returns it as v2. Every failure is a ConfigError naming the file. */
export async function readResultsFile(path: string): Promise<Results> {
  const abs = resolve(path);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read results file ${abs}: ${fsReason(e)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`invalid results file ${abs}: ${(e as Error).message}`);
  }
  try {
    return readResults(json);
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(`invalid results file ${abs}: ${e.message}`);
    throw e;
  }
}

/** Writes through a temp file and a rename, so readers never see a half-written file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, data);
  await rename(tmp, abs);
}
```

- [ ] **Step 5: Replace `table.ts` and write `markdown.ts`**

Replace `packages/cli/src/report/table.ts` with:
```ts
import type { Results } from '@mcp-evals/core';

type Cell = Results['suites'][number]['cells'][number];

export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export const ci = ([lo, hi]: [number, number]): string => `[${Math.round(lo * 100)}–${Math.round(hi * 100)}%]`;
export const usd = (x: number): string => `$${x.toFixed(4)}`;
/** "runs/planned", or just "runs" for results upgraded from v1. */
export const runsText = (c: Cell): string => (c.plannedRuns === null ? String(c.runs) : `${c.runs}/${c.plannedRuns}`);
export const isIncomplete = (c: Cell): boolean => c.plannedRuns !== null && !c.complete;

export function alignColumns(rows: string[][]): string {
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((cells) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd()).join('\n');
}

const HEADER = ['SUITE', 'SERVER', 'MODEL', 'RUNS', 'SUCCESS', '95% CI', 'TOOL ACC', 'CTX TOK (med)', 'STEPS', '$/TASK', 'ERRORS'];

export function formatTable(results: Results): string {
  const rows = results.suites.flatMap((s) =>
    s.cells.map((c) => [
      s.suite,
      c.server,
      c.model,
      runsText(c),
      c.successRate === null ? '–' : pct(c.successRate),
      ci(c.successCi95),
      c.toolAccuracy === null ? '–' : pct(c.toolAccuracy),
      String(Math.round(c.contextTokensPerTask.median)),
      c.stepsPerTask.toFixed(1),
      usd(c.costUsdPerTask),
      pct(c.errorRate),
    ]),
  );
  const out = [alignColumns([HEADER, ...rows])];
  const notices: string[] = [];
  if (results.partial) notices.push('PARTIAL: the budget cap or an out-of-credits stop ended the run before every planned run finished.');
  const incomplete = results.suites.flatMap((s) => s.cells).filter(isIncomplete).length;
  if (incomplete > 0) notices.push(`INCOMPLETE: ${incomplete} cell(s) did not finish every planned run; do not compare them as if complete.`);
  if (notices.length > 0) out.push('', ...notices);
  out.push('', `total cost ${usd(results.totalCostUsd)} · run ${results.runId}`);
  return out.join('\n');
}
```

`packages/cli/src/report/markdown.ts`:
```ts
import type { Results } from '@mcp-evals/core';
import { ci, isIncomplete, pct, runsText, usd } from './table.js';

const HEADER = '| Server | Model | Runs | Success | 95% CI | Tool acc. | Context tok. (median) | Provider prompt tok. (median) | Steps | $/task | Errors |';

export function formatMarkdown(r: Results): string {
  const out: string[] = [
    `## mcp-evals results — run \`${r.runId}\``,
    '',
    `Harness ${r.harnessVersion} · ${r.startedAt} → ${r.finishedAt} · total cost ${usd(r.totalCostUsd)}${r.partial ? ' · **PARTIAL**' : ''}`,
  ];
  for (const s of r.suites) {
    out.push('', `### ${s.suite} (v${s.suiteVersion})`, '');
    if (s.fixture) out.push(`Fixture: ${s.fixture.git} @ \`${s.fixture.ref}\``);
    out.push(`Models: ${s.models.map((m) => `${m.id} (${m.provider})`).join(', ')}`);
    if (s.judge) out.push(`Judge: ${s.judge.id} (${s.judge.provider})`);
    out.push(`Servers: ${Object.entries(s.servers).map(([name, v]) => (v.version ? `${name} ${v.version}` : name)).join(', ')}`, '');
    out.push(HEADER, `|${HEADER.split('|').slice(1, -1).map(() => '---').join('|')}|`);
    for (const c of s.cells) {
      const cols = [
        c.server,
        c.model,
        runsText(c),
        c.successRate === null ? '–' : pct(c.successRate),
        ci(c.successCi95),
        c.toolAccuracy === null ? '–' : pct(c.toolAccuracy),
        String(Math.round(c.contextTokensPerTask.median)),
        c.providerPromptTokensPerTask === null ? '–' : String(Math.round(c.providerPromptTokensPerTask.median)),
        c.stepsPerTask.toFixed(1),
        usd(c.costUsdPerTask),
        pct(c.errorRate),
      ];
      out.push(`| ${cols.join(' | ')} |`);
    }
    const incomplete = s.cells.filter(isIncomplete);
    if (incomplete.length > 0) {
      out.push('', `Incomplete cells (not every planned run finished): ${incomplete.map((c) => `${c.server}/${c.model}`).join(', ')}`);
    }
  }
  return out.join('\n');
}
```

- [ ] **Step 6: Write `compare.ts`**

`packages/cli/src/report/compare.ts`:
```ts
import type { Results } from '@mcp-evals/core';
import { alignColumns, pct } from './table.js';

export interface CompareThresholds {
  /** Percentage points. */
  maxSuccessDropPts: number;
  /** Percent of the base median context tokens. */
  maxContextIncreasePct: number;
}

export type CellStatus = 'ok' | 'regression' | 'incomplete' | 'missing_in_base' | 'missing_in_head';

export interface CellSide {
  successRate: number | null;
  contextTokensMedian: number;
  runs: number;
  plannedRuns: number | null;
  complete: boolean;
}

export interface CellComparison {
  suite: string;
  server: string;
  model: string;
  status: CellStatus;
  base: CellSide | null;
  head: CellSide | null;
  successDeltaPts: number | null;
  contextChangePct: number | null;
  reasons: string[];
}

export interface Comparison {
  thresholds: CompareThresholds;
  regressions: number;
  cells: CellComparison[];
}

type Cell = Results['suites'][number]['cells'][number];
interface Located {
  suite: string;
  cell: Cell;
}

/** Rounds away float noise, so a drop exactly at the threshold is not a regression. */
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const keyOf = (suite: string, c: Cell): string => [suite, c.server, c.model].join('\u0000');
/** Unknown completeness (results upgraded from v1) is not treated as incomplete. */
const incomplete = (s: CellSide): boolean => s.plannedRuns !== null && !s.complete;

function index(r: Results): Map<string, Located> {
  const m = new Map<string, Located>();
  for (const s of r.suites) for (const c of s.cells) m.set(keyOf(s.suite, c), { suite: s.suite, cell: c });
  return m;
}

function side(c: Cell): CellSide {
  return { successRate: c.successRate, contextTokensMedian: c.contextTokensPerTask.median, runs: c.runs, plannedRuns: c.plannedRuns, complete: c.complete };
}

export function compareResults(base: Results, head: Results, t: CompareThresholds): Comparison {
  const b = index(base);
  const h = index(head);
  const keys = [...h.keys(), ...[...b.keys()].filter((k) => !h.has(k))];
  const cells = keys.map((k) => compareCell(b.get(k), h.get(k), t));
  return { thresholds: t, regressions: cells.filter((c) => c.status === 'regression').length, cells };
}

function compareCell(b: Located | undefined, h: Located | undefined, t: CompareThresholds): CellComparison {
  const where = (h ?? b)!;
  const base = b ? side(b.cell) : null;
  const head = h ? side(h.cell) : null;
  const successDeltaPts =
    base?.successRate != null && head?.successRate != null ? round6((head.successRate - base.successRate) * 100) : null;
  const contextChangePct =
    base && head && base.contextTokensMedian > 0
      ? round6(((head.contextTokensMedian - base.contextTokensMedian) / base.contextTokensMedian) * 100)
      : null;
  const common = { suite: where.suite, server: where.cell.server, model: where.cell.model, base, head, successDeltaPts, contextChangePct };
  if (!base) return { ...common, status: 'missing_in_base', reasons: ['cell not in base results'] };
  if (!head) return { ...common, status: 'missing_in_head', reasons: ['cell not in head results'] };
  if (incomplete(base) || incomplete(head)) {
    const reasons = (
      [
        ['base', base],
        ['head', head],
      ] as const
    ).flatMap(([label, s]) => (incomplete(s) ? [`${label} incomplete (${s.runs}/${s.plannedRuns} runs)`] : []));
    return { ...common, status: 'incomplete', reasons };
  }
  const reasons: string[] = [];
  if (successDeltaPts !== null && -successDeltaPts > t.maxSuccessDropPts) {
    reasons.push(`success dropped ${(-successDeltaPts).toFixed(1)} pts (max ${t.maxSuccessDropPts})`);
  }
  if (contextChangePct !== null && contextChangePct > t.maxContextIncreasePct) {
    reasons.push(`context tokens rose ${contextChangePct.toFixed(1)}% (max ${t.maxContextIncreasePct}%)`);
  }
  return { ...common, status: reasons.length > 0 ? 'regression' : 'ok', reasons };
}

const rate = (s: CellSide | null): string => (s === null ? '–' : s.successRate === null ? 'n/a' : pct(s.successRate));
const ctx = (s: CellSide | null): string => (s === null ? '–' : String(Math.round(s.contextTokensMedian)));
const signed = (x: number): string => `${x > 0 ? '+' : ''}${x.toFixed(1)}`;
const HEADER = ['SUITE', 'SERVER', 'MODEL', 'STATUS', 'SUCCESS', 'Δ PTS', 'CTX TOK (med)', 'Δ CTX', 'NOTES'];

export function formatComparison(c: Comparison, format: 'table' | 'markdown' | 'json'): string {
  if (format === 'json') return JSON.stringify(c, null, 2);
  const rows = c.cells.map((x) => [
    x.suite,
    x.server,
    x.model,
    x.status === 'regression' ? 'REGRESSION' : x.status,
    `${rate(x.base)} → ${rate(x.head)}`,
    x.successDeltaPts === null ? '–' : signed(x.successDeltaPts),
    `${ctx(x.base)} → ${ctx(x.head)}`,
    x.contextChangePct === null ? '–' : `${signed(x.contextChangePct)}%`,
    x.reasons.join('; '),
  ]);
  const summary = `${c.regressions} regression(s) in ${c.cells.length} cell(s) · max success drop ${c.thresholds.maxSuccessDropPts} pts · max context increase ${c.thresholds.maxContextIncreasePct}%`;
  if (format === 'markdown') {
    const esc = (s: string) => s.replace(/\|/g, '\\|');
    return [`| ${HEADER.join(' | ')} |`, `|${HEADER.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`), '', summary].join('\n');
  }
  return [alignColumns([HEADER, ...rows]), '', summary].join('\n');
}
```

- [ ] **Step 7: Write the commands**

`packages/cli/src/commands/compare.ts`:
```ts
import { ConfigError } from '@mcp-evals/core';
import { readResultsFile } from '../files.js';
import { compareResults, formatComparison, type Comparison } from '../report/compare.js';

export interface CompareCommandOptions {
  base: string;
  head: string;
  /** Percentage points (default 5 in the CLI). */
  maxSuccessDrop: number;
  /** Percent (default 20 in the CLI). */
  maxContextIncrease: number;
  format: 'table' | 'markdown' | 'json';
  log?: (line: string) => void;
}

/** Exit 1 on a regression, 0 otherwise, 2 for unreadable or invalid input. */
export async function compareCommand(o: CompareCommandOptions): Promise<{ exitCode: number; comparison?: Comparison }> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    for (const [flag, v] of [['--max-success-drop', o.maxSuccessDrop], ['--max-context-increase', o.maxContextIncrease]] as const) {
      if (!Number.isFinite(v) || v < 0) throw new ConfigError(`${flag} must be a non-negative number, got ${v}`);
    }
    const base = await readResultsFile(o.base);
    const head = await readResultsFile(o.head);
    const comparison = compareResults(base, head, { maxSuccessDropPts: o.maxSuccessDrop, maxContextIncreasePct: o.maxContextIncrease });
    log(formatComparison(comparison, o.format));
    return { exitCode: comparison.regressions > 0 ? 1 : 0, comparison };
  } catch (e) {
    if (e instanceof ConfigError) {
      log(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}
```

`packages/cli/src/commands/report.ts`:
```ts
import { ConfigError } from '@mcp-evals/core';
import { readResultsFile } from '../files.js';
import { formatMarkdown } from '../report/markdown.js';
import { formatTable } from '../report/table.js';

export interface ReportCommandOptions {
  results: string;
  format: 'table' | 'markdown';
  log?: (line: string) => void;
}

export async function reportCommand(o: ReportCommandOptions): Promise<{ exitCode: number }> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    const results = await readResultsFile(o.results);
    log(o.format === 'markdown' ? formatMarkdown(results) : formatTable(results));
    return { exitCode: 0 };
  } catch (e) {
    if (e instanceof ConfigError) {
      log(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}
```

- [ ] **Step 8: Run the CLI tests and typecheck**

Run: `pnpm vitest run packages/cli && pnpm typecheck`
Expected: every test PASSES; typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src
git commit -m "feat(cli): compare and report commands, markdown output, runs/planned in the table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Connector and loop follow-ups — tool timeout policy, non-retryable unknown errors, server version

**Files:**
- Modify: `packages/core/src/mcp/connection.ts:6,35-50` , `packages/core/src/mcp/connection.test.ts`
- Modify: `packages/core/src/agent/loop.ts:1,118-125`, `packages/core/src/agent/loop.test.ts`

**Interfaces:**
- Consumes: `ToolTimeoutError`, `LoopEnd 'tool_timeout'`, `McpConnection.serverVersion?` (Task 1).
- Produces:
  - `McpConnection.callTool` throws `ToolTimeoutError(name, timeoutMs)` when the per-call timeout fires; any non-MCP transport error becomes `InfraError('server', …, retryable=false)` (only `ConnectionClosed` stays retryable).
  - Both connectors implement `serverVersion()` from the MCP `initialize` `serverInfo.version`.
  - `runAgentLoop`: a tool call that hits `toolTimeoutMs` (not the run deadline) ends the run with `end: 'tool_timeout'` (a model `fail`, no `infraError`) and an `error` trace event of kind `tool_timeout`; a call cut short by the run deadline still ends with `'timeout'`. Task 8 passes `toolTimeoutMs = suite.defaults.toolTimeoutS * 1000`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/mcp/connection.test.ts`, change the errors import to
```ts
import { InfraError, ToolTimeoutError } from '../errors.js';
```
replace the test `'turns tool timeouts into non-retryable InfraErrors'` with
```ts
  it('turns tool timeouts into ToolTimeoutError (a model fail, not infra)', async () => {
    const conn = await memory(stdioSpec, { cwd: await tmp(), vars: {} });
    const err = await conn.callTool('slow', { ms: 500 }, 50).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolTimeoutError);
    expect(err).toMatchObject({ tool: 'slow', timeoutMs: 50 });
    await conn.close();
  });

  it('treats unknown transport errors as non-retryable', async () => {
    const conn = await memory(stdioSpec, { cwd: await tmp(), vars: {} });
    await conn.close();
    const err = await conn.callTool('echo', { text: 'x' }, 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toMatchObject({ kind: 'server', retryable: false, message: expect.stringMatching(/Not connected/) });
  });

  it('reports the MCP server version from initialize', async () => {
    const conn = await memory(stdioSpec, { cwd: await tmp(), vars: {} });
    expect(conn.serverVersion?.()).toBe('1.0.0');
    await conn.close();
  });
```
and add inside `describe('stdio connector', …)`:
```ts
  it('reports the server version over stdio too', async () => {
    const conn = await stdioConnector(stdioSpec, { cwd: await tmp(), vars: {} });
    expect(conn.serverVersion?.()).toBe('1.0.0');
    await conn.close();
  });
```

Append to `describe('runAgentLoop', …)` in `packages/core/src/agent/loop.test.ts`:
```ts
  it('ends with tool_timeout (a model fail, not infra) when one call exceeds the tool timeout', async () => {
    const { opts } = await setup([{ toolCalls: [{ name: 'slow', arguments: { ms: 400 } }] }, { content: 'never' }], {
      toolTimeoutMs: 50,
      timeoutMs: 5000,
    });
    const r = await runAgentLoop(opts);
    expect(r.end).toBe('tool_timeout');
    expect(r.infraError).toBeUndefined();
    expect(r.failReason).toBe('tool "slow" exceeded the 50ms tool timeout');
    expect(r.events.at(-1)).toMatchObject({ type: 'error', kind: 'tool_timeout' });
  });

  it('still ends with timeout when the run deadline, not the tool timeout, cut the call short', async () => {
    const { opts } = await setup([{ toolCalls: [{ name: 'slow', arguments: { ms: 400 } }] }, { content: 'never' }], {
      toolTimeoutMs: 60_000,
      timeoutMs: 100,
    });
    expect((await runAgentLoop(opts)).end).toBe('timeout');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/mcp packages/core/src/agent`
Expected: FAIL — timeouts are still `InfraError`s, `Not connected` is retryable, `serverVersion` is undefined, and the loop ends with `infra_error` instead of `tool_timeout`.

- [ ] **Step 3: Update the connector**

In `packages/core/src/mcp/connection.ts`:
- change line 6 to `import { InfraError, ToolTimeoutError } from '../errors.js';`
- replace the `catch` block of `callTool` (lines 39–48) with:
```ts
      } catch (e) {
        if (e instanceof McpError && e.code === ErrorCode.ConnectionClosed) {
          throw new InfraError('server', `${name}: server connection closed (crashed?): ${e.message}`, true);
        }
        if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) throw new ToolTimeoutError(name, timeoutMs);
        if (e instanceof McpError) return { text: `Error: ${e.message}`, isError: true };
        // Only a closed connection is known to be transient; anything else would most likely repeat on a retry.
        throw new InfraError('server', `${name}: ${(e as Error).message}`, false);
      }
```
- in `wrap`, add after `stderr: getStderr,`:
```ts
    serverVersion: () => client.getServerVersion()?.version,
```

- [ ] **Step 4: Update the loop**

In `packages/core/src/agent/loop.ts`:
- change line 1 to `import { InfraError, ProviderError, ToolTimeoutError } from '../errors.js';`
- replace the `catch (e) { … }` block around `o.connection.callTool(...)` (the block that starts with `if (e instanceof InfraError && (now() >= deadline || (capped && …`) with:
```ts
      } catch (e) {
        if (e instanceof ToolTimeoutError) {
          // Cut short by the run deadline: the run timed out. Otherwise the tool itself was too slow for the policy.
          if (capped || now() >= deadline) return finish('timeout', { failReason: `timed out after ${o.timeoutMs}ms` });
          events.push({ type: 'error', step: steps, t: t(), kind: 'tool_timeout', message: e.message });
          return finish('tool_timeout', { failReason: `tool "${tool}" exceeded the ${configured}ms tool timeout` });
        }
        if (now() >= deadline) return finish('timeout', { failReason: `timed out after ${o.timeoutMs}ms` });
        const infra = e instanceof InfraError ? e : new InfraError('server', e instanceof Error ? e.message : String(e), false);
        events.push({ type: 'error', step: steps, t: t(), kind: infra.kind, message: infra.message });
        return finish('infra_error', { infraError: infra, failReason: infra.message });
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: every test PASSES (including the existing `'bounds tool calls by the run deadline'`, which still ends with `timeout`); typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/mcp packages/core/src/agent
git commit -m "fix(core): tool timeouts are model fails, unknown transport errors are not retried, record server version

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Runner wiring, pre-flight building blocks, and public exports

**Files:**
- Modify: `packages/core/src/runner/run.ts` (full replacement), `packages/core/src/runner/run.test.ts`
- Modify: `packages/core/src/agent/loop.ts` (pin, servedBy, out of credits), `packages/core/src/agent/loop.test.ts`
- Create: `packages/core/src/runner/preflight.ts`, `packages/core/src/runner/preflight.test.ts`
- Modify: `packages/core/src/index.ts` (full replacement)

**Interfaces:**
- Consumes: everything from Tasks 1–7: `RunCache`-independent `skip` keys; `OutOfCreditsError`; `gradersCostUsd`, `GradeContext.judge/taskPrompt`; `JudgeConfig`; `ModelPrice`, `CatalogModel`; `Results`; `McpConnection.serverVersion`; `PlannedCell`.
- Produces:
  - `interface PlanOptions { suites: Suite[]; models?: string[]; servers?: string[]; tasks?: string[]; repeats?: number; skip?: ReadonlySet<string> }`.
  - `interface RunSuitesOptions extends PlanOptions { provider; connector; fixtures; budgetUsd?; retries?; sleep?; onRecord?: (r: RunRecord) => void | Promise<void>; now? }` — `onRecord` is awaited before the next run.
  - `type StopReason = 'budget' | 'out_of_credits'`; `RunSuitesOutput { records (this invocation only); planned (full plan); partial; stopReason: StopReason | null; totalCostUsd; startedAt; finishedAt }`.
  - `interface PlanPreview { planned: PlannedCell[]; remaining: PlannedCell[] }`; `previewPlan(o: PlanOptions): PlanPreview` (validates filters; throws `ConfigError` like `runSuites`).
  - Runner behavior: `--tasks` filter (unknown ids → `ConfigError`); skipped runKeys stay planned but never run; an all-cached plan returns no records without throwing; `{fixture}` = `realpath` of the workspace in prompts, server args/env and setup; `toolTimeoutMs = suite.defaults.toolTimeoutS * 1000`; `providerPin = suite.modelPins[model]`; `llm_judge` uses the suite judge through the same provider, its cost added to the run; `record.serverVersion`; `OutOfCreditsError` (agent or judge) stops the whole run with no record for that run and its spend counted; invalid `budgetUsd` (NaN/negative) → `ConfigError`.
  - `AgentLoopOptions.providerPin?: string`; `AgentRunResult.outOfCredits?: boolean`; `model_call` events carry `servedBy` when reported.
  - `preflight.ts`: `ASSUMED_PROMPT_TOKENS_PER_RUN = 25_000`, `ASSUMED_COMPLETION_TOKENS_PER_RUN = 1_000`; `interface ServerCheck { suite; server; tools: number; version: string | null }`; `checkServers({ suites, servers?, connector, fixtures }): Promise<ServerCheck[]>` (throws `ConfigError` starting `pre-flight: server "<name>"`); `interface ModelEstimate { model; runs; usdPerRun; basis: 'measured' | 'catalog' }`; `interface CostEstimate { runs; usd; perModel: ModelEstimate[] }`; `estimateCost({ remaining, prices: ReadonlyMap<string, ModelPrice | null>, measured?: Results }): CostEstimate`; `measuredCostPerRun(results, model): number | undefined`; `catalogIssues({ suites, planned, catalog }): string[]`.
  - `index.ts` exports every public symbol listed in Step 7.

- [ ] **Step 1: Write the failing loop tests**

In `packages/core/src/agent/loop.test.ts` change the errors import to `import { InfraError, OutOfCreditsError } from '../errors.js';`, the types import to `import type { ChatRequest, ModelProvider } from '../types.js';`, and append to `describe('runAgentLoop', …)`:
```ts
  it('passes the provider pin and records who served each call', async () => {
    const { opts } = await setup([{ content: 'unused' }]);
    const seen: ChatRequest[] = [];
    const served: ModelProvider = {
      name: 'served',
      chat: async (req) => {
        seen.push(req);
        return { content: 'done', toolCalls: [], usage: { promptTokens: 9, completionTokens: 1, costUsd: 0.001 }, latencyMs: 1, servedBy: 'Acme' };
      },
    };
    const r = await runAgentLoop({ ...opts, provider: served, providerPin: 'acme' });
    expect(seen[0]!.providerPin).toBe('acme');
    expect(r.events[0]).toMatchObject({ type: 'model_call', servedBy: 'Acme' });
  });

  it('ends like a budget stop, flagged outOfCredits, on OutOfCreditsError', async () => {
    const { opts } = await setup([{ content: 'unused' }]);
    const broke: ModelProvider = { name: 'broke', chat: () => Promise.reject(new OutOfCreditsError('OpenRouter 402: no credits')) };
    const r = await runAgentLoop({ ...opts, provider: broke });
    expect(r).toMatchObject({ end: 'budget', outOfCredits: true, failReason: 'OpenRouter 402: no credits' });
    expect(r.infraError).toBeUndefined();
  });
```

- [ ] **Step 2: Write the failing runner tests**

In `packages/core/src/runner/run.test.ts` replace the import block (lines 1–12) with:
```ts
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildFakeServer } from '../../test/fixtures/fake-server.mjs';
import { ConfigError, InfraError, OutOfCreditsError, ProviderError } from '../errors.js';
import { FixtureManager } from '../fixtures/manager.js';
import { createInMemoryConnector } from '../mcp/connection.js';
import { MockProvider, parseMockScript, type MockScript } from '../providers/mock.js';
import { parseSuite } from '../suite/load.js';
import type { ChatRequest, Connector, ModelProvider } from '../types.js';
import { runKey } from '../util.js';
import { previewPlan, runSuites, type RunSuitesOptions } from './run.js';
```
In the existing test `'stops scheduling and marks partial when the budget is spent'` add after `expect(out.partial).toBe(true);`:
```ts
    expect(out.stopReason).toBe('budget');
```
and append a new describe block at the end of the file:
```ts
function capture(script: MockScript = SCRIPT) {
  const requests: ChatRequest[] = [];
  const inner = new MockProvider(script);
  const provider: ModelProvider = { name: 'capture', chat: (req) => (requests.push(req), inner.chat(req)) };
  return { requests, provider };
}

async function localRepo(): Promise<{ git: string; ref: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'runner-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  await writeFile(join(repo, 'README.md'), 'fixture\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  return { git: repo, ref: git('rev-parse', 'HEAD') };
}

describe('runSuites (M2 wiring)', () => {
  // Review Focus 5
  it('substitutes the real workspace path for {fixture} in prompts and server args alike', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-link-'));
    const realWork = join(root, 'real-work');
    await mkdir(realWork);
    const linkWork = join(root, 'link-work');
    await symlink(realWork, linkWork);
    const repo = await localRepo();
    const suite = parseSuite(
      `
suite: paths
version: 1
fixture: { git: ${JSON.stringify(repo.git)}, ref: ${JSON.stringify(repo.ref)} }
servers:
  fake: { command: unused, args: ["{fixture}"] }
models: [mock/a]
defaults: { repeats: 1 }
tasks:
  - id: where
    prompt: "ECHO in {fixture}"
`,
      'paths.yaml',
    );
    const seen: Array<Record<string, string>> = [];
    const spy: Connector = async (server, ctx) => {
      seen.push(ctx.vars);
      return memory(server, ctx);
    };
    const { requests, provider } = capture();
    const out = await runSuites({
      ...(await opts()),
      suites: [suite],
      provider,
      connector: spy,
      fixtures: new FixtureManager({ cacheDir: join(root, 'cache'), workRoot: linkWork }),
    });
    expect(out.records).toHaveLength(1);
    const fixtureDir = seen[0]!.fixture!;
    expect(fixtureDir.startsWith(`${await realpath(realWork)}${sep}`)).toBe(true);
    expect(fixtureDir).not.toContain('link-work');
    expect(requests[0]!.messages[1]).toEqual({ role: 'user', content: `ECHO in ${fixtureDir}` });
  });

  it('filters tasks and rejects unknown or empty task filters', async () => {
    const out = await runSuites(await opts({ tasks: ['write'], repeats: 1 }));
    expect(out.records.map((r) => r.task)).toEqual(['write', 'write']);
    await expect(runSuites(await opts({ tasks: ['nope'] }))).rejects.toThrow(/Unknown task\(s\): nope/);
    await expect(runSuites(await opts({ tasks: [] }))).rejects.toThrow(/the tasks filter is empty/);
  });

  it('skips cached runKeys, keeps them in the plan, and awaits onRecord in order', async () => {
    const first = await runSuites(await opts({ repeats: 1 }));
    const keep = new Set(first.records.slice(0, 2).map((r) => r.runKey));
    const order: string[] = [];
    const out = await runSuites(
      await opts({
        repeats: 1,
        skip: keep,
        onRecord: async (r) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(r.runKey);
        },
      }),
    );
    expect(out.records).toHaveLength(2);
    expect(out.records.some((r) => keep.has(r.runKey))).toBe(false);
    expect(order).toEqual(out.records.map((r) => r.runKey));
    expect(out.planned.reduce((s, c) => s + c.runs, 0)).toBe(4);
  });

  it('returns no records, without throwing, when every planned run is cached', async () => {
    const first = await runSuites(await opts({ repeats: 1 }));
    const out = await runSuites(await opts({ repeats: 1, skip: new Set(first.records.map((r) => r.runKey)) }));
    expect(out).toMatchObject({ records: [], partial: false, stopReason: null, totalCostUsd: 0 });
  });

  it('previews planned and remaining runs per cell', () => {
    const suites = [parseSuite(SUITE, 'demo.yaml')];
    expect(previewPlan({ suites, repeats: 1 }).planned).toEqual([
      { suite: 'demo', server: 'fake', model: 'mock/a', runs: 2 },
      { suite: 'demo', server: 'fake', model: 'mock/b', runs: 2 },
    ]);
    const skip = new Set([runKey({ suite: 'demo', server: 'fake', model: 'mock/a', task: 'echo', repeat: 0 })]);
    expect(previewPlan({ suites, repeats: 1, skip }).remaining).toEqual([
      { suite: 'demo', server: 'fake', model: 'mock/b', runs: 2 },
      { suite: 'demo', server: 'fake', model: 'mock/a', runs: 1 },
    ]);
    expect(() => previewPlan({ suites, models: ['mock/typo'] })).toThrow(ConfigError);
  });

  it('stops the whole run on OutOfCreditsError: no record for that run, nothing scheduled after it', async () => {
    let calls = 0;
    const inner = new MockProvider(SCRIPT);
    const broke: ModelProvider = {
      name: 'broke',
      chat: (req) => (++calls === 3 ? Promise.reject(new OutOfCreditsError('OpenRouter 402')) : inner.chat(req)),
    };
    const out = await runSuites(await opts({ provider: broke }));
    expect(out).toMatchObject({ partial: true, stopReason: 'out_of_credits' });
    expect(calls).toBe(3);
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({ model: 'mock/a', task: 'echo', outcome: 'pass' });
    expect(out.totalCostUsd).toBeCloseTo(0.002, 9);
  });

  it('grades llm_judge with the suite judge through the same provider and adds its cost', async () => {
    const suite = parseSuite(
      `
suite: judged
version: 1
servers:
  fake: { command: unused }
models: [{ id: mock/a, provider: acme }]
judge: { id: mock/judge, provider: acme }
defaults: { repeats: 1 }
tasks:
  - id: echo
    prompt: "ECHO judged"
    graders:
      - { type: answer_contains_all, values: [hello] }
      - { type: llm_judge, rubric: "Says hello." }
`,
      'judged.yaml',
    );
    const script = parseMockScript({
      entries: [
        { match: 'ECHO', model: 'mock/a', steps: [{ toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }] }, { content: 'hello' }] },
        { match: 'Says hello.', model: 'mock/judge', steps: [{ content: '{"pass": true, "reason": "it says hello"}', usage: { costUsd: 0.0005 } }] },
      ],
    });
    const { requests, provider } = capture(script);
    const out = await runSuites({ ...(await opts()), suites: [suite], provider });
    const r = out.records[0]!;
    expect(r.outcome).toBe('pass');
    expect(r.graders.find((g) => g.type === 'llm_judge')).toMatchObject({ pass: true, costUsd: 0.0005 });
    expect(r.costUsd).toBeCloseTo(0.0025, 9);
    expect(requests.map((q) => [q.model, q.providerPin])).toEqual([
      ['mock/a', 'acme'],
      ['mock/a', 'acme'],
      ['mock/judge', 'acme'],
    ]);
  });

  it('stops the whole run when the judge reports out of credits', async () => {
    const suite = parseSuite(
      `
suite: judged
version: 1
servers:
  fake: { command: unused }
models: [mock/a]
judge: { id: mock/judge, provider: acme }
defaults: { repeats: 2 }
tasks:
  - id: echo
    prompt: "ECHO judged"
    graders: [{ type: llm_judge, rubric: "Says hello." }]
`,
      'judged.yaml',
    );
    const inner = new MockProvider(SCRIPT);
    const provider: ModelProvider = {
      name: 'judge-broke',
      chat: (req) => (req.model === 'mock/judge' ? Promise.reject(new OutOfCreditsError('402')) : inner.chat(req)),
    };
    const out = await runSuites({ ...(await opts()), suites: [suite], provider });
    expect(out).toMatchObject({ records: [], partial: true, stopReason: 'out_of_credits' });
    expect(out.totalCostUsd).toBeCloseTo(0.002, 9);
  });

  it('applies defaults.tool_timeout_s: a slow tool is a model fail (tool_timeout), not an error', async () => {
    const suite = parseSuite(
      `
suite: slow
version: 1
servers:
  fake: { command: unused }
models: [mock/a]
defaults: { repeats: 1, tool_timeout_s: 0.05, timeout_s: 10 }
tasks:
  - id: slow
    prompt: "SLOW task"
`,
      'slow.yaml',
    );
    const script = parseMockScript({ entries: [{ match: 'SLOW', steps: [{ toolCalls: [{ name: 'slow', arguments: { ms: 400 } }] }, { content: 'x' }] }] });
    const out = await runSuites({ ...(await opts()), suites: [suite], provider: new MockProvider(script) });
    expect(out.records[0]).toMatchObject({ outcome: 'fail', end: 'tool_timeout', attempts: 1 });
  });

  it('records the MCP server version on every record', async () => {
    const out = await runSuites(await opts({ models: ['mock/a'], repeats: 1 }));
    expect(out.records.every((r) => r.serverVersion === '1.0.0')).toBe(true);
  });

  it('rejects an invalid budget before running anything', async () => {
    await expect(runSuites(await opts({ budgetUsd: Number.NaN }))).rejects.toThrow(/budgetUsd/);
    await expect(runSuites(await opts({ budgetUsd: -1 }))).rejects.toThrow(/budgetUsd/);
  });
});
```

`packages/core/src/runner/preflight.test.ts`:
```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFakeServer } from '../../test/fixtures/fake-server.mjs';
import { ConfigError } from '../errors.js';
import { FixtureManager } from '../fixtures/manager.js';
import { createInMemoryConnector } from '../mcp/connection.js';
import type { CatalogModel, ModelPrice } from '../providers/openrouter.js';
import type { Results } from '../results/schema.js';
import { parseSuite } from '../suite/load.js';
import type { Connector } from '../types.js';
import { catalogIssues, checkServers, estimateCost, measuredCostPerRun } from './preflight.js';

const SUITE = `
suite: demo
version: 1
servers:
  fake: { command: unused }
  other: { command: unused, setup: "exit 3" }
models: [{ id: acme/a, provider: acme }, acme/b]
judge: { id: acme/judge, provider: acme }
tasks:
  - id: t
    prompt: "ECHO"
    graders: [{ type: llm_judge, rubric: "x" }]
`;
const suite = parseSuite(SUITE, 'demo.yaml');
const memory: Connector = createInMemoryConnector((ctx) => buildFakeServer(ctx.cwd));

async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), 'preflight-'));
  return new FixtureManager({ cacheDir: join(root, 'cache'), workRoot: join(root, 'work') });
}

describe('checkServers', () => {
  it('starts each selected server once and reports its tools and version', async () => {
    expect(await checkServers({ suites: [suite], servers: ['fake'], connector: memory, fixtures: await fixtures() })).toEqual([
      { suite: 'demo', server: 'fake', tools: 8, version: '1.0.0' },
    ]);
  });

  it('turns a server that cannot start, or whose setup fails, into a ConfigError naming it', async () => {
    const boom: Connector = () => Promise.reject(new Error('spawn exploded'));
    const err = await checkServers({ suites: [suite], servers: ['fake'], connector: boom, fixtures: await fixtures() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/^pre-flight: server "fake" \(suite demo\) failed: spawn exploded/);
    await expect(checkServers({ suites: [suite], servers: ['other'], connector: memory, fixtures: await fixtures() })).rejects.toThrow(
      /server "other".*setup command failed/s,
    );
  });
});

const prices = new Map<string, ModelPrice | null>([
  ['acme/a', { prompt: 0.000002, completion: 0.00001 }],
  ['acme/b', { prompt: 0.00000015, completion: 0.00000047 }],
  ['acme/free', null],
]);

const measured: Results = {
  schemaVersion: 2, harnessVersion: '0', runId: 'smoke', startedAt: 'a', finishedAt: 'b', partial: false, totalCostUsd: 0.012,
  suites: [{
    suite: 'demo', suiteVersion: 1, fixture: null, servers: {}, models: [], judge: null,
    cells: [
      { server: 'fake', model: 'acme/b', runs: 3, plannedRuns: 3, complete: true, successRate: 1, successCi95: [0, 1], toolAccuracy: null,
        contextTokensPerTask: { mean: 0, median: 0 }, providerPromptTokensPerTask: null, stepsPerTask: 1, latencyMsP50: 1, costUsdPerTask: 0.004, errorRate: 0, tasks: [] },
      { server: 'other', model: 'acme/b', runs: 2, plannedRuns: 2, complete: true, successRate: null, successCi95: [0, 1], toolAccuracy: null,
        contextTokensPerTask: { mean: 0, median: 0 }, providerPromptTokensPerTask: null, stepsPerTask: 0, latencyMsP50: 0, costUsdPerTask: 0, errorRate: 1, tasks: [] },
    ],
  }],
};

describe('estimateCost', () => {
  it('uses catalog prices × 25k prompt + 1k completion tokens per run', () => {
    const est = estimateCost({ remaining: [{ suite: 'demo', server: 'fake', model: 'acme/a', runs: 6 }, { suite: 'demo', server: 'other', model: 'acme/a', runs: 4 }], prices });
    expect(est.runs).toBe(10);
    expect(est.perModel).toEqual([{ model: 'acme/a', runs: 10, usdPerRun: expect.closeTo(0.06, 12), basis: 'catalog' }]);
    expect(est.usd).toBeCloseTo(0.6, 12);
  });

  it('prefers the measured cost per run of earlier results, per model, ignoring errored runs', () => {
    expect(measuredCostPerRun(measured, 'acme/b')).toBeCloseTo(0.004, 12);
    expect(measuredCostPerRun(measured, 'acme/a')).toBeUndefined();
    const est = estimateCost({
      remaining: [{ suite: 'demo', server: 'fake', model: 'acme/a', runs: 1 }, { suite: 'demo', server: 'fake', model: 'acme/b', runs: 10 }],
      prices,
      measured,
    });
    expect(est.perModel.map((m) => [m.model, m.basis])).toEqual([['acme/a', 'catalog'], ['acme/b', 'measured']]);
    expect(est.usd).toBeCloseTo(0.06 + 0.04, 12);
  });

  it('fails loudly for a model without a catalog price', () => {
    expect(() => estimateCost({ remaining: [{ suite: 'demo', server: 'fake', model: 'acme/free', runs: 1 }], prices })).toThrow(/no price for model "acme\/free"/);
  });
});

describe('catalogIssues', () => {
  const catalog = new Map<string, CatalogModel>([
    ['acme/a', { id: 'acme/a', supportsTools: true, price: null }],
    ['acme/b', { id: 'acme/b', supportsTools: false, price: null }],
  ]);
  it('flags unpinned models, models without tool support or missing from the catalog, and a missing judge', () => {
    const planned = [
      { suite: 'demo', server: 'fake', model: 'acme/a', runs: 1 },
      { suite: 'demo', server: 'fake', model: 'acme/b', runs: 1 },
    ];
    expect(catalogIssues({ suites: [suite], planned, catalog })).toEqual([
      'suite demo: model "acme/b" has no provider pin; write it as { id: acme/b, provider: <slug> }',
      'suite demo: model "acme/b" does not support tool calling on OpenRouter',
      'suite demo: judge "acme/judge" is not in the OpenRouter catalog',
    ]);
    expect(catalogIssues({ suites: [suite], planned: [planned[0]!], catalog: new Map([...catalog, ['acme/judge', { id: 'acme/judge', supportsTools: false, price: null }]]) })).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/runner packages/core/src/agent`
Expected: FAIL — `previewPlan` / `./preflight.js` missing, `stopReason` undefined, `{fixture}` not substituted in prompts, judge not wired, `outOfCredits` missing.

- [ ] **Step 4: Update the loop**

In `packages/core/src/agent/loop.ts`:
- change the errors import to `import { InfraError, OutOfCreditsError, ProviderError, ToolTimeoutError } from '../errors.js';`
- add to `AgentLoopOptions` after `model: string;`:
```ts
  /** OpenRouter provider slug for this model (suite pin). */
  providerPin?: string;
```
- add to `AgentRunResult` after `infraError?: InfraError;`:
```ts
  /** The provider reported 402: the whole run must stop. */
  outOfCredits?: boolean;
```
- replace the `o.provider.chat({ … })` argument with
```ts
        o.provider.chat({
          model: o.model,
          ...(o.providerPin !== undefined ? { providerPin: o.providerPin } : {}),
          messages,
          tools: o.tools.defs,
          temperature: o.temperature,
          signal: controller.signal,
        }),
```
- in the `catch (e)` of the model call, add right after `if (e instanceof LoopTimeout) return finish(…);`:
```ts
      if (e instanceof OutOfCreditsError) return finish('budget', { failReason: e.message, outOfCredits: true });
```
- replace the `model_call` event push with
```ts
    events.push({
      type: 'model_call', step: steps, t: t(), latencyMs: res.latencyMs,
      promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens, costUsd: res.usage.costUsd,
      ...(res.servedBy !== undefined ? { servedBy: res.servedBy } : {}),
    });
```

- [ ] **Step 5: Replace the runner**

Replace `packages/core/src/runner/run.ts` with:
```ts
import { realpath } from 'node:fs/promises';
import { runAgentLoop, type AgentRunResult } from '../agent/loop.js';
import { ConfigError, InfraError, OutOfCreditsError } from '../errors.js';
import { snapshotDir, type FixtureManager, type Workspace } from '../fixtures/manager.js';
import { describeFailures, gradersCostUsd, runGraders, taskPassed, toolSelectionOk } from '../graders.js';
import { runSetup } from '../mcp/setup.js';
import { convertTools } from '../tools/convert.js';
import type { Connector, GraderResult, McpConnection, ModelProvider, Outcome, PlannedCell, RunRecord, Suite, TaskSpec } from '../types.js';
import { runKey, sleep as realSleep, substituteVars } from '../util.js';

export interface PlanOptions {
  suites: Suite[];
  models?: string[];
  servers?: string[];
  tasks?: string[];
  repeats?: number;
  /** runKeys a resumed run already finished: they stay in the plan but are not executed. */
  skip?: ReadonlySet<string>;
}

export interface RunSuitesOptions extends PlanOptions {
  provider: ModelProvider;
  connector: Connector;
  fixtures: FixtureManager;
  /** Cap on this invocation's spend. */
  budgetUsd?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Awaited before the next run starts (so a cache append lands first). */
  onRecord?: (r: RunRecord) => void | Promise<void>;
  now?: () => Date;
}

export type StopReason = 'budget' | 'out_of_credits';

export interface RunSuitesOutput {
  /** Records produced by this invocation (not the skipped ones). */
  records: RunRecord[];
  /** Runs per suite × server × model in the full plan, in plan order. */
  planned: PlannedCell[];
  partial: boolean;
  stopReason: StopReason | null;
  totalCostUsd: number;
  startedAt: string;
  finishedAt: string;
}

export interface PlanPreview {
  planned: PlannedCell[];
  /** planned minus the skipped runKeys. */
  remaining: PlannedCell[];
}

interface RunTarget {
  suite: Suite;
  serverName: string;
  model: string;
  task: TaskSpec;
  repeat: number;
}

/** The plan a run would execute, validated exactly like runSuites validates it. */
export function previewPlan(o: PlanOptions): PlanPreview {
  const plan = validPlan(o);
  return { planned: countPlanned(plan), remaining: countPlanned(plan.filter((t) => !o.skip?.has(keyOf(t)))) };
}

export async function runSuites(o: RunSuitesOptions): Promise<RunSuitesOutput> {
  if (o.budgetUsd !== undefined && !(o.budgetUsd >= 0)) throw new ConfigError(`budgetUsd must be a non-negative number, got ${o.budgetUsd}`);
  const plan = validPlan(o);
  const todo = plan.filter((t) => !o.skip?.has(keyOf(t)));
  // Fetch every fixture up front so a bad fixture fails before any spend (and never after earlier results).
  for (const suite of new Set(todo.map((t) => t.suite))) {
    if (suite.fixture) await o.fixtures.prepare(suite.fixture);
  }

  const now = o.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const budget = o.budgetUsd ?? Number.POSITIVE_INFINITY;
  const records: RunRecord[] = [];
  let spent = 0;
  let stopReason: StopReason | null = null;

  for (const target of todo) {
    if (spent >= budget) {
      stopReason = 'budget';
      break;
    }
    const out = await runOne(o, target, (c) => spent + c >= budget);
    spent += out.costUsd;
    // A budget or out-of-credits cut-off is not a run outcome: no record, but its spend still counts.
    if (!out.record) {
      stopReason = out.stop ?? 'budget';
      break;
    }
    records.push(out.record);
    await o.onRecord?.(out.record);
  }
  return {
    records,
    planned: countPlanned(plan),
    partial: stopReason !== null,
    stopReason,
    totalCostUsd: spent,
    startedAt,
    finishedAt: now().toISOString(),
  };
}

function validPlan(o: PlanOptions): RunTarget[] {
  validateFilters(o);
  const plan = planRuns(o);
  if (plan.length === 0) throw new ConfigError(`no runs to execute: ${emptyPlanReason(o)}`);
  return plan;
}

function keyOf(t: RunTarget): string {
  return runKey({ suite: t.suite.name, server: t.serverName, model: t.model, task: t.task.id, repeat: t.repeat });
}

/** Repeat-major order (repeat → suite → task → server → model), so a budget cut-off hits every cell evenly. */
function planRuns(o: PlanOptions): RunTarget[] {
  const suites = o.suites.map((suite) => ({
    suite,
    models: o.models ? suite.models.filter((m) => o.models!.includes(m)) : suite.models,
    servers: Object.keys(suite.servers).filter((s) => !o.servers || o.servers.includes(s)),
    tasks: o.tasks ? suite.tasks.filter((t) => o.tasks!.includes(t.id)) : suite.tasks,
    repeats: o.repeats ?? suite.defaults.repeats,
  }));
  const maxRepeats = Math.max(0, ...suites.map((s) => s.repeats));
  const plan: RunTarget[] = [];
  for (let repeat = 0; repeat < maxRepeats; repeat++) {
    for (const { suite, models, servers, tasks, repeats } of suites) {
      if (repeat >= repeats) continue;
      for (const task of tasks) {
        for (const serverName of servers) {
          if (task.servers && !task.servers.includes(serverName)) continue;
          for (const model of models) plan.push({ suite, serverName, model, task, repeat });
        }
      }
    }
  }
  return plan;
}

function countPlanned(plan: RunTarget[]): PlannedCell[] {
  const cells = new Map<string, PlannedCell>();
  for (const t of plan) {
    const key = [t.suite.name, t.serverName, t.model].join('\u0000');
    const cell = cells.get(key);
    if (cell) cell.runs++;
    else cells.set(key, { suite: t.suite.name, server: t.serverName, model: t.model, runs: 1 });
  }
  return [...cells.values()];
}

function emptyPlanReason(o: PlanOptions): string {
  if (o.models && o.models.length === 0) return 'the models filter is empty';
  if (o.servers && o.servers.length === 0) return 'the servers filter is empty';
  if (o.tasks && o.tasks.length === 0) return 'the tasks filter is empty';
  if (o.repeats !== undefined && o.repeats < 1) return 'repeats must be at least 1';
  return 'no task in the given suites applies to the selected servers and models';
}

function validateFilters(o: PlanOptions): void {
  const allModels = new Set(o.suites.flatMap((s) => s.models));
  const allServers = new Set(o.suites.flatMap((s) => Object.keys(s.servers)));
  const allTasks = new Set(o.suites.flatMap((s) => s.tasks.map((t) => t.id)));
  const badModels = (o.models ?? []).filter((m) => !allModels.has(m));
  const badServers = (o.servers ?? []).filter((s) => !allServers.has(s));
  const badTasks = (o.tasks ?? []).filter((t) => !allTasks.has(t));
  if (badModels.length) throw new ConfigError(`Unknown model(s): ${badModels.join(', ')}. Suites declare: ${[...allModels].join(', ')}`);
  if (badServers.length) throw new ConfigError(`Unknown server(s): ${badServers.join(', ')}. Suites declare: ${[...allServers].join(', ')}`);
  if (badTasks.length) throw new ConfigError(`Unknown task(s): ${badTasks.join(', ')}. Suites declare: ${[...allTasks].join(', ')}`);
}

interface RunOneResult {
  /** Undefined when the run was cut off (budget or out of credits). */
  record?: RunRecord;
  costUsd: number;
  stop?: StopReason;
}

async function runOne(o: RunSuitesOptions, target: RunTarget, overBudget: (runCostUsd: number) => boolean): Promise<RunOneResult> {
  const { suite, serverName, model, task } = target;
  const server = suite.servers[serverName]!;
  const retries = o.retries ?? 3;
  const sleep = o.sleep ?? realSleep;
  const providerPin = suite.modelPins[model];
  let attempts = 0;
  let costUsd = 0;

  for (;;) {
    attempts++;
    let ws: Workspace | undefined;
    let conn: McpConnection | undefined;
    let result: AgentRunResult | undefined;
    let stderr = '';
    let serverVersion: string | undefined;
    let backoffMs = 0;
    try {
      ws = await o.fixtures.createWorkspace(suite.fixture);
      // The real path (macOS tmp is /var → /private/var), so the prompt and the server args name the same directory.
      const fixtureDir = await realpath(ws.dir);
      const vars = { fixture: fixtureDir };
      if (server.setup) await runSetup(substituteVars(server.setup, vars), fixtureDir);
      conn = await o.connector(server, { cwd: fixtureDir, vars });
      serverVersion = conn.serverVersion?.();
      let listed: Awaited<ReturnType<McpConnection['listTools']>>;
      try {
        listed = await conn.listTools();
      } catch (e) {
        if (e instanceof InfraError) throw e;
        throw new InfraError('server', `listTools failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      const unknown = unknownGraderTool(task, serverName, listed.map((t) => t.name));
      if (unknown !== undefined) {
        stderr = conn.stderr();
        const reason = `grader references unknown tool "${unknown}" on server "${serverName}"`;
        return { record: makeRecord(target, 'error', undefined, [], reason, stderr, attempts, costUsd, serverVersion), costUsd };
      }
      // Snapshot after setup and server start, so fs_state judges only the agent's changes.
      const snapshot = await snapshotDir(ws.dir);
      const tools = convertTools(listed);
      const prompt = substituteVars(task.prompt, vars);
      const priorCost = costUsd;
      result = await runAgentLoop({
        provider: o.provider,
        connection: conn,
        tools,
        model,
        ...(providerPin !== undefined ? { providerPin } : {}),
        prompt,
        maxSteps: task.maxSteps ?? suite.defaults.maxSteps,
        timeoutMs: (task.timeoutS ?? suite.defaults.timeoutS) * 1000,
        temperature: suite.defaults.temperature,
        toolTimeoutMs: suite.defaults.toolTimeoutS * 1000,
        shouldStop: (loopCost) => overBudget(priorCost + loopCost),
      });
      costUsd += result.costUsd;
      stderr = conn.stderr();
      if (result.end === 'infra_error' && result.infraError) throw result.infraError;
      if (result.end === 'budget') return { costUsd, stop: result.outOfCredits ? 'out_of_credits' : 'budget' };
      const graders = await runGraders(task.graders, {
        server: serverName,
        finalAnswer: result.finalAnswer,
        events: result.events,
        steps: result.steps,
        contextTokens: result.contextTokens,
        workspace: { dir: ws.dir, snapshot },
        taskPrompt: prompt,
        ...(suite.judge ? { judge: { provider: o.provider, model: suite.judge.id, providerPin: suite.judge.provider, sleep } } : {}),
      });
      costUsd += gradersCostUsd(graders);
      const pass = taskPassed(graders, result.end);
      const reason = pass ? undefined : result.end === 'final_answer' ? describeFailures(graders) : result.failReason;
      return { record: makeRecord(target, pass ? 'pass' : 'fail', result, graders, reason, stderr, attempts, costUsd, serverVersion), costUsd };
    } catch (e) {
      try {
        stderr = conn?.stderr() ?? stderr;
      } catch {
        // ignore
      }
      // 402 (agent or judge): stop the whole run. Spend so far counts; there is no record, as for a budget cut-off.
      if (e instanceof OutOfCreditsError) return { costUsd, stop: 'out_of_credits' };
      if (!(e instanceof InfraError)) {
        const reason = `unexpected: ${e instanceof Error ? e.message : String(e)}`;
        return { record: makeRecord(target, 'error', result, [], reason, stderr, attempts, costUsd, serverVersion), costUsd };
      }
      if (e.retryable && attempts <= retries) {
        backoffMs = 500 * 2 ** (attempts - 1);
      } else {
        return { record: makeRecord(target, 'error', result, [], `${e.kind}: ${e.message}`, stderr, attempts, costUsd, serverVersion), costUsd };
      }
    } finally {
      try {
        if (conn) await conn.close();
      } catch {
        // cleanup must never throw
      }
      try {
        if (ws) await ws.dispose();
      } catch {
        // cleanup must never throw
      }
    }
    await sleep(backoffMs);
  }
}

/** First tool named by an applicable tool_called / tool_args_match grader that the server does not expose. */
function unknownGraderTool(task: TaskSpec, serverName: string, available: string[]): string | undefined {
  for (const g of task.graders) {
    if (g.server !== undefined && g.server !== serverName) continue;
    if ((g.type === 'tool_called' || g.type === 'tool_args_match') && !available.includes(g.tool)) return g.tool;
  }
  return undefined;
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
  serverVersion: string | undefined,
): RunRecord {
  const key = keyOf(target);
  const base = { suite: target.suite.name, server: target.serverName, model: target.model, task: target.task.id, repeat: target.repeat };
  const summary = {
    outcome,
    end: result?.end ?? null,
    ...(failReason ? { failReason } : {}),
    graders,
    attempts,
    costUsd,
    steps: result?.steps ?? 0,
    contextTokens: result?.contextTokens ?? 0,
    latencyMs: result?.latencyMs ?? 0,
  };
  return {
    runKey: key,
    ...base,
    ...summary,
    ...(serverVersion !== undefined ? { serverVersion } : {}),
    toolSelectionOk: outcome === 'error' ? null : toolSelectionOk(graders, result?.end ?? null),
    trace: { runKey: key, ...base, ...summary, events: result?.events ?? [], serverStderr },
  };
}
```

- [ ] **Step 6: Write the pre-flight building blocks**

`packages/core/src/runner/preflight.ts`:
```ts
import { realpath } from 'node:fs/promises';
import { ConfigError } from '../errors.js';
import type { FixtureManager, Workspace } from '../fixtures/manager.js';
import { runSetup } from '../mcp/setup.js';
import type { CatalogModel, ModelPrice } from '../providers/openrouter.js';
import type { Results } from '../results/schema.js';
import type { Connector, McpConnection, PlannedCell, Suite } from '../types.js';
import { substituteVars } from '../util.js';

/** Fallback cost model when no measured run exists (spec §3.6). */
export const ASSUMED_PROMPT_TOKENS_PER_RUN = 25_000;
export const ASSUMED_COMPLETION_TOKENS_PER_RUN = 1_000;

export interface ServerCheck {
  suite: string;
  server: string;
  tools: number;
  version: string | null;
}

/** Starts every selected server once, in a fresh workspace after its setup, and lists its tools. */
export async function checkServers(o: { suites: Suite[]; servers?: string[]; connector: Connector; fixtures: FixtureManager }): Promise<ServerCheck[]> {
  const checks: ServerCheck[] = [];
  for (const suite of o.suites) {
    for (const [name, server] of Object.entries(suite.servers)) {
      if (o.servers && !o.servers.includes(name)) continue;
      let ws: Workspace | undefined;
      let conn: McpConnection | undefined;
      try {
        ws = await o.fixtures.createWorkspace(suite.fixture);
        const dir = await realpath(ws.dir);
        const vars = { fixture: dir };
        if (server.setup) await runSetup(substituteVars(server.setup, vars), dir);
        conn = await o.connector(server, { cwd: dir, vars });
        const tools = await conn.listTools();
        checks.push({ suite: suite.name, server: name, tools: tools.length, version: conn.serverVersion?.() ?? null });
      } catch (e) {
        const stderr = conn?.stderr() ?? '';
        const message = e instanceof Error ? e.message : String(e);
        throw new ConfigError(`pre-flight: server "${name}" (suite ${suite.name}) failed: ${message}${stderr ? `\n${stderr.slice(-2000)}` : ''}`);
      } finally {
        await conn?.close().catch(() => {});
        await ws?.dispose().catch(() => {});
      }
    }
  }
  return checks;
}

export interface ModelEstimate {
  model: string;
  runs: number;
  usdPerRun: number;
  basis: 'measured' | 'catalog';
}

export interface CostEstimate {
  runs: number;
  usd: number;
  perModel: ModelEstimate[];
}

/** Measured cost per run (e.g. the smoke run's) for `model`, weighted by completed runs; undefined when none. */
export function measuredCostPerRun(results: Results, model: string): number | undefined {
  let usd = 0;
  let n = 0;
  for (const s of results.suites) {
    for (const c of s.cells) {
      if (c.model !== model) continue;
      const completed = Math.round(c.runs * (1 - c.errorRate));
      usd += c.costUsdPerTask * completed;
      n += completed;
    }
  }
  return n > 0 ? usd / n : undefined;
}

/** Cost of the remaining runs: measured cost per run where known, else catalog price × assumed tokens. */
export function estimateCost(o: { remaining: PlannedCell[]; prices: ReadonlyMap<string, ModelPrice | null>; measured?: Results }): CostEstimate {
  const runsByModel = new Map<string, number>();
  for (const c of o.remaining) runsByModel.set(c.model, (runsByModel.get(c.model) ?? 0) + c.runs);
  const perModel: ModelEstimate[] = [];
  for (const [model, runs] of runsByModel) {
    const measured = o.measured ? measuredCostPerRun(o.measured, model) : undefined;
    if (measured !== undefined) {
      perModel.push({ model, runs, usdPerRun: measured, basis: 'measured' });
      continue;
    }
    const price = o.prices.get(model);
    if (!price) throw new ConfigError(`no price for model "${model}" in the OpenRouter catalog; cannot estimate the cost`);
    const usdPerRun = ASSUMED_PROMPT_TOKENS_PER_RUN * price.prompt + ASSUMED_COMPLETION_TOKENS_PER_RUN * price.completion;
    perModel.push({ model, runs, usdPerRun, basis: 'catalog' });
  }
  return {
    runs: perModel.reduce((s, m) => s + m.runs, 0),
    usd: perModel.reduce((s, m) => s + m.runs * m.usdPerRun, 0),
    perModel,
  };
}

/** Everything that would make an OpenRouter run fail: unpinned models, models missing or without tools, a missing judge. */
export function catalogIssues(o: { suites: Suite[]; planned: PlannedCell[]; catalog: ReadonlyMap<string, CatalogModel> }): string[] {
  const issues: string[] = [];
  for (const suite of o.suites) {
    const models = [...new Set(o.planned.filter((p) => p.suite === suite.name).map((p) => p.model))];
    if (models.length === 0) continue;
    for (const model of models) {
      if (suite.modelPins[model] === undefined) {
        issues.push(`suite ${suite.name}: model "${model}" has no provider pin; write it as { id: ${model}, provider: <slug> }`);
      }
      const entry = o.catalog.get(model);
      if (!entry) issues.push(`suite ${suite.name}: model "${model}" is not in the OpenRouter catalog`);
      else if (!entry.supportsTools) issues.push(`suite ${suite.name}: model "${model}" does not support tool calling on OpenRouter`);
    }
    const judged = suite.tasks.some((t) => t.graders.some((g) => g.type === 'llm_judge'));
    if (judged && suite.judge && !o.catalog.has(suite.judge.id)) issues.push(`suite ${suite.name}: judge "${suite.judge.id}" is not in the OpenRouter catalog`);
  }
  return issues;
}
```

- [ ] **Step 7: Export the public API**

Replace `packages/core/src/index.ts` with:
```ts
export * from './types.js';
export * from './errors.js';
export * from './util.js';
export { countTokens, TOKENIZER } from './tokens.js';
export { loadSuite, parseSuite, SuiteError } from './suite/load.js';
export { runGraders, taskPassed, toolSelectionOk, describeFailures, gradersCostUsd, type GradeContext } from './graders.js';
export { extractJson, validateJson, JsonSchemaSchema, type ExtractResult } from './grading/json-schema.js';
export { runJudge, judgePrompt, JUDGE_SYSTEM_PROMPT, type JudgeConfig, type JudgeInput, type JudgeVerdict } from './grading/judge.js';
export { wilson } from './results/wilson.js';
export { ResultsSchema, ResultsV1Schema, type Results, type ResultsV1 } from './results/schema.js';
export { readResults } from './results/read.js';
export { aggregate, type AggregateInput } from './results/aggregate.js';
export { convertTools, sanitizeToolName, type ToolMapping } from './tools/convert.js';
export { MockProvider, parseMockScript, loadMockScript, DEFAULT_MOCK_COST_USD, type MockScript } from './providers/mock.js';
export {
  OpenRouterProvider,
  fetchModelCatalog,
  OPENROUTER_BASE_URL,
  type OpenRouterOptions,
  type CatalogModel,
  type ModelPrice,
} from './providers/openrouter.js';
export { FixtureManager, snapshotDir, type Workspace, type FixtureManagerOptions } from './fixtures/manager.js';
export { stdioConnector, createInMemoryConnector, contentToText } from './mcp/connection.js';
export { runSetup } from './mcp/setup.js';
export { runAgentLoop, SYSTEM_PROMPT, DEFAULT_TOOL_TIMEOUT_MS, type AgentLoopOptions, type AgentRunResult } from './agent/loop.js';
export {
  runSuites,
  previewPlan,
  type PlanOptions,
  type PlanPreview,
  type RunSuitesOptions,
  type RunSuitesOutput,
  type StopReason,
} from './runner/run.js';
export { RunCache, identityOf, suiteHash, DEFAULT_RUNS_DIR, type RunIdentity, type RunManifest } from './runner/cache.js';
export {
  checkServers,
  estimateCost,
  measuredCostPerRun,
  catalogIssues,
  ASSUMED_PROMPT_TOKENS_PER_RUN,
  ASSUMED_COMPLETION_TOKENS_PER_RUN,
  type ServerCheck,
  type ModelEstimate,
  type CostEstimate,
} from './runner/preflight.js';
```

- [ ] **Step 8: Run all tests, typecheck, and build**

Run: `pnpm test && pnpm typecheck && pnpm --filter @mcp-evals/core build`
Expected: every test PASSES (the CLI still uses the old `runSuites` options, which remain compatible); typecheck exits 0; `packages/core/dist/index.d.ts` exports `previewPlan`, `OpenRouterProvider`, `RunCache`.

- [ ] **Step 9: Commit**

```bash
git add packages/core
git commit -m "feat(core): wire pins, judge, tool timeouts, resume skips and out-of-credits stops into the runner; pre-flight helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: CLI wiring — OpenRouter by default, pre-flight, `--resume`, `.env`, atomic writes, exit 2 on usage errors

**Files:**
- Create: `packages/cli/src/program.ts`, `packages/cli/src/program.test.ts`
- Create: `packages/cli/src/env.ts`, `packages/cli/src/env.test.ts`
- Create: `packages/cli/src/commands/preflight.ts`
- Modify: `packages/cli/src/index.ts` (full replacement), `packages/cli/src/commands/run.ts` (full replacement), `packages/cli/src/commands/run.test.ts` (full replacement)

**Interfaces:**
- Consumes: `previewPlan`, `runSuites` (with `tasks`, `skip`, async `onRecord`, `stopReason`), `RunCache`, `identityOf`, `DEFAULT_RUNS_DIR`, `OpenRouterProvider`, `fetchModelCatalog`, `checkServers`, `estimateCost`, `catalogIssues`, `aggregate` (with `planned`), `ResultsSchema` (Tasks 2–8); `compareCommand`, `reportCommand`, `readResultsFile`, `writeFileAtomic`, `fsReason`, `formatTable`, `usd` (Task 6); `startFakeOpenRouter`, `completion`, `toolCall` (Task 3, tests only).
- Produces:
  - `interface RunCommandOptions { suites; provider: string; mockScript?; models?; servers?; tasks?; repeats?; budgetUsd?; resume?: string; yes?: boolean; estimateFrom?: string; out; traces?; cacheDir; runsDir?: string; retries?; connector?; log?; env?: Record<string, string | undefined>; openRouterBaseUrl?: string; now?: () => Date }`; `runCommand(o): Promise<{ exitCode: number; results?: Results; runId?: string }>`.
  - `openRouterPreflight(i: PreflightInput): Promise<OpenRouterProvider>` — key → catalog → pins/tools/judge → each server starts once → estimate printed → abort (`ConfigError`) when the estimate exceeds `--budget-usd` unless `--yes`.
  - `loadDotEnv(path = '.env', load = Node's process.loadEnvFile | null): 'loaded' | 'missing' | 'unsupported'`.
  - `interface ProgramDeps { run; compare; report; writeOut; writeErr }`; `main(argv: string[], deps?: ProgramDeps): Promise<number>` — returns the command's exit code; any commander usage error returns 2; `--help`/`--version` return 0.
  - CLI: `run <suites...> [--provider openrouter|mock (default openrouter)] [--mock-script] [--models] [--servers] [--tasks] [--repeats] [--budget-usd] [--resume <runId>] [--yes] [--estimate-from <results.json>] [--out results.json] [--traces] [--cache-dir .mcp-evals/cache] [--runs-dir .mcp-evals/runs]`; `compare <base> <head> [--max-success-drop 5] [--max-context-increase 20] [--format table|markdown|json]`; `report <results> [--format table|markdown]`. Task 12 adds `publish`.

- [ ] **Step 1: Write the failing tests**

`packages/cli/src/env.test.ts`:
```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDotEnv } from './env.js';

describe('loadDotEnv', () => {
  it('loads .env without overriding variables already set in the environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'env-'));
    const path = join(dir, '.env');
    await writeFile(path, 'MCP_EVALS_TEST_A=from-file\nMCP_EVALS_TEST_B=from-file\n');
    process.env.MCP_EVALS_TEST_A = 'from-shell';
    try {
      expect(loadDotEnv(path)).toBe('loaded');
      expect(process.env.MCP_EVALS_TEST_A).toBe('from-shell');
      expect(process.env.MCP_EVALS_TEST_B).toBe('from-file');
    } finally {
      delete process.env.MCP_EVALS_TEST_A;
      delete process.env.MCP_EVALS_TEST_B;
    }
  });

  it('reports a missing file, and a Node without process.loadEnvFile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'env-'));
    expect(loadDotEnv(join(dir, '.env'))).toBe('missing');
    await writeFile(join(dir, '.env'), 'X=1\n');
    expect(loadDotEnv(join(dir, '.env'), null)).toBe('unsupported');
  });
});
```

`packages/cli/src/program.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { main, type ProgramDeps } from './program.js';

function stub() {
  const calls: Array<[string, unknown]> = [];
  const err: string[] = [];
  const deps: ProgramDeps = {
    run: async (o) => (calls.push(['run', o]), { exitCode: 0 }),
    compare: async (o) => (calls.push(['compare', o]), { exitCode: 1 }),
    report: async (o) => (calls.push(['report', o]), { exitCode: 0 }),
    writeOut: () => {},
    writeErr: (s) => {
      err.push(s);
    },
  };
  return { calls, err, deps };
}

describe('main', () => {
  it('defaults run to the openrouter provider and the standard paths', async () => {
    const { calls, deps } = stub();
    expect(await main(['run', 'a.yaml'], deps)).toBe(0);
    expect(calls).toEqual([['run', { suites: ['a.yaml'], provider: 'openrouter', out: 'results.json', cacheDir: '.mcp-evals/cache', runsDir: '.mcp-evals/runs' }]]);
  });

  it('parses every run flag', async () => {
    const { calls, deps } = stub();
    const argv = [
      'run', 'a.yaml', 'b.yaml', '--provider', 'mock', '--mock-script', 'm.json', '--models', 'x/a, x/b', '--servers', 'fs', '--tasks', 't1,t2',
      '--repeats', '2', '--budget-usd', '9.5', '--resume', 'r1', '--yes', '--estimate-from', 'smoke.json', '--out', 'o.json', '--traces', 't.jsonl',
    ];
    expect(await main(argv, deps)).toBe(0);
    expect(calls[0]![1]).toEqual({
      suites: ['a.yaml', 'b.yaml'], provider: 'mock', mockScript: 'm.json', models: ['x/a', 'x/b'], servers: ['fs'], tasks: ['t1', 't2'],
      repeats: 2, budgetUsd: 9.5, resume: 'r1', yes: true, estimateFrom: 'smoke.json', out: 'o.json', traces: 't.jsonl',
      cacheDir: '.mcp-evals/cache', runsDir: '.mcp-evals/runs',
    });
  });

  it('returns the command exit code (compare regression → 1) with compare defaults', async () => {
    const { calls, deps } = stub();
    expect(await main(['compare', 'a.json', 'b.json'], deps)).toBe(1);
    expect(calls[0]).toEqual(['compare', { base: 'a.json', head: 'b.json', maxSuccessDrop: 5, maxContextIncrease: 20, format: 'table' }]);
    expect(await main(['report', 'r.json', '--format', 'markdown'], deps)).toBe(0);
    expect(calls[1]).toEqual(['report', { results: 'r.json', format: 'markdown' }]);
  });

  it('exits 2 on every usage error without running anything', async () => {
    const cases = [
      ['run', 'a.yaml', '--repeats', '0'],
      ['run', 'a.yaml', '--budget-usd', 'lots'],
      ['run'],
      ['run', 'a.yaml', '--provider', 'nope'],
      ['run', 'a.yaml', '--bogus'],
      ['compare', 'a.json'],
      ['compare', 'a.json', 'b.json', '--format', 'xml'],
      ['compare', 'a.json', 'b.json', '--max-success-drop', 'abc'],
      ['report', 'r.json', '--format', 'json'],
      ['bogus'],
      [],
    ];
    for (const argv of cases) {
      const { calls, err, deps } = stub();
      expect(await main(argv, deps)).toBe(2);
      expect(calls).toEqual([]);
      expect(err.join('')).not.toBe('');
    }
  });

  it('exits 0 for --help and --version', async () => {
    expect(await main(['--help'], stub().deps)).toBe(0);
    expect(await main(['--version'], stub().deps)).toBe(0);
  });
});
```

Replace `packages/cli/src/commands/run.test.ts` with:
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResultsSchema } from '@mcp-evals/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completion,
  startFakeOpenRouter,
  toolCall,
  type FakeOpenRouter,
  type FakeOpenRouterOptions,
  type FakeReply,
} from '../../../core/test/fixtures/fake-openrouter.js';
import { runCommand, type RunCommandOptions } from './run.js';

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

const base = (dir: string, lines: string[]) => ({
  out: join(dir, 'r.json'), cacheDir: join(dir, 'c'), runsDir: join(dir, 'runs'), retries: 0, env: {}, log: (l: string) => lines.push(l),
});

describe('runCommand (end-to-end over stdio, mock model)', () => {
  it('runs, writes valid results and traces, and prints a table', async () => {
    const { dir, suite, script } = await workspace();
    const lines: string[] = [];
    const { exitCode, results, runId } = await runCommand({
      ...base(dir, lines), suites: [suite], provider: 'mock', mockScript: script,
      out: join(dir, 'out', 'results.json'), traces: join(dir, 'traces.jsonl'),
    });
    expect(exitCode).toBe(0);
    const written = ResultsSchema.parse(JSON.parse(await readFile(join(dir, 'out', 'results.json'), 'utf8')));
    expect(written).toEqual(results);
    const cell = written.suites[0]!.cells[0]!;
    expect(cell).toMatchObject({ runs: 4, plannedRuns: 4, complete: true });
    expect(cell.tasks).toEqual([
      expect.objectContaining({ id: 'echo', passes: 2, fails: 0, errors: 0 }),
      // a crashing server is an error, never a model fail
      expect.objectContaining({ id: 'crash', passes: 0, fails: 0, errors: 2 }),
    ]);
    expect(cell.errorRate).toBe(0.5);
    expect(written.suites[0]!.servers.fake!.version).toBe('1.0.0');
    const traces = (await readFile(join(dir, 'traces.jsonl'), 'utf8')).trim().split('\n');
    expect(traces).toHaveLength(4);
    expect(JSON.parse(traces[0]!)).toMatchObject({ outcome: 'pass', end: 'final_answer', attempts: 1 });
    const crashTrace = traces.map((l) => JSON.parse(l)).find((t) => t.task === 'crash');
    expect(crashTrace).toMatchObject({ outcome: 'error', end: 'infra_error', failReason: expect.stringMatching(/server/) });
    expect(lines.some((l) => l.startsWith('SUITE'))).toBe(true);
    expect(lines[0]).toBe(`run ${runId}: 4 run(s) to execute`);
    expect(existsSync(join(dir, 'runs', `${runId}.jsonl`))).toBe(true);
  });

  it('exits 2 with a clear message for invalid suites and bad flags', async () => {
    const { dir, suite, script } = await workspace();
    const bad = join(dir, 'bad.yaml');
    await writeFile(bad, 'suite: x\nversion: 1\n');
    const lines: string[] = [];
    const b = base(dir, lines);
    expect((await runCommand({ ...b, suites: [bad], provider: 'mock', mockScript: script })).exitCode).toBe(2);
    expect((await runCommand({ ...b, suites: [suite], provider: 'openrouter' })).exitCode).toBe(2);
    expect((await runCommand({ ...b, suites: [suite], provider: 'mock' })).exitCode).toBe(2);
    expect((await runCommand({ ...b, suites: [suite], provider: 'mock', mockScript: script, models: ['mock/typo'] })).exitCode).toBe(2);
    expect((await runCommand({ ...b, suites: [suite], provider: 'gpt' })).exitCode).toBe(2);
    expect(lines.filter((l) => l.startsWith('error: '))).toHaveLength(5);
    expect(lines).toHaveLength(5);
    expect(existsSync(join(dir, 'r.json'))).toBe(false);
    expect(existsSync(join(dir, 'runs'))).toBe(false);
  });

  it('exits 2 when filters leave nothing to run', async () => {
    const { dir, suite, script } = await workspace();
    const lines: string[] = [];
    expect((await runCommand({ ...base(dir, lines), suites: [suite], provider: 'mock', mockScript: script, models: [] })).exitCode).toBe(2);
    expect(lines).toEqual([expect.stringMatching(/^error: no runs to execute/)]);
  });

  it('exits 2, before any run, when a later suite has a bad fixture', async () => {
    const { dir, suite, script } = await workspace();
    const second = join(dir, 'second.yaml');
    await writeFile(
      second,
      (await readFile(suite, 'utf8')).replace('suite: e2e', 'suite: second\nfixture: { git: "/definitely/not/a/repo.git", ref: abc1234 }'),
    );
    const lines: string[] = [];
    const res = await runCommand({ ...base(dir, lines), suites: [suite, second], provider: 'mock', mockScript: script, traces: join(dir, 't.jsonl') });
    expect(res.exitCode).toBe(2);
    expect(lines).toEqual([expect.stringMatching(/^error: failed to fetch fixture \/definitely\/not\/a\/repo\.git@abc1234/)]);
    expect(existsSync(join(dir, 'r.json'))).toBe(false);
    expect(existsSync(join(dir, 't.jsonl'))).toBe(false);
    expect(existsSync(join(dir, 'runs'))).toBe(false);
  });

  it('exits 2 naming the file for missing or invalid suite and mock-script files', async () => {
    const { dir, suite, script } = await workspace();
    const lines: string[] = [];
    const b = base(dir, lines);
    const missingSuite = join(dir, 'missing.yaml');
    const missingScript = join(dir, 'missing.json');
    const badJson = join(dir, 'bad.json');
    await writeFile(badJson, '{not json');
    const badShape = join(dir, 'shape.json');
    await writeFile(badShape, JSON.stringify({ entries: [{ match: 'X', steps: [] }] }));
    const cases: [RunCommandOptions, string][] = [
      [{ ...b, suites: [missingSuite], provider: 'mock', mockScript: script }, missingSuite],
      [{ ...b, suites: [suite], provider: 'mock', mockScript: missingScript }, missingScript],
      [{ ...b, suites: [suite], provider: 'mock', mockScript: badJson }, badJson],
      [{ ...b, suites: [suite], provider: 'mock', mockScript: badShape }, badShape],
    ];
    for (const [opts, path] of cases) {
      lines.length = 0;
      expect((await runCommand(opts)).exitCode).toBe(2);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^error: /);
      expect(lines[0]).toContain(path);
      expect(lines[0]).not.toMatch(/\n\s+at /);
    }
    expect(existsSync(join(dir, 'r.json'))).toBe(false);
  });
});

// ---- OpenRouter path, against the local fake OpenRouter server -------------------------

const LIVE_SUITE = [
  'suite: live',
  'version: 1',
  'servers:',
  `  fake: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE)}] }`,
  'models: [{ id: acme/model-a, provider: acme }]',
  'judge: { id: acme/judge, provider: acme }',
  'defaults: { repeats: 2, max_steps: 4, timeout_s: 20 }',
  'tasks:',
  '  - id: echo',
  '    prompt: "ECHO please"',
  '    graders:',
  '      - { type: answer_contains_all, values: [hello] }',
  '      - { type: llm_judge, rubric: "Says hello." }',
].join('\n');

/** Agent: call echo, then answer "hello" ($0.001 per call). Judge: pass ($0.0001). So $0.0021 per run. */
function script(body: any): FakeReply {
  if (body.model === 'acme/judge') {
    return { json: completion({ content: '{"pass": true, "reason": "ok"}' }, { prompt_tokens: 50, completion_tokens: 5, cost: 0.0001 }) };
  }
  const last = body.messages.at(-1);
  return last.role === 'tool'
    ? { json: completion({ content: 'hello' }, { prompt_tokens: 200, completion_tokens: 5, cost: 0.001 }) }
    : { json: completion({ tool_calls: [toolCall('c1', 'echo', { text: 'hello' })] }, { prompt_tokens: 100, completion_tokens: 5, cost: 0.001 }) };
}

let fake: FakeOpenRouter | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function liveSetup(o: FakeOpenRouterOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-live-'));
  const suite = join(dir, 'live.yaml');
  await writeFile(suite, LIVE_SUITE);
  const f = await startFakeOpenRouter({ respond: script, ...o });
  fake = f;
  const lines: string[] = [];
  const opts: RunCommandOptions = {
    suites: [suite], provider: 'openrouter', env: { OPENROUTER_API_KEY: 'sk-test-key' }, openRouterBaseUrl: f.baseUrl,
    out: join(dir, 'results.json'), traces: join(dir, 'traces.jsonl'), cacheDir: join(dir, 'cache'), runsDir: join(dir, 'runs'),
    retries: 0, log: (l) => lines.push(l),
  };
  return { dir, suite, lines, opts, fake: f };
}

describe('runCommand --provider openrouter (fake OpenRouter, stdio fake server)', () => {
  it('pre-flights, runs, judges, and writes v2 results with pins, versions and costs', async () => {
    const { opts, lines, fake } = await liveSetup();
    const { exitCode, results, runId } = await runCommand(opts);
    expect(exitCode).toBe(0);
    const s = results!.suites[0]!;
    expect(s.models).toEqual([{ id: 'acme/model-a', provider: 'acme' }]);
    expect(s.judge).toEqual({ id: 'acme/judge', provider: 'acme' });
    expect(s.servers.fake!.version).toBe('1.0.0');
    expect(s.cells[0]).toMatchObject({ runs: 2, plannedRuns: 2, complete: true, successRate: 1 });
    expect(results!.partial).toBe(false);
    expect(results!.totalCostUsd).toBeCloseTo(2 * 0.0021, 9);
    const chats = fake.chatRequests();
    expect(chats).toHaveLength(6);
    expect(chats.every((r) => r.body.provider.order[0] === 'acme' && r.body.provider.allow_fallbacks === false)).toBe(true);
    expect(lines).toContain('  live/fake: 9 tools, version 1.0.0');
    expect(lines.some((l) => /^plan: 2 run\(s\), 2 to execute; estimated cost \$0\.0540$/.test(l))).toBe(true);
    expect(existsSync(join(opts.runsDir!, `${runId}.jsonl`))).toBe(true);
    for (const path of [opts.out, opts.traces!, join(opts.runsDir!, `${runId}.jsonl`), join(opts.runsDir!, `${runId}.manifest.json`)]) {
      expect(await readFile(path, 'utf8')).not.toContain('sk-test-key');
    }
    expect(lines.join('\n')).not.toContain('sk-test-key');
  });

  it('exits 2 before any request when OPENROUTER_API_KEY is missing', async () => {
    const { opts, lines, fake } = await liveSetup();
    expect((await runCommand({ ...opts, env: {} })).exitCode).toBe(2);
    expect(lines).toEqual([expect.stringMatching(/^error: OPENROUTER_API_KEY is not set\. Copy \.env\.example to \.env/)]);
    expect(fake.requests).toHaveLength(0);
    expect(existsSync(opts.out)).toBe(false);
    expect(existsSync(opts.runsDir!)).toBe(false);
  });

  it('exits 2 when a model is missing from the catalog', async () => {
    const { opts, lines, fake } = await liveSetup({ models: [{ id: 'acme/judge', supported_parameters: [], pricing: { prompt: '0', completion: '0' } }] });
    expect((await runCommand(opts)).exitCode).toBe(2);
    expect(lines.at(-1)).toMatch(/model "acme\/model-a" is not in the OpenRouter catalog/);
    expect(fake.chatRequests()).toHaveLength(0);
  });

  it('exits 2 when a model has no tool support', async () => {
    const { opts, lines } = await liveSetup({
      models: [
        { id: 'acme/model-a', supported_parameters: ['temperature'], pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'acme/judge', supported_parameters: [], pricing: { prompt: '0', completion: '0' } },
      ],
    });
    expect((await runCommand(opts)).exitCode).toBe(2);
    expect(lines.at(-1)).toMatch(/does not support tool calling/);
  });

  it('exits 2 when a model has no provider pin', async () => {
    const { opts, lines, suite } = await liveSetup();
    await writeFile(suite, LIVE_SUITE.replace('models: [{ id: acme/model-a, provider: acme }]', 'models: [acme/model-a]'));
    expect((await runCommand(opts)).exitCode).toBe(2);
    expect(lines.at(-1)).toMatch(/model "acme\/model-a" has no provider pin/);
  });

  it('aborts when the estimate exceeds --budget-usd, unless --yes', async () => {
    const { opts, lines, fake } = await liveSetup();
    // catalog: 25k × $0.000001 + 1k × $0.000002 = $0.027 per run, 2 runs → $0.054
    expect((await runCommand({ ...opts, budgetUsd: 0.05 })).exitCode).toBe(2);
    expect(lines.at(-1)).toMatch(/^error: estimated cost \$0\.0540 exceeds --budget-usd \$0\.0500/);
    expect(fake.chatRequests()).toHaveLength(0);
    expect((await runCommand({ ...opts, budgetUsd: 0.05, yes: true })).exitCode).toBe(0);
  });

  it('estimates from measured cost per run with --estimate-from', async () => {
    const { opts, lines } = await liveSetup();
    expect((await runCommand(opts)).exitCode).toBe(0);
    lines.length = 0;
    const second = await runCommand({ ...opts, out: join(dirname(opts.out), 'r2.json'), estimateFrom: opts.out, budgetUsd: 0.01 });
    expect(second.exitCode).toBe(0);
    expect(lines).toContain('  acme/model-a: 2 run(s) × $0.0021 (measured)');
  });

  it('stops on 402 with partial results, then --resume finishes without re-running finished runs', async () => {
    let n = 0;
    const credits: FakeReply = { status: 402, json: { error: { code: 402, message: 'Insufficient credits' } } };
    const { opts, lines, fake } = await liveSetup({ respond: (body) => (++n === 4 ? credits : script(body)) });
    const first = await runCommand(opts);
    expect(first.exitCode).toBe(0);
    expect(first.results!.partial).toBe(true);
    expect(first.results!.suites[0]!.cells[0]).toMatchObject({ runs: 1, plannedRuns: 2, complete: false });
    expect(lines.some((l) => l.startsWith('STOPPED: OpenRouter reports the key is out of credits'))).toBe(true);
    expect(lines.some((l) => l.includes(`--resume ${first.runId}`))).toBe(true);

    const before = fake.chatRequests().length;
    const second = await runCommand({ ...opts, resume: first.runId! });
    expect(second.exitCode).toBe(0);
    expect(second.runId).toBe(first.runId);
    expect(fake.chatRequests().length - before).toBe(3);
    expect(second.results).toMatchObject({ partial: false, runId: first.runId });
    expect(second.results!.suites[0]!.cells[0]).toMatchObject({ runs: 2, plannedRuns: 2, complete: true });
    expect(second.results!.totalCostUsd).toBeCloseTo(2 * 0.0021, 9);
    expect((await readFile(opts.traces!, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('refuses to resume when the suite changed, or when the run id is unknown', async () => {
    const { opts, lines, suite } = await liveSetup();
    const first = await runCommand(opts);
    await writeFile(suite, LIVE_SUITE.replace('ECHO please', 'ECHO please now'));
    expect((await runCommand({ ...opts, resume: first.runId! })).exitCode).toBe(2);
    expect(lines.at(-1)).toMatch(/cannot resume run .*: the configuration changed/);
    expect((await runCommand({ ...opts, resume: 'no-such-run' })).exitCode).toBe(2);
    expect(lines.at(-1)).toMatch(/no cached run "no-such-run"/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/cli`
Expected: FAIL — `Cannot find module './program.js'` / `'./env.js'`; `runCommand` rejects `openrouter`, ignores `runsDir`, and prints no `run …` line.

- [ ] **Step 3: Write `env.ts`**

`packages/cli/src/env.ts`:
```ts
import { existsSync } from 'node:fs';

export type DotEnvStatus = 'loaded' | 'missing' | 'unsupported';
type Loader = (path: string) => void;

function nodeLoader(): Loader | null {
  return typeof process.loadEnvFile === 'function' ? (path) => process.loadEnvFile(path) : null;
}

/** Loads `.env` with Node's built-in loader. Variables already set in the environment win (Node never overrides them). */
export function loadDotEnv(path = '.env', load: Loader | null = nodeLoader()): DotEnvStatus {
  if (!existsSync(path)) return 'missing';
  if (load === null) return 'unsupported';
  load(path);
  return 'loaded';
}
```

- [ ] **Step 4: Write the OpenRouter pre-flight**

`packages/cli/src/commands/preflight.ts`:
```ts
import {
  catalogIssues,
  checkServers,
  ConfigError,
  estimateCost,
  fetchModelCatalog,
  OpenRouterProvider,
  type CatalogModel,
  type Connector,
  type FixtureManager,
  type ModelPrice,
  type PlanPreview,
  type Suite,
} from '@mcp-evals/core';
import { readResultsFile } from '../files.js';
import { usd } from '../report/table.js';

export interface PreflightInput {
  suites: Suite[];
  servers?: string[];
  plan: PlanPreview;
  fixtures: FixtureManager;
  connector: Connector;
  env: Record<string, string | undefined>;
  baseUrl?: string;
  budgetUsd?: number;
  yes?: boolean;
  estimateFrom?: string;
  log: (line: string) => void;
}

/** Everything that must hold before an OpenRouter run spends money. Throws ConfigError (exit 2) otherwise. */
export async function openRouterPreflight(i: PreflightInput): Promise<OpenRouterProvider> {
  const apiKey = i.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError('OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key, or export OPENROUTER_API_KEY in your shell.');
  }
  const endpoint = { apiKey, ...(i.baseUrl ? { baseUrl: i.baseUrl } : {}) };
  let catalog: Map<string, CatalogModel>;
  try {
    catalog = await fetchModelCatalog(endpoint);
  } catch (e) {
    throw new ConfigError(`pre-flight: cannot fetch the OpenRouter model catalog: ${e instanceof Error ? e.message : String(e)}`);
  }
  const issues = catalogIssues({ suites: i.suites, planned: i.plan.planned, catalog });
  if (issues.length > 0) throw new ConfigError(`pre-flight failed:\n  - ${issues.join('\n  - ')}`);

  i.log('pre-flight: starting each server once');
  const checks = await checkServers({ suites: i.suites, ...(i.servers ? { servers: i.servers } : {}), connector: i.connector, fixtures: i.fixtures });
  for (const c of checks) i.log(`  ${c.suite}/${c.server}: ${c.tools} tools${c.version ? `, version ${c.version}` : ''}`);

  const prices = new Map<string, ModelPrice | null>([...catalog].map(([id, m]) => [id, m.price]));
  const measured = i.estimateFrom ? await readResultsFile(i.estimateFrom) : undefined;
  const est = estimateCost({ remaining: i.plan.remaining, prices, ...(measured ? { measured } : {}) });
  const planned = i.plan.planned.reduce((s, c) => s + c.runs, 0);
  i.log(`plan: ${planned} run(s), ${est.runs} to execute; estimated cost ${usd(est.usd)}`);
  for (const m of est.perModel) {
    const basis = m.basis === 'measured' ? 'measured' : 'catalog price × 25k prompt + 1k completion tokens';
    i.log(`  ${m.model}: ${m.runs} run(s) × ${usd(m.usdPerRun)} (${basis})`);
  }
  if (i.budgetUsd !== undefined && est.usd > i.budgetUsd && !i.yes) {
    throw new ConfigError(
      `estimated cost ${usd(est.usd)} exceeds --budget-usd ${usd(i.budgetUsd)}. Reduce --models/--repeats/--tasks, ` +
        `or re-run with --yes to start anyway (the cap still stops spending at ${usd(i.budgetUsd)}).`,
    );
  }
  const knownPrices = Object.fromEntries([...catalog].flatMap(([id, m]) => (m.price ? [[id, m.price] as const] : [])));
  return new OpenRouterProvider({ ...endpoint, prices: knownPrices });
}
```

- [ ] **Step 5: Replace the run command**

Replace `packages/cli/src/commands/run.ts` with:
```ts
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  aggregate,
  ConfigError,
  DEFAULT_RUNS_DIR,
  FixtureManager,
  identityOf,
  InfraError,
  loadSuite,
  MockProvider,
  parseMockScript,
  previewPlan,
  ResultsSchema,
  RunCache,
  runSuites,
  stdioConnector,
  SuiteError,
  type Connector,
  type MockScript,
  type ModelProvider,
  type Results,
  type RunRecord,
  type Suite,
} from '@mcp-evals/core';
import { fsReason, writeFileAtomic } from '../files.js';
import { formatTable } from '../report/table.js';
import { CLI_VERSION } from '../version.js';
import { openRouterPreflight } from './preflight.js';

export interface RunCommandOptions {
  suites: string[];
  /** 'openrouter' (CLI default) or 'mock'. */
  provider: string;
  mockScript?: string;
  models?: string[];
  servers?: string[];
  tasks?: string[];
  repeats?: number;
  /** Cap on this invocation's spend. */
  budgetUsd?: number;
  /** Continue a cached run: skip its finished runs and reuse its runId. */
  resume?: string;
  /** Start even if the pre-flight estimate exceeds the budget. */
  yes?: boolean;
  /** results.json whose measured cost per run drives the estimate (e.g. the smoke run). */
  estimateFrom?: string;
  out: string;
  traces?: string;
  cacheDir: string;
  runsDir?: string;
  retries?: number;
  connector?: Connector;
  log?: (line: string) => void;
  /** Environment to read OPENROUTER_API_KEY from (default process.env). */
  env?: Record<string, string | undefined>;
  /** Test seam: point the OpenRouter client at a local fake server. */
  openRouterBaseUrl?: string;
  now?: () => Date;
}

export async function runCommand(o: RunCommandOptions): Promise<{ exitCode: number; results?: Results; runId?: string }> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = o.now ?? (() => new Date());
  try {
    if (o.provider !== 'openrouter' && o.provider !== 'mock') throw new ConfigError(`unknown provider "${o.provider}" (supported: openrouter, mock)`);
    const suites = await Promise.all(o.suites.map(readSuite));
    const filters = {
      ...(o.models ? { models: o.models } : {}),
      ...(o.servers ? { servers: o.servers } : {}),
      ...(o.tasks ? { tasks: o.tasks } : {}),
      ...(o.repeats !== undefined ? { repeats: o.repeats } : {}),
    };
    const identity = identityOf({ provider: o.provider, suites, ...filters });
    const runsDir = resolve(o.runsDir ?? DEFAULT_RUNS_DIR);
    let cache: RunCache | undefined;
    let prior: RunRecord[] = [];
    if (o.resume !== undefined) {
      cache = await RunCache.open(runsDir, o.resume);
      cache.assertCompatible(identity);
      prior = await cache.records();
    }
    const skip = new Set(prior.map((r) => r.runKey));
    const plan = previewPlan({ suites, ...filters, skip });
    const fixtures = new FixtureManager({ cacheDir: resolve(o.cacheDir) });
    const connector = o.connector ?? stdioConnector;
    const provider: ModelProvider =
      o.provider === 'openrouter'
        ? await openRouterPreflight({
            suites,
            ...(o.servers ? { servers: o.servers } : {}),
            plan,
            fixtures,
            connector,
            env: o.env ?? process.env,
            ...(o.openRouterBaseUrl ? { baseUrl: o.openRouterBaseUrl } : {}),
            ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}),
            ...(o.yes ? { yes: true } : {}),
            ...(o.estimateFrom ? { estimateFrom: o.estimateFrom } : {}),
            log,
          })
        : await makeMockProvider(o);
    // A bad fixture must fail before the run cache exists and before any spend.
    for (const suite of suites) {
      if (suite.fixture && plan.remaining.some((c) => c.suite === suite.name)) await fixtures.prepare(suite.fixture);
    }
    if (!cache) {
      const createdAt = now().toISOString();
      const runId = `${createdAt.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
      cache = await RunCache.create(runsDir, { runId, createdAt, harnessVersion: CLI_VERSION, identity });
    }
    const runCache = cache;
    const runId = runCache.manifest.runId;
    const priorUnrecordedUsd = runCache.manifest.unrecordedSpendUsd;
    const remaining = plan.remaining.reduce((s, c) => s + c.runs, 0);
    log(`run ${runId}: ${remaining} run(s) to execute${prior.length > 0 ? `, ${prior.length} reused from the run cache` : ''}`);

    const run = await runSuites({
      suites,
      provider,
      connector,
      fixtures,
      ...filters,
      skip,
      ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}),
      ...(o.retries !== undefined ? { retries: o.retries } : {}),
      onRecord: async (r) => {
        await runCache.append(r);
        log(`${r.outcome.padEnd(5)} ${r.suite}/${r.server}/${r.model}/${r.task}#${r.repeat}${r.failReason ? ` — ${r.failReason}` : ''}`);
      },
    });
    const unrecordedUsd = run.totalCostUsd - run.records.reduce((s, r) => s + r.costUsd, 0);
    if (unrecordedUsd > 1e-9) await runCache.addUnrecordedSpend(unrecordedUsd);

    const records = [...prior, ...run.records];
    const plannedTotal = run.planned.reduce((s, c) => s + c.runs, 0);
    const results = ResultsSchema.parse(
      aggregate({
        records,
        suites,
        planned: run.planned,
        providerName: provider.name,
        harnessVersion: CLI_VERSION,
        runId,
        startedAt: runCache.manifest.createdAt,
        finishedAt: run.finishedAt,
        partial: records.length < plannedTotal,
        totalCostUsd: prior.reduce((s, r) => s + r.costUsd, 0) + priorUnrecordedUsd + run.totalCostUsd,
      }),
    );
    // Build both payloads first, then write each atomically: traces first, so a results file always has its traces.
    const resultsText = `${JSON.stringify(results, null, 2)}\n`;
    const tracesText = records.length > 0 ? `${records.map((r) => JSON.stringify(r.trace)).join('\n')}\n` : '';
    if (o.traces && tracesText) await writeFileAtomic(o.traces, tracesText);
    await writeFileAtomic(o.out, resultsText);

    log('');
    log(formatTable(results));
    if (run.stopReason === 'out_of_credits') log('STOPPED: OpenRouter reports the key is out of credits (HTTP 402). Results so far are saved.');
    if (results.partial) {
      log(`Resume the remaining runs with the same suites and filters: mcp-evals run ${o.suites.join(' ')} --resume ${runId} --budget-usd <n>`);
    }
    return { exitCode: 0, results, runId };
  } catch (e) {
    // User errors (bad input, failed pre-flight, unfetchable fixture) are all detected before any run.
    if (e instanceof SuiteError || e instanceof ConfigError || (e instanceof InfraError && e.kind === 'fixture')) {
      log(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}

async function makeMockProvider(o: RunCommandOptions): Promise<ModelProvider> {
  if (!o.mockScript) throw new ConfigError('--mock-script is required with --provider mock');
  return new MockProvider(await readMockScript(resolve(o.mockScript)));
}

async function readSuite(path: string): Promise<Suite> {
  const abs = resolve(path);
  try {
    return await loadSuite(abs);
  } catch (e) {
    if (e instanceof SuiteError) throw e;
    throw new ConfigError(`cannot read suite file ${abs}: ${fsReason(e)}`);
  }
}

async function readMockScript(path: string): Promise<MockScript> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read mock script ${path}: ${fsReason(e)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`invalid mock script ${path}: ${(e as Error).message}`);
  }
  try {
    return parseMockScript(json);
  } catch (e) {
    throw new ConfigError(`invalid mock script ${path}: ${issuesOf(e)}`);
  }
}

function issuesOf(e: unknown): string {
  const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (!Array.isArray(issues)) return e instanceof Error ? e.message : String(e);
  return issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
}
```

- [ ] **Step 6: Write the program and the entry point**

`packages/cli/src/program.ts`:
```ts
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { compareCommand, type CompareCommandOptions } from './commands/compare.js';
import { reportCommand, type ReportCommandOptions } from './commands/report.js';
import { runCommand, type RunCommandOptions } from './commands/run.js';
import { CLI_VERSION } from './version.js';

export interface ProgramDeps {
  run: (o: RunCommandOptions) => Promise<{ exitCode: number }>;
  compare: (o: CompareCommandOptions) => Promise<{ exitCode: number }>;
  report: (o: ReportCommandOptions) => Promise<{ exitCode: number }>;
  writeOut: (s: string) => void;
  writeErr: (s: string) => void;
}

const defaultDeps: ProgramDeps = {
  run: runCommand,
  compare: compareCommand,
  report: reportCommand,
  writeOut: (s) => process.stdout.write(s),
  writeErr: (s) => process.stderr.write(s),
};

type RunFlags = Omit<RunCommandOptions, 'suites' | 'retries' | 'connector' | 'log' | 'env' | 'openRouterBaseUrl' | 'now'>;

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

function nonNegativeNumber(flag: string) {
  return (v: string) => {
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n) || n < 0) throw new InvalidArgumentError(`${flag} must be a non-negative number`);
    return n;
  };
}

/** Runs the CLI and returns the exit code: the command's own, 2 for any usage error, 0 for --help/--version. */
export async function main(argv: string[], deps: ProgramDeps = defaultDeps): Promise<number> {
  let exitCode = 0;
  const program = new Command()
    .name('mcp-evals')
    .description('Benchmark MCP servers and the models that use them')
    .version(CLI_VERSION)
    .exitOverride()
    .configureOutput({ writeOut: deps.writeOut, writeErr: deps.writeErr });

  program
    .command('run')
    .description('Run one or more suites and write results.json')
    .argument('<suites...>', 'suite YAML files')
    .addOption(new Option('--provider <name>', 'model provider').choices(['openrouter', 'mock']).default('openrouter'))
    .option('--mock-script <path>', 'scripted responses for --provider mock')
    .option('--models <ids>', 'comma-separated model ids to run', list)
    .option('--servers <names>', 'comma-separated server names to run', list)
    .option('--tasks <ids>', 'comma-separated task ids to run', list)
    .option('--repeats <n>', 'override repeats per task', positiveInt('--repeats'))
    .option('--budget-usd <n>', 'hard cost cap for this invocation', positiveNumber('--budget-usd'))
    .option('--resume <runId>', 'continue a cached run, skipping the runs it already finished')
    .option('--yes', 'start even if the pre-flight estimate exceeds --budget-usd')
    .option('--estimate-from <results.json>', 'estimate cost from measured cost per run in earlier results (e.g. a smoke run)')
    .option('--out <path>', 'results file', 'results.json')
    .option('--traces <path>', 'write traces as JSONL')
    .option('--cache-dir <path>', 'fixture cache directory', '.mcp-evals/cache')
    .option('--runs-dir <path>', 'run cache directory (used by --resume)', '.mcp-evals/runs')
    .action(async (suites: string[], opts: RunFlags) => {
      exitCode = (await deps.run({ suites, ...opts })).exitCode;
    });

  program
    .command('compare')
    .description('Compare two results files; exit 1 on regression')
    .argument('<base>', 'baseline results.json')
    .argument('<head>', 'new results.json')
    .option('--max-success-drop <pts>', 'regression when success drops by more than this many percentage points', nonNegativeNumber('--max-success-drop'), 5)
    .option('--max-context-increase <pct>', 'regression when median context tokens rise by more than this percent', nonNegativeNumber('--max-context-increase'), 20)
    .addOption(new Option('--format <format>', 'output format').choices(['table', 'markdown', 'json']).default('table'))
    .action(async (base: string, head: string, opts: Omit<CompareCommandOptions, 'base' | 'head' | 'log'>) => {
      exitCode = (await deps.compare({ base, head, ...opts })).exitCode;
    });

  program
    .command('report')
    .description('Print a results file as a table or markdown')
    .argument('<results>', 'results.json')
    .addOption(new Option('--format <format>', 'output format').choices(['table', 'markdown']).default('table'))
    .action(async (results: string, opts: Omit<ReportCommandOptions, 'results' | 'log'>) => {
      exitCode = (await deps.report({ results, ...opts })).exitCode;
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    throw e;
  }
}
```

Replace `packages/cli/src/index.ts` with:
```ts
import { loadDotEnv } from './env.js';
import { main } from './program.js';

// Load .env from the working directory before anything reads the environment; variables already set win.
if (loadDotEnv() === 'unsupported') {
  process.stderr.write('warning: found .env, but this Node version has no process.loadEnvFile (needs Node >= 20.12); export the variables in your shell instead\n');
}
process.exitCode = await main(process.argv.slice(2));
```

- [ ] **Step 7: Run all tests, typecheck, and build**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: every test PASSES; typecheck exits 0; `packages/cli/dist/index.js` exists.

- [ ] **Step 8: Smoke-test the built binary (offline, mock provider)**

Run (from the repo root):
```bash
D=$(mktemp -d) && FAKE="$PWD/packages/core/test/fixtures/fake-server.mjs" && NODE="$(command -v node)" && \
printf 'suite: smoke\nversion: 1\nservers:\n  fake: { command: "%s", args: ["%s"] }\nmodels: [mock/a]\ndefaults: { repeats: 1 }\ntasks:\n  - id: echo\n    prompt: "ECHO"\n    graders: [{ type: tool_called, tool: echo }]\n' "$NODE" "$FAKE" > "$D/s.yaml" && \
echo '{"entries":[{"match":"ECHO","steps":[{"toolCalls":[{"name":"echo","arguments":{"text":"hi"}}]},{"content":"hi"}]}]}' > "$D/m.json" && \
node packages/cli/dist/index.js run "$D/s.yaml" --provider mock --mock-script "$D/m.json" --out "$D/results.json" --runs-dir "$D/runs"; echo "exit=$?"; \
node packages/cli/dist/index.js run "$D/s.yaml" --repeats 0; echo "usage-exit=$?"; \
node packages/cli/dist/index.js report "$D/results.json" --format markdown; echo "report-exit=$?"; \
OPENROUTER_API_KEY= node packages/cli/dist/index.js run "$D/s.yaml" --runs-dir "$D/runs"; echo "nokey-exit=$?"
```
Expected: `pass  smoke/fake/mock/a/echo#0`, the table with `1/1` runs, `exit=0`; `usage-exit=2`; a markdown table and `report-exit=0`; `error: OPENROUTER_API_KEY is not set. Copy .env.example to .env …` and `nokey-exit=2`. (The last command must be run from a directory whose `.env` does not set a key, or with the variable exported empty as shown — an exported variable wins over `.env`.)

- [ ] **Step 9: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): openrouter by default with pre-flight and cost estimate, --resume, .env loading, exit 2 on usage errors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `suites/code-navigation.yaml` with verified answer keys

**Files:**
- Create: `suites/code-navigation.yaml`
- Test: `packages/core/test/suite-code-navigation.test.ts`

**Interfaces:**
- Consumes: `loadSuite`, `previewPlan`, `FixtureManager.cachePath` (Tasks 1, 8; M1).
- Produces: the suite the first real run executes (wave E). Task ids used by the smoke run: `preset-routers`, `strict-path`, `default-error-handler`.

The 12 tasks below were authored against a checkout of Hono at `08a023cbfde55b434fb0fb30fae35d42e4bf20aa` (v4.13.13). Every expected value was checked with `git grep` / `ls` in that checkout on 2026-10-16: every repo-relative path exists, every symbol occurs under `src/`, and each list is complete for its question (e.g. exactly six classes `implements Router<T>`, exactly eight non-test middleware files construct `new HTTPException`). Prompts scope every question to `src/` because the repo also has a top-level `adapters/` tree. Run count: 12 tasks × 2 servers × 4 models × 2 repeats = 192.

- [ ] **Step 1: Write the failing test**

`packages/core/test/suite-code-navigation.test.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FixtureManager } from '../src/fixtures/manager.js';
import { previewPlan } from '../src/runner/run.js';
import { loadSuite } from '../src/suite/load.js';
import type { Suite } from '../src/types.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const suite: Suite = await loadSuite(join(ROOT, 'suites/code-navigation.yaml'));

/** A checkout of the pinned fixture: $MCP_EVALS_FIXTURE_DIR, or the CLI's default fixture cache. Undefined offline. */
function fixtureDir(s: Suite): string | undefined {
  const fromEnv = process.env.MCP_EVALS_FIXTURE_DIR;
  const dir = fromEnv ? resolve(fromEnv) : new FixtureManager({ cacheDir: join(ROOT, '.mcp-evals/cache') }).cachePath(s.fixture!);
  return existsSync(join(dir, '.git')) ? dir : undefined;
}

const git = (dir: string, ...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const PATH = /^[\w.-]+(\/[\w.-]+)*\/[\w.-]+\.[a-z]+$/;

describe('suites/code-navigation.yaml', () => {
  it('pins the fixture, servers and models from the M2 spec', () => {
    expect(suite.fixture).toEqual({ git: 'https://github.com/honojs/hono', ref: '08a023cbfde55b434fb0fb30fae35d42e4bf20aa' });
    expect(suite.servers).toEqual({
      neatcode: { command: 'npx', args: ['-y', '@neatcodeai/mcp@0.1.4'], env: {}, headers: {}, setup: 'npx -y @neatcodeai/cli@0.1.4 init' },
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '{fixture}'], env: {}, headers: {} },
    });
    expect(suite.models).toEqual(['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash', 'qwen/qwen3.8-flash']);
    expect(suite.modelPins).toEqual({
      'anthropic/claude-sonnet-5.5': 'anthropic',
      'openai/gpt-6.1-sol': 'openai',
      'google/gemini-3.8-flash': 'google-ai-studio',
      'qwen/qwen3.8-flash': 'alibaba',
    });
    expect(suite.defaults).toEqual({ repeats: 2, maxSteps: 12, timeoutS: 180, temperature: 0, toolTimeoutS: 60 });
  });

  it('has 12 deterministic tasks that run on both servers and say where the repository is', () => {
    expect(suite.tasks).toHaveLength(12);
    for (const t of suite.tasks) {
      expect(t.prompt).toContain('The repository is at {fixture}.');
      expect(t.servers).toBeUndefined();
      expect(t.graders.length).toBeGreaterThan(0);
      expect(t.graders.every((g) => g.type === 'answer_contains_all')).toBe(true);
    }
    for (const id of ['preset-routers', 'strict-path', 'default-error-handler']) expect(suite.tasks.map((t) => t.id)).toContain(id);
  });

  it('plans 192 runs (12 tasks × 2 servers × 4 models × 2 repeats)', () => {
    expect(previewPlan({ suites: [suite] }).planned.reduce((s, c) => s + c.runs, 0)).toBe(192);
  });

  const dir = fixtureDir(suite);
  describe.skipIf(!dir)('answer key (needs a checkout of the pinned fixture)', () => {
    it('is checked out at the pinned commit', () => {
      expect(git(dir!, 'rev-parse', 'HEAD').stdout.trim()).toBe(suite.fixture!.ref);
    });

    it('names only paths that exist and symbols that occur under src/', () => {
      const missing: string[] = [];
      for (const t of suite.tasks) {
        for (const g of t.graders) {
          if (g.type !== 'answer_contains_all') continue;
          for (const v of g.values) {
            const ok = PATH.test(v) ? existsSync(join(dir!, v)) : git(dir!, 'grep', '-q', '-F', '-e', v, '--', 'src').status === 0;
            if (!ok) missing.push(`${t.id}: ${v}`);
          }
        }
      }
      expect(missing).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/test/suite-code-navigation.test.ts`
Expected: FAIL — `ENOENT: no such file or directory, open '…/suites/code-navigation.yaml'`.

- [ ] **Step 3: Write the suite**

`suites/code-navigation.yaml`:
```yaml
# NeatCode vs. the filesystem MCP server on identical code-navigation tasks.
# Fixture: Hono v4.13.13. Answer keys are verified by packages/core/test/suite-code-navigation.test.ts.
suite: code-navigation
version: 1
fixture:
  git: https://github.com/honojs/hono
  ref: 08a023cbfde55b434fb0fb30fae35d42e4bf20aa
servers:
  neatcode:
    command: npx
    args: ["-y", "@neatcodeai/mcp@0.1.4"]
    setup: "npx -y @neatcodeai/cli@0.1.4 init"
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem@1.0.0", "{fixture}"]
models:
  - { id: anthropic/claude-sonnet-5.5, provider: anthropic }
  - { id: openai/gpt-6.1-sol, provider: openai }
  - { id: google/gemini-3.8-flash, provider: google-ai-studio }
  - { id: qwen/qwen3.8-flash, provider: alibaba }
defaults: { repeats: 2, max_steps: 12, timeout_s: 180, temperature: 0, tool_timeout_s: 60 }
tasks:
  - id: router-implementations
    prompt: >-
      The repository is at {fixture}. Which classes under src/ implement the `Router` interface
      declared in src/router.ts? List every class together with the repo-relative path of the file that defines it.
    graders:
      - type: answer_contains_all
        values:
          - LinearRouter
          - PatternRouter
          - PreparedRegExpRouter
          - RegExpRouter
          - SmartRouter
          - TrieRouter
          - src/router/linear-router/router.ts
          - src/router/pattern-router/router.ts
          - src/router/reg-exp-router/prepared-router.ts
          - src/router/reg-exp-router/router.ts
          - src/router/smart-router/router.ts
          - src/router/trie-router/router.ts

  - id: compose-callers
    prompt: >-
      The repository is at {fixture}. Which functions or methods in non-test files under src/ call `compose`
      from src/compose.ts? For each call give the repo-relative file path and the name of the enclosing function or method.
    graders:
      - { type: answer_contains_all, values: [src/hono-base.ts, src/middleware/combine/index.ts, route, dispatch, every] }

  - id: strict-path
    prompt: >-
      The repository is at {fixture}. When a Hono app is created with `strict: false`, which function extracts the
      request path, and in which file (repo-relative path) is that function defined?
    graders:
      - { type: answer_contains_all, values: [getPathNoStrict, src/utils/url.ts] }

  - id: preset-routers
    prompt: >-
      The repository is at {fixture}. Which router does each Hono entry point construct by default:
      src/hono.ts, src/preset/quick.ts and src/preset/tiny.ts? Name the router classes used by each.
    graders:
      - { type: answer_contains_all, values: [SmartRouter, RegExpRouter, TrieRouter, LinearRouter, PatternRouter] }

  - id: cookie-helper-importers
    prompt: >-
      The repository is at {fixture}. Which non-test files under src/ import from the cookie helper module
      src/helper/cookie/index.ts? List their repo-relative paths.
    graders:
      - type: answer_contains_all
        values:
          - src/middleware/jwk/jwk.ts
          - src/middleware/jwt/jwt.ts
          - src/middleware/language/language.ts
          - src/validator/validator.ts

  - id: timing-safe-callers
    prompt: >-
      The repository is at {fixture}. Which middleware call `timingSafeEqual` from src/utils/buffer.ts?
      Give the repo-relative file path and the name of the exported middleware function for each.
    graders:
      - { type: answer_contains_all, values: [src/middleware/basic-auth/index.ts, src/middleware/bearer-auth/index.ts, basicAuth, bearerAuth] }

  - id: rename-check-optional-parameter
    prompt: >-
      The repository is at {fixture}. If `checkOptionalParameter` in src/utils/url.ts were renamed, which other
      non-test files under src/ would have to change? List their repo-relative paths.
    graders:
      - type: answer_contains_all
        values:
          - src/router/linear-router/router.ts
          - src/router/reg-exp-router/router.ts
          - src/router/trie-router/router.ts

  - id: two-merge-paths
    prompt: >-
      The repository is at {fixture}. There are two different functions named `mergePath` under src/. Where is
      each one defined, and which non-test file under src/ uses each? Give repo-relative paths.
    graders:
      - { type: answer_contains_all, values: [src/utils/url.ts, src/client/utils.ts, src/hono-base.ts, src/client/client.ts] }

  - id: fetch-to-compose
    prompt: >-
      The repository is at {fixture}. Trace a request from `app.fetch` to the point where the matched handlers are
      composed when more than one handler matches. Name each function or method in call order and the repo-relative
      file it is defined in.
    graders:
      - { type: answer_contains_all, values: [fetch, dispatch, match, compose, src/hono-base.ts, src/compose.ts] }

  - id: default-error-handler
    prompt: >-
      The repository is at {fixture}. Where is Hono's default error handler defined (function name and
      repo-relative file), how does it turn an `HTTPException` into a response (which method does it call, and in
      which file is that method defined), and what status does it return for any other error?
    graders:
      - { type: answer_contains_all, values: [errorHandler, getResponse, src/hono-base.ts, src/http-exception.ts, "500"] }

  - id: http-exception-throwers
    prompt: >-
      The repository is at {fixture}. Which middleware under src/middleware/ throw an `HTTPException`?
      List the repo-relative path of every non-test file that does.
    graders:
      - type: answer_contains_all
        values:
          - src/middleware/basic-auth/index.ts
          - src/middleware/bearer-auth/index.ts
          - src/middleware/body-limit/index.ts
          - src/middleware/csrf/index.ts
          - src/middleware/ip-restriction/index.ts
          - src/middleware/jwk/jwk.ts
          - src/middleware/jwt/jwt.ts
          - src/middleware/timeout/index.ts

  - id: smart-router-fallback
    prompt: >-
      The repository is at {fixture}. SmartRouter (src/router/smart-router/router.ts) catches one specific error
      to fall back to its next router. What is that error class, in which file is it defined, and which router
      classes under src/router/ throw it?
    graders:
      - { type: answer_contains_all, values: [UnsupportedPathError, src/router.ts, LinearRouter, PatternRouter, RegExpRouter] }
```

- [ ] **Step 4: Run the test (structure only, offline)**

Run: `pnpm vitest run packages/core/test/suite-code-navigation.test.ts`
Expected: the three structural tests PASS; the `answer key` block is SKIPPED (no fixture checkout yet).

- [ ] **Step 5: Verify the answer key against the real fixture (needs network once)**

Run:
```bash
FIX=$(mktemp -d)/hono && git clone --quiet --filter=blob:none https://github.com/honojs/hono "$FIX" && \
git -C "$FIX" checkout --quiet --detach 08a023cbfde55b434fb0fb30fae35d42e4bf20aa && \
MCP_EVALS_FIXTURE_DIR="$FIX" pnpm vitest run packages/core/test/suite-code-navigation.test.ts
```
Expected: all 5 tests PASS (none skipped). If one value is reported missing, fix the YAML, not the test.

- [ ] **Step 6: Commit**

```bash
git add suites/code-navigation.yaml packages/core/test/suite-code-navigation.test.ts
git commit -m "feat(suites): code-navigation suite on Hono v4.13.13 with verified answer keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: `suites/general-tools.yaml` (filesystem + memory)

**Files:**
- Create: `suites/general-tools.yaml`
- Test: `packages/core/test/suite-general-tools.test.ts`

**Interfaces:**
- Consumes: `loadSuite`, `previewPlan`, `FixtureManager.cachePath`.
- Produces: the general-tools suite (run in a later session, not in the first $10 run).

Each run uses one server, so every task names exactly one server: 8 filesystem tasks (read-and-answer, three `answer_json_schema`, three file edits checked with `fs_state`, one judged explanation) and 4 memory tasks (multi-step graph building checked through the server's JSONL file at `{fixture}/.memory.json`, one judged). 2 of 12 tasks use `llm_judge` (limit 3). Tool names in graders are the ones `@modelcontextprotocol/server-filesystem@1.0.0` and `@modelcontextprotocol/server-memory@1.0.0` register (read from their published `dist/` on 2026-10-16). The memory server writes one JSON object per line in the form `{"type":"entity","name":"…","entityType":"…","observations":[…]}` / `{"type":"relation","from":"…","to":"…","relationType":"…"}`, which the `fs_state contains` checks rely on. Facts were checked in the pinned checkout: `package.json` is `hono` / `4.13.13` / `MIT`; `src/middleware` has 27 directories; `src/middleware/combine/index.ts` exports exactly `some`, `every`, `except`; the timeout middleware defaults to `504` / `Gateway Timeout`; `src/middleware/powered-by/index.ts` contains `options?.serverName ?? 'Hono'`; `docs/MIGRATION.md` starts with `# Migration Guide`. Run count: (8 + 4) tasks × 4 models × 2 repeats = 96.

- [ ] **Step 1: Write the failing test**

`packages/core/test/suite-general-tools.test.ts`:
```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FixtureManager } from '../src/fixtures/manager.js';
import { previewPlan } from '../src/runner/run.js';
import { loadSuite } from '../src/suite/load.js';
import type { Suite } from '../src/types.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const suite: Suite = await loadSuite(join(ROOT, 'suites/general-tools.yaml'));

/** Tools registered by the pinned server versions. */
const TOOLS: Record<string, string[]> = {
  filesystem: [
    'create_directory', 'directory_tree', 'edit_file', 'get_file_info', 'list_allowed_directories', 'list_directory',
    'list_directory_with_sizes', 'move_file', 'read_file', 'read_media_file', 'read_multiple_files', 'read_text_file', 'search_files', 'write_file',
  ],
  memory: ['add_observations', 'create_entities', 'create_relations', 'delete_entities', 'delete_observations', 'delete_relations', 'open_nodes', 'read_graph', 'search_nodes'],
};

/** A checkout of the pinned fixture: $MCP_EVALS_FIXTURE_DIR, or the CLI's default fixture cache. Undefined offline. */
function fixtureDir(s: Suite): string | undefined {
  const fromEnv = process.env.MCP_EVALS_FIXTURE_DIR;
  const dir = fromEnv ? resolve(fromEnv) : new FixtureManager({ cacheDir: join(ROOT, '.mcp-evals/cache') }).cachePath(s.fixture!);
  return existsSync(join(dir, '.git')) ? dir : undefined;
}

describe('suites/general-tools.yaml', () => {
  it('pins the fixture, the filesystem and memory servers, the models, and the judge', () => {
    expect(suite.fixture).toEqual({ git: 'https://github.com/honojs/hono', ref: '08a023cbfde55b434fb0fb30fae35d42e4bf20aa' });
    expect(suite.servers).toEqual({
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '{fixture}'], env: {}, headers: {} },
      memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@1.0.0'], env: { MEMORY_FILE_PATH: '{fixture}/.memory.json' }, headers: {} },
    });
    expect(Object.keys(suite.modelPins)).toEqual(suite.models);
    expect(suite.judge).toEqual({ id: 'anthropic/claude-haiku-5.5', provider: 'anthropic' });
  });

  it('has 12 tasks, each on exactly one server, at most 3 judged, with graders naming only real tools', () => {
    expect(suite.tasks).toHaveLength(12);
    const judged = suite.tasks.filter((t) => t.graders.some((g) => g.type === 'llm_judge'));
    expect(judged.length).toBeLessThanOrEqual(3);
    for (const t of suite.tasks) {
      expect(t.servers).toHaveLength(1);
      const server = t.servers![0]!;
      if (server === 'filesystem') expect(t.prompt).toContain('The repository is at {fixture}.');
      for (const g of t.graders) {
        if (g.type === 'tool_called' || g.type === 'tool_not_called' || g.type === 'tool_args_match') expect(TOOLS[server]).toContain(g.tool);
      }
    }
    expect(previewPlan({ suites: [suite] }).planned.reduce((s, c) => s + c.runs, 0)).toBe(96);
  });

  const dir = fixtureDir(suite);
  describe.skipIf(!dir)('answer key (needs a checkout of the pinned fixture)', () => {
    const read = (p: string) => readFileSync(join(dir!, p), 'utf8');
    it('matches the facts the graders expect', () => {
      expect(JSON.parse(read('package.json'))).toMatchObject({ name: 'hono', version: '4.13.13', license: 'MIT' });
      const middleware = readdirSync(join(dir!, 'src/middleware'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      expect(middleware).toHaveLength(27);
      expect(middleware).toEqual(expect.arrayContaining(['basic-auth', 'context-storage', 'jsx-renderer', 'method-not-allowed', 'trailing-slash']));
      const combine = read('src/middleware/combine/index.ts');
      expect(combine.match(/^export /gm)).toHaveLength(3);
      for (const name of ['some', 'every', 'except']) expect(combine).toContain(`export const ${name}`);
      expect(read('src/middleware/timeout/index.ts')).toMatch(/504[\s\S]*Gateway Timeout/);
      expect(read('src/middleware/powered-by/index.ts')).toContain("options?.serverName ?? 'Hono'");
      expect(read('docs/MIGRATION.md').startsWith('# Migration Guide')).toBe(true);
      expect(read('src/router/smart-router/router.ts')).toContain('UnsupportedPathError');
      for (const p of ['src/hono.ts', 'src/middleware/powered-by/index.test.ts']) expect(existsSync(join(dir!, p))).toBe(true);
      for (const p of ['EVAL_NOTES.md', 'docs/archive', '.memory.json']) expect(existsSync(join(dir!, p))).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/test/suite-general-tools.test.ts`
Expected: FAIL — `ENOENT: no such file or directory, open '…/suites/general-tools.yaml'`.

- [ ] **Step 3: Write the suite**

`suites/general-tools.yaml`:
```yaml
# General tool use: the filesystem and memory MCP servers on the Hono fixture.
# Each task targets exactly one server. At most 3 tasks use llm_judge (2 do).
suite: general-tools
version: 1
fixture:
  git: https://github.com/honojs/hono
  ref: 08a023cbfde55b434fb0fb30fae35d42e4bf20aa
servers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem@1.0.0", "{fixture}"]
  memory:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-memory@1.0.0"]
    env: { MEMORY_FILE_PATH: "{fixture}/.memory.json" }
models:
  - { id: anthropic/claude-sonnet-5.5, provider: anthropic }
  - { id: openai/gpt-6.1-sol, provider: openai }
  - { id: google/gemini-3.8-flash, provider: google-ai-studio }
  - { id: qwen/qwen3.8-flash, provider: alibaba }
judge: { id: anthropic/claude-haiku-5.5, provider: anthropic }
defaults: { repeats: 2, max_steps: 12, timeout_s: 180, temperature: 0, tool_timeout_s: 60 }
tasks:
  # ---- filesystem: read and answer --------------------------------------------
  - id: package-json
    servers: [filesystem]
    prompt: >-
      The repository is at {fixture}. What are the `name`, `version` and `license` fields of its package.json?
      Reply with only a JSON object that has exactly the keys "name", "version" and "license".
    graders:
      - type: answer_json_schema
        schema:
          type: object
          required: [name, version, license]
          additionalProperties: false
          properties:
            name: { type: string, enum: [hono] }
            version: { type: string, enum: ["4.13.13"] }
            license: { type: string, enum: [MIT] }

  - id: middleware-list
    servers: [filesystem]
    prompt: >-
      The repository is at {fixture}. List the name of every directory directly inside src/middleware.
      Reply with only a JSON object of the form {"middleware": ["name", ...]}.
    graders:
      - type: answer_json_schema
        schema:
          type: object
          required: [middleware]
          additionalProperties: false
          properties:
            middleware: { type: array, minItems: 27, items: { type: string } }
      - { type: answer_contains_all, values: [basic-auth, context-storage, jsx-renderer, method-not-allowed, trailing-slash] }

  - id: combine-exports
    servers: [filesystem]
    prompt: >-
      The repository is at {fixture}. Which functions does src/middleware/combine/index.ts export?
      Reply with only a JSON object of the form {"exports": ["name", ...]}.
    graders:
      - type: answer_json_schema
        schema:
          type: object
          required: [exports]
          additionalProperties: false
          properties:
            exports: { type: array, minItems: 3, items: { type: string, enum: [some, every, except] } }
      - { type: answer_contains_all, values: [some, every, except], case_sensitive: true }

  - id: timeout-default
    servers: [filesystem]
    prompt: >-
      The repository is at {fixture}. When Hono's timeout middleware (src/middleware/timeout/index.ts) fires and
      no custom exception was given, which HTTP status code and message does it respond with?
    graders:
      - { type: answer_contains_all, values: ["504", Gateway Timeout] }

  # ---- filesystem: file edits ---------------------------------------------------
  - id: write-notes
    servers: [filesystem]
    prompt: >-
      The repository is at {fixture}. Create a new file at {fixture}/EVAL_NOTES.md whose entire content is the
      single line: reviewed-by: mcp-evals
    graders:
      - { type: tool_called, tool: write_file }
      - { type: fs_state, path: EVAL_NOTES.md, contains: "reviewed-by: mcp-evals" }

  - id: edit-powered-by
    servers: [filesystem]
    prompt: >-
      The repository is at {fixture}. In src/middleware/powered-by/index.ts, change the value the middleware falls
      back to for the X-Powered-By header from 'Hono' to 'Hono-Eval'. Do not change any other file.
    graders:
      - { type: fs_state, path: src/middleware/powered-by/index.ts, contains: "options?.serverName ?? 'Hono-Eval'" }
      - { type: fs_state, path: src/hono.ts, unchanged: true }
      - { type: fs_state, path: src/middleware/powered-by/index.test.ts, unchanged: true }

  - id: move-migration-guide
    servers: [filesystem]
    prompt: >-
      The repository is at {fixture}. Move docs/MIGRATION.md to docs/archive/MIGRATION.md, creating the
      docs/archive directory if needed. Do not change the file's content.
    graders:
      - { type: tool_called, tool: move_file }
      - { type: fs_state, path: docs/archive/MIGRATION.md, contains: "# Migration Guide" }
      - { type: fs_state, path: docs/MIGRATION.md, exists: false }

  # ---- filesystem: open-ended (judged) ----------------------------------------
  - id: explain-smart-router
    servers: [filesystem]
    prompt: >-
      The repository is at {fixture}. Read src/router/smart-router/router.ts and explain in 3 to 5 sentences how
      SmartRouter decides which of its routers to use, and what happens on later calls to match().
    graders:
      - { type: answer_contains_all, values: [UnsupportedPathError] }
      - type: llm_judge
        rubric: >-
          The answer must say that SmartRouter tries its routers in order, registering all collected routes on each;
          that a router throwing UnsupportedPathError is skipped in favour of the next one; that the first router that
          succeeds becomes the only router; and that later match() calls go straight to that router's match (it
          replaces its own match method). Fail answers that invent behaviour not in the file.

  # ---- memory: multi-step -----------------------------------------------------
  - id: memory-store-graph
    servers: [memory]
    prompt: >-
      Using the memory tools, record this knowledge graph. Entities (entity type "router"): SmartRouter,
      RegExpRouter, TrieRouter. Relations: SmartRouter "tries" RegExpRouter, and SmartRouter "tries" TrieRouter.
      When it is stored, reply with the word: stored
    graders:
      - { type: tool_called, tool: create_entities }
      - { type: tool_called, tool: create_relations }
      - { type: fs_state, path: .memory.json, contains: '"name":"SmartRouter"' }
      - { type: fs_state, path: .memory.json, contains: '"name":"TrieRouter"' }
      - { type: fs_state, path: .memory.json, contains: '"relationType":"tries"' }

  - id: memory-observations
    servers: [memory]
    prompt: >-
      Using the memory tools: create an entity named "hono" of type "project" with the observations
      "MIT licensed" and "version 4.13.13". Then add a third observation, "uses SmartRouter by default", to that
      same entity. Finally, read the entity back from memory and reply with all of its observations.
    graders:
      - { type: tool_called, tool: add_observations }
      - { type: fs_state, path: .memory.json, contains: "uses SmartRouter by default" }
      - { type: answer_contains_all, values: [MIT licensed, version 4.13.13, uses SmartRouter by default] }

  - id: memory-delete
    servers: [memory]
    prompt: >-
      Using the memory tools: create three entities of type "test" named "alpha", "beta" and "gamma". Then delete
      "beta". Then read the whole graph back and reply with the names of the entities that remain.
    graders:
      - { type: tool_called, tool: delete_entities }
      - { type: tool_called, tool: read_graph }
      - { type: fs_state, path: .memory.json, contains: '"name":"gamma"' }
      - { type: answer_contains_all, values: [alpha, gamma] }

  - id: memory-team-graph
    servers: [memory]
    prompt: >-
      Model this team in the memory knowledge graph, with people and teams as entities and the relationships as
      relations: Ana leads the Router team. Ben and Chen are members of the Router team. Chen also maintains the
      cors middleware. Then describe, in plain sentences, the graph you stored.
    graders:
      - { type: tool_called, tool: create_relations }
      - { type: fs_state, path: .memory.json, contains: '"name":"Chen"' }
      - type: llm_judge
        rubric: >-
          The answer must describe a stored graph in which Ana leads the Router team, Ben and Chen are members of the
          Router team, and Chen maintains the cors middleware. It must not add people, teams or relationships that
          were not given.
```

- [ ] **Step 4: Run the test (structure offline, then the answer key against a checkout)**

Run: `pnpm vitest run packages/core/test/suite-general-tools.test.ts`
Expected: the two structural tests PASS; the `answer key` block is SKIPPED.

Run (reuse the checkout from Task 10 Step 5, or clone it the same way): `MCP_EVALS_FIXTURE_DIR="$FIX" pnpm vitest run packages/core/test/suite-general-tools.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add suites/general-tools.yaml packages/core/test/suite-general-tools.test.ts
git commit -m "feat(suites): general-tools suite for the filesystem and memory servers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Publishing (`mcp-evals publish`) and `docs/methodology.md`

**Files:**
- Create: `packages/cli/src/commands/publish.ts`, `packages/cli/src/commands/publish.test.ts`
- Modify: `packages/cli/src/program.ts` (register `publish`), `packages/cli/src/program.test.ts` (stub + one test)
- Create: `docs/methodology.md`

**Interfaces:**
- Consumes: `readResultsFile`, `writeFileAtomic`, `fsReason` (Task 6); `ConfigError`; `ProgramDeps`, `main` (Task 9); `SYSTEM_PROMPT`, `TOKENIZER`, `ASSUMED_*_TOKENS_PER_RUN` (for the doc's facts).
- Produces:
  - `interface PublishCommandOptions { results: string; traces: string; dataDir: string; latest?: boolean; allowPartial?: boolean; log?: (line: string) => void }`; `publishCommand(o): Promise<{ exitCode: number }>` — writes `<dataDir>/runs/<runId>/results.json` and `<dataDir>/runs/<runId>/traces.jsonl.gz` (gzip of the traces file), and with `latest` also `<dataDir>/latest.json` (same bytes as the run's results.json). Refuses (exit 2): partial results without `allowPartial`, a traces file whose line count differs from the results' total `runs`, a non-JSON trace line, an already-published run id, unreadable files.
  - CLI: `mcp-evals publish <results> --traces <path> [--data-dir data] [--latest] [--allow-partial]`; `ProgramDeps.publish`.
  - `docs/methodology.md` (spec §5 step 3 contents).

- [ ] **Step 1: Write the failing tests**

`packages/cli/src/commands/publish.test.ts`:
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Results } from '@mcp-evals/core';
import { describe, expect, it } from 'vitest';
import { cell, results } from '../testing/results-fixture.js';
import { publishCommand } from './publish.js';

async function setup(over: Partial<Results> = {}, traceLines = 4) {
  const dir = await mkdtemp(join(tmpdir(), 'publish-'));
  const r = results([cell({ server: 'neatcode', model: 'acme/a' })], over); // the cell has 4 runs
  const resultsPath = join(dir, 'results.json');
  await writeFile(resultsPath, JSON.stringify(r));
  const traces = `${Array.from({ length: traceLines }, (_, i) => JSON.stringify({ runKey: `k${i}`, events: [] })).join('\n')}\n`;
  const tracesPath = join(dir, 'traces.jsonl');
  await writeFile(tracesPath, traces);
  const lines: string[] = [];
  return { dir, r, resultsPath, tracesPath, traces, dataDir: join(dir, 'data'), lines, log: (l: string) => lines.push(l) };
}

describe('publishCommand', () => {
  it('writes data/runs/<runId>/results.json and traces.jsonl.gz, and data/latest.json with --latest', async () => {
    const s = await setup();
    const res = await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, latest: true, log: s.log });
    expect(res.exitCode).toBe(0);
    const runDir = join(s.dataDir, 'runs', 'run-1');
    const published = await readFile(join(runDir, 'results.json'), 'utf8');
    expect(JSON.parse(published)).toEqual(s.r);
    expect(gunzipSync(await readFile(join(runDir, 'traces.jsonl.gz'))).toString('utf8')).toBe(s.traces);
    expect(await readFile(join(s.dataDir, 'latest.json'), 'utf8')).toBe(published);
    expect(s.lines.some((l) => l.includes(join(runDir, 'results.json')))).toBe(true);
  });

  it('leaves data/latest.json alone without --latest', async () => {
    const s = await setup();
    expect((await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, log: s.log })).exitCode).toBe(0);
    expect(existsSync(join(s.dataDir, 'latest.json'))).toBe(false);
  });

  it('refuses partial results unless --allow-partial', async () => {
    const s = await setup({ partial: true });
    expect((await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, log: s.log })).exitCode).toBe(2);
    expect(s.lines[0]).toMatch(/^error: results run-1 are partial/);
    expect((await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, allowPartial: true, log: s.log })).exitCode).toBe(0);
  });

  it('refuses traces that do not belong to the results, and non-JSON trace lines', async () => {
    const short = await setup({}, 3);
    expect((await publishCommand({ results: short.resultsPath, traces: short.tracesPath, dataDir: short.dataDir, log: short.log })).exitCode).toBe(2);
    expect(short.lines[0]).toMatch(/traces file has 3 line\(s\) but the results count 4 run\(s\)/);
    const junk = await setup();
    await writeFile(junk.tracesPath, '{}\n{}\nnot json\n{}\n');
    expect((await publishCommand({ results: junk.resultsPath, traces: junk.tracesPath, dataDir: junk.dataDir, log: junk.log })).exitCode).toBe(2);
    expect(junk.lines[0]).toMatch(/line 3 is not JSON/);
    expect(existsSync(join(junk.dataDir, 'runs'))).toBe(false);
  });

  it('refuses to overwrite a published run, and names unreadable files', async () => {
    const s = await setup();
    expect((await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, log: s.log })).exitCode).toBe(0);
    expect((await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, log: s.log })).exitCode).toBe(2);
    expect(s.lines.at(-1)).toMatch(/already exists; refusing to overwrite a published run/);
    const missing = join(s.dir, 'nope.jsonl');
    expect((await publishCommand({ results: s.resultsPath, traces: missing, dataDir: join(s.dir, 'other'), log: s.log })).exitCode).toBe(2);
    expect(s.lines.at(-1)).toContain(missing);
  });
});
```

In `packages/cli/src/program.test.ts`, add to the `deps` object in `stub()`:
```ts
    publish: async (o) => (calls.push(['publish', o]), { exitCode: 0 }),
```
and append to `describe('main', …)`:
```ts
  it('parses publish flags and requires --traces', async () => {
    const { calls, deps } = stub();
    expect(await main(['publish', 'r.json', '--traces', 't.jsonl', '--latest'], deps)).toBe(0);
    expect(calls[0]).toEqual(['publish', { results: 'r.json', traces: 't.jsonl', dataDir: 'data', latest: true }]);
    expect(await main(['publish', 'r.json'], stub().deps)).toBe(2);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/commands/publish.test.ts packages/cli/src/program.test.ts`
Expected: FAIL — `Cannot find module './publish.js'`; `publish` is not a known command.

- [ ] **Step 3: Write the publish command**

`packages/cli/src/commands/publish.ts`:
```ts
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ConfigError } from '@mcp-evals/core';
import { fsReason, readResultsFile, writeFileAtomic } from '../files.js';

export interface PublishCommandOptions {
  results: string;
  traces: string;
  /** Repository data directory (default "data"). */
  dataDir: string;
  /** Also write <dataDir>/latest.json. */
  latest?: boolean;
  allowPartial?: boolean;
  log?: (line: string) => void;
}

/** Spec §5.3 layout: data/runs/<runId>/results.json, data/runs/<runId>/traces.jsonl.gz, data/latest.json. */
export async function publishCommand(o: PublishCommandOptions): Promise<{ exitCode: number }> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    const results = await readResultsFile(o.results);
    if (results.partial && !o.allowPartial) {
      throw new ConfigError(`results ${results.runId} are partial; finish them with --resume first, or pass --allow-partial`);
    }
    const tracesPath = resolve(o.traces);
    let traces: Buffer;
    try {
      traces = await readFile(tracesPath);
    } catch (e) {
      throw new ConfigError(`cannot read traces file ${tracesPath}: ${fsReason(e)}`);
    }
    const lines = traces.toString('utf8').split('\n').filter((l) => l.trim() !== '');
    lines.forEach((line, i) => {
      try {
        JSON.parse(line);
      } catch {
        throw new ConfigError(`traces file ${tracesPath}: line ${i + 1} is not JSON`);
      }
    });
    const runs = results.suites.reduce((sum, s) => sum + s.cells.reduce((n, c) => n + c.runs, 0), 0);
    if (lines.length !== runs) {
      throw new ConfigError(`traces file has ${lines.length} line(s) but the results count ${runs} run(s); publish the traces written by the same run`);
    }
    const dataDir = resolve(o.dataDir);
    const runDir = join(dataDir, 'runs', results.runId);
    const resultsOut = join(runDir, 'results.json');
    if (existsSync(resultsOut)) throw new ConfigError(`${resultsOut} already exists; refusing to overwrite a published run`);
    const text = `${JSON.stringify(results, null, 2)}\n`;
    await writeFileAtomic(join(runDir, 'traces.jsonl.gz'), gzipSync(traces));
    await writeFileAtomic(resultsOut, text);
    log(`published ${resultsOut} and ${join(runDir, 'traces.jsonl.gz')}`);
    if (o.latest) {
      await writeFileAtomic(join(dataDir, 'latest.json'), text);
      log(`updated ${join(dataDir, 'latest.json')}`);
    }
    return { exitCode: 0 };
  } catch (e) {
    if (e instanceof ConfigError) {
      log(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}
```

- [ ] **Step 4: Register the command**

In `packages/cli/src/program.ts`:
- add the import `import { publishCommand, type PublishCommandOptions } from './commands/publish.js';`
- add to `ProgramDeps` after `report: …;`:
```ts
  publish: (o: PublishCommandOptions) => Promise<{ exitCode: number }>;
```
- add to `defaultDeps` after `report: reportCommand,`: `publish: publishCommand,`
- add before the `try { await program.parseAsync(…` block:
```ts
  program
    .command('publish')
    .description('Copy a finished run into data/ (data/runs/<runId>/…, optionally data/latest.json)')
    .argument('<results>', 'results.json of the run')
    .requiredOption('--traces <path>', 'traces.jsonl written by the same run')
    .option('--data-dir <path>', 'data directory', 'data')
    .option('--latest', 'also write data/latest.json')
    .option('--allow-partial', 'publish results that have partial: true')
    .action(async (results: string, opts: Omit<PublishCommandOptions, 'results' | 'log'>) => {
      exitCode = (await deps.publish({ results, ...opts })).exitCode;
    });
```

- [ ] **Step 5: Write `docs/methodology.md`**

`docs/methodology.md`:
````markdown
# mcp-evals methodology

How mcp-evals measures MCP servers and the models that use them, and what the numbers in `data/latest.json` mean. Results are reported as measured, whichever way they fall.

## What one run is

A **run** is one (suite, server, model, task, repeat). For every run the harness copies the pinned fixture into a fresh temporary workspace (without `.git`), runs the server's `setup` command there (for NeatCode: `npx -y @neatcodeai/cli@0.1.4 init`, which indexes the repo), starts a fresh server process, lists its tools, and runs its own agent loop: system prompt + task prompt → model → tool calls executed over MCP → results appended → repeat until the model answers without calling tools or a limit is hit.

## Outcomes

- **pass** — the model gave a final answer and every decisive grader passed.
- **fail** — the model misbehaved or answered wrongly: a grader failed, it called an unknown tool or sent invalid JSON arguments, it hit `max_steps` or the run timeout, or **one tool call exceeded the per-call tool timeout** (`defaults.tool_timeout_s`, 60 s; recorded as `end: tool_timeout`).
- **error** — infrastructure failed: the server crashed or could not start, setup failed, or the model API failed (429, 5xx, network, request timeout). Transient errors are retried with exponential backoff (0.5 s, 1 s, 2 s; at most 3 retries). Errors are reported in `errorRate` and **excluded** from the success rate.

## Metrics

- **Success rate** — passes / (passes + fails) per cell (server × model), with a **Wilson 95% confidence interval**. `null` when a cell has no completed runs.
- **Context tokens per task (headline)** — the tokens of text returned by MCP tool calls during the run, counted with **`gpt-tokenizer` `o200k_base` for every model** (special-token text such as `<|endoftext|>` is counted as text). Because it depends only on what the server returned, it is comparable across servers and models. Reported as mean and median per cell.
- **Provider-reported prompt tokens per task (secondary)** — the sum of `usage.prompt_tokens` over the run's agent model calls, as reported by OpenRouter. It includes the system prompt, tool schemas and the growing conversation, and uses each model's own tokenizer, so it is **not** comparable across models; it is what the run was billed for.
- **Tool accuracy** — share of completed runs whose `tool_called` / `tool_args_match` graders passed (`null` when a cell has none).
- **Steps** — model calls per run. **Latency (p50)** — wall time of the agent loop only: it **excludes** copying the fixture, the server's setup command (e.g. NeatCode indexing), starting the server, and listing its tools.
- **Cost** — OpenRouter's `usage.cost` for each call (credits, treated as USD), including `llm_judge` calls. If a response lacked `usage.cost`, the catalog price × reported tokens is used instead. A retried run's cost includes its failed attempts.

## Grading

Deterministic graders run first: `answer_contains_all` (case-insensitive substring match on repo-relative paths and symbols), `answer_matches`, `answer_json_schema` (a built-in JSON Schema subset), `tool_called` / `tool_not_called` / `tool_args_match`, and `fs_state` (file exists / contains / unchanged after the run, judged against a snapshot taken after setup and server start). Budget graders (`max_steps`, `max_context_tokens`) are recorded but decide nothing unless `strict`. `llm_judge` runs **only** when a final answer exists and every decisive deterministic grader passed; the judge returns `{"pass", "score", "reason"}` and the verdict and reason are stored in the trace.

## Fairness rules

- One system prompt for every model: *"You are an agent completing a task with the tools provided. Use tools when they help. When you are finished, reply with your final answer as plain text and do not call any more tools."*
- Tool schemas are converted by one function and sorted by name, identically for every model.
- Temperature 0; identical limits for every run of a suite (code-navigation: 12 steps, 180 s run timeout, 60 s per tool call).
- A fresh workspace and a fresh server process per run. `{fixture}` is replaced by the workspace's real absolute path, identically in the prompt and in every server's arguments and environment.
- Every model is pinned to one provider with `allow_fallbacks: false`, so a cell is never served by a mix of providers.

## Pinned configuration (first real run)

| Item | Value |
|---|---|
| Models (OpenRouter id → provider) | `anthropic/claude-sonnet-5.5` → `anthropic`; `openai/gpt-6.1-sol` → `openai`; `google/gemini-3.8-flash` → `google-ai-studio`; `qwen/qwen3.8-flash` → `alibaba` |
| Judge | `anthropic/claude-haiku-5.5` → `anthropic` |
| Fixture | `https://github.com/honojs/hono` v4.13.13 @ `08a023cbfde55b434fb0fb30fae35d42e4bf20aa` |
| Servers | `@neatcodeai/mcp@0.1.4` (setup `@neatcodeai/cli@0.1.4 init`); `@modelcontextprotocol/server-filesystem@1.0.0`; `@modelcontextprotocol/server-memory@1.0.0` (general-tools) |
| Tokenizer | `gpt-tokenizer` `o200k_base` |
| Repeats | 2 (code-navigation first run) |

`results.json` also records the harness version, each server's reported `serverInfo.version`, and each model's pinned provider. Catalog checks: on 2026-10-15 all four models were served with tool support at list price by their pinned providers; list prices on 2026-10-16 (USD per million prompt / completion tokens): Sonnet 5.5 2 / 10, GPT-6.1 Sol 2 / 10, Gemini 3.8 Flash 0.825 / 4.125, Qwen3.8 Flash 0.15 / 0.47, Haiku 5.5 0.10 / 0.50.

## Budget, partial runs and completeness

Every run invocation has a hard cap (`--budget-usd`). Before spending, the CLI checks the key, the model catalog (every model exists, supports tools, has a pin), starts every server once, and prints the planned runs and an estimate (measured cost per run from an earlier run where available, otherwise catalog price × 25k prompt + 1k completion tokens per run); it refuses to start when the estimate exceeds the cap unless `--yes`. At the cap no new run starts and the in-flight run stops before its next model call (its cost counts, it gets no record). An HTTP 402 (out of credits) from OpenRouter stops the run the same way. The results are then written with `partial: true`, and each cell reports `plannedRuns` and `complete` (`runs === plannedRuns`; error runs count as runs). `mcp-evals run … --resume <runId>` finishes the remaining runs later without re-running finished ones. Incomplete cells are never compared as if complete.

## Known limitations

- Small samples: 2 repeats per task give wide confidence intervals; read the intervals, not just the point estimates.
- `answer_contains_all` checks that expected paths and symbols appear; it does not penalise extra, wrong items in an answer.
- One fixture (a single TypeScript repository); results may not transfer to other languages or repo sizes.
- Even at temperature 0, providers are not perfectly deterministic, and provider-side model updates can change results under the same id.
- The filesystem server has no content search, so it must read files to answer; that difference is what the head-to-head measures.
- The harness author also wrote NeatCode. Tasks, answer keys and graders are public in `suites/`, and every trace is published, so the comparison can be audited.

## Data layout

`data/runs/<runId>/results.json` (schema v2), `data/runs/<runId>/traces.jsonl.gz` (one JSON trace per run), and `data/latest.json` (a copy of the latest full run's results). Written by `mcp-evals publish`.

## Reproducing

```bash
cp .env.example .env            # add OPENROUTER_API_KEY
pnpm install && pnpm build
node packages/cli/dist/index.js run suites/code-navigation.yaml --budget-usd 10 --out results.json --traces traces.jsonl
node packages/cli/dist/index.js report results.json --format markdown
```
````

- [ ] **Step 6: Check the doc's facts against the code**

Run:
```bash
grep -c "You are an agent completing a task with the tools provided. Use tools when they help." packages/core/src/agent/loop.ts && \
grep -n "ASSUMED_PROMPT_TOKENS_PER_RUN = 25_000\|ASSUMED_COMPLETION_TOKENS_PER_RUN = 1_000" packages/core/src/runner/preflight.ts && \
grep -n "o200k_base" packages/core/src/tokens.ts && \
grep -n "max_steps: 12, timeout_s: 180, temperature: 0, tool_timeout_s: 60" suites/code-navigation.yaml
```
Expected: each grep prints a match (the first prints `1`). If one does not, fix the doc to match the code.

- [ ] **Step 7: Run all tests and typecheck**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: every test PASSES; typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src docs/methodology.md
git commit -m "feat(cli): publish runs into data/; docs: methodology

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Wave E — live run runbook (not executed by implementers)

The user runs this in their own shell with their own key; it spends real money. Never put the key on the command line, in a file other than `.env`, or in a commit. Stop and ask the user before any step that could exceed the $10 total.

1. **Prepare (offline checks):**
   ```bash
   cp .env.example .env    # then edit .env: OPENROUTER_API_KEY=sk-or-…   (.env is git-ignored)
   pnpm install && pnpm build && pnpm test && pnpm typecheck
   ```
   Check: all green; `git status` shows `.env` untracked and ignored.

2. **Smoke run — code-navigation, 3 tasks, `qwen/qwen3.8-flash`, 1 repeat (counts toward the $10):**
   ```bash
   node packages/cli/dist/index.js run suites/code-navigation.yaml \
     --models qwen/qwen3.8-flash --tasks preset-routers,strict-path,default-error-handler --repeats 1 \
     --budget-usd 1 --out .mcp-evals/smoke/results.json --traces .mcp-evals/smoke/traces.jsonl
   ```
   Check: pre-flight lists `code-navigation/neatcode` and `code-navigation/filesystem` with their tool counts and versions; `plan: 6 run(s), 6 to execute`; exit code 0; `errorRate` is 0 in every cell (if not, read the traces' `failReason` / `serverStderr` before spending more). Then:
   ```bash
   node packages/cli/dist/index.js report .mcp-evals/smoke/results.json
   SMOKE=$(node -e "console.log(require('./.mcp-evals/smoke/results.json').totalCostUsd)"); echo "smoke spend: \$$SMOKE"
   pnpm vitest run packages/core/test/suite-code-navigation.test.ts   # the answer key now runs against the cached fixture
   ```
   Check: the answer-key tests run (not skipped) and pass.

3. **Full first real run — code-navigation, all 4 models, 2 repeats (192 runs), capped at $10 minus the smoke spend:**
   ```bash
   BUDGET=$(node -e "console.log((10 - Number(process.argv[1])).toFixed(4))" "$SMOKE")
   node packages/cli/dist/index.js run suites/code-navigation.yaml \
     --budget-usd "$BUDGET" --estimate-from .mcp-evals/smoke/results.json \
     --out .mcp-evals/full/results.json --traces .mcp-evals/full/traces.jsonl
   ```
   Check: the pre-flight estimate is printed per model (qwen measured, the others catalog-based) and is below `$BUDGET`; if the CLI refuses because the estimate exceeds the budget, **do not add `--yes`** — report the estimate to the user and let them decide (e.g. fewer repeats or models). Note the printed `run <runId>`.

4. **If the run stopped early** (`partial: true`, budget cap or HTTP 402): results so far are already written. Only with the user's approval of a new amount, finish later with
   ```bash
   node packages/cli/dist/index.js run suites/code-navigation.yaml --resume <runId> --budget-usd <approved-amount> \
     --out .mcp-evals/full/results.json --traces .mcp-evals/full/traces.jsonl
   ```

5. **Check the results:**
   ```bash
   node packages/cli/dist/index.js report .mcp-evals/full/results.json --format markdown
   ```
   Check: `partial` is false (or the user accepted a partial run); every cell is complete; `totalCostUsd` + smoke spend ≤ $10; spot-check three traces (one pass, one fail, one per server) in `.mcp-evals/full/traces.jsonl`.

6. **Publish:**
   ```bash
   node packages/cli/dist/index.js publish .mcp-evals/full/results.json --traces .mcp-evals/full/traces.jsonl --latest
   ```
   Check: `data/runs/<runId>/results.json`, `data/runs/<runId>/traces.jsonl.gz` and `data/latest.json` exist; add a "First real run" paragraph to `docs/methodology.md` with the run id, date, total spend (smoke + full) and the headline table from step 5; the user reviews and commits `data/` and the doc.

7. `general-tools` runs in a later session (its own budget, same steps with `suites/general-tools.yaml`).

---

## Spec coverage map

| M2 spec item | Task(s) |
|---|---|
| §3.1 OpenRouter provider: request shape, pins, usage/cost, serving provider, key handling, error classes incl. `OutOfCreditsError`, malformed JSON, `signal` | 3 (provider), 8 (pin/servedBy/402 in loop + runner), 9 (key from env, `.env`, pre-flight) |
| §3.1 `.env` via `process.loadEnvFile()`, env wins, `.env.example` hint | 9 |
| §3.2 `countTokens` (o200k_base) replacing `estimateTokens`; provider prompt tokens kept | 1, 2 |
| §3.3 `answer_json_schema`, `llm_judge` (+ suite `judge:`), judge cost, retry rules, unparseable verdict = fail | 1 (judge block), 5, 8 |
| §3.4 run cache JSONL, `--resume`, manifest mismatch → `ConfigError` | 4, 8 (skip), 9 |
| §3.5 results v2 (`plannedRuns`, `complete`, `providerPromptTokensPerTask`, server version, pinned provider, judge, `schemaVersion: 2`), `readResults()` v1 upgrade | 2 (+ 7/8 for versions) |
| §3.6 `run --provider openrouter` default / `mock`, `--resume`, `--yes`; `compare` with thresholds, formats and exit codes; `report`; pre-flight (key, catalog with tools, servers start once, estimate, abort unless `--yes`) | 6, 8, 9 |
| §3.7 follow-ups: completeness; unknown transport errors non-retryable; tool timeout policy (`tool_timeout_s`, `end: tool_timeout`); server version; nullable `successRate` docs; usage errors exit 2; atomic results/traces after building both; `fs_state` ENOENT-only | 2, 7, 1+8, 7+8+2, 2, 9, 9, 5 |
| §4.1 model objects with pins, `judge`, `defaults.tool_timeout_s`, plain strings for mock, `{fixture}` in prompts | 1, 8 |
| §4.2 code-navigation suite + answer-key test | 10 |
| §4.3 general-tools suite (filesystem + memory, `MEMORY_FILE_PATH`, ≤ 3 `llm_judge`) | 11 |
| §5 smoke + full run, $10 cap, resume, 402 | Wave E runbook (code: 8, 9) |
| §5.3 publish layout + `docs/methodology.md` | 12 |
| §6 offline tests (fake OpenRouter: tool calls, usage/cost, 429/500/402/401, malformed JSON, timeouts; tokenizer; cache/resume/manifest; validator; judge; compare; report; v1→v2; pre-flight vs fake catalog; both suites; answer key skipped offline) | 1–12 |
