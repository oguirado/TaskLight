# Running a TaskLight wave

Run `tasklight wave --manifest wave.json` or
`python3 -m bridge.room wave --manifest wave.json` from the working directory
for the commands. Relative command and result paths use that directory.

```json
{
  "room": "demo",
  "parent": "leader",
  "parent_run": "leader-run",
  "lanes": [
    {
      "agent": "lane-a",
      "run_id": "lane-a-run",
      "argv": ["python3", "worker.py", "--result", "results/lane-a.json"],
      "result_file": "results/lane-a.json",
      "harness": "worker",
      "wall_s": 120
    }
  ]
}
```

A manifest admits 1–64 lanes [TARGET]. Each lane needs a unique `agent` and
`run_id` pair, a distinct `result_file` and a nonempty `argv` array. The
launcher passes each argument directly to the command. Both `harness` and
`wall_s` are optional. Use a positive finite number for `wall_s` to set the
monotonic wall limit from spawn. The launcher validates the entire manifest
before starting lanes and returns `bad_args` with the index of an invalid lane.

The launcher starts a `tasklight run` wrapper for each eligible lane and
waits for all wrappers. Lane output streams to stderr. Stdout contains one
JSON summary with entries in manifest order under `wave.lanes`. Each entry
has `agent`, `run_id`, `state`, `reason` and `exit`. The wave exits
successfully only when every lane records `finished`.

## Terminal outcomes

| Reason | Outcome |
| --- | --- |
| `exit:0` | Natural completion, recorded as `finished`. |
| `exit:<code>` | A nonzero command exit or a launch failure, recorded as `failed`. |
| `signal:<NAME>` | The child exited from a signal, recorded as `failed`. |
| `wrapper:SIGTERM`, `wrapper:SIGINT` | The wrapper received that signal and cancelled the child, recorded as `failed`. |
| `wall_timeout` | The lane exceeded its wall limit, recorded as `failed`. |
| `already_terminal` | The pair has a terminal event in this room. The lane is `skipped` and its `exit` is null. |
| `missing_terminal`, `room_read_failed` | The launcher could not confirm a terminal event, so the wave reports a failed lane. |

Cancellation signals the child's process group and escalates to SIGKILL after
2 seconds [TARGET]. The wrapper keeps the child's exit status, even when a
cancelled child exits successfully. Use `tasklight run --no-group` for
interactive foreground commands that need the existing terminal group.
See [Waiting for agent results](WAIT_AGENTS.md) for result publication and
the grace period.

## Orchestrator loop

1. Capture the room head cursor before launch. Start the wave in the
   background so the orchestrator can receive results while lanes run.

   ```sh
   tasklight wave --manifest wave.json > wave-summary.json &
   wave_pid=$!
   ```

2. Call `wait_agents` with the room, the parent agent and the saved
   `since_lamport` cursor. Match each event to its expected `agent`,
   `run_id` and parent run. Persist the returned cursor after handling all
   returned events. Check the wave summary for skipped or unconfirmed lanes,
   which may produce no new terminal event.
3. Review each terminal result and use `unit_decide` to record the
   verdict against the plan unit. See [Results and unit decisions](RESULTS.md)
   for decision arguments.
4. Use `wait "$wave_pid"` to collect the wave exit status. To retry a
   terminal lane, specify a new `run_id` and publish to a fresh result file.
