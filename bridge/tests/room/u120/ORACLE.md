# U120 fail-first oracle

Spec: `.unit/SPEC.md`, read through Amendment C. Status: **DRAFT; U120 RESCOPE** [CITED: `.unit/SPEC.md`]. Full-plan **W2**; lean-plan deferral after **30 Nov** [CITED: `.unit/SPEC.md`]. Integration dependencies: **U109, U111, U119 (schema binding), U132** [CITED: Amendments B/C]. The prompt correction still belongs in lean **W2** if the rest of **U120** defers [CITED: Amendment C].

Only `bridge/tests/room/u120/` contains oracle deliverables. Application surfaces remain `bridge/room/app.py`, `bridge/room/mcp.py`, and `bridge/room/__main__.py`; they are not modified. Existing room suites are not modified. `support.py` provides observations and fixtures, not a replacement application or storage implementation. Imports use only existing modules and the standard library. Missing `dispatch(..., *, pin=None)` is an explicit assertion failure, never an import error or unexpected keyword exception.

## Run

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u120 -t .
```

Recorded result: **264 tests, 237 red, 27 green, no errors or skips** [MEASURED]. Exact unittest summary:

```text
FAILED (failures=237)
```

The current failures concern absent trusted pin support, ignored startup configuration, absent pre-handler adapter refusals, mutable/absent startup context, and missing prompt corrections/trust wording. Preserved behavior can pass. No `expectedFailure`, skip gate, external service, real deadline, or missing-module prerequisite makes these tests red.

## Acceptance map

Test names below are relative to their indicated class. Generated names are ordinary discoverable unittest methods; the source generators enumerate each case deterministically.

| Acceptance | Tests | Decision checked |
| --- | --- | --- |
| A1 | `AdapterOracle.test_startup_cli_role_only`, `test_startup_mcp_role_only`, `test_startup_cli_empty_both`, `test_startup_mcp_empty_both`, `test_startup_cli_liaison`, `test_startup_mcp_liaison`, `test_startup_cli_bad_agent`, `test_startup_mcp_bad_agent`, `test_neither_variable_cli_legacy_post`, `test_neither_variable_mcp_tools_resources_prompts`, `test_cli_unpinned_tools_still_available`; all startup and valid-startup generated methods in `test_adapters.py` | Amendment C validation order, exact untrimmed syntax, JSON channels, startup exit, no stdin or `CW_HOME` access, and no missing-room creation. Both valid roles and the existing punctuation/length syntax remain usable. |
| A2 | `AdapterOracle.test_mcp_post_status_foreign`, `test_mcp_post_status_same`, `test_call_post_status_foreign`, `test_call_post_status_same`, `test_post_post_status_foreign`, `test_post_post_status_same`, `test_mcp_room_send_foreign`, `test_mcp_room_send_same`, `test_call_room_send_foreign`, `test_call_room_send_same`; `DispatchOracle.test_foreign_actor_post_status`, `test_foreign_actor_room_send` and the full tool matrix below | MCP tool-error contract, CLI call/legacy exit mapping, actionable detail, unchanged journal bytes/head, untouched handlers/store/room stat, registered extension parity, and real successful writes. |
| A3 | `ReplayLifecycleOracle.test_unpinned_retry_still_deduplicates`, `test_pinned_retry_refuses_before_receipt_lookup`, `test_matching_pinned_retry_still_deduplicates`, `test_replay_mcp_refuses_without_disclosure`, `test_replay_cli_refuses_without_disclosure`, `test_control_late_replay_guard_is_detected` | Real unpinned `room_send` seed: sender `executor-b`, recipient `coordinator`, act `question`, text `private-marker`, `op_id="u120-replay-01"`. A foreign pinned retry reaches neither room I/O nor receipt lookup, discloses no message/receipt, and preserves journal bytes/head. Legitimate replay remains deduplicated. |
| A4 | `ReplayLifecycleOracle.test_harness_real_lifecycle_deploy_without_plan_and_replay`, `test_harness_premature_finished_keeps_u132_conformance`, `test_harness_preserves_lifecycle_validation`, `test_harness_preserves_alive_throttle_and_retired_run`, `test_mcp_lifecycle_harness_executor_b`, `test_cli_lifecycle_harness_executor_b`, `test_mcp_lifecycle_executor_executor_a`, `test_mcp_lifecycle_executor_executor_b`, `test_cli_lifecycle_executor_executor_a`, `test_cli_lifecycle_executor_executor_b`; generated executor-state, invalid-harness-target, and U109 preservation methods in `test_replay_lifecycle.py` | Real registered U132 integration is required, not skipped. `coordinator/harness` may deploy target `executor-b` with `run_id="u120-run"`, `op_id="u120-life-01"`, no plan, and unchanged replay. Amendment C rejects every executor lifecycle target, including self. Harness does not bypass validation, retirement, throttling, ownership, prerequisites, fencing, or premature-finish conformance. |
| A5 | `DispatchOracle.test_hostile_role`, `test_hostile_pin`, `test_hostile_harness`, `test_hostile_payload`, `test_nested_pin_and_passive_fields_do_not_change_actor`, `test_real_room_send_to_another_agent_is_permitted`, `test_harness_no_general_privilege_post_status`, `test_harness_no_general_privilege_read_inbox`, `test_harness_no_general_privilege_plan_get`, `test_harness_no_general_privilege_room_events`, `test_harness_no_general_privilege_room_send`, `test_harness_no_general_privilege_task_claim`; `AdapterOracle.test_mcp_initialize_and_meta_cannot_override_session` | Caller arguments, nested labels, `initialize` metadata and `_meta` cannot replace the startup pin or elevate its role. The guard checks calling `agent`, not `to`, `assignee`, or passive text. No general harness privilege or room read authorization is added. |
| A6 | `DispatchOracle.test_required_agent_is_not_injected`, `test_agent_null_required`, `test_agent_null_optional`, `test_optional_agent_omission_preserves_args`, `test_real_optional_plan_get_preserves_unpinned_result`, `test_interleaved_contexts_are_independent`, `test_context_and_request_are_not_mutated_or_serialized`, `test_startup_context_is_immutable`, `test_unpinned_validation_and_envelope_compatibility`; `AdapterOracle.test_sessions_do_not_leak_context`, `test_mcp_pin_is_captured_before_first_input_and_requires_restart`; generated required/optional omission, agent-type, malformed-context, argument-shape and unregistered-name methods | Required omission/null is `bad_agent`; optional omission remains omission. Explicit invalid agent types/whitespace/case are rejected. Requests and contexts stay separate, context is immutable, pin/role is not journaled, and independent sessions/interleaved dispatch do not share identity. |
| A7 | All methods in `PromptOracle`: named prompt/capability matrix, `test_fallback_branch_is_distinct_from_available_branch`, `test_coordinator_hostile_brief_remains_passive`, `test_module_trust_wording_mcp`, `test_module_or_cli_help_trust_wording` | Retrieve `swarm_coordinator`, `swarm_executor`, `executor_loop` with both U119 tools, neither, acquisition only, and report only. Discover `tools/list`, branch on `EXT_TOOLS`, use `work_acquire`/`work_report` as available, retain legacy fallback, evidence/next-active guidance, stable `run_id`, periodic beats, human questions through harness, lifecycle hook bookkeeping, passive fences and exact trust wording. Retrieval dispatches no tool; fixture sockets/process creation are forbidden. |
| A8 | `ReplayLifecycleOracle.test_control_late_handler_guard_is_detected`, `test_control_late_replay_guard_is_detected`, `test_control_executor_lifecycle_privilege_is_detected` | Each control establishes nominal refusal first. In-memory mutations then deliberately invoke a no-I/O handler before the guard, perform room/replay access before the guard, or elevate executor lifecycle to harness. The same refusal observations must reject each mutation by assertion. Production files are never mutated. Infrastructure errors do not satisfy the controls. |

## Binding amendments and stop rules

| Contract | Additional test names/families | Resolution |
| --- | --- | --- |
| M1 / B / C validation order | `test_startup_cli_invalid_agent_before_role`, `test_startup_mcp_invalid_agent_before_role`, `test_startup_cli_missing_role_before_bad_agent`, `test_startup_mcp_missing_role_before_bad_agent`, `test_startup_cli_empty_role_before_bad_agent`, `test_startup_mcp_empty_role_before_bad_agent` | Both absent is unpinned. Otherwise missing/empty wins before invalid agent; invalid agent wins before unknown role. Environment values are strings; JSON-looking strings are probes, not impossible non-string OS environment values. |
| C every CLI subcommand | `test_invalid_startup_stops_post`, `test_invalid_startup_stops_read`, `test_invalid_startup_stops_wait`, `test_invalid_startup_stops_status`, `test_invalid_startup_stops_export`, `test_invalid_startup_stops_tools`, `test_invalid_startup_stops_call`, `test_wait_explicit_foreign_agent_before_stat`, `test_wait_same_agent_filter_is_preserved` | Invalid startup must stop every subcommand before room stat/read/write. For pinned legacy `wait`, explicit `--agent` follows Amendment C's explicit-agent guard; omission remains optional. |
| B malformed pin / C registered name and dictionary args | `DispatchOracle.test_malformed_pin_*`, `test_args_*`, `test_unregistered_name_*`, `test_unknown_handler_is_not_registered_by_dispatch_table_alone` | Fail closed with existing `bad_args`/`bad_agent`; a dispatch-table entry alone does not establish schema registration. Wrong exceptions are assertions, not successful refusal detection. |
| M4 / C lifecycle precedence | `test_executor_lifecycle_executor_a_deployed`, `test_executor_lifecycle_executor_b_deployed`, all generated lifecycle-state probes, `test_harness_missing_target`, `test_harness_invalid_target_*` | Amendment C supersedes the original executor self-target allowance in M4/A4/A8. Only a trusted harness context may call `agent_lifecycle`; targets must still satisfy existing agent syntax. Request `harness` grants no role. |
| M2 immutable context representation | `test_startup_context_is_immutable`, `test_context_and_request_are_not_mutated_or_serialized`, `test_interleaved_contexts_are_independent` | No context class, constructor, factory, helper name, or mutable global is assumed. The fixture captures the adapter's explicit `pin` argument and reuses that public context at shared dispatch. Mapping and attribute-based immutable representations are supported. |
| M7 / B / C U119 binding | `PromptOracle.test_swarm_coordinator_*`, `test_swarm_executor_*`, `test_executor_loop_*` | Runtime `tools/list` supplies real U119 schemas. No invented `work_report` arguments or required example syntax is introduced; guidance must bind to a frozen/discovered schema. No named harness product, provider, launcher, or hook adapter is added by the oracle. |

The exact trust text checked in M8 is: "The session pin prevents accidental cross-agent calls. It is not authentication. Agent identity remains caller-asserted within the same-user CW_HOME boundary."

## Discovered-tool guard matrix

Every listed tool has a foreign-actor test with a no-I/O handler spy. Omission tests are selected from the registered schema, so optional reads are not accidentally assigned an actor. The actual `room_send`, `agent_lifecycle`, `work_acquire`, and `work_report` handlers already exist in this workspace [MEASURED]; the spec's older lifecycle-stub note is stale. Discovery and successful lifecycle calls prove integration rather than silently skipping it.

| Tool | Calling agent schema | Foreign-actor test | Omission test |
| --- | --- | --- | --- |
| `post_status` | required | `test_foreign_actor_post_status` | `test_required_agent_missing_post_status` |
| `post_plan` | required | `test_foreign_actor_post_plan` | `test_required_agent_missing_post_plan` |
| `post_step` | required | `test_foreign_actor_post_step` | `test_required_agent_missing_post_step` |
| `close_task` | required | `test_foreign_actor_close_task` | `test_required_agent_missing_close_task` |
| `read_inbox` | required | `test_foreign_actor_read_inbox` | `test_required_agent_missing_read_inbox` |
| `wait_inbox` | required | `test_foreign_actor_wait_inbox` | `test_required_agent_missing_wait_inbox` |
| `list_templates` | optional/absent | `test_foreign_actor_list_templates` | `test_optional_agent_missing_list_templates` |
| `get_template` | optional/absent | `test_foreign_actor_get_template` | `test_optional_agent_missing_get_template` |
| `plan_create` | required | `test_foreign_actor_plan_create` | `test_required_agent_missing_plan_create` |
| `plan_get` | optional/absent | `test_foreign_actor_plan_get` | `test_optional_agent_missing_plan_get` |
| `plan_check` | optional/absent | `test_foreign_actor_plan_check` | `test_optional_agent_missing_plan_check` |
| `task_add` | required | `test_foreign_actor_task_add` | `test_required_agent_missing_task_add` |
| `task_update` | required | `test_foreign_actor_task_update` | `test_required_agent_missing_task_update` |
| `task_claim` | required | `test_foreign_actor_task_claim` | `test_required_agent_missing_task_claim` |
| `task_release` | required | `test_foreign_actor_task_release` | `test_required_agent_missing_task_release` |
| `microtask_add` | required | `test_foreign_actor_microtask_add` | `test_required_agent_missing_microtask_add` |
| `microtask_set` | required | `test_foreign_actor_microtask_set` | `test_required_agent_missing_microtask_set` |
| `next_work` | required | `test_foreign_actor_next_work` | `test_required_agent_missing_next_work` |
| `memory_set` | required | `test_foreign_actor_memory_set` | `test_required_agent_missing_memory_set` |
| `memory_get` | optional/absent | `test_foreign_actor_memory_get` | `test_optional_agent_missing_memory_get` |
| `plan_phase` | required | `test_foreign_actor_plan_phase` | `test_required_agent_missing_plan_phase` |
| `plan_close` | required | `test_foreign_actor_plan_close` | `test_required_agent_missing_plan_close` |
| `room_events` | required | `test_foreign_actor_room_events` | `test_required_agent_missing_room_events` |
| `activity_beat` | required | `test_foreign_actor_activity_beat` | `test_required_agent_missing_activity_beat` |
| `room_export` | required | `test_foreign_actor_room_export` | `test_required_agent_missing_room_export` |
| `memory_history` | required | `test_foreign_actor_memory_history` | `test_required_agent_missing_memory_history` |
| `room_send` | required | `test_foreign_actor_room_send` | `test_required_agent_missing_room_send` |
| `agent_lifecycle` | required | `test_foreign_actor_agent_lifecycle` | `test_required_agent_missing_agent_lifecycle` |
| `work_acquire` | required | `test_foreign_actor_work_acquire` | `test_required_agent_missing_work_acquire` |
| `work_report` | required | `test_foreign_actor_work_report` | `test_required_agent_missing_work_report` |

## Hardening and regression limits

`session-pin-guard`: `DispatchOracle.test_session_pin_guard_no_io_fixture` provides the same real shared dispatch over a no-I/O handler in pinned and unpinned modes. Its canonical fixture SHA-256 is `c7dd433772fad72740541687d74d851bacb03a82fdc599a70a28ec1f7b92bbcd` [MEASURED]. Fixture environment: CPython `3.12.3`, Linux `aarch64` [MEASURED], fixed time and deterministic IDs, sockets/process creation/sleeps forbidden, scratch and `CW_HOME` inside this oracle package. No host identifier or local artifact location is published.

The added-guard p95 target is **at most 1 ms** [CITED: `.unit/SPEC.md`]; the load gate is **load5 below 18** [CITED: `.unit/SPEC.md`]. Timing baseline, wall time for the guard, load telemetry and p95 are **AUSENTE**. Timing is **INCONCLUSIVE**, never PASS; this deterministic oracle fabricates no timing. Current correctness is **BLOCK** because U120 behavior is missing. Rejected replay I/O and lookup absence are asserted independently of timing. The performance fixture is scoped entirely to this directory.

Regression observation: standard pre-existing room discovery ran **1268 tests** [MEASURED] before oracle execution. It had a scheduling-dependent `real sleep forbidden` failure inside subprocess cleanup; that test passed separately. A subsequent existing-only discovery had **9** such failures and **6** existing skips [MEASURED]; all **9** failing tests passed in an isolated rerun [MEASURED]. No U120 test was executed in that existing-only run. Therefore full-suite green is not claimed. An expanded historical filename sweep also includes stale tool-count/replay/conformance expectations and a stdin-runner multiprocessing error; those are not counted as U120 failures or gate detections.

## Out of scope

| Owning unit/surface | Treatment |
| --- | --- |
| U109 ownership/dependency/fencing implementation | Existing gates are exercised through pinned integration calls; their algorithms/storage are not reimplemented. |
| U110 message persistence and read semantics | Real public `room_send` seeds establish replay fixtures; wider messaging implementation stays with its unit. |
| U111 hook adapters and human conversation transport | Prompt wording routes human questions through the harness; no hook invocation, launch, or messaging service is added. |
| U119 acquisition/report implementation and exact schema definition | Existing discovered schemas bind guidance; acquisition/report algorithms are not duplicated. |
| U132 lifecycle/storage implementation, retirement/throttle algorithms and exhaustive conformance | Real integration is mandatory and tested for preserved outcomes; comprehensive lifecycle internals remain U132 tests, not a missing-U120 failure category. |
| U131 public guides, `docs/HEADLESS.md`, authentication, RBAC, room authorization, UI | Not edited or newly implemented. The trust sentence does not claim authentication or a room floor. |

The mandate is limited to the supplied spec and the confirmed repository seams in this isolated workspace.
