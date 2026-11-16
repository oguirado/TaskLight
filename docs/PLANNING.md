# TaskLight Planning

This guide covers the v9 planning model used by developers and agent
operators. Planning turns a template into a concrete plan inside a room,
and an MCP client drives tasks, microtasks and memory through the tools
described in [MCP](MCP.md). Plan and memory storage is local to the host;
nothing is collected in the cloud.

## Planning templates (`planning-template/v1`)

A planning template is a JSON document with version field `v` validated
against `schemas/planning-template.v1.schema.json`. The document carries:

- `id`, `v`, `name` (at most 40 characters), `summary`.
- `hash`: the sha256 of the canonical JSON of the document. The `hash`
  field itself is excluded from the hashed input.
- `brief_fields[]`: at most 8 fields collected from the user before a
  plan is opened.
- `phases[]`: at most 8 ordered phase objects shaped
  `{id, label, exit}`.
- `task_types[]`: at most 12 task type objects shaped
  `{id, label, accept_required, evidence_required, micro_hints[]}`.
- `granularity`: `tasks_max` bounded at 40 (matching task ids `T01` to
  `T40`), `micro_min` at 1 or more, `micro_max` at 12 or fewer. The
  rule is one verifiable outcome per microtask.
- `memory_sections[]`: at most 12 sections, each with `max_chars` at
  most 2,000 characters.
- `lens_id`: an optional lens identifier.

Every template is checked for control characters and code-like strings
before use. Templates supplied by the user live in `CW_HOME/templates/`
and are validated as untrusted data.

Derived `rooms/<room>/PLAN.md` and `rooms/<room>/MEMORY.md` files are
human-readable exports of the folded plan and memory. They are never the
source of truth; the room event log is authoritative.

## Starter templates

The schema itself uses neutral planning vocabulary; software terms exist
only inside development starters. Five starters ship in
`templates/planning/*.json`:

- `blank`: the neutral minimal template.
- `web-app`: the full-stack development template used by the demo room.
- `cli-library`: a command-line library template.
- `mobile-app`: a mobile application template.
- `data-ml`: a data and machine-learning template.

## Agent creation flow over MCP

1. List or fetch a starter with `list_templates` or `get_template`, or
   go through the `plan_from_template` prompt.
2. Seed memory with `memory_set`. Memory may be written before a plan
   exists, using initial `base_rev: 0`.
3. Create the plan with `plan_create`. The call is one atomic batch: a
   `plan.open` op plus `task.add` ops referencing local `key` values,
   with `deps` and `microtasks` inlined. An optional `strict` flag asks
   for conformance to be enforced.
4. Read `conformance.findings[]`. Findings are advisory by default; when
   `strict` is true the batch is rejected with `not_conformant` instead.
5. Execute with `next_work`, `task_claim`, `task_release`,
   `microtask_add`, `microtask_set`, `plan.phase` and `plan.close`.
   Agents that need context can call `resume_from_memory`.

## Task and microtask model

- One active plan per room. The plan id is `p1`. Closing a plan and
  opening a new one archives the closed plan in `archived_plans`, resets
  tasks and ids, and preserves memory and replay history.
- Tasks are numbered `T01` through `T40`, monotonic and never reused.
  A task records `title` (at most 120 characters), `type`, `phase`,
  `accept` (at most 160 characters), `deps[]` (at most 8), `assignee`
  (an agent slug or `null`), `claim_lamport`, `estimate` (at most 32
  characters) and `rev`.
- Microtasks are numbered `T01.M01` through `T40.M12` (at most 12 per
  task). A microtask records `text` (at most 80 characters), `accept`
  (at most 160 characters), `state`, `outcome` (at most 240 characters),
  `took` (at most 32 characters), `evidence[]` (at most 8 absolute
  paths with sha256) and `rev`.
- States: a plan is `active` or `closed`. A microtask is `pending`,
  `active`, `blocked` or `done`. Task state is derived from its
  microtasks, except for explicit `blocked` (with `blocked_reason`)
  and `cancelled` set through the task update tool. Progress is the
  `done` microtasks divided by total microtasks, computed from the
  folded projection.
- A dependency is satisfied when its task is `done` or `cancelled`.
  Dependency readiness excludes those completed or cancelled tasks;
  agenda eligibility additionally excludes `blocked` tasks. A task whose dependencies are unsatisfied waits and reports
  `ready: false`.

## Privacy

In the MVP both plan and memory data stay on-device. The `private` tier
never leaves the device, `standard` prefers on-device storage with a
fallback only when allowed, and `shared` permits hybrid review. The
relay redacts all strings inside `op` events before browser delivery,
and agent-provided strings remain inside `untrusted` envelopes rather
than being interpreted by the wall.
