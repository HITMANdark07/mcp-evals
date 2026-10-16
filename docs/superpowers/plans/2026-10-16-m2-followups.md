# M2 follow-ups (open items after the M2 merge)

Deferred items from M2 per-task and final reviews (triaged as not blocking the first paid run). Raw review notes, one line each:

Task 1: minor (deferred): pinned-model union errors show generic "Invalid input"; package.json reformat churn; tautological countTokens assertion in loop test; no tests for unpinned/placeholder rules on object form; SLUG rejects slugs with '/' (e.g. google-vertex/global)
Task 2: minor (deferred): countPlanned placed above planRuns detaching its doc comment; base-spec TS block still shows toolAccuracy:number / fixture non-null; cell with records but no planned entry gets plannedRuns 0
Task 6: minor (deferred): report --format markdown doesn't escape '|' (plan-mandated); no test for '|' escaping in compare; signed(-0.04) → -0.0; compareCommand exit 0 with incomplete cells not tested end-to-end; tmp file left if rename fails; duplicate cell keys overwrite silently; errors go to stdout (revisit in Task 9)
Task 7: minor (deferred): unknown-transport test matches SDK message text; non-timeout InfraError after deadline reported as timeout; no test for stdio timeout path / missing serverInfo.version
Task 5: minor (deferred): judge ignores pass:false under threshold (spec semantics); verdict parsing only whole/first-fence JSON; answer not escaped in judge prompt (prompt injection); enum compare key-order sensitive; missing tests (server-skipped judge, multiple judges, nested items+additionalProperties)
Task 4: minor (deferred): no fsync on append; records() rewrite unsafe if concurrent with append (call once before appends — doc); isRunRecord shallow; suites order not sorted in identity; test gaps (corrupt manifest paths, missing records file)
Task 5: minor (deferred): explicit "score": null now unparseable (untested behavior change); redundant alias
Task 4: minor (deferred): orphan empty records file if manifest write fails after 'wx' create
Task 3: minor (deferred): cost error message says "no catalog price" even when cause is missing token counts; fetchModelCatalog Number(null) etc. now handled; string error.code never stops run; abort-vs-network precedence
Task 8: minor (deferred): multiple judges — earlier judge cost lost if a later judge throws; judge cost crossing the cap not tested end-to-end; retryable judge error re-runs the agent; judge not budget-gated (one-call overshoot); catalog fallback estimate omits judge cost and pools servers; checkServers skips unknown names silently; catalogIssues checks judge even if --tasks removed judged tasks; onRecord throw loses in-memory totals
Task 9: minor (deferred): no --tasks / budget-stop coverage in runCommand tests; stale traces file when zero records; unexpected errors exit 1 (same as compare regression); --estimate-from ignored with mock
Task 11: minor (deferred): memory-team-graph contains is case-sensitive; middleware-list schema has no upper bound (no maxItems in subset); memory-delete doesn't assert beta gone
Deferred (post-run): judge cost lost if a later judge throws; harnessCommit doesn't mark dirty tree; CLIENT_INFO version 0.0.0; abort estimate ignores completion tokens; error bodies with tokens but no price → 0; unrecorded spend persisted only after runSuites returns
