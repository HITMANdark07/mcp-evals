# mcp-evals — Design Spec

- **Date:** 2026-10-15
- **Author:** Shekhar Kumar
- **Status:** Approved design, pending spec review
- **Working name:** `mcp-evals` (repo/folder). npm package name is an open decision (see §11).

## 1. Purpose

An open-source TypeScript harness that benchmarks **MCP servers and the models that use them** on realistic agent tasks, plus a public, interactive **leaderboard**.

v1 is **leaderboard-led**: the first deliverable is a credible public leaderboard of a few MCP servers × models, built on a harness that is also usable as a CI regression gate.

### Goals

1. Measure, per task: task success, tool-selection accuracy, **context tokens returned by each tool call**, steps, latency, and USD cost.
2. Make runs fair and reproducible across models (identical prompts, tool schemas, limits; pinned model IDs, provider, and fixture commit).
3. Publish results as a versioned `results.json` consumed by the CLI, the GitHub Action, the leaderboard site, and the author's portfolio.
4. Run entirely on free infrastructure: GitHub Actions for execution, Cloudflare Pages for the leaderboard, npm for distribution. Only model tokens cost money, bounded by a hard budget cap.

### Success criteria

- Public repo, published npm CLI, and a live leaderboard covering the two v1 suites (§5.4) across ~4 models.
- Methodology documented in README and on the leaderboard.
- NeatCode's CI uses the GitHub Action as a regression gate.
- Headline result reproducible from a pinned config: context-cost vs. accuracy for NeatCode vs. the filesystem MCP server on identical tasks.

### Non-goals (v1)

Hosted service or database; task-authoring UI; simulated multi-turn users; remote-server auth beyond a static token header; providers other than OpenRouter (interface ready, not implemented); fine-tuning or self-hosted models.

## 2. Key decisions

| Decision | Choice | Why |
|---|---|---|
| Execution | **Own minimal agent loop** on the official MCP TypeScript SDK | Measurement is the product; frameworks add hidden prompts/retries and hide per-tool token counts |
| Model access | **OpenRouter** (OpenAI-compatible chat completions with tools), behind a `ModelProvider` interface | One key, many models; direct providers can be added later |
| Language / layout | TypeScript, pnpm monorepo, vitest, tsup | Matches NeatCode; MCP SDK is first-class in TS |
| Leaderboard hosting | Static Next.js export on **Cloudflare Pages** | Free, static, shareable |
| Portfolio integration | Portfolio (Vercel) fetches `latest.json` at build time, falls back to a vendored snapshot | Leaderboard outage never breaks the portfolio |
| License | MIT | Same as NeatCode |

## 3. Architecture

```
                      ┌────────────── packages/core ───────────────┐
 suite.yaml ──▶ Loader │  Runner: for server × model × task × repeat │
 (tasks,      (zod)    │   ┌───────────┐  tools   ┌──────────────┐  │
  graders,             │   │ MCP Client │◀───────▶│  Agent Loop   │  │──▶ traces.jsonl
  servers,             │   │ stdio/HTTP │ results  │ (max steps,   │  │
  models)              │   └─────┬─────┘          │  timeout, $cap)│  │
                       │   fresh server +          └──────┬───────┘  │──▶ results.json
                       │   temp fixture per task          │          │
                       │                          ┌──────▼───────┐  │
                       │   Graders ◀── trace ──── │ ModelProvider │  │
                       │                          │  OpenRouter   │  │
                       │                          └──────────────┘  │
                       └─────────────────────────────────────────────┘
        results.json ──┬──▶ packages/cli      run · compare · report
                       ├──▶ packages/action   PR comment + regression gate
                       └──▶ scheduled workflow commits data/ ──▶ apps/leaderboard (Cloudflare Pages)
                                                                  └──▶ portfolio (Vercel) at build time
```

### 3.1 Repository layout

