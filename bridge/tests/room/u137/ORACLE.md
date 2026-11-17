# U137 fail-first oracle

Specification: `.unit/SPEC.md`, **R39, DRAFT**, including final **Amendment B**. Tests use stdlib `unittest`. Only this test package is added; no production handlers, configuration writers, adapter stubs, or native event fixtures are substituted.

## Execution and observed state

Run from the repository root:

    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u137 -t .

Discovery: **42 tests; 26 red, 8 green, 8 blocked/skipped; no errors** [MEASURED]. Exact summary:

    FAILED (failures=26, skipped=8)

Every red test stops at an assertion naming an absent required artifact: `docs/HARNESS_ANTIGRAVITY.md` or a file under `templates/antigravity/`. None is an import error. A failed artifact prerequisite does not establish execution of its downstream behavioral scenario.

The existing room suites `bridge.tests.room.test_post`, `bridge.tests.room.test_read`, `bridge.tests.room.test_mcp` and `bridge.tests.room.test_hook` pass: **74 tests, OK** [MEASURED]. Bytecode writes are disabled for runner and Python children, and regression temporary storage is confined to this package. The file-set/content digest outside this package matches its baseline [MEASURED].

`tools/secret_scan.sh` completed without findings [MEASURED]. Live client compatibility, native lifecycle and wall receipts remain **AUSENTE**.

## Acceptance-to-test mapping

Names below are methods in the indicated test file. BLOCKED is not a pass and does not attribute another unit's missing behavior to U137.

| Spec | Explicit tests | Coverage and stop boundary |
| --- | --- | --- |
| A1 | `test_contract.py`: `test_a1_raw_config_navigation_and_manual_preservation`, `test_a1_unknown_client_capabilities_are_ausente`, `test_a1_tasklight_registration_is_separate_from_firebase`, `test_a1_live_compatibility_receipts_cannot_be_inferred`; `test_registration.py`: `test_a1_registration_json_has_only_public_command_and_args`, `test_a1_documented_launcher_initializes_and_discovers_offline`, `test_a1_launcher_preserves_unrelated_and_malformed_configurations`; `test_protocol.py`: `test_a1_initialize_and_discover_coordination_prompts`, `test_a1_required_lifecycle_capability_is_discovered_before_use` | Required registration artifacts are red. Existing server discovery is green. Launcher execution is gated by absent documentation; lifecycle discovery is blocked by U132. Client version, redacted configuration, live Antigravity responses, wall evidence and compatibility receipt: AUSENTE. |
| A2 | `test_contract.py`: `test_a2_manual_activation_and_unknown_native_triggers`, `test_a2_discover_prompts_before_get_and_version_fallback_copies`, `test_a2_coordinator_reads_plans_assigns_routes_and_reconciles`, `test_a2_executor_claims_before_editing_and_keeps_identity`, `test_a2_beats_retired_runs_and_takeover_rule`; `test_protocol.py`: `test_a2_versioned_templates_retain_discovered_u111_prompt_text` | Missing templates are red. Copies are checked against real discovered U111 rules, excluding their interpolated data fence. Shared-plan mutation gates belong to U109; wall parity on ownership, task/microtask, progress and blocked dependencies remains a cross-unit integration prerequisite. No Python wall projection is invented. |
| A3 | `test_contract.py`: `test_a3_no_adapter_without_public_native_contract`, `test_a3_guide_declares_native_contract_and_automatic_lifecycle_ausente`, `test_a3_conditional_contract_covers_persistence_without_model_calls`, `test_a3_native_replay_failure_release_bound_and_op_id_mutant` | No-adapter gate is green; missing guide is red. Native event names, payload schema, delivery/retry identity and invocation semantics are AUSENTE. Native deploy without a plan, failure/release, single-event replay, held-lock/missing-room execution bounds and provider non-invocation remain BLOCKED. |
| A4 | `test_contract.py`: `test_a4_explicit_enablement_and_r39_exception`, `test_a4_fallback_provenance_is_agent_reported`, `test_a4_bookkeeping_tokens_and_limited_c1_coverage`, `test_a4_graceful_release_and_abrupt_kill_limit`; `test_protocol.py`: `test_a4_deploy_alive_and_truthful_finish_without_plan`, `test_a4_observed_failure_carries_agent_reported_origin`, `test_a4_retry_identity_does_not_duplicate_mutations`, `test_a4_abrupt_kill_expires_to_unknown_without_fabricated_failed` | Missing fallback artifacts are red. Real MCP lifecycle fixtures are dependency-gated. No harness kill event is invented. Beat expiry/wall rendering and retired runs belong to U132/U90. Limited fallback coverage never establishes NORTH_STAR C-1. |
| A5 | `test_contract.py`: `test_a5_interpolated_text_and_untrusted_results_are_passive`, `test_a5_hook_fallback_same_run_collision_stop_rule`, `test_a5_caller_asserted_identity_and_same_user_boundary`, `test_a5_public_artifacts_contain_no_operator_or_secret_leaks`; `test_registration.py`: `test_a5_launcher_quotes_hostile_configured_paths`, `test_a5_launcher_never_interpolates_event_text_into_shell`, `test_a5_quoting_probe_keeps_unsafe_expansions_visible`; `test_protocol.py`: `test_a5_hostile_prompt_brief_stays_passive_without_mutation`, `test_a5_malformed_json_is_rejected_without_append_and_stream_recovers`, `test_a5_traversal_room_is_rejected_without_storage_escape`, `test_a5_unknown_tool_is_not_a_lifecycle_transition`, `test_a5_invalid_lifecycle_state_and_room_append_nothing`, `test_a5_valid_reason_is_data_and_does_not_execute` | Existing framing, passive brief and traversal checks are green. Missing artifacts are red; lifecycle validation is blocked by U132. Launcher paths contain whitespace, quotes, substitutions and backticks. Collision coverage requires the fallback rule to stop same-run reporting with a hook enabled; no authenticated identity or backend collision API is invented. Unknown native events remain blocked with A3. |
| A6 | `test_contract.py`: `test_a6_provenance_mutant_is_rejected_after_positive_control`, `test_a6_missing_template_is_not_a_detected_mutant`, `test_a3_native_replay_failure_release_bound_and_op_id_mutant` | The actual fallback must pass its positive control before provenance mutation. Its absence is currently a red assertion, not a detected mutant. The missing-positive-control guard is green. Removing event-derived `op_id` cannot be tested without documented native fixtures; BLOCKED. Infrastructure errors never count as detected mutants. |

