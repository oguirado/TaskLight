# U143 fail-first oracle

Only files under `bridge/tests/family/u143/` are added. Product files and existing tests are unchanged.

## Spec interpretation and admission boundary

The complete supplied `.unit/SPEC.md` ends with the operator-decisions paragraph. Numbered acceptance cases and Amendment sections are AUSENTE. AC1 through AC7 below are local traceability labels for its gate, MUST, oracle, hostile and negative clauses; they do not replace a missing acceptance list.

The spec requires ADMIT for U109, U119, U121, U132, U139, U140 and U141; work kinds additionally require U142. Package statuses are cited context, not new admissions:

| Dependency | Admission evidence in the supplied spec/package |
| --- | --- |
| U109 | Integrated, review pending [CITED] |
| U119 | Integrated, review pending [CITED] |
| U121 | ADMIT [CITED] |
| U132 | ADMIT [CITED] |
| U139 | ADMIT receipt AUSENTE |
| U140 | ADMIT receipt AUSENTE; implemented fencing is not an admission receipt |
| U141 | ADMIT receipt AUSENTE |
| U142 | ADMIT receipt AUSENTE; required for `work.acquire` and `work.report` |

Production remains HOLD. No admission receipt format, discovery mechanism, public config switch or per-dependency injection API is specified. The oracle invents none. Positive transport cases replace only the existing `bridge.room.family._available_kinds` startup-availability seam with the expected enabled set for explicit `slice:2`. This is a test precondition supplied in memory; it cannot prove runtime admission, capability enablement or an admitted deployment. Validation, allowlists, retained identity, mailbox dispatch, publication and backend commits remain intact. The negative startup test uses the real availability check without this replacement.

`slice:1` is the existing documented default configuration, with all configuration fields still required. The oracle does not require omission of `slice` to become valid. It preserves a documented slice-one example without requiring example ordering or excluding an explicit slice-two example.

## Acceptance map

| Local case | Requirement and verification gate | Negative contrast | Test names |
| --- | --- | --- | --- |
| AC1 | Unadmitted explicit `slice:2` stops before dispatch, receipt or room mutation and retains the request; stderr includes `planning delivery awaits atomic backend generation fencing`. | Tool availability or config alone must not open delivery. | `RoutingOracle.test_unadmitted_slice_two_refuses_startup_before_dispatch` |
| AC2 | Every new kind reaches its fixed registered operation with envelope identity, deterministic operation identity and applicable generation fence. | A generic `bad_args` response or arbitrary dispatcher selection fails. | Exact route matrix below. |
| AC3 | The real-backend scenario crosses the mailbox for every mutation through close and verifies journal projection and exact report replay. | The current stop at `agent.plan` with `bad_args` fails an assertion. | `AllMailboxOracle.test_all_mailbox_progresses_past_agent_plan_through_all_ten_kinds` |
| AC4 | `slice:1` keeps its legacy capability set, documented default and `bad_args` for every new kind, without dispatch. | Unconditionally enabling the new kinds fails. | `RoutingOracle.test_slice_one_capabilities_retains_legacy_and_holds_all_new_kinds`, `RoutingOracle.test_documented_default_configuration_remains_slice_one`, and the slice-one matrix below. |
| AC5 | A source outside `sources` gets `bad_args`; a room outside `rooms` gets `bad_room`. No backend call or journal mutation occurs. Revocation precedes completed-result replay. | Authorization only on initial delivery is insufficient. | Allowlist matrix below; `SafetyOracle.test_revoked_allowlist_applies_before_replaying_a_completed_result`. |
| AC6 | Exact replay returns the retained result without redispatch. Changed envelopes sharing an identity get `bad_op` after result consumption; unread results remain intact; pending conflicts cannot redispatch. | Reusing an id with changed `run_id` or plan arguments fails. | Replay matrix below; `SafetyOracle.test_changed_unread_envelope_never_overwrites_receipt_or_redispatches`, `SafetyOracle.test_changed_pending_envelope_cannot_be_redispatched`. |
| AC7 | The existing closed-envelope and generation-fence boundaries survive new routing; activity accepts and forwards the fence to the actual writer. | Accepting forged identity, arbitrary tools or absent/invalid fences fails; stale activity must be `stale_rev`, not an unfenced append or generic argument rejection. | Supplementary boundary tests listed below. |

