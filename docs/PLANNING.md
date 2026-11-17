# TaskLight Planning

This guide covers the v9 planning model used by developers and agent
operators. Planning turns a template into a concrete plan inside a room,
and an MCP client drives tasks, microtasks and memory through the tools
described in [MCP](MCP.md) under the rules in
[docs/PLANNING_CONTRACT.md](PLANNING_CONTRACT.md). The external harness deploys and directs agents; TaskLight maintains their
shared plans and coarse microtasks. Room storage is local to the host; model
access remains subject to room privacy policy.

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

**Markdown exports and memory history:** `room_export` is shipped and
returns `{format:"markdown",text,rev}` for `what:"plan"` or `what:"memory"`.
`memory_history` returns accepted memory revisions newest first. Both are
available through MCP and `python3 -m bridge.room call`; see
[HEADLESS.md](HEADLESS.md#5-cli-parity) for examples and the supported
`export --room R --out DIR` command. The file exporter implementation
writes `PLAN.md` and `MEMORY.md` only beneath `$CW_HOME`. The room event
log (`events.jsonl`) remains authoritative.

## Starter templates

The schema itself uses neutral planning vocabulary; software terms exist
only inside development starters. Starter templates ship in
`templates/planning/*.json`:

- `blank`: the neutral minimal template.
- `autonomous-software`: the six-phase (`brief`, `design`, `oracle`,
  `build`, `verify`, `release`) software template built for
  [docs/PLANNING_CONTRACT.md](PLANNING_CONTRACT.md).
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
5. Execute with `work_acquire` and boundary-only `work_report` batches.
   `work_acquire` claims without takeover and returns the claim fence;
   `work_report` records completed outcomes and evidence and activates the next
   pending microtask in one append transaction. The granular alternative is
   `next_work` then `task_claim`, followed by `microtask_set`. Use `task_release`
   for unfinished handoff, `microtask_add` for added work, `plan_phase` for phase
   gates and `plan_close` only after all tasks are `done` or `cancelled`.
   See [HEADLESS.md](HEADLESS.md) for the executable workflow and
   [SWARM.md](SWARM.md) for `swarm_coordinator`, `swarm_executor`, `executor_loop`.
   Send `activity_beat` every 30 seconds while assigned work is active;
   beats supply liveness, not task completion. Use a separate stdio
   connection for blocking waits so beats can continue. After 90 seconds
   without a valid beat the wall shows **Liveness unknown**; partially done
   work alone is not evidence of execution.
   Agents that need context follow the [resume ladder](PLANNING_CONTRACT.md#5-resume-after-context-loss)
   or call `resume_from_memory`.

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
  Cancellation unblocks dependants but does not count as completed work
  or establish acceptance; cancelled tasks are excluded from `next_work`.
  Dependency readiness excludes those completed or cancelled tasks;
  agenda eligibility additionally excludes `blocked` tasks. A task whose dependencies are unsatisfied waits and reports
  `ready: false`.

## Ownership and dependency gates

Unassigned microtask writes return `not_conformant`; foreign writes return
`claimed_by_other`. Dependencies must be `done` or `cancelled` before a
microtask can become `active` or `done`. A stale optional `claim_lamport` on
`microtask_set` or `task_release` returns `stale_rev`. Release resets active
microtasks to `pending`. Terminal task release is rejected: **HOLD** until its
upstream contract is resolved. Premature closure returns `not_conformant` with
unfinished task identifiers. A lean-plan gate cannot pass until required owner
contracts, discovery descriptors and dependency admission are verified.

Reuse the harness-recorded `run_id`, stable per attempt. Executors never
self-announce deployment or exit. Human questions and terminals belong in the
harness; retained chat and liaison are legacy, with no new investment.
Report outcomes and evidence at coarse microtask boundaries.

## Privacy

The room journal is local storage. Private narration stays on-device; if
unavailable it uses a labelled **Rules summary**. Narration cannot mutate the
room. Other tiers permit cloud narration only under privacy policy. Cloud
executors operate under the harness and its configured data boundaries. The
relay redacts all strings inside `op` events before browser delivery
(structural sha256 values such as `template_hash` and evidence hashes pass
unchanged, and a redacted `op_id` becomes an opaque surrogate),
and agent-provided strings remain inside `untrusted` envelopes rather
than being interpreted by the wall.
