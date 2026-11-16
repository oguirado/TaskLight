# TaskLight MCP

This guide is for integrators connecting any MCP client to TaskLight.
The plan and memory protocol is described in [PLANNING](PLANNING.md), and the normative agent rules are in [PLANNING_CONTRACT](PLANNING_CONTRACT.md).

## Registration

TaskLight speaks the stdio MCP wire format: newline-delimited JSON-RPC
2.0 with `protocolVersion` `"2024-11-05"`, `serverInfo`
`{"name": "tasklight", "version": "0.2.0"}` and `capabilities`
`{"tools": {}, "resources": {}, "prompts": {}}`. A generic MCP client
registers the server like this:

```json
{
  "command": "python3",
  "args": ["-m", "bridge.room.mcp"],
  "cwd": "<repo-root>",
  "env": { "CW_HOME": "<cw-home-path>" }
}
```

`CW_HOME` points at the local data directory. Rooms, plans and memory
are stored underneath it; the server never writes outside it.

## Tools

Twenty-two tools are exposed. One-line purposes:

Legacy six (`TOOLS[0:6]`):

- `post_status`: post a status heartbeat event to a room.
- `post_plan`: post a legacy plan with steps to a room.
- `post_step`: post a step update to a room.
- `close_task`: close an agent task with a one-line outcome.
- `read_inbox`: read inbox events for an agent.
- `wait_inbox`: wait for the next inbox event for an agent.

v2 sixteen (`TOOLS[6:22]`):

- `list_templates`: list the available planning templates.
- `get_template`: fetch one planning template by id.
- `plan_create`: atomically open a plan and add its tasks (up to 40 tasks).
- `plan_get`: return the folded projection, with nested
  `tasks[].microtasks` entries inside the task list.
- `plan_check`: check plan conformance against its base template.
- `plan_phase`: advance the active plan phase (`{room, agent, phase, base_rev, op_id?}`, posting `plan.phase`; unknown `phase` returns `bad_op`, and a stale `base_rev` returns `stale_rev`).
- `plan_close`: close the active plan with an optional outcome (`{room, agent, outcome?, base_rev, op_id?}`, posting `plan.close`; requires `base_rev`).
- `task_add`: add one task to the active plan.
- `task_update`: change a nullable task state (`blocked`, `cancelled`
  or `null`), a `reason` and an `estimate`; this update never assigns
  ownership.
- `task_claim`: claim a task for the calling agent, with optional
  `takeover: true` after more than 600,000 ms of silence from the
  current assignee.
- `task_release`: release a claimed task back to the pool.
- `microtask_add`: add one microtask to a task; requires the task
  `base_rev`.
- `microtask_set`: set a microtask by `id` (for example `"T01.M01"`,
  mapped to `op.micro_id`) and `state` (`pending`, `active`, `done`, or
  `blocked`), with optional `outcome`, `took`, and `evidence` (a list of
  up to 8 absolute paths to existing files, excluding credential files;
  a plain string returns `bad_evidence`); the op must not carry `base_rev`
  or any revision field.
- `next_work`: return the next ready task for the calling agent: tasks
  already assigned to the caller first, then unassigned ready tasks;
  never returns tasks assigned to another agent.
- `memory_set`: write one memory section text (`base_rev: 0` for the
  first write of a section).
- `memory_get`: read one memory section text.

## Copy-paste: your first plan

In `plan_create`, `brief` is an object whose keys are the template's
`brief_fields` ids, and each entry in `tasks` (up to 40) accepts
exclusively these keys:

- `key` (required in `plan_create`, unique string referenced by `deps`)
- `title` (required, non-empty string, `<= 120` chars)
- `type` (required, a `task_types[].id` from the template)
- `phase` (required, a `phases[].id` from the template)
- `accept` (optional string, `<= 160` chars)
- `deps` (optional array of task `key` strings, `<= 8`, no duplicates, acyclic)
- `assignee` (optional agent slug or `null`)
- `estimate` (optional string, `<= 32` chars)
- `microtasks` (optional array, `<= 12` objects of `{text, accept?}` where `text` is required, non-empty, `<= 80` chars, and `accept` is `<= 160` chars)

