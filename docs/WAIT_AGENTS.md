# Waiting for agent results

`wait_agents` wakes an orchestrator when a child ends and returns the child's
result in the room. No server-side waiter, subscription, or consumed marker is
created. The caller owns the Lamport `cursor` and persists it across restarts.

## Launch and wait

Capture the room's head Lamport cursor **before launching any children** so a
fast exit cannot fall at or before the starting cursor. If you have no
pre-launch cursor, start with `since_lamport: 0` and an `agents` filter for
the children, then match results by their expected `run_id`.

Launch each lane with a unique `run_id` and the orchestrator as its parent.
For each retry, use a new `run_id` and update the expected run before launch.
Use [a wave manifest](WAVES.md) to launch several lanes together.

```sh
tasklight run --room demo --agent lane-a --run-id lane-a-run \
  --parent leader --parent-run leader-run --result-file '<result-file>' \
  -- <agent-command> <agent-arguments>
```

Have the child publish its result JSON by atomically replacing the result
file. The supervisor reads it immediately after exit and retries for up to
2 seconds [TARGET] if the file is missing or invalid. The first valid result
is attached to `finished` or `failed`. Result files
may contain at most 65,536 bytes, including JSON whitespace; the reader checks
one extra byte to detect overflow before decoding UTF-8 or parsing JSON.
Only regular files are accepted. FIFOs are rejected without waiting for a
writer. If the grace period expires without a valid result, the supervisor
reports one diagnostic on stderr and emits the terminal event with the
observed outcome. Child output, command arguments, and environment stay
outside the journal.

Use the same tool through MCP or the CLI:

```sh
tasklight call wait_agents --json '{"room":"demo","parent":"leader","since_lamport":0,"timeout_s":60}'
```

The CLI accepts the cursor as `since_lamport` in JSON, rather than a `--since`
flag. Both transports return the same payload, inside the existing `untrusted`
envelope. This Python example uses the shared application dispatcher to launch
the children and wait until every expected run has ended.

```python
import subprocess
from bridge.room.app import dispatch

room, parent, parent_run = "demo", "leader", "leader-run"
cursor = dispatch("orchestrator_snapshot", {"room": room})["untrusted"]["head_lamport"]
remaining = {"lane-a": "lane-a-run", "lane-b": "lane-b-run"}
for agent, run_id in remaining.items():
    subprocess.Popen([
        "tasklight", "run", "--room", room, "--agent", agent,
        "--run-id", run_id, "--parent", parent, "--parent-run", parent_run,
        "--result-file", f"results/{agent}.json", "--", "<agent-command>",
    ])
while remaining:
    reply = dispatch("wait_agents", {
        "room": room, "parent": parent, "agents": list(remaining),
        "since_lamport": cursor, "timeout_s": 60,
    })["untrusted"]
    for event in reply["events"]:
        if remaining.get(event["agent"]) == event["run_id"]:
            result = event.get("result")  # Legacy runs may have no result.
            # Handle or persist the verdict, summary and pointers here.
            del remaining[event["agent"]]
    cursor = reply["cursor"]  # Save only after handling every returned event.
```

A timeout returns `{"events": [], "cursor": ..., "timed_out": true}`; continue
the loop. Passing the same cursor again replays the same matches. Appends
between calls are returned by the next call using the previous cursor.

## Tool contract

Arguments are `{room, agents?, parent?, states?, since_lamport?, timeout_s?}`.
Only `room` is required; unknown keys are rejected. `agents` is an exact list of
agent slugs, `parent` selects direct children, and filters intersect. Explicitly
empty `agents` or `states` arrays are rejected immediately with `bad_args` on
both MCP and CLI. Omit the filter to use its default. `states` defaults to
`["finished", "failed"]`; explicit states may also include `deployed` and `alive`.
`since_lamport` defaults to zero and is an exclusive nonnegative safe integer.
A cursor ahead of the room head returns `bad_args` immediately with detail
`since_lamport is ahead of the room head (<head>)`. A cursor equal to the
head waits for a later matching event.
`timeout_s` defaults to 60 seconds, with an inclusive range of 1 through 600.

A match returns `{events: [{agent, run_id, state, parent, lamport, result?}],
cursor}`. Every matching event after the supplied cursor is returned in Lamport
order, including earlier runs. There is no first-event or batch-size truncation.
The parent link is `{agent, run_id}` or null and includes metadata inherited
from deployment. The cursor covers the journal snapshot inspected by that call,
including nonmatching events. A room that has never been created can time out
with no events and cursor zero. For an existing room, a missing journal, a
journal path that is not a regular file, an unreadable journal, or a malformed
or foreign committed record returns `room_read_failed` with the fixed detail
`Room data could not be read.`
The waiter checks committed records before applying the cursor or filters.

## Journal replay cost

The waiter reads and folds the full journal on every observed journal change,
including unrelated chat and activity events. Replay sorts, deduplicates, and
visits the journal's events, so busy, large rooms incur repeated snapshot work.
An unchanged journal stamp avoids another read and fold. No lifecycle-only
shortcut is applied: activity and operation admission can influence later
lifecycle replay. Matching rows and the cursor continue to describe the same
journal snapshot.

## Terminal result

Only `finished` and `failed` accept optional `result`. Under A-C6b, only
`verdict` is required. For example, `{"verdict":"OK"}` is a complete result;
omitted fields remain absent in the journal and in `wait_agents` replies.
Optional members are validated whenever present:

| Member | Contract |
| --- | --- |
| `verdict` | `ADMIT`, `HOLD`, `NO_PUDE`, `OK`, or `FAIL` |
| `summary` | String, at most 2,000 Unicode code points |
| `receipt` | Path string, at most 512 Unicode code points |
| `evidence` | At most 32 objects, each with only `path` and `sha256` |

Evidence `path` is a string of at most 512 Unicode code points; `sha256` is
exactly 64 hexadecimal characters. Unknown keys, a missing verdict, wrong types,
and oversized values are rejected with `bad_args`. Legacy events omit `result`
and replay unchanged. `agents_list` adds `last_result` for the current run:
`{verdict, summary, receipt}`, with the summary truncated to 200 Unicode code
points, or null. Redeployment clears that result.

Outputs use the Wall's shared `sanitize_output`: summaries are redacted,
receipt pointers retain their bytes, and evidence uses the shared pointer
policy. Owner journal bytes remain unchanged. A sanitizer error refuses output.