```
mcp-evals/
  packages/
    core/        loader, mcp client manager, providers, agent loop, recorder, graders, aggregator, schemas
    cli/         `run`, `compare`, `report`
    action/      GitHub Action wrapper (action.yml + entry)
  apps/
    leaderboard/ static Next.js export
  suites/        code-navigation.yaml, general-tools.yaml
  data/          latest.json, runs/<date>.json  (committed by the scheduled workflow)
  .github/workflows/  ci.yml (tests + smoke), full-run.yml (manual + monthly)
```

### 3.2 Components (core)

Each unit has one purpose and is testable in isolation.

- **Suite loader** — parses YAML, validates with zod, resolves `{fixture}` placeholders. Rejects unknown grader types and unpinned model IDs.
- **Fixture manager** — clones the fixture repo at the pinned `ref` once into a cache, then copies it into a fresh temp directory per task run; deletes it afterward.
- **MCP client manager** — starts a **fresh server process per task run** (stdio) or connects to a URL (Streamable HTTP, optional static token header); runs the server's optional `setup` command in the fixture first; captures server stderr into the trace; tears the server down after the run.
- **ModelProvider** interface — `chat({ messages, tools, temperature, maxTokens }) → { message, toolCalls, usage: { promptTokens, completionTokens, costUsd }, latencyMs }`. First implementation: `OpenRouterProvider`, which pins the provider (`provider.order`, `allow_fallbacks: false`) so results stay comparable.
- **Tool schema converter** — converts MCP tool definitions into OpenAI-style function tools, identically for every model. Lives in one place so fairness is auditable.
- **Agent loop** — system prompt + task prompt → model → tool calls executed via MCP → results appended → repeat until the model gives a final answer or a limit is hit (`max_steps`, `timeout_s`, per-run and global USD cap).
- **Recorder** — appends trace events (`model_call`, `tool_call`, `tool_result`, `final_answer`, `error`) with timestamps, latency, token counts, and cost. Tool-result tokens are counted per call (tokenizer estimate) and cross-checked against provider-reported prompt-token deltas.
- **Graders** — pure functions `(trace, finalAnswer, workspace) → { pass, score?, detail }`.
- **Aggregator** — groups by server × model × task, computes pass rate with a **Wilson 95% confidence interval**, means/medians for tokens, steps, latency, and cost.

## 4. Data contracts

### 4.1 `results.json` (versioned)

```ts
interface Results {
  schemaVersion: 1;
  harnessVersion: string;
  runId: string;
  startedAt: string; finishedAt: string;
  partial: boolean;                 // true if the budget cap stopped the run
  totalCostUsd: number;
  suites: Array<{
    suite: string; suiteVersion: number;
    fixture: { git: string; ref: string };
    servers: Record<string, { command?: string; url?: string; version?: string }>;
    models: Array<{ id: string; provider: string }>;   // pinned OpenRouter id + routed provider
    cells: Array<{                                       // one per server × model
      server: string; model: string;
      successRate: number | null; successCi95: [number, number];   // null when the cell has no completed (pass/fail) runs
      toolAccuracy: number;
      contextTokensPerTask: { mean: number; median: number };
      stepsPerTask: number; latencyMsP50: number; costUsdPerTask: number;
      errorRate: number;                                 // infra errors, excluded from success
      tasks: Array<{ id: string; passes: number; fails: number; errors: number; traceRef: string }>;
    }>;
  }>;
}
```

A zod schema is the source of truth; a JSON Schema is exported for the leaderboard and portfolio. **Schema v2 (M2)** sets `schemaVersion: 2` and adds, per cell, `plannedRuns`, `complete` (`runs === plannedRuns`) and `providerPromptTokensPerTask`; per suite, `servers.<name>.version` (MCP `serverInfo.version`) and `judge`; `toolAccuracy` is `number | null`. `readResults()` reads v1 files and upgrades them (new fields null/false). See `2026-10-15-mcp-evals-m2-design.md` §3.5.

