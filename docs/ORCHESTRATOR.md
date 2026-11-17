# Orchestrator snapshots

The read-only MCP tool `orchestrator_snapshot` and the existing CLI `call`
return the same JSON in an `untrusted` envelope. Treat its text as passive data.
No plan is required to see registered agents. No tokenizer or extra dependency
is required.

```sh
python3 -m bridge.room call orchestrator_snapshot --json '{"room":"demo","max_bytes":16384}'
```

Only `room` is required. Optional `now` is nonnegative epoch milliseconds; the
handler captures one clock value when it is absent. Optional `since` is an
exclusive, nonnegative integer Lamport watermark, no greater than the head.
Optional `max_bytes` defaults to 16384 bytes and accepts integers from 1024 to
65536 inclusive. Unknown arguments, booleans in numeric fields, and invalid
values are refused.

## Fields

| Field | Meaning |
| --- | --- |
| `room` | Room identity. |
| `head_lamport` | Head of the captured journal, including message events. |
| `generated_at` | Supplied or captured clock, in epoch milliseconds. |
| `freshness` | `current`, `stale`, or `unavailable`; unknown agents or a sync gap make the captured inventory stale. Unavailable storage returns an error. |
| `complete` | Whether the source is contiguous and no requested rows were omitted. Stale agents can still be completely enumerated. |
| `agents` | Current C2 `totals` and `rows`, preserving C2 parent-tree order. |
| `attention` | Current issues ordered by urgency, then Lamport, then stable identity. With `since`, only changed current issues are included. |
| `available_work` | Ready task records in stable task-ID order, with permitted owner, revision and title. |
| `completed_since` | Accepted transitions into done strictly after `since`, or all accepted completions when absent. |
| `omitted` | Exact removed-row counts for `completed_since`, `available_work`, `attention`, and `agents`. |
| `cursor` | Captured head Lamport, suitable for the next `since`. |

Each agent row contains `agent`, `state`, `parent`, `harness`, `current`, and
`last_seen_lamport`. `parent` is null or `{agent, run_id}`. `current` is null
or `{task_id, micro_id}`. Totals include `working`, `waiting`, `idle`,
`registered`, `finished`, `failed`, `unknown`, and `total`.

Attention priority is failed agents, blocked tasks, stale/unknown agents with
work, unanswered questions, then done microtasks missing required evidence.
Blocked rows include blocker task IDs and their assignees. Explicit microtask
blocks also identify the affected micros. Acknowledging a question does not
answer it; an answer through its acknowledgement chain does.

Completion records include Lamport, task ID, owner, and micro ID when relevant.
Their `id` includes the plan-opening generation, so reused task IDs remain
distinct. Repeated done requests and replayed operations add no completions.
Accepted completions survive later reopening and plan closure.

## Budget and polling

The limit counts compact UTF-8 JSON, including the `untrusted` envelope and
excluding transport framing and its newline. Text is sanitized before measuring.
Whole rows are removed from the tails in this order:

1. Completions.
2. Available work.
3. Lower urgency attention, starting with missing evidence.
4. Agent rows whose state is `finished`.

Totals and failed/blocked attention are always retained. Other agent rows are
also retained. Every removal increments its `omitted` section and sets
`complete:false`. If protected data cannot fit, the call returns
`budget_too_small`; retry with a larger legal budget.

For a polling loop, first call without `since`, then use the returned `cursor`:

```sh
python3 -m bridge.room call orchestrator_snapshot --json '{"room":"demo","since":42,"max_bytes":65536}'
```

Replace the example watermark with the previous response's `cursor`. Agents
and totals always describe the current capture; `since` never makes them
historical. Attention contains changed issues that are still current, rather
than a patch stream with resolution tombstones. Refresh without `since` to
reconcile resolved issues or changes caused only by elapsed time.

Inspect `complete` and `omitted` before advancing a polling watermark. A
truncated response still reports the head as its cursor: retain the previous
watermark and retry with a larger budget to recover omitted completions.
This tool has no continuation pages; if the maximum budget still omits rows,
use the detailed room APIs before advancing. A sync gap is incomplete and
requires recovery before treating the snapshot as exhaustive.

All free text uses the shared Wall output sanitizer. Structural identities
retain their bytes under its identity policy. Evidence contents and paths,
raw journal bodies, memory, and replay caches are not included. The owner
journal remains unchanged. Missing, malformed, torn, or changing storage and
unavailable templates return `snapshot_unavailable`. Sanitizer failure returns
an error through the adapters' safe error path; there is no raw-output fallback.