Example `plan_create` call using the `web-app` template:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "plan_create",
    "arguments": {
      "room": "demo",
      "agent": "planner",
      "template_id": "web-app",
      "title": "TaskLight starter app",
      "op_id": "plan-create-0001",
      "brief": {
        "goal": "Ship a minimal web task tracker",
        "users": "Solo developers",
        "stack": "Python API and TypeScript UI",
        "constraints": "Local-first storage only"
      },
      "tasks": [
        {
          "key": "api-auth",
          "title": "Implement session API endpoint",
          "type": "api",
          "phase": "design",
          "accept": "POST /session returns 200 and rejects invalid payloads with 400",
          "estimate": "1h",
          "microtasks": [
            {
              "text": "Define request schema and validation errors",
              "accept": "Schema rejects missing token with 400"
            },
            {
              "text": "Implement handler and unit tests",
              "accept": "Session unit tests pass locally"
            }
          ]
        },
        {
          "key": "ui-login",
          "title": "Build session sign-in view",
          "type": "ui",
          "phase": "build",
          "accept": "Form submits to POST /session and displays error states",
          "deps": ["api-auth"],
          "assignee": "worker-ui",
          "estimate": "1h",
          "microtasks": [
            {
              "text": "Create accessible sign-in form component",
              "accept": "Keyboard navigation and labels verified"
            },
            {
              "text": "Wire form submission and error banner",
              "accept": "Invalid submission renders API error message"
            }
          ]
        }
      ]
    }
  }
}
```

Claim `T01` before editing its files:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "task_claim",
    "arguments": {
      "room": "demo",
      "agent": "worker-api",
      "task_id": "T01",
      "op_id": "claim-t01-0001"
    }
  }
}
```

Mark microtask `T01.M01` done with `evidence` paths (never pass `base_rev` to `microtask_set`):

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "microtask_set",
    "arguments": {
      "room": "demo",
      "agent": "worker-api",
      "id": "T01.M01",
      "state": "done",
      "outcome": "Added request schema validation and 400 error responses",
      "took": "15m",
      "evidence": [
        "/workspace/app/src/session.py",
        "/workspace/app/tests/test_session.py"
      ],
      "op_id": "micro-t01m01-0001"
    }
  }
}
```

Write the initial `architecture` memory section (`base_rev: 0`):

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "memory_set",
    "arguments": {
      "room": "demo",
      "agent": "planner",
      "section": "architecture",
      "text": "API runs locally on loopback; UI communicates over JSON REST.",
      "base_rev": 0,
      "op_id": "mem-arch-0001"
    }
  }
}
```

Advance the plan phase (`base_rev` matches the current plan revision from `plan_get`):

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "plan_phase",
    "arguments": {
      "room": "demo",
      "agent": "planner",
      "phase": "design",
      "base_rev": 1,
      "op_id": "phase-design-0001"
    }
  }
}
```

## Resources and prompts

Resources are read-only and never create directories:

- `resources/list`, `resources/templates/list`, `resources/read`.
- `tasklight://contract` (`text/markdown`) for the planning contract.
- `tasklight://templates/{id}` for one planning template.
- `tasklight://rooms/{room}/plan` for the folded plan projection.
- `tasklight://rooms/{room}/memory` for all memory sections.

Prompts used to build and govern plans from a template:

- `prompts/list`, `prompts/get`.
- `plan_from_template` with `template_id` and `brief` arguments.
- `resume_from_memory` with a `room` argument and optional `agent`.
- `planning_contract` with optional `room` and `agent` arguments; returns the contract's agent system prompt.

## Errors

JSON-RPC level errors: `-32700` (parse error), `-32600` (bad
request), `-32601` (method not found), `-32602` (bad params, including
malformed URIs), `-32002` (missing valid resource) and `-32603`
(internal error).

Legacy tool errors use short codes: `bad_args`, `bad_room`,
`bad_agent`, `bad_act`, `text_too_long`, `bad_plan`, `bad_step`,
`bad_evidence`, `bad_re`, `room_full`, `internal`.

Eleven v2 tool errors cover planning state and conflicts:
`no_plan`, `plan_exists`, `unknown_template`, `bad_template`,
`bad_op`, `not_found`, `stale_rev`, `dep_cycle`, `claimed_by_other`,
`limit_exceeded` and `not_conformant`.

## Idempotency, revisions and the untrusted envelope

Every v2 op may carry an `op_id` matching `^[A-Za-z0-9_-]{8,64}$`.
An explicit `null` value is invalid. Idempotency is scoped by
`(agent, op_id)`: repeating an op returns the original result with a
transient `"replayed": true` field and writes no duplicate event.

State changes are serialized under `events.lock`. Revision rules via
`base_rev`:

- required on `plan.close` (`plan_close`), `plan.phase` (`plan_phase`),
  `task.set` (`task_update`), `micro.add` (`microtask_add`) and
  `memory.set` (`memory_set`, `0` for the first write of a section);
- optional on `task.add` (`task_add`), `task.claim` (`task_claim`) and
  `task.release` (`task_release`);
- forbidden on `micro.set` (`microtask_set`, `bad_op` is returned).

A missing required `base_rev` is `bad_op`; a mismatch is `stale_rev`.

Every complete v2 data payload is wrapped in an untrusted envelope:
`{"untrusted": payload}`. Protocol metadata and error codes stay
outside the envelope. Prompt arguments and memory content are placed
in escaped passive-data fences so an MCP client renders them as data,
never as instructions.
