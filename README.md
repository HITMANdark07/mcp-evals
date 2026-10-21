# mcp-evals

Benchmark MCP servers and the models that use them. mcp-evals runs the same tasks across models and MCP servers, grades the answers, and records every model call and tool call, so a claim like "this server saves context" can be checked against the same tasks, prompts and limits.

## First results (2026-10-16)

12 code-navigation tasks on [Hono](https://github.com/honojs/hono) v4.13.13, 2 repeats, [NeatCode](https://github.com/HITMANdark07/neatcodeai) 0.1.4 vs. the [filesystem MCP server](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem) 1.0.0, three models through OpenRouter (each pinned to one provider). 144 runs, every cell complete, $7.10 in total.

| Server | Model | Success (95% CI) | Invalid tool calls | Context tokens, median | $/task |
|---|---|---|---|---|---|
| neatcode | GPT-6.1 Sol | 100% [86–100%] | 0% | 3,235 | $0.0214 |
| filesystem | GPT-6.1 Sol | 100% [86–100%] | 0% | 8,390 | $0.0395 |
| neatcode | Gemini 3.8 Flash | 0% [0–14%] | 0% | 13,010 | $0.0993 |
| filesystem | Gemini 3.8 Flash | 25% [12–45%] | 0% | 42,889 | $0.1155 |
| neatcode | Qwen3.8 Flash | 8% [2–26%] | 33% | 13,541 | $0.0084 |
| filesystem | Qwen3.8 Flash | 25% [12–45%] | 42% | 13,420 | $0.0113 |

- **GPT-6.1 Sol** solved every task on both servers. With NeatCode it used 61% fewer tool-result tokens and cost 46% less per task, though it took more steps.
- **Both flash models scored lower with NeatCode.** Their traces led to a NeatCode indexer bug: functions written as `export const compose = (...) => ...` were not indexed, so `compose`, `every`, `mergePath` and `timingSafeEqual` could not be found. It is fixed in NeatCode 0.1.5 (on Hono the graph went from 82 to 592 function nodes), along with interface nodes, "did you mean" suggestions and a bounded `get_source` tool. In a small 1-repeat check with 0.1.5, Qwen3.8 Flash passed 9 of 12 tasks (was 2 of 24) and Gemini 3.8 Flash 2 of 6 (was 0 of 12); the table above stays the measured 0.1.4 run until a full re-run.
- The harness author also wrote NeatCode. Tasks, answer keys and graders are in [`suites/`](suites/), and every trace is published.

Full results: [`data/latest.json`](data/latest.json) · traces: [`data/runs/`](data/runs/) · how it is measured, fairness rules and limitations: [`docs/methodology.md`](docs/methodology.md).

## What it measures

Per server × model cell: task success (with a Wilson 95% interval), success counting infrastructure errors as failures, invalid tool calls, tool accuracy (where a task has tool graders), context tokens returned by tool calls (one tokenizer for every model), provider-reported prompt tokens, steps, latency and cost. Infrastructure failures (rate limits, crashes) are retried and reported as an error rate instead of counting against a model.

## Quick start

Requires Node 20+ and pnpm.

```bash
pnpm install && pnpm build
cp .env.example .env            # add OPENROUTER_API_KEY (.env is git-ignored)

# A real run: prints the plan and a cost estimate first, and stops at the cap.
node packages/cli/dist/index.js run suites/code-navigation.yaml \
  --models openai/gpt-6.1-sol,google/gemini-3.8-flash,qwen/qwen3.8-flash \
  --budget-usd 10 --out results.json --traces traces.jsonl

node packages/cli/dist/index.js report results.json --format markdown
node packages/cli/dist/index.js compare base.json results.json   # exit 1 on regression
```

Runs that stop (budget cap, out of credits, repeated provider errors) print the exact command to resume without re-paying finished runs. `run --provider mock` runs offline with a scripted model.

## Run local models (Ollama)

Any server that speaks the OpenAI chat-completions API with tool calling works with `--provider openai-compatible`: Ollama, LM Studio, vLLM, the llama.cpp server. With Ollama:

```bash
# 1. Install Ollama (https://ollama.com/download), start it, and pull a model that supports tool calling
ollama pull qwen3:8b

# 2. Run a suite against it (Ollama serves its OpenAI-compatible API under /v1)
node packages/cli/dist/index.js run suites/code-navigation.yaml \
  --provider openai-compatible --base-url http://localhost:11434/v1 \
  --models qwen3:8b --repeats 1 --out local.json --traces local.jsonl
```

- `--models` names the server's model ids; they do not need to be listed in the suite, and need no provider pin. `--base-url` can also come from `OPENAI_COMPATIBLE_BASE_URL`. If the server needs a key, set `OPENAI_COMPATIBLE_API_KEY` (sent as a Bearer token, never logged or written).
- Pre-flight checks that every model is listed by `GET {base}/models` and starts each MCP server once.
- Cost is **not measured** for local servers: every call is recorded as $0 and the estimate prints $0. Token counts come from the server's `usage` when it reports one (otherwise 0).
- Suites with `llm_judge` tasks (e.g. `general-tools`) also need the suite's judge model to be served by the same server.
- Local runs are checks, not leaderboard numbers: cost and latency depend on your hardware and are not comparable with hosted runs. See [methodology](docs/methodology.md#local-models-openai-compatible-servers).

## Commands

| Command | What it does |
|---|---|
| `run <suites...>` | Run suites and write `results.json` (+ traces). `--provider openrouter\|openai-compatible\|mock`, `--base-url`, `--resume <runId>`, `--retry-errors`, `--budget-usd`, `--models`, `--repeats`. |
| `report <results>` | Print results as a table or markdown. |
| `compare <base> <head>` | Compare two results files cell by cell; exit 1 when success drops or context grows past the thresholds. |
| `publish <results>` | Copy a finished run into `data/` (refuses partial runs and anything containing an API key). |

## Suites

Suites are YAML: servers (command, args, setup), models with their pinned provider, tasks with graders (`answer_contains_all`, `answer_matches`, `answer_json_schema`, `tool_called`, `tool_args_match`, `fs_state`, `llm_judge`) and limits. See [`suites/code-navigation.yaml`](suites/code-navigation.yaml) and [`suites/general-tools.yaml`](suites/general-tools.yaml).

## Status

Milestones 1 (runner, graders, CLI) and 2 (OpenRouter runs, results schema v2, resume, `compare`, `report`, `publish`, first real run) are done. Next: a GitHub Action that comments on PRs and gates CI, an npm release, and a public leaderboard.

## License

MIT