### AC2 fixed routes and AC4 preserved slice-one refusal

| Kind / permitted subtool | Shared operation | Positive test | Preserved negative test |
| --- | --- | --- | --- |
| `agent.activity` | `activity_beat` | `RoutingOracle.test_admitted_routes_agent_activity` | `RoutingOracle.test_slice_one_rejects_agent_activity` |
| `agent.plan / plan_create` | `plan_create` | `RoutingOracle.test_admitted_routes_agent_plan` | `RoutingOracle.test_slice_one_rejects_agent_plan` |
| `work.acquire` | `work_acquire` | `RoutingOracle.test_admitted_routes_work_acquire` | `RoutingOracle.test_slice_one_rejects_work_acquire` |
| `work.report` | `work_report` | `RoutingOracle.test_admitted_routes_work_report` | `RoutingOracle.test_slice_one_rejects_work_report` |
| `task.claim` | `task_claim` | `RoutingOracle.test_admitted_routes_task_claim` | `RoutingOracle.test_slice_one_rejects_task_claim` |
| `task.release` | `task_release` | `RoutingOracle.test_admitted_routes_task_release` | `RoutingOracle.test_slice_one_rejects_task_release` |
| `task.update` | `task_update` | `RoutingOracle.test_admitted_routes_task_update` | `RoutingOracle.test_slice_one_rejects_task_update` |
| `microtask.update` | `microtask_set` | `RoutingOracle.test_admitted_routes_microtask_update` | `RoutingOracle.test_slice_one_rejects_microtask_update` |
| `plan.phase` | `plan_phase` | `RoutingOracle.test_admitted_routes_plan_phase` | `RoutingOracle.test_slice_one_rejects_plan_phase` |
| `plan.close` | `plan_close` | `RoutingOracle.test_admitted_routes_plan_close` | `RoutingOracle.test_slice_one_rejects_plan_close` |
| `agent.plan / task_add` | `task_add` | `RoutingOracle.test_admitted_routes_agent_plan_task_add` | Covered by `test_slice_one_rejects_agent_plan` |
| `agent.plan / microtask_add` | `microtask_add` | `RoutingOracle.test_admitted_routes_agent_plan_microtask_add` | Covered by `test_slice_one_rejects_agent_plan` |

The positive route tests observe the existing application-dispatcher boundary with a result double. They assert fixed tool selection, payload preservation, envelope-owned `room`, `agent` and `op_id`, `run_id` for activity/work, and translation of `plan_opened` to `expected_opened_lamport`. Creation forbids a generation; existing-plan `agent.plan` subtools carry it. The actual backend is exercised separately in AC3 and the activity cases.

### AC5 allowlists and AC6 replay matrix

