# mcp-evals methodology

How mcp-evals measures MCP servers and the models that use them, and what the numbers in `data/latest.json` mean. Results are reported as measured, whichever way they fall.

## What one run is

A **run** is one (suite, server, model, task, repeat). For every run the harness copies the pinned fixture into a fresh temporary workspace (without `.git`), runs the server's `setup` command there (for NeatCode: `npx -y @neatcodeai/cli@0.1.4 init`, which indexes the repo), starts a fresh server process, lists its tools, and runs its own agent loop: system prompt + task prompt → model → tool calls executed over MCP → results appended → repeat until the model answers without calling tools or a limit is hit.

## Outcomes

- **pass** — the model gave a final answer and every decisive grader passed.
- **fail** — the model misbehaved or answered wrongly: a grader failed, it called an unknown tool or sent invalid JSON arguments, it hit `max_steps` or the run timeout, or **one tool call exceeded the per-call tool timeout** (`defaults.tool_timeout_s`, 60 s; recorded as `end: tool_timeout`). The **run timeout includes model latency**: it is wall time of the whole agent loop, model calls and tool calls alike, so a slow provider can turn into a timeout fail.
- **error** — infrastructure failed: the server crashed or could not start, setup failed, the model API failed (429, 5xx, network, request timeout, or a non-retryable 4xx), a grader names a tool the server does not expose (a suite bug, recorded before any model call), or an unexpected exception occurred in the harness. Transient model-API errors are retried with backoff of 2 s, 10 s, then 30 s; transient server-start failures with 0.5 s, 1 s, 2 s (at most 3 retries either way). Errors are reported in `errorRate`, excluded from `successRate`, and counted as failures in `successRateWithErrors`.

## Metrics

- **Success rate** — `successRate` = passes / (passes + fails) per cell (server × model), with a **Wilson 95% confidence interval**; errors are excluded. `null` when a cell has no completed runs.
- **Success rate with errors** — `successRateWithErrors` = passes / runs: every error counts as a failure. `null` when a cell has no runs. A server that crashes often looks better on `successRate` than on this one; when comparing servers, read both, together with `errorRate`.
- **Context tokens per task (headline)** — the tokens of text returned by MCP tool calls during the run, counted with **`gpt-tokenizer` `o200k_base` for every model** (special-token text such as `<|endoftext|>` is counted as text). It is the same tokenizer for every model: a **proxy** for how much text the server put into the context, not each model's own token count. Tool-schema tokens (the tool list sent with every request) are **not** included. Because it depends only on what the server returned, it is comparable across servers and models. Reported as mean and median per cell.
- **Provider-reported prompt tokens per task (secondary)** — the sum of `usage.prompt_tokens` over the run's agent model calls, as reported by OpenRouter. It includes the system prompt, tool schemas and the growing conversation, and uses each model's own tokenizer, so it is **not** comparable across models; it is what the run was billed for.
- **Tool accuracy** — share of completed runs whose `tool_called` / `tool_args_match` graders passed (`null` when a cell has none).
- **Steps** — model calls per run. **Latency (p50)** — wall time of the agent loop only: it **excludes** copying the fixture, the server's setup command (e.g. NeatCode indexing), starting the server, and listing its tools.
- **Cost** — OpenRouter's `usage.cost` for each call (credits, treated as USD), including `llm_judge` calls. If a response lacks `usage.cost`, the catalog price × reported tokens is used instead. If neither is available, the cost **cannot be determined and the whole run stops** (`STOPPED: cost could not be determined …`, resumable), because the budget cap could no longer be enforced. A request aborted after it was sent (run timeout or the 120 s request timeout) is charged a conservative estimate — the o200k tokens of its messages and tools × the catalog prompt price — and an error response that reports `usage.cost` is charged that cost. A retried run's cost includes its failed attempts, including failed judge attempts.
- **Per-task metrics exclude error runs**: context tokens, provider prompt tokens, steps, latency and `costUsdPerTask` are computed over pass and fail runs only. `totalCostUsd` covers all spend, errors and cut-off runs included.

## Grading

Deterministic graders run first: `answer_contains_all` (case-insensitive substring match on repo-relative paths and symbols), `answer_matches`, `answer_json_schema` (a built-in JSON Schema subset), `tool_called` / `tool_not_called` / `tool_args_match`, and `fs_state` (file exists / contains / unchanged after the run, judged against a snapshot taken after setup and server start). Budget graders (`max_steps`, `max_context_tokens`) are recorded but decide nothing unless `strict`. `llm_judge` runs **only** when a final answer exists and every decisive deterministic grader passed; the judge returns `{"pass", "score", "reason"}` and the verdict and reason are stored in the trace. Without `pass_threshold` the judge's `pass` decides; with one, pass = `score >= pass_threshold` (a verdict without a score fails). An unparseable verdict, or a score outside 0–1, is a grader **fail** with the reason recorded, not an error.

The code-navigation graders check symbols with word-boundary `answer_matches` patterns (so `RegExpRouter` is not satisfied by `PreparedRegExpRouter`, and words such as `route`, `every`, `match` or `compose` count only when named as code or next to their file), check that each entry point is paired with its own routers and that a call chain is in order, and add **decoy** checks to list tasks: naming a plausible-but-wrong file (grep-verified not to contain what the task asks about) fails the run. The answer-key test verifies every expected path, symbol and decoy against the pinned fixture.

## Fairness rules

