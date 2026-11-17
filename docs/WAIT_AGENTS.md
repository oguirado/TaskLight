# Waiting for agent results

`wait_agents` wakes an orchestrator when a child ends and returns the child's
result in the room. No server-side waiter, subscription, or consumed marker is
created. The caller owns the Lamport `cursor` and persists it across restarts.

## Launch and wait

Launch each lane with a unique run identity and the orchestrator as its parent:

```sh
tasklight run --room demo --agent lane-a --run-id lane-a-run \
  --parent leader --parent-run leader-run --result-file '<result-file>' \
  -- <agent-command> <agent-arguments>
```

The child writes its result JSON before exiting. The supervisor reads the file
after exit and attaches a valid result to `finished` or `failed`. Result files
may contain at most 65,536 bytes, including JSON whitespace; the reader checks
one extra byte to detect overflow before decoding UTF-8 or parsing JSON.
Only regular files are accepted; FIFOs and other non-regular files are
rejected without waiting for a writer. A missing, invalid, non-regular, or
oversized file produces one stderr diagnostic; it does
not prevent the terminal event or change the child's exit code. Without
`--result-file`, behavior is
unchanged. Child output, command arguments, and environment stay outside the
journal.

Use the same tool through MCP or the CLI:

```sh
tasklight call wait_agents --json '{"room":"demo","parent":"leader","since_lamport":0,"timeout_s":60}'
```

The CLI accepts the cursor as `since_lamport` in JSON, rather than a `--since`
flag. Both transports return the same payload, inside the existing `untrusted`
envelope. This Python example uses the shared application dispatcher; capture
an initial cursor before launching the children, then loop until every expected
run has ended:

```python
import subprocess
from bridge.room.app import dispatch

room, parent, parent_run = "demo", "leader", "leader-run"
cursor = dispatch("orchestrator_snapshot", {"room": room})["untrusted"]["cursor"]
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
`timeout_s` defaults to 60 seconds, with an inclusive range of 1 through 600.

A match returns `{events: [{agent, run_id, state, parent, lamport, result?}],
cursor}`. Every matching event after the supplied cursor is returned in Lamport
order, including earlier runs. There is no first-event or batch-size truncation.
The parent link is `{agent, run_id}` or null and includes metadata inherited
from deployment. The cursor covers the journal snapshot inspected by that call,
including nonmatching events. Journal read errors fail rather than appearing as
a healthy empty room.

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