| Kind | Source denied | Room denied | Exact replay | Changed envelope |
| --- | --- | --- | --- | --- |
| `agent.activity` | `SafetyOracle.test_denies_source_agent_activity` | `SafetyOracle.test_denies_room_agent_activity` | `SafetyOracle.test_exact_replay_agent_activity` | `SafetyOracle.test_changed_envelope_agent_activity` |
| `agent.plan` | `SafetyOracle.test_denies_source_agent_plan` | `SafetyOracle.test_denies_room_agent_plan` | `SafetyOracle.test_exact_replay_agent_plan` | `SafetyOracle.test_changed_envelope_agent_plan` |
| `work.acquire` | `SafetyOracle.test_denies_source_work_acquire` | `SafetyOracle.test_denies_room_work_acquire` | `SafetyOracle.test_exact_replay_work_acquire` | `SafetyOracle.test_changed_envelope_work_acquire` |
| `work.report` | `SafetyOracle.test_denies_source_work_report` | `SafetyOracle.test_denies_room_work_report` | `SafetyOracle.test_exact_replay_work_report` | `SafetyOracle.test_changed_envelope_work_report` |
| `task.claim` | `SafetyOracle.test_denies_source_task_claim` | `SafetyOracle.test_denies_room_task_claim` | `SafetyOracle.test_exact_replay_task_claim` | `SafetyOracle.test_changed_envelope_task_claim` |
| `task.release` | `SafetyOracle.test_denies_source_task_release` | `SafetyOracle.test_denies_room_task_release` | `SafetyOracle.test_exact_replay_task_release` | `SafetyOracle.test_changed_envelope_task_release` |
| `task.update` | `SafetyOracle.test_denies_source_task_update` | `SafetyOracle.test_denies_room_task_update` | `SafetyOracle.test_exact_replay_task_update` | `SafetyOracle.test_changed_envelope_task_update` |
| `microtask.update` | `SafetyOracle.test_denies_source_microtask_update` | `SafetyOracle.test_denies_room_microtask_update` | `SafetyOracle.test_exact_replay_microtask_update` | `SafetyOracle.test_changed_envelope_microtask_update` |
| `plan.phase` | `SafetyOracle.test_denies_source_plan_phase` | `SafetyOracle.test_denies_room_plan_phase` | `SafetyOracle.test_exact_replay_plan_phase` | `SafetyOracle.test_changed_envelope_plan_phase` |
| `plan.close` | `SafetyOracle.test_denies_source_plan_close` | `SafetyOracle.test_denies_room_plan_close` | `SafetyOracle.test_exact_replay_plan_close` | `SafetyOracle.test_changed_envelope_plan_close` |

The changed-envelope matrix changes `run_id` while retaining source, target and id. The pending/unread cases change plan arguments, covering distinct envelope conflicts. Exact replay is checked after consuming the response. No test counts a rejected first delivery as a successful replay.

### AC7 supplementary closed-envelope and activity boundary tests

| Test | Gate |
| --- | --- |
| `SafetyOracle.test_agent_plan_rejects_arbitrary_dispatch_tool_names` | Restrict `agent.plan` to `plan_create`, `task_add`, `microtask_add`; reject other known tools and unknown names before dispatch. |
| `SafetyOracle.test_payload_cannot_override_envelope_identity_or_generation` | Reject forged `room`, `agent`, `run_id`, `op_id`, `plan_opened`, `expected_opened_lamport` in direct and nested planning arguments. |
| `SafetyOracle.test_missing_or_invalid_generation_is_rejected_before_dispatch` | Existing-plan kinds reject absent, boolean, zero, negative and string generations. |
| `ActivityFenceOracle.test_matching_generation_activity_reaches_the_real_writer` | Matching generation is accepted by `activity_beat` and appends the matching activity operation. |
| `ActivityFenceOracle.test_stale_generation_activity_is_stale_rev_without_append` | A forged future generation is rejected as `stale_rev` and changes no journal bytes. |

AC7 preserves the fencing and passive-envelope conditions documented in `docs/FAMILY_CHANNEL.md`; it does not recertify the backend lock primitive owned by U140.

## Real scenario and bounded execution

The scenario deploys an executor, creates a plan, adds a task and microtask, claims/releases work, acquires work, records activity, reports evidence, replays that report, updates/completes the remaining work, advances phase and closes the plan. It covers every new kind and each permitted `agent.plan` subtool. Planning is non-strict because mailbox memory initialization is not an enabled operation in this unit. Read-only projection calls observe state; they do not seed mutations. Evidence is created outside the room metadata tree, following the existing backend validation contract.

Clocks and token generation are deterministic. Network construction, process launches and real sleeps raise assertions. Every drain is a single sweep; loops use finite fixture collections. All runtime files are disposable children of this test directory and are cleaned on success or assertion failure. No providers, GUI, polling consumer, workers, commits, pushes or deployment are needed.

