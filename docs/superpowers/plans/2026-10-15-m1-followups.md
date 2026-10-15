# M1 follow-ups (carry into M2)

Open items from M1's per-task reviews and final whole-branch review, triaged. Items fixed in the final fix wave are omitted.

## Before any public leaderboard run
- Per-cell completeness: add expected vs. actual run counts (or a `complete` flag) to each cell, so partial runs are never compared as if complete.
- `mcp/connection.ts` `callTool` fallback still treats unknown transport errors as retryable; align with the loop's rule (only known-transient errors retry).
- Spec §4.1 and the M1 plan still describe `successRate` as a number / 0; it is now `number | null`. Update the docs.
- Decide the per-call tool timeout policy: `DEFAULT_TOOL_TIMEOUT_MS` (60 s) is not suite-configurable, and an uncapped tool timeout becomes a non-retryable `error` (spec §7 "timeouts in transport" is ambiguous).
- Record the server version in results (from MCP `initialize` serverInfo).

## Should fix soon
- CLI: commander flag errors (`--repeats 0`, missing `--provider`) exit 1; make all usage errors exit 2.
- CLI: traces are written after `results.json`; build both payloads first, skip empty trace files.
- `fs_state` treats every read error as "missing" (only `ENOENT` should); `exists: true` on a directory fails.
- Loader `PLACEHOLDER` check false-positives on legitimate args like `<div>`.
- Fixture manager: workspace dir leaks when `prepare`/`cp` fails; crashed clones leave `<key>.tmp-*` dirs; `createWorkspace` snapshot is now unused (double hashing).
- Grader tool-name typo (F7) starts one workspace + server per affected run before erroring; check once per suite × server.
- Retries: no pre-attempt budget check; a retried run's `latencyMs`/`events` cover only the last attempt; `costUsdPerTask` includes failed infra attempts.
- `budgetUsd` is not validated (NaN/negative).

## Hardening / polish
- Loader: Windows drive-letter paths in `fs_state`; unpinned-model patterns `provider/latest`, `@latest`; `fs_state` with no assertions; `grader.server` not checked against `task.servers`.
- Aggregator silently drops records for unknown server/model/task; task counts lack `.nonnegative()`; filtered-out models/servers still listed in results.
- Connector: stderr cap counts characters, not bytes; setup timeout message says `(unknown)` and kills only `sh`; setup does not receive the server's `env`.
- Loop: injected `now` does not drive the model-call timer; deadline-timeout path leaves a `tool_call` without `tool_result`; `null` content becomes `''` final answer.
- Git option injection hardening: pass `--` before the fixture URL.
- pnpm ignores esbuild postinstall; consider `pnpm.onlyBuiltDependencies: ["esbuild"]`.
- Test gaps: strict budget graders, `tool_not_called` failing, default case-insensitivity, 64 KB stderr cap, `ws.dispose` rejection, capped-timer-early branch, table column alignment, cache-reuse test is vacuous.