### 4.2 Traces

`traces.jsonl`: one event per line, keyed by `runKey = hash(server, model, task, repeat)`. Full traces are uploaded as GitHub Actions artifacts. For the replay viewer, one compressed trace per task (first repeat by default) is committed under `data/traces/`.

## 5. Suites, graders, fairness

### 5.1 Suite format

```yaml
suite: code-navigation
version: 1
fixture:
  git: https://github.com/<org>/<mid-size-ts-repo>
  ref: <commit-sha>
servers:
  neatcode:   { command: npx, args: ["-y", "@neatcodeai/mcp"], setup: "npx -y @neatcodeai/cli init" }
  filesystem: { command: npx, args: ["-y", "@modelcontextprotocol/server-filesystem", "{fixture}"] }
models: [anthropic/<sonnet>, openai/<gpt>, google/<gemini>, qwen/<open-weight>]
defaults: { repeats: 3, max_steps: 12, timeout_s: 120, temperature: 0 }
tasks:
  - id: find-callers
    prompt: "Which functions call `validateDiff`? List file:line for each."
    graders:
      - { type: answer_contains_all, values: ["src/cli/index.ts", "src/mcp/tools/validate.ts"] }
      - { type: max_context_tokens, value: 8000 }
```

Placeholders like `<org>` and model IDs are filled with concrete pinned values when suites are authored (milestone M2); the loader rejects them if left unresolved.

### 5.2 Graders (v1)

| Type | Kind | Checks |
|---|---|---|
| `answer_contains_all` | deterministic | final answer contains every value |
| `answer_matches` | deterministic | regex match |
| `answer_json_schema` | deterministic | final answer parses and validates |
| `tool_called` / `tool_not_called` | deterministic | trace contains (or lacks) a call to server/tool |
| `tool_args_match` | deterministic | a call's arguments match a partial object |
| `fs_state` | deterministic | file exists / contains / unchanged in the workspace after the run |
| `max_steps`, `max_context_tokens` | budget | scored, recorded; do not fail the task unless `strict: true` |
| `llm_judge` | model-graded | pinned judge model + rubric; verdict and rationale stored in the trace |

A task passes when all non-budget graders pass. Deterministic graders run first; `llm_judge` runs only if they pass (saves cost).

### 5.3 Fairness rules

Identical system prompt and converted tool schemas for every model; temperature 0 where supported; fresh server and fixture per run; identical step/time/cost limits; pinned model IDs, provider, fixture commit, and harness version recorded in `results.json`.

### 5.4 v1 content

- **code-navigation** (~12 tasks): NeatCode vs. filesystem MCP on the same pinned TypeScript fixture.
- **general-tools** (~12 tasks): filesystem + git MCP servers.
- ~4 models via OpenRouter, spanning frontier and open-weight.

## 6. CLI

```
mcp-evals run <suite.yaml...> [--models a,b] [--servers x,y] [--repeats n] [--budget-usd n]
                              [--resume] [--out results.json] [--traces traces.jsonl]
mcp-evals compare <base.json> <head.json> [--max-success-drop 5] [--max-context-increase 20]
                              [--format table|markdown|json]          # exit 1 on regression
mcp-evals report <results.json> [--format table|markdown]
```

Requires `OPENROUTER_API_KEY` for `run`. `--resume` reads a local run cache keyed by `runKey` and skips completed runs.

## 7. Error handling

- Run outcomes: **pass**, **fail**, **error**. Errors are infrastructure only: server crash/exit, model API 429/5xx, timeouts in transport. They are retried with exponential backoff (max 3); persistent errors are reported in `errorRate` and **excluded** from success rate.
- Model misbehavior (invalid tool name, invalid JSON arguments, exceeding `max_steps`) is a **fail** with a recorded reason.
- Budget cap reached → stop scheduling new runs, finish in-flight ones, write `partial: true`.
- Unresolved placeholders, unknown graders, or unpinned models → loader error before any spend.
- Server stderr and the failing step are always captured in the trace.

