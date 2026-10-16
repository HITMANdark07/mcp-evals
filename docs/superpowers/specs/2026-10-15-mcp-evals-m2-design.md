# mcp-evals — M2 Design (Real runs)

- **Date:** 2026-10-15
- **Status:** Approved design, pending spec review
- **Extends:** `2026-10-15-mcp-evals-design.md` (the base spec stays authoritative where this file is silent)
- **Inputs:** `docs/superpowers/plans/2026-10-15-m1-followups.md`

## 1. Goal

Produce the first real, reproducible results: a credible head-to-head of **NeatCode vs. the filesystem MCP server** on identical code-navigation tasks, plus a general tool-use suite, across four models via OpenRouter — published as `results.json` (schema v2) with a methodology note. Results are reported as measured, whichever way they fall.

**Success:** a committed real run within a $25 cap, `data/latest.json` validating against `ResultsSchema` v2, `docs/methodology.md`, and all tests offline and green.

**Out of scope:** GitHub Action and npm release (M3); leaderboard site (M4); git MCP server suite; providers other than OpenRouter.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Model lineup | `anthropic/claude-sonnet-5.5`, `openai/gpt-6.1-sol`, `google/gemini-3.8-flash`, `qwen/qwen3.8-flash` | Two frontier + two efficient, incl. one open-weight; est. full run $15–25 |
| Provider pinning | first-party: `anthropic`, `openai`, `google-ai-studio`, `alibaba`; `allow_fallbacks: false` | Comparable results; all four serve tools at list price (checked 2026-10-15) |
| Judge model | `anthropic/claude-haiku-5.5` pinned to `anthropic` | Cheap ($0.10/$0.50 per M), only runs after deterministic graders pass |
| Headline context metric | `gpt-tokenizer` `o200k_base`, identical for every model | Depends only on what the server returned → server-comparable; provider-reported prompt tokens kept as a secondary column |
| HTTP client | Node `fetch`, no SDK | Small surface, full control of error classification |
| Code-navigation fixture | `https://github.com/honojs/hono` v4.13.13 @ `08a023cbfde55b434fb0fb30fae35d42e4bf20aa` | Neutral, MIT, ~26k LOC TS; NeatCode indexes it in ~3 s |
| Budget | `--budget-usd 25` for the full run; smoke run first | User-approved |

## 3. Components

### 3.1 `providers/openrouter.ts` — `OpenRouterProvider implements ModelProvider`
- `POST https://openrouter.ai/api/v1/chat/completions` with `{ model, messages, tools, temperature, provider: { order: [slug], allow_fallbacks: false } }`. Messages/tools use the OpenAI chat format (assistant `tool_calls[{id, type:'function', function:{name, arguments}}]`, tool results `{role:'tool', tool_call_id, content}`).
- Pins come from the suite (§4.1). A model without a pin is a config error.
- Reads `usage.prompt_tokens`, `usage.completion_tokens`, `usage.cost` (credits, treated as USD; documented), and the serving provider from the response when present.
- API key only from `OPENROUTER_API_KEY`; never logged, traced, or written. The CLI loads a `.env` file from the working directory at startup with Node's built-in `process.loadEnvFile()` (no dependency); variables already set in the environment win. `.env` is git-ignored and `.env.example` (committed) documents the variables. Missing key → `ConfigError` before any work, with a hint to copy `.env.example` to `.env`.
- Errors: HTTP 429/5xx, network errors, and request timeouts → `ProviderError(retryable: true)`; 400/401/403/404 → `ProviderError(retryable: false)`; **402 (insufficient credits) → a dedicated `OutOfCreditsError`** that stops the whole run (no new runs, results so far kept, `partial: true`). Malformed response JSON → `ProviderError(retryable: false)`.
- Honors `ChatRequest.signal`.

### 3.2 `tokens.ts`
`countTokens(text: string): number` via `gpt-tokenizer` (`o200k_base`), replacing `estimateTokens` everywhere context tokens are measured. Traces additionally keep the provider-reported `promptTokens` per model call (already present).

### 3.3 Graders
- `answer_json_schema`: final answer must parse as JSON (optionally inside a fenced block) and satisfy a built-in validator supporting `type`, `properties`, `required`, `items`, `enum`, `minItems`, `additionalProperties: false`. No external dependency.
- `llm_judge`: `{ rubric, pass_threshold? }`; judge model/provider come from the suite's `judge:` block. Runs only if every deterministic grader passed. Sends the task prompt, the final answer, and the rubric; expects JSON `{ "pass": boolean, "reason": string }`. Verdict and reason stored in `GraderResult.detail`; judge cost added to the run's cost. Judge infra errors follow the provider retry rules; an unparseable verdict is a grader `fail` with reason.

### 3.4 Run cache and `--resume`
- Every finished `RunRecord` is appended to `.mcp-evals/runs/<runId>.jsonl` as it completes.
- `run --resume <runId>` reloads that file, skips completed `runKey`s, reuses the runId, and produces results over old + new records. Changing suites/models between resume runs → `ConfigError` (a manifest with suite hashes and options is stored next to the JSONL).

