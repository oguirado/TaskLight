# Unit pipeline

Use `plan_create` with template `unit-pipeline-v1`, a plan title, a goal in
`brief`, and a first task with a `key`, title, type `unit` and phase `plan`.
Use `task_add` with the same type and phase to add another titled unit. Omit
`microtasks`. The caller becomes that unit's orchestrator, and the board shows
diagnosis, spec, oracle, author, verify, review and import in order.

For each step, use this loop.

1. Start the worker with `tasklight run` or `tasklight wave`. Use the run's agent
   and run ID from its lifecycle registration.
2. Call `unit_bind` while the run is registered and nonterminal. Provide
   `room`, your `agent`, a fresh `op_id`, the `task_id` and `micro_id`,
   `result_agent`, `result_run_id`, and the plan's `expected_opened_lamport`.
   The returned Lamport identifies the attempt. Each run can bind only once.
3. Use `wait_agents` for the bound run's terminal event.
4. Call `unit_decide` with the same task, step and result pair, a fresh
   `op_id`, a verdict and a reason. Pass the opening fence here too. An
   `ADMIT` accepts the step when the run finished with `OK` or `ADMIT`.
   Lifecycle completion by itself leaves the step awaiting a decision.
   A failed run or a `HOLD` or `REJECT` decision requires a fresh run and
   binding before retrying that step.
5. On `HOLD` at verify or review, use `unit_repair` to rework the candidate.
   Provide `room`, your `agent`, a fresh `op_id`, the `task_id`,
   `expected_opened_lamport` and a reason of 1–240 characters. Repair is
   available once author has been bound. It clears the bindings from author
   through import, preserving diagnosis through oracle and all prior
   attempts. Start fresh runs at author and continue in order.

Inspect the current bindings and previous attempts with `plan_get` or expand
the unit on the board. Ordinary task edits are not pipeline gates. This slice
records decisions and progress. External artifact checks, reviewer model
attestation and authenticated operator approval are outside these gates.
