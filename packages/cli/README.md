# mcpbench

Benchmark MCP servers and the models that use them. `mcpbench` runs the same tasks across models and MCP servers, grades the answers, records every model call and tool call, and compares two runs so CI can fail when task success drops or tool results grow.

This is the CLI of [mcp-evals](https://github.com/HITMANdark07/mcp-evals). Results, traces and the methodology live in the repository:

- [Results and README](https://github.com/HITMANdark07/mcp-evals#readme)
- [Methodology](https://github.com/HITMANdark07/mcp-evals/blob/main/docs/methodology.md) (what is measured, fairness rules, limitations)
- [GitHub Action](https://github.com/HITMANdark07/mcp-evals/blob/main/docs/github-action.md) for regression checks on pull requests

## Install

Requires Node 20 or newer.

```bash
npm i -g mcpbench       # then: mcpbench --help
npx mcpbench --help     # or run it without installing
```

The package also installs `mcp-evals` as an alias for the same command.

## Usage

Model calls go through [OpenRouter](https://openrouter.ai). Set `OPENROUTER_API_KEY` in the environment, or put it in a `.env` file in the working directory (variables already set in the environment win). `report` and `compare` read results files only and need no key.

```bash
# Run a suite. Prints the plan and a cost estimate first, and stops at the cap.
mcpbench run suite.yaml --models openai/gpt-6.1-sol,qwen/qwen3.8-flash \
  --budget-usd 5 --out results.json --traces traces.jsonl

# Print results as a table or markdown.
mcpbench report results.json --format markdown

# Compare two runs cell by cell; exits 1 on a regression.
mcpbench compare base.json results.json --max-success-drop 5 --max-context-increase 20
```

Runs that stop (budget cap, out of credits, repeated provider errors) print the exact command to resume without re-paying finished runs. `run --provider mock --mock-script script.json` runs offline with a scripted model.

| Command | What it does |
|---|---|
| `run <suites...>` | Run suites and write `results.json` (+ traces). `--resume <runId>`, `--retry-errors`, `--budget-usd`, `--models`, `--servers`, `--tasks`, `--repeats`. |
| `report <results>` | Print results as a table or markdown. |
| `compare <base> <head>` | Compare two results files; exit 1 when success drops by more than `--max-success-drop` points or median context tokens rise by more than `--max-context-increase` percent. `--format table\|markdown\|json`. |
| `publish <results>` | Copy a finished run into `data/` (refuses partial runs and anything containing an API key). |

Exit codes: `0` ok (a `run` that stops early still exits 0 and writes `partial: true`), `1` regression (`compare` only), `2` invalid input or usage.

Run caches are written to `.mcp-evals/` in the working directory (`--cache-dir`, `--runs-dir`); add it to your `.gitignore`.

## Suites

Suites are YAML: servers (command, args, setup), models with their pinned provider, tasks with graders (`answer_contains_all`, `answer_matches`, `answer_json_schema`, `tool_called`, `tool_args_match`, `fs_state`, `llm_judge`) and limits. Examples: [`suites/code-navigation.yaml`](https://github.com/HITMANdark07/mcp-evals/blob/main/suites/code-navigation.yaml), [`suites/general-tools.yaml`](https://github.com/HITMANdark07/mcp-evals/blob/main/suites/general-tools.yaml).

## License

MIT