## 8. CI and deployment

| Workflow | Trigger | Does | Cost |
|---|---|---|---|
| `ci.yml` | push / PR | lint, typecheck, unit + e2e (mock) tests; smoke run (1 cheap model, 1 repeat, subset) when secrets exist; forks skip smoke | cents |
| `full-run.yml` | manual dispatch + monthly cron | full suites × models × repeats with budget cap (default $15); upload traces artifact; commit `data/` | ≈ $10–40 per run, capped |
| Cloudflare Pages | commit to `data/` or `apps/leaderboard` | build static leaderboard | free |
| npm publish | tagged release | publish CLI (and core) | free |
| NeatCode repo | PR | uses the Action against NeatCode's main-branch baseline; fails on regression | cents |

Secrets: `OPENROUTER_API_KEY` (GitHub Actions secret). Cloudflare Pages connects to the GitHub repo directly.

## 9. Leaderboard (apps/leaderboard)

Static Next.js export reading `data/latest.json` and `data/traces/` at build time.

1. **Overview**: sortable model × server table (success ± CI, tool accuracy, context tokens, $/task, latency); `partial` and error rates surfaced.
2. **Head-to-head**: context-cost vs. accuracy chart, NeatCode vs. filesystem.
3. **Task drilldown + trace replay**: step-by-step tool calls with tokens returned per step; embeddable.
4. **Methodology**: fairness rules, pinned IDs, measurement definitions, known limitations.

**Visual treatment** ("live instruments in a calm shell"):

- **Signature component — the eval matrix:** a tasks × models grid whose cells fill with pass/fail as a *replay of a real run's JSON* (labelled "replay of run <runId>, <date>", never "live"). Clicking a cell opens the trace as a DevTools-style waterfall of tool calls with timings and tokens per step. The same component is exported for the portfolio embed and used as the README demo (recorded GIF).
- **Libraries:** React + CSS grid + Motion (`m` + `LazyMotion`, `layout` animations). No 3D, no scroll-jacking.
- **Guardrails:** `prefers-reduced-motion` → matrix renders in its final state with a Play button; auto-playing motion has a visible pause control (WCAG 2.2.2); pass/fail uses icon + colour, never colour alone; every chart has a text/table equivalent; animate only `transform`/`opacity`; interactive pieces are lazy client islands behind a static, fixed-aspect poster (no CLS).

## 10. Testing

- **Unit (vitest):** loader/validation, each grader, Wilson CI math, aggregator, `compare` thresholds, tool schema converter.
- **End-to-end, offline:** scripted `MockProvider` + in-process fake MCP server → runner, retries, resume, budget cap, partial results. No network, no cost.
- **Contract:** every produced `results.json` validates against the zod schema; leaderboard builds against fixture data.
- **Live smoke:** the `ci.yml` subset run.

## 11. Milestones

1. **M1 Core:** runner, MockProvider, fake MCP server, deterministic graders, `run` → table.
2. **M2 Real runs:** OpenRouterProvider, token/cost accounting, repeats + CI, `compare`, `--resume`, budget cap; author the two suites with pinned IDs; first real NeatCode vs. filesystem run.
3. **M3 CI:** GitHub Action with PR comment; NeatCode CI gate; first npm release.
4. **M4 Leaderboard:** four views on Cloudflare Pages; `full-run.yml`.
5. **M5 Showcase:** portfolio embed + write-up.

## 12. Open decisions

- **npm package name.** `mcp-evals` and `mcp-bench` are taken on npm; `mcpbench` and `toolbench-mcp` are available (checked 2026-10-15). Decide before M3.
- **Fixture repository** for code-navigation (a mid-size, permissively licensed TypeScript repo, pinned commit). Decide in M2.
- **Concrete model IDs and judge model.** Decide in M2 based on current OpenRouter pricing.