- One system prompt for every model: *"You are an agent completing a task with the tools provided. Use tools when they help. When you are finished, reply with your final answer as plain text and do not call any more tools."*
- Tool schemas are converted by one function and sorted by name, identically for every model.
- Temperature 0. Limits are identical across models and servers for a given task: the suite defaults (code-navigation: 12 steps, 180 s run timeout, 60 s per tool call), which a task may override for itself.
- A fresh workspace and a fresh server process per run. `{fixture}` is replaced by the workspace's real absolute path, identically in the prompt and in every server's arguments and environment.
- Every model is pinned to one provider with `allow_fallbacks: false`, so a cell is never served by a mix of providers.
- Models that return reasoning metadata (`reasoning_details`) get it back unchanged on later turns, as their providers require for multi-turn tool use; it is never graded or traced.
- Setup commands, servers and fixture `git` run with a minimal environment (`PATH`, `HOME`, … plus the server's own `env`), never with `OPENROUTER_API_KEY`.

## Pinned configuration (first real run)

| Item | Value |
|---|---|
| Models (OpenRouter id → provider) | `anthropic/claude-sonnet-5.5` → `anthropic`; `openai/gpt-6.1-sol` → `openai`; `google/gemini-3.8-flash` → `google-ai-studio`; `qwen/qwen3.8-flash` → `alibaba` |
| Judge | `anthropic/claude-haiku-5.5` → `anthropic` |
| Fixture | `https://github.com/honojs/hono` v4.13.13 @ `08a023cbfde55b434fb0fb30fae35d42e4bf20aa` |
| Servers | `@neatcodeai/mcp@0.1.4` (setup `@neatcodeai/cli@0.1.4 init`); `@modelcontextprotocol/server-filesystem@1.0.0`; `@modelcontextprotocol/server-memory@1.0.0` (general-tools) |
| Tokenizer | `gpt-tokenizer` `o200k_base` |
| Repeats | 2 (code-navigation first run) |

`results.json` also records the harness version and commit (`harnessCommit`, `git rev-parse --short HEAD` of the harness checkout; `null` outside a checkout), each server's command, args and setup as written in the suite and its reported `serverInfo.version`, and each planned model with its pinned provider. Catalog checks: on 2026-10-15 all four models were served with tool support at list price by their pinned providers; list prices on 2026-10-16 (USD per million prompt / completion tokens): Sonnet 5.5 2 / 10, GPT-6.1 Sol 2 / 10, Gemini 3.8 Flash 0.825 / 4.125, Qwen3.8 Flash 0.15 / 0.47, Haiku 5.5 0.10 / 0.50.

## Budget, partial runs and completeness

Every run invocation has a cap (`--budget-usd`). Before spending, the CLI checks the key, the model catalog (every model exists, supports tools, has a pin), starts every server once, and prints the planned runs and an estimate (measured cost per run from an earlier run where available, otherwise catalog price × 25k prompt + 1k completion tokens per run); it refuses to start when the estimate exceeds the cap unless `--yes`.

The cap is checked before every model call, so it is **per-call granular**: spend can overshoot it by at most one in-flight model call plus that run's judge calls. At the cap no new run starts and the in-flight run stops before its next model call (its cost counts, it gets no record). The run stops the same way, with a `STOPPED: <reason>` line, when OpenRouter reports the key out of credits (HTTP 402, or 403 for a key/credit limit), when a call's cost cannot be determined, or when one model produces 3 consecutive error runs with the same provider error. The results are then written with `partial: true`, and each cell reports `plannedRuns` and `complete` (`runs === plannedRuns`; error runs count as runs). The CLI prints the exact command to resume: `mcp-evals run … --resume <runId> --budget-usd <amount>`, which finishes the remaining runs without re-running finished ones. On a resume `--budget-usd` caps only the **new** spend of that invocation, while `totalCostUsd` reports all spend of the run, including cut-off runs. Runs that ended in an error count as finished; `--resume <runId> --retry-errors` runs them again (the new record replaces the old one, whose cost stays in the total). Incomplete cells are never compared as if complete.

## Known limitations

- Small samples: 2 repeats per task give wide confidence intervals; read the intervals, not just the point estimates.
- The Wilson intervals assume independent runs. Runs are clustered by task (the same task repeated, and tasks of different difficulty), so the intervals are **optimistic**: the real uncertainty is larger.
- Graders check that expected paths and symbols appear, and decoys catch a few plausible-but-wrong files; they do not penalise every extra or wrong item in an answer. A decoy also fails an answer that names the decoy file only to say it is not part of the answer.
- One fixture (a single TypeScript repository); results may not transfer to other languages or repo sizes.
- Even at temperature 0, providers are not perfectly deterministic, and provider-side model updates can change results under the same id.
- The filesystem server has no content search, so it must read files to answer; that difference is what the head-to-head measures.
- The harness author also wrote NeatCode. Tasks, answer keys and graders are public in `suites/`, and every trace is published, so the comparison can be audited.

## Data layout

`data/runs/<runId>/results.json` (schema v2), `data/runs/<runId>/traces.jsonl.gz` (one JSON trace per run), and `data/latest.json` (a copy of the latest full run's results). Written by `mcp-evals publish <results.json> --traces <traces.jsonl> [--latest]`. `publish` refuses partial results unless `--allow-partial` is given — so `publish --latest` never makes a partial run the latest one by accident — and refuses to overwrite a published run. The `runId` must be a single safe path segment (letters, digits, `.`, `_`, `-`). `publish` also refuses (exit 2) results or traces that contain `sk-or-` or the current `OPENROUTER_API_KEY`, and warns when traces contain `/Users/` paths.

## Reproducing

```bash
cp .env.example .env            # add OPENROUTER_API_KEY
pnpm install && pnpm build
node packages/cli/dist/index.js run suites/code-navigation.yaml --budget-usd 10 --out results.json --traces traces.jsonl
# if it stops, run the printed resume command with a new --budget-usd
node packages/cli/dist/index.js report results.json --format markdown
```
