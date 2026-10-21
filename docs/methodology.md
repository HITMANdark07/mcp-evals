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
- **Tool accuracy** — share of completed runs whose `tool_called` / `tool_args_match` graders passed (`null` when no completed run in the cell has such graders; the code-navigation suite has none).
- **Invalid tool calls** — `invalidToolCallRate`: share of completed runs that ended because the model called a tool the server does not expose (or sent arguments that are not valid JSON). Such a run is a fail; this metric shows how often that was the reason.
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
| Models (OpenRouter id → provider) | `anthropic/claude-sonnet-5.5` → `anthropic` (smoke run only, see below); `openai/gpt-6.1-sol` → `openai`; `google/gemini-3.8-flash` → `google-ai-studio`; `qwen/qwen3.8-flash` → `alibaba` |
| Judge | `anthropic/claude-haiku-5.5` → `anthropic` (general-tools only; code-navigation has no `llm_judge` tasks) |
| Fixture | `https://github.com/honojs/hono` v4.13.13 @ `08a023cbfde55b434fb0fb30fae35d42e4bf20aa` |
| Servers | `@neatcodeai/mcp@0.1.4` (setup `@neatcodeai/cli@0.1.4 init`); `@modelcontextprotocol/server-filesystem@1.0.0`; `@modelcontextprotocol/server-memory@1.0.0` (general-tools) |
| Tokenizer | `gpt-tokenizer` `o200k_base` |
| Repeats | 2 (code-navigation first run) |

`results.json` also records the harness version and commit (`harnessCommit`, `git rev-parse --short HEAD` of the harness checkout; `null` outside a checkout), each server's command, args and setup as written in the suite and its reported `serverInfo.version`, and each planned model with its pinned provider. Catalog checks: on 2026-10-15 all four models were served with tool support at list price by their pinned providers; list prices on 2026-10-16 (USD per million prompt / completion tokens): Sonnet 5.5 2 / 10, GPT-6.1 Sol 2 / 10, Gemini 3.8 Flash 0.825 / 4.125, Qwen3.8 Flash 0.15 / 0.47, Haiku 5.5 0.10 / 0.50.

## First real run (2026-10-16)

Run `2026-10-16T11-09-26-158Z-3e36fe`: suite `code-navigation`, 12 tasks × 2 repeats × 2 servers × 3 models = 144 runs. Every cell is complete (24/24) with no error runs left. Published as `data/runs/2026-10-16T11-09-26-158Z-3e36fe/` and `data/latest.json`. The runs executed at harness commit `691c0ec`; the published `results.json` was then re-aggregated from the same cached run records at `f692ef5`, which fixed how tool accuracy is computed and added `invalidToolCallRate` (no run, grade or cost changed), so its `harnessCommit` is `f692ef5` and its `finishedAt` is the re-aggregation time.

| Server | Model | Success (95% CI) | Invalid tool calls | Context tokens, median (mean) | Provider prompt tokens, median | Steps | Latency p50 | $/task |
|---|---|---|---|---|---|---|---|---|
| neatcode | `openai/gpt-6.1-sol` | 100% [86–100%] | 0% | 3,235 (4,843) | 35,716 | 6.0 | 19.1 s | $0.0214 |
| filesystem | `openai/gpt-6.1-sol` | 100% [86–100%] | 0% | 8,390 (11,987) | 22,116 | 4.4 | 15.9 s | $0.0395 |
| neatcode | `google/gemini-3.8-flash` | 0% [0–14%] | 0% | 13,010 (13,414) | 162,382 | 12.0 | 39.7 s | $0.0993 |
| filesystem | `google/gemini-3.8-flash` | 25% [12–45%] | 0% | 42,889 (54,547) | 415,440 | 11.3 | 53.4 s | $0.1155 |
| neatcode | `qwen/qwen3.8-flash` | 8% [2–26%] | 33% | 13,541 (11,855) | 119,564 | 7.1 | 180.0 s | $0.0084 |
| filesystem | `qwen/qwen3.8-flash` | 25% [12–45%] | 42% | 13,420 (29,701) | 45,026 | 5.7 | 44.3 s | $0.0113 |

What the traces show, as measured:

- **GPT-6.1 Sol** answered every task correctly on both servers. With NeatCode it pulled about 60% fewer tool-result tokens into context (median 3.2k vs 8.4k) but took more steps (6.0 vs 4.4), so its provider-reported prompt tokens were *higher* (median 35.7k vs 22.1k): the headline context metric excludes tool schemas and the re-sent conversation, and this is where that matters. Its billed cost per task was still lower with NeatCode.
- **Gemini 3.8 Flash** called only real tools, but kept exploring instead of answering: with NeatCode all 24 runs hit the 12-step limit; with the filesystem server 18 of 24 did (the other 6 passed).
- **Qwen3.8 Flash** often called tools that do not exist (e.g. `grep_files`, `Bash`, `mcp__local__get_repo_overview`), which fails the run at once: 8 of 24 runs with NeatCode, 10 of 24 with the filesystem server. With NeatCode a further 13 runs hit the 180 s run timeout (filesystem: 5). In those 13 runs the model calls took 2,097 s in total and the tool calls 2.8 s, so the timeouts came from slow model responses (about 19 s per call on average) on long prompts (median provider prompt 119.6k tokens with NeatCode vs 45.0k with the filesystem server), not from slow tools.
- Both flash models scored lower with NeatCode than with the filesystem server. The traces show *how* they failed (above) but not a single cause, so this run does not establish *why*.
- **Follow-up (2026-10-21, no re-run yet):** replaying the models' tool calls against NeatCode 0.1.4 showed that `find_node` found none of `compose`, `every`, `mergePath`, `timingSafeEqual`, `getCookie` or `checkOptionalParameter`: 0.1.4 did not index functions written as `export const f = (...) => ...` unless they returned JSX or were decorator factories, and Hono writes most of its functions that way. NeatCode 0.1.5 indexes them (on this fixture: 82 → 592 function nodes, 2,300 → 5,517 edges) and the same calls now resolve. The table above is for 0.1.4; whether 0.1.5 changes the flash models' results needs a new run.

Scope and budget: the agreed cap for the first real run was $10. A smoke run (2 tasks, all four models, 1 repeat; run `2026-10-16T10-22-05-097Z-fa96ce`, $1.26) measured per-run cost. `anthropic/claude-sonnet-5.5` cost about $0.19 per run there (4/4 passes), which would have put the full run over the cap, so it was **dropped from the full run for budget reasons**, not because of its results. The full run cost **$7.10** (smoke + full: $8.36). It took four invocations of the same run id: the first two stopped after 3 consecutive `429` responses from Alibaba for Qwen (OpenRouter showed the endpoint up, and the 429s cleared after waiting), the third finished every remaining run with 4 Qwen runs still ending in a `429` error, and a final `--retry-errors` re-ran those 4, all of which completed as pass or fail.

## Budget, partial runs and completeness

Every run invocation has a cap (`--budget-usd`). Before spending, the CLI checks the key, the model catalog (every model exists, supports tools, has a pin), starts every server once, and prints the planned runs and an estimate (measured cost per run from an earlier run where available, otherwise catalog price × 25k prompt + 1k completion tokens per run); it refuses to start when the estimate exceeds the cap unless `--yes`.

The cap is checked before every model call, so it is **per-call granular**: spend can overshoot it by at most one in-flight model call plus that run's judge calls. At the cap no new run starts and the in-flight run stops before its next model call (its cost counts, it gets no record). The run stops the same way, with a `STOPPED: <reason>` line, when OpenRouter reports the key out of credits (HTTP 402, or 403 for a key/credit limit), when a call's cost cannot be determined, or when one model produces 3 consecutive error runs with the same provider error. The results are then written with `partial: true`, and each cell reports `plannedRuns` and `complete` (`runs === plannedRuns`; error runs count as runs). The CLI prints the exact command to resume: `mcp-evals run … --resume <runId> --budget-usd <amount>`, which finishes the remaining runs without re-running finished ones. On a resume `--budget-usd` caps only the **new** spend of that invocation, while `totalCostUsd` reports all spend of the run, including cut-off runs. Runs that ended in an error count as finished; `--resume <runId> --retry-errors` runs them again (the new record replaces the old one, whose cost stays in the total). Incomplete cells are never compared as if complete.

## Known limitations

- Small samples: 2 repeats per task give wide confidence intervals; read the intervals, not just the point estimates.
- The Wilson intervals assume independent runs. Runs are clustered by task (the same task repeated, and tasks of different difficulty), so the intervals are **optimistic**: the real uncertainty is larger.
- Graders check that expected paths and symbols appear, and decoys catch a few plausible-but-wrong files; they do not penalise every extra or wrong item in an answer. A decoy also fails an answer that names the decoy file only to say it is not part of the answer. Some tasks check only that the right files appear, not how they relate: `two-merge-paths` passes an answer that names all four files even if it pairs each definition with the wrong user.
- Ceiling effect: in the first real run GPT-6.1 Sol passed every task on both servers, so for a strong model this suite cannot show whether a server improves accuracy, only what it costs in context, steps and money. Harder tasks are needed to separate servers on accuracy at that level.
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
# The first real run's three models (about $7). Without --models the suite also runs
# anthropic/claude-sonnet-5.5, which adds about $9 (48 runs at about $0.19 each).
node packages/cli/dist/index.js run suites/code-navigation.yaml \
  --models openai/gpt-6.1-sol,google/gemini-3.8-flash,qwen/qwen3.8-flash \
  --budget-usd 10 --out results.json --traces traces.jsonl
# if it stops, run the printed resume command with a new --budget-usd
node packages/cli/dist/index.js report results.json --format markdown
```