Fixture calibration exercised the scenario through a temporary in-memory routing control and activity-fence forwarding control against the real backend. This confirmed that later scenario steps are valid; it is not a product pass or admission receipt. No substitute implementation is saved in the oracle.

## Scope exclusions and stop rules

| Owner | Out of scope for U143 oracle |
| --- | --- |
| U109 / U119 / U121 / U132 | Backend ownership, batching, replay and lifecycle correctness; supplying or issuing ADMIT receipts. |
| U139 | Durable throttled lifecycle no-op recovery across the backend-return crash cut. |
| U140 | Atomic lock-through-commit fencing, writer races and reopen scheduling. U143 checks argument forwarding and real activity refusal only. |
| U141 | Cross-transport resumable terminal cleanup, successor-claim protection and room-bootstrap parity. |
| U142 | Terminal work refusal, new deployment/run identity rules and mismatch-beat disposition. The operator decision remains binding on that dependency; this oracle does not classify it as a U143 failure. |
| U128 | Cursor thread-field projection (`to`, `re`, evidence). |
| U145 | Full MCP/CLI transport-parity recipe, failure-hook reassignment and capsule seed variants. |
| Frontend / capsules | Card roots, pruning, Wall rendering, persona acceptance, narrator and automatic harness wiring. `src/app/swarm_vm.ts` and `deriveSwarmViewModel` remain untouched. |

An actual positive consumer run must stop until every applicable admission is proven. Test-only availability never changes HOLD. The oracle adds tests and this report only; product code is not enabled. Existing family tests remain a separate regression suite; their lifecycle-only doubles are not reused to fabricate a planning backend.

## Re-pinned corpus

| File | Relevant current coordinates |
| --- | --- |
| `.unit/SPEC.md` | Gate, MUST, oracle and hostile/negative clauses; complete file including final operator decisions. |
| `bridge/room/family.py` | `_available_kinds` at line 181 [MEASURED]; fixed dispatch at line 430 [MEASURED]; allowlists precede retained lookup in `consume`. |
| `bridge/room/family_envelope.py` | Closed kind/payload validation, protected identity fields and generation requirements. |
| `bridge/room/ext/activity.py` | `activity_beat` argument allowlist and writer call; generation forwarding is missing. |
| `docs/FAMILY_CHANNEL.md` | HOLD, required config, allowlists, fixed routes, generation fencing and immutable-envelope replay. |
| `bridge/tests/family/test_routing.py` | Existing slice-one refusal and lifecycle routing expectations, unchanged. |
| `bridge/tests/family/test_recovery.py` | Existing exact replay, changed/pending identities and unread-result rules, unchanged. |
| `bridge/room/app.py` | Registered planning tool contracts and shared dispatcher. |
| `bridge/room/store.py` | Real generation checks and evidence validation. |
| `bridge/room/ext/acquire.py` | Existing work contracts accepting generation and run identity. |
| `templates/planning/blank.json` | Public scenario template. |

## Verification

From the repository root:

    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/family/u143 -t .

Current product: 74 tests [MEASURED], 37 assertion failures [MEASURED], 37 green [MEASURED], zero errors or skips [MEASURED]. Exact final summary:

    FAILED (failures=37)

The real scenario fails at `agent.plan` with `bad_args`. Route/replay positives fail because those kinds are not dispatched; the activity tests fail because `expected_opened_lamport` is rejected as `bad_args`. Preserved slice-one refusal, startup HOLD, closed-envelope safety and initial hostile allowlist cases pass. These results do not establish positive hostile replay coverage until the missing routes are implemented.

Existing family baseline: 206 tests [MEASURED], `OK`, zero failures or errors [MEASURED]. Admission and runtime end-to-end acceptance receipts remain AUSENTE.

The mandate and conclusions are limited to the supplied spec, package and files in this isolated project copy.
