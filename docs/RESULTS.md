# Results and unit decisions

The room journal carries worker results and the orchestrator's immutable
ADMIT, HOLD or REJECT decisions. Integration export replaces a separate
hand-written integration log.

## Orchestrator loop

Capture a cursor before launching children. Each child writes its result JSON
before exiting; a verdict is required and summary, receipt and evidence are
optional. See [Waiting for agent results](WAIT_AGENTS.md) for supervision and
cursor handling.

```sh
tasklight run --room demo --agent worker --run-id worker-run \
  --parent leader --parent-run leader-run --result-file results/worker.json \
  -- <agent-command> <agent-arguments>

tasklight call wait_agents --json '{"room":"demo","parent":"leader","since_lamport":0}'

tasklight call unit_decide --json '{"room":"demo","agent":"leader","op_id":"review-worker-run","task_id":"T01","verdict":"ADMIT","reason":"Verification passed","result_agent":"worker","result_run_id":"worker-run","expected_opened_lamport":1}'

tasklight call room_export --json '{"room":"demo","agent":"leader","what":"integration"}'
```

Review every returned result before deciding, and persist the returned cursor
after handling all events. Replace the example plan fence with the current
`plan_get` value of `opened_lamport`. A decision can optionally name a
`micro_id` belonging to that task. The tool's `agent` identifies the caller.
Supply both `result_agent` and `result_run_id` to reference a worker's terminal
result in this room; omit both to record an independent decision. The source
agent need not be the caller. These same fields are stored in `unit.decision`
and displayed on the board and in integration export. Unknown runs, live runs
and terminal events without a result are rejected without appending a record.

For existing clients, the tool still accepts `run_id` as a same-caller result
reference. Existing raw operations with the pair `agent` and `run_id` remain
readable. Supply one complete reference form; mixing old and new fields is
rejected. Agent slugs have the existing 48-character limit [TARGET] and run
identifiers the existing 64-character limit [TARGET].

Decisions require an existing task in the active plan and a reason of
1–240 characters [TARGET]. Optional decision evidence contains 1–8 entries
[TARGET], each with a repository-relative `path` and a lowercase SHA-256 hash.
Paths have a 512-character cap [TARGET]. Reusing an `op_id` with identical
content is a no-op; conflicting content is rejected. Decisions cannot be
edited or deleted. A stale plan fence returns `stale_rev`; a missing active
plan returns `no_plan`; malformed decisions or unknown bindings return `bad_op`.

Task projections retain the latest 16 decisions [TARGET] and `last_decision`.
The integration export keeps every accepted result and decision in Lamport
order, including older runs and decisions beyond that projection cap. Rejected
records and retries produce no extra lines. Export sanitizes complete fields
before truncating summaries to 200 characters [TARGET], treats legacy
non-string summaries as absent, and escapes Markdown pipes and backslashes.
An empty export says
`No results or decisions yet.`

Inventory exposes the current run's result and its first 8 evidence entries
[TARGET], preserving pointer bytes. Finished and failed lanes show a verdict
badge and a summary capped at 200 characters [TARGET]. Task bubbles expose
the latest decision in their accessible name; ADMIT and OK use the existing
done fill, while other verdicts retain visible text markers. Text is rendered
as passive content. Responses redact free text without rewriting owner storage;
a sanitizer failure stops output.