### 3.5 Results schema v2
Adds to each cell: `plannedRuns` (runs the plan scheduled for this cell), `complete` (`runs === plannedRuns`, where `runs` counts every record including `error` outcomes; budget-aborted and never-started runs make it false), `providerPromptTokensPerTask {mean, median}`; to each suite: `servers.<name>.version` (MCP `serverInfo.version`), `models[].provider` = pinned slug, `judge`. `successRate: number | null` (already). `schemaVersion: 2`. `aggregate` keeps producing v2; a `readResults()` helper accepts v1 and upgrades it (missing fields null/false).

### 3.6 CLI
- `run --provider openrouter` (new default) | `mock`; `--resume <runId>`; `--yes` to skip the cost confirmation.
- `compare <base.json> <head.json> [--max-success-drop 5] [--max-context-increase 20] [--format table|markdown|json]` → exit 1 on regression, 0 otherwise; compares cells by (suite, server, model); cells missing on either side are reported, not failures.
- `report <results.json> [--format table|markdown]`.
- Pre-flight before any spend (openrouter only): key present; every pinned model exists in `GET /api/v1/models` with `tools` support; every server starts and lists tools once; print planned runs and an estimate. If the estimate (from the smoke run's measured mean cost per run, or catalog prices × an assumed 25k prompt / 1k completion tokens per run) exceeds the budget, abort unless `--yes`.

### 3.7 M1 follow-ups included
From the follow-ups file's "Before any public leaderboard run": per-cell completeness (§3.5); `connection.ts` unknown transport errors → non-retryable; **tool timeout policy**: suite `defaults.tool_timeout_s` (default 60) — hitting it is a model `fail` (`end: 'tool_timeout'`), not infra; server version recorded; docs updated for nullable `successRate`. Also: CLI usage errors exit 2; write traces/results atomically after building both payloads; `fs_state` treats only `ENOENT` as missing.

## 4. Suites

### 4.1 Suite format additions
```yaml
models:
  - { id: anthropic/claude-sonnet-5.5, provider: anthropic }
judge: { id: anthropic/claude-haiku-5.5, provider: anthropic }
defaults: { tool_timeout_s: 60 }
```
Plain-string model entries remain valid for the mock provider. Task prompts may use `{fixture}` (absolute workspace path), substituted per run for every server alike.

### 4.2 `suites/code-navigation.yaml`
- Fixture: Hono v4.13.13 @ `08a023cbfde55b434fb0fb30fae35d42e4bf20aa`.
- Servers: `neatcode` — `npx -y @neatcodeai/mcp@0.1.4`, setup `npx -y @neatcodeai/cli@0.1.4 init`; `filesystem` — `npx -y @modelcontextprotocol/server-filesystem@1.0.0 {fixture}`.
- ~12 tasks (callers, definitions, importers, middleware chain, interface implementations, rename impact). Deterministic graders (`answer_contains_all` on repo-relative paths/symbols). Every prompt states "The repository is at {fixture}."
- An answer-key test verifies every expected path exists and every expected symbol occurs in the pinned fixture (skipped without network/cache).

### 4.3 `suites/general-tools.yaml`
- Same fixture. Servers: `filesystem` (as above) and `memory` (`npx -y @modelcontextprotocol/server-memory@1.0.0`, with `MEMORY_FILE_PATH={fixture}/.memory.json` so each run's memory is isolated in its workspace).
- ~12 tasks: read-and-answer, structured answers (`answer_json_schema`), file edits (`fs_state`), multi-step memory tasks; at most 3 tasks use `llm_judge`.

## 5. Execution of the real run
1. Smoke: `code-navigation`, 3 tasks, `qwen/qwen3.8-flash`, 1 repeat → measures mean cost per run.
2. Full: both suites, all models, 3 repeats, `--budget-usd 25`. Pre-flight estimate must fit or the run asks first.
3. Publish: `data/runs/<runId>/results.json`, `data/runs/<runId>/traces.jsonl.gz`, `data/latest.json` (copy of the full run's results), and `docs/methodology.md` (tokenizer, pinned models/providers, fairness rules, setup time excluded from latency, provider-reported tokens column, known limitations, date of catalog checks).

The live run is never part of the test suite; it runs only with the user's key in their own shell.

## 6. Testing
Offline only: a local fake HTTP server for OpenRouter (tool calls, usage/cost, 429/500/402/401, malformed JSON, timeouts); tokenizer; run cache/resume and manifest mismatch; `answer_json_schema` validator; `llm_judge` with the fake server; `compare` thresholds and exit codes; `report`; v1→v2 results upgrade; pre-flight checks against a fake catalog; suite loading for both real suites; answer-key test (skipped offline).

## 7. Build waves
A: schema v2 + types, tokenizer · B (parallel): OpenRouter provider; run cache + resume; new graders; `compare` + `report`; M1 follow-ups · C: CLI/runner wiring + pre-flight · D: suites + answer keys + methodology · E: live smoke + full run (needs the user's key; spends money).

## 8. Open decisions
- Final task lists and answer keys (authored and verified in wave D).
