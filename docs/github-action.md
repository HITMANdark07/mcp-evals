# GitHub Action: regression checks

`HITMANdark07/mcp-evals` is a composite action that compares two `results.json` files with `mcpbench compare`, writes the table to the job summary, keeps one comment on the pull request up to date, and fails the job on a regression. The comparison is offline: the action needs no model API key. Only producing new results (`mcpbench run`) calls a model.

A cell (suite × server × model) is a regression when its task success drops by more than `max-success-drop` percentage points, or its median context tokens rise by more than `max-context-increase` percent. Incomplete cells are never compared as if complete. See [methodology](methodology.md) for what the numbers mean.

## Inputs

| Input | Default | Description |
|---|---|---|
| `base` | required | Baseline `results.json`, for example one committed to the repository. |
| `head` | required | New `results.json` to check. |
| `max-success-drop` | `5` | Allowed drop in task success, in percentage points. |
| `max-context-increase` | `20` | Allowed rise in median context tokens, in percent. |
| `comment` | `true` | On `pull_request` events, create or update one PR comment (found by a hidden `<!-- mcpbench -->` marker). |
| `mcpbench-version` | `0.2.0` | Version of the [`mcpbench`](https://www.npmjs.com/package/mcpbench) npm package to run. |
| `github-token` | `github.token` | Token used to post the comment. |

Outputs: `exit-code` (`0` no regression, `1` regression, `2` invalid input) and `report` (path to the markdown report).

The step fails when `compare` exits 1 (regression) or 2 (missing or invalid results file). Posting the comment is best effort: on a pull request from a fork the default token is read-only, the comment step logs a warning, and the pass/fail result still applies. The runner needs Node 20 or newer (GitHub-hosted runners have it).

## Example: run the suite on each pull request

The baseline is committed (here `bench/base.json`, written by `mcpbench run` on `main`). The job runs the suite against the pull request's code and compares. Running the suite needs `OPENROUTER_API_KEY` as a repository secret; secrets are not available to pull requests from forks.

```yaml
name: MCP benchmark

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write   # for the PR comment

jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 20

      # Build your MCP server here if the suite runs it from this checkout.

      - name: Run the suite
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
        run: |
          npx -y mcpbench@0.2.0 run bench/suite.yaml \
            --models openai/gpt-6.1-sol --repeats 2 \
            --budget-usd 2 --out head.json --traces head-traces.jsonl

      - uses: HITMANdark07/mcp-evals@v0
        with:
          base: bench/base.json
          head: head.json
          max-success-drop: 5
          max-context-increase: 20

      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: mcpbench-results
          path: |
            head.json
            head-traces.jsonl
```

Keep the run small (few models, `--repeats`, `--tasks`) and capped with `--budget-usd`: every pull request pays for it. A run that hits the cap writes `partial: true`, and its unfinished cells are reported as `incomplete`, not as regressions. Cells that are only in one of the two files are reported as `missing_in_base` or `missing_in_head` and do not fail the check either.

## Example: compare results produced elsewhere

When results come from another job or workflow (a nightly run, a self-hosted runner with the server's dependencies), download them and compare. This job needs no secrets.

```yaml
jobs:
  compare:
    needs: bench            # a job that uploaded an artifact named mcpbench-results
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v5
      - uses: actions/download-artifact@v4
        with:
          name: mcpbench-results
      - uses: HITMANdark07/mcp-evals@v0
        with:
          base: bench/base.json
          head: head.json
```

To update the baseline, commit a new `bench/base.json` from a full run on `main`.

## Running the same check locally

```bash
npx mcpbench compare bench/base.json head.json --format markdown   # exit 1 on regression
```
