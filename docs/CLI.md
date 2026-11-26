# TaskLight CLI

Run `./bin/tasklight` from the checkout, or put its `bin` directory on
`PATH` to run `tasklight` as shown below. The launcher follows symlinks
to the checkout and starts `python3 -m bridge.room` there. Relative paths
passed to the launcher, including manifest and child command paths, resolve
from that checkout. For the module form, run `python3 -m bridge.room` from
the checkout and pass the same arguments.

`tasklight --help` prints one JSON line with the built-in verbs under
`verbs` and live operation names under `tools`. `tasklight tools` prints
the registered operation schemas. An operation takes a JSON object via
`--json`. Built-in verbs take precedence over operation names. Use
`tasklight call <operation> --json '<object>'` to invoke an operation whose
name matches a built-in verb.

Direct operation calls and `call` share the same JSON output and exit status.
Success is `0`. Malformed CLI arguments or an unknown operation return
`bad_args` with status `2`. A dispatched refusal returns status `3`.
See [MCP.md](MCP.md) for schemas and response envelopes, and
[HEADLESS.md](HEADLESS.md) for a scratch-room walkthrough and storage setup.

## Built-in verbs

```sh
tasklight post --room demo --agent alice --act question --text 'Is the draft ready?'
tasklight read --room demo --since 0 --json
tasklight wait --room demo --act question --timeout 5
tasklight status --room demo
tasklight export --room demo --out exports
tasklight tools
tasklight call list_templates --json '{}'
tasklight run --room demo --agent worker --harness generic -- python3 -c 'print("done")'
tasklight wave --manifest wave.json
```

`export` writes under `CW_HOME`. For `run`, put the child command after
`--`. For `wave`, supply a JSON manifest with `room`, `parent`,
`parent_run` and `lanes`. The lane entries specify each child's `agent`,
`run_id`, `argv` and `result_file`.

## Operations

These are individual examples. For state-dependent operations, substitute
the room's actual task IDs, run IDs, revisions, Lamport values and evidence
paths. Use a scratch `CW_HOME` when trying commands that write to a room.

### Room coordination and discovery

```sh
tasklight post_status --json '{"room":"demo","agent":"alice","text":"Draft ready"}'
tasklight post_plan --json '{"room":"demo","agent":"alice","title":"Review draft","steps":[{"text":"Read draft"}]}'
tasklight post_step --json '{"room":"demo","agent":"alice","index":0,"state":"done","outcome":"Draft read"}'
tasklight close_task --json '{"room":"demo","agent":"alice","outcome":"Review recorded"}'
tasklight read_inbox --json '{"room":"demo","agent":"alice","since":0}'
tasklight wait_inbox --json '{"room":"demo","agent":"alice","since":0,"timeout_s":5}'
tasklight room_send --json '{"room":"demo","agent":"alice","to":"bob","act":"question","text":"Is the draft ready?"}'
tasklight room_events --json '{"room":"demo","agent":"alice","after_lamport":0}'
tasklight room_export --json '{"room":"demo","agent":"alice","what":"plan"}'
tasklight list_templates --json '{}'
tasklight get_template --json '{"template_id":"blank"}'
```

### Planning, tasks and memory

```sh
tasklight plan_create --json '{"room":"demo","agent":"alice","template_id":"blank","title":"Review draft","brief":{"goal":"Verify the draft"},"tasks":[{"key":"review","title":"Review draft","type":"task","phase":"execute","accept":"Draft verified","microtasks":[{"text":"Read draft"}]}]}'
tasklight plan_get --json '{"room":"demo","agent":"alice"}'
tasklight plan_check --json '{"room":"demo","agent":"alice"}'
tasklight plan_phase --json '{"room":"demo","agent":"alice","phase":"review","base_rev":4}'
tasklight plan_close --json '{"room":"demo","agent":"alice","base_rev":5,"outcome":"Review complete"}'
tasklight task_add --json '{"room":"demo","agent":"alice","title":"Check references","type":"task","phase":"execute","accept":"References verified","microtasks":[{"text":"Check cited sources"}]}'
tasklight task_update --json '{"room":"demo","agent":"alice","task_id":"T01","base_rev":2,"estimate":"10m"}'
tasklight task_claim --json '{"room":"demo","agent":"alice","task_id":"T01"}'
tasklight task_release --json '{"room":"demo","agent":"alice","task_id":"T01","claim_lamport":3}'
tasklight microtask_add --json '{"room":"demo","agent":"alice","task_id":"T01","base_rev":2,"text":"Check citations"}'
tasklight microtask_set --json '{"room":"demo","agent":"alice","id":"T01.M01","state":"active","claim_lamport":3}'
tasklight next_work --json '{"room":"demo","agent":"alice"}'
tasklight memory_set --json '{"room":"demo","agent":"alice","section":"goal","text":"Verify the draft","base_rev":0}'
tasklight memory_get --json '{"room":"demo","agent":"alice","section":"goal"}'
tasklight memory_history --json '{"room":"demo","agent":"alice","section":"goal","limit":5}'
```

### Work and lifecycle

```sh
tasklight work_acquire --json '{"room":"demo","agent":"alice","prefer_task":"T01","run_id":"review-run"}'
tasklight work_report --json '{"room":"demo","agent":"alice","task_id":"T01","claim_lamport":3,"run_id":"review-run","done":[{"id":"T01.M01","outcome":"Draft verified","evidence":["<absolute-evidence-path>"]}]}'
tasklight activity_beat --json '{"room":"demo","agent":"alice","task_id":"T01","micro_id":"T01.M01","run_id":"review-run"}'
tasklight agent_lifecycle --json '{"room":"demo","agent":"alice","state":"deployed","run_id":"review-run","harness":"generic"}'
tasklight agents_list --json '{"room":"demo"}'
tasklight wait_agents --json '{"room":"demo","agents":["alice"],"states":["finished","failed"],"since_lamport":0,"timeout_s":5}'
tasklight orchestrator_snapshot --json '{"room":"demo"}'
tasklight unit_decide --json '{"room":"demo","agent":"coordinator","task_id":"T01","op_id":"review-decision","verdict":"HOLD","reason":"Awaiting verification evidence"}'
tasklight artifact_read --json '{"room":"demo","agent":"coordinator","path":"<recorded-artifact-path>"}'
tasklight unit_bind --json '{"room":"demo","agent":"coordinator","op_id":"review-bind","task_id":"T01","expected_opened_lamport":1,"micro_id":"T01.M01","result_agent":"alice","result_run_id":"review-run"}'
tasklight unit_repair --json '{"room":"demo","agent":"coordinator","op_id":"review-repair","task_id":"T01","expected_opened_lamport":1,"reason":"Retry with the corrected draft"}'
```

Lifecycle writes belong to the harness. See [HARNESS_HOOKS.md](HARNESS_HOOKS.md)
for lifecycle usage and [RESULTS.md](RESULTS.md) for artifact and decision inputs.
