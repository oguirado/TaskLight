# TaskLight MCP

This guide is for integrators connecting any MCP client to TaskLight.
The plan and memory protocol is described in [PLANNING](PLANNING.md).

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

Twenty tools are exposed. One-line purposes:

Legacy six (`TOOLS[0:6]`):

- `post_status`: post a status heartbeat event to a room.
- `post_plan`: post a legacy plan with steps to a room.
- `post_step`: post a step update to a room.
- `close_task`: close an agent task with a one-line outcome.
- `read_inbox`: read inbox events for an agent.
- `wait_inbox`: wait for the next inbox event for an agent.

v2 fourteen (`TOOLS[6:20]`):

- `list_templates`: list the available planning templates.
- `get_template`: fetch one planning template by id.
- `plan_create`: atomically open a plan and add its tasks.
- `plan_get`: return the folded projection, with nested
  `tasks[].microtasks` entries inside the task list.
- `plan_check`: check plan conformance against its base template.
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
- `microtask_set`: set a microtask by `id` (mapped to `op.micro_id`)
  with `evidence` carried inside the op; the op must not carry a
  revision field.
- `next_work`: return the next ready task for the calling agent.
- `memory_set`: write one memory section text.
- `memory_get`: read one memory section text.

## Resources and prompts

Resources are read-only and never create directories:

- `resources/list`, `resources/templates/list`, `resources/read`.
- `tasklight://templates/{id}` for one planning template.
- `tasklight://rooms/{room}/plan` for the folded plan projection.
- `tasklight://rooms/{room}/memory` for all memory sections.

Prompts used to build plans from a template:

- `prompts/list`, `prompts/get`.
- `plan_from_template` with `template_id` and `brief` arguments.
- `resume_from_memory` with a `room` argument and optional `agent`.

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

- required on `plan.close`, `plan.phase`, `task.set`, `micro.add`
  and `memory.set` (`0` for the first write of a section);
- optional on `task.add`, `task.claim` and `task.release`;
- forbidden on `micro.set` (`bad_op` is returned).

A missing required `base_rev` is `bad_op`; a mismatch is `stale_rev`.

Every complete v2 data payload is wrapped in an untrusted envelope:
`{"untrusted": payload}`. Protocol metadata and error codes stay
outside the envelope. Prompt arguments and memory content are placed
in escaped passive-data fences so an MCP client renders them as data,
never as instructions.