## MUST and amendment coverage

| Requirement | Mapping |
| --- | --- |
| M1 | A1 navigation, copyable `mcpServers.tasklight` JSON using only `command`/`args`, working directory/`CW_HOME` launcher, configuration preservation and unsupported client details marked AUSENTE. |
| M2 | A2 manual activation, discovery/get order, versioned U111 copies, coordinator/executor roles, stable slug/`run_id` and evidence boundaries; A5 passive task text/results. |
| M3 | A3 no adapter without native evidence, no extrapolation from `hook_claude.py`/`PostToolUse`, automatic lifecycle AUSENTE and agent-reported token accounting. |
| M4 | A3 conditional documentation and stop gate. U133 owns `bridge/room/hook.py`, its `docs/HARNESS_HOOKS.md` stdin contract, validation/replay/throttle/release and execution bound. Native checks remain blocked. |
| M5 | A4 explicit fallback, truthful state order, `Antigravity 2 (agent-reported)`, R39/U111 exception, stable retry identity and explicit `task_release`; A5 mutual exclusion and A6 provenance control. |
| M6 | A2 preserves dependency/ownership guidance, beats, retired runs and takeover; A4 abrupt termination/C-1 limitation; A5 caller-asserted identity, same-user `CW_HOME`, routing boundaries and leaks. Optional Firebase skills stay separate. |
| M7 | Deterministic offline unittest discovery, selected existing room regressions and repository secret scan; missing prerequisites block rather than pass. |
| Amendment B.1 | W2/W3 scheduling after U111/U132/U133 ADMIT and registering Surface in `STRATEGY_v11_A1.md` section 4.2 belong to the strategy/orchestrator lane. ADMIT receipts: AUSENTE. |
| Amendment B.2 | Referenced “section (2) above” is absent from the supplied specification. Final explicit M1/M2/M3/M5 wording governs; no unseen rewrite is invented. |
| Amendment B.3 | A5 hostile path quoting, public-artifact leak scanning and hook/fallback same-run collision stop-rule tests are explicitly mapped above. |

## Prerequisites and out-of-scope cases

| Dependency/surface | Status and treatment |
| --- | --- |
| U111 | `swarm_coordinator`/`swarm_executor` are present through `prompts/list`/`prompts/get` [MEASURED]. Availability is not an ADMIT receipt. Shared implementation is unchanged. |
| U132 | `bridge/room/ext/lifecycle.py` is unimplemented and `agent_lifecycle` is absent from discovery [MEASURED]. MCP scenarios skip at discovery, before invoking another unit's stub. |
| U133 | `bridge/room/hook.py` and `docs/HARNESS_HOOKS.md` are prerequisites for the conditional adapter. No native execution/lock timing/replay evidence is fabricated. |
| U134 | Optional only; mailbox implementation and assumed Antigravity participation are out of scope. |
| U109/U90 and wall | Ownership/dependency rejection without append, task release, takeover, retired-run and wall expiry implementations remain with their owning units. Full shared-plan/wall integration receipt: AUSENTE. |
| Native harness | No contract supports `Antigravity 2 (harness-recorded)` events. No adapter ships. That label describes origin, not authenticated identity. |
| Other exclusions | Authentication, process launching/cancellation, new UI/lifecycle schemas, `hook_claude.py` edits, automatic reassignment, Firebase deployment and changing the on-device narrator or `firebase-hybrid` defaults. R39's PREFER_ON_DEVICE, Gemini Nano, gemini-4-hydrogen fallback and private-room restrictions are unchanged. |

The launcher runner fills operator-configured shell assignments and the `cd` operand without prescribing variable names, install locations, client config paths or native trigger names. It binds the parsed registration's launcher placeholder to a scratch executable and preserves its arguments. Scratch client configuration is a preservation sentinel, not a claimed desktop location. The real MCP module runs with sockets, child processes and sleeps denied. A process timeout is a test safety cap, not a lifecycle timing assertion.

Runtime MCP tests use a fixed clock, deterministic nonces and file snapshots. Scratch storage stays under this package and is cleaned. No model inference runs. These assertions are limited to the supplied specification and inspected repository surfaces.
