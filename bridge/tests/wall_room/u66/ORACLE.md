# U66 fail-first oracle

Status: R27 W3. Authority: `.unit/SPEC.md`, read through its final A8 case.
Amendment sections in that file: AUSENTE — no inventar.
All test names below are in `bridge/tests/wall_room/u66/test_u66.py`.
Production surfaces under test are `bridge/wall/room_relay.py` and
`bridge/room/mcp.py`; this oracle changes neither.

## Acceptance mapping

| Case | Test names | Gate and negative contrast |
| --- | --- | --- |
| A1 | `SanitizeOracle.test_a1_real_template_hash_survives` | The real canonical hash of `templates/planning/web-app.json` survives byte-identical; entropy masking it fails. The source event validates before sanitizing. |
| A2 | `SanitizeOracle.test_a2_other_redaction_classes_prevent_exemption` | Non-entropy-only and mixed class results remain masked or are dropped; a shape-only exemption fails. |
| A3 | `SanitizeOracle.test_a3_changed_op_id_gets_exact_deterministic_surrogate`; `FrameOracle.test_a3_surrogate_is_valid_in_live_and_replay_frames` | Repeated input yields the specified SHA-256 surrogate and valid identifier in sanitizer, live and replay frames; markers, leaking the original, or differing identifiers fail. |
| A4 | `SanitizeOracle.test_a4_clean_op_id_is_unchanged` | `agent-op-0001` is unchanged; hashing every identifier fails. |
| A5 | `FrameOracle.test_a5_poll_removes_batch_and_preserves_other_fields`; `FrameOracle.test_a5_sync_removes_batch_and_preserves_other_fields` | Both frame paths omit batch, preserve every other clean field and the private floor, and contain no planted secret; masking or retaining batch fails. |
| A6 | `SanitizeOracle.test_a6_nested_template_hash_has_no_exemption` | The real hash under brief is still redacted; recursive exemptions fail. |
| A7 | `McpOracle.test_a7_persisted_open_declares_discovery`; `McpOracle.test_a7_plan_get_and_conformance_unchanged` | Persisted open explicitly records discovery, plan_get returns discovery, and conformance equals the historical implicit-phase fold; merely relying on template lookup fails. |
| A8 | `McpOracle.test_a8_dispatch_store_sanitize_fold_three_tasks` | Real MCP dispatcher, temporary CW_HOME, real room read, real sanitizer and real fold with the same template yield an active plan and three unchanged tasks with no rejected operations; bad_op/no_plan fails. |

## Additional MUST and stop gates

| Requirement | Test names | Gate and negative contrast |
| --- | --- | --- |
| M1 scope | `SanitizeOracle.test_m1_exemption_is_not_restricted_to_plan_open` | Top-level hash policy applies to an op independently of its kind; a plan.open-only exemption fails. |
| M1 shape boundary | `SanitizeOracle.test_m1_invalid_hashes_keep_existing_redaction` | Uppercase, short, long, nonhex, prefixed, planted-secret and nonstring values preserve existing redaction/scalar behavior; broad exemptions fail. Low-entropy valid lowercase hex remains unchanged. |
| M2 all changed strings | `SanitizeOracle.test_m2_non_entropy_secret_op_ids_use_utf8_surrogate` | KEY_ASSIGN and Unicode inputs use SHA-256 of original UTF-8; hashing redacted text or only handling entropy fails. |
| M3 any batch value | `FrameOracle.test_m3_legacy_event_batch_removed_regardless_of_value` | Legacy status frames lose batch even when null, scalar, list or empty metadata; op-only removal fails. |
| M4 nested identifiers | `SanitizeOracle.test_m4_nested_op_ids_and_list_hashes_have_no_exemption` | Brief identifiers and microtask list identifiers/hashes retain ordinary redaction; depth-blind exemptions fail. |
| M5 template ordering | `McpOracle.test_m5_first_declared_phase_is_not_hardcoded` | A reordered custom template supplies its first declared phase; hardcoding discovery fails. |
| M5 independent reader | `McpOracle.test_m5_readers_without_template_get_same_initial_phase` | Folding persisted events without templates still yields discovery; an empty phase fails. |
| M5 absent phases | `McpOracle.test_m5_no_phases_omits_phase_at_store_boundary` | The MCP batch omits phase for a resolved phase-less fixture; adding null or an empty phase fails. |
| M6 U58 planted secret | `SanitizeOracle.test_m6_u58_planted_secret_remains_masked` | FAKE_SECRET in both special fields never leaks its planted value; an unrestricted identifier/hash bypass fails. Existing U58 O1 is also included in legacy verification. |
| Fail closed on residue | `SanitizeOracle.test_stop_nested_residue_drops_event` | Persistent residue under either nested special key drops the event; emitting residue fails. |
| Fail closed on redactor error | `SanitizeOracle.test_stop_redactor_error_does_not_exempt_hash` | A redactor exception on a valid hash drops the event; exempting on shape before proving the redaction class fails. |

## Interpretation and isolation

- A2 cannot be produced by the current real patterns: a lowercase hex string cannot contain a KEY_ASSIGN delimiter, email, bearer phrase or other non-entropy syntax. Controlled redactor results exercise both KEY_ASSIGN alone and mixed classes. The real hash/redactor is used in A1, A3, A6 and A8.
- M3's “every other field is unchanged” means batch removal introduces no additional changes beyond the existing sanitizer. Clean fields are compared exactly in both transport paths. No nested batch removal is required.
- Current template validation requires nonempty phases, and task validation requires a phase belonging to the template. M5's no-phase branch therefore supplies an already-resolved phase-less template and captures the emitted batch at `store.post_ops`, without asserting changes to template or task validation. No stub files are created.
- A7 compares conformance against the same raw event history with the explicit opening phase omitted, folded using the same pinned template. This preserves advisory findings, including required empty memory sections.
- Tests use stdlib unittest, controlled clocks, in-memory transport/store reads for frame tests, and temporary CW_HOME directories under the test directory for integration tests. No network, ports, sleeps, real timer assertions or operator data are used. Temporary data is cleaned up and bytecode generation is disabled during verification.
- The regression gate is assertion failures on missing behavior, contrasted with zero import/runtime errors. No production file is modified to make the oracle green.

## Out of scope

The R27 late-page hello race, replay continuation beyond the relay page limit,
page event-retention checkpoints, phase-label rendering, template metadata
rendering, demo expansion, desktop setup, Firebase provisioning and the older
v9 Firestore-mirror unit also named U66 are outside this Python relay/MCP unit.
They are not oracle failures. No commit, push or deploy is performed.

## Verification

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/wall_room/u66 -t .
```

The oracle currently contains 22 tests [MEASURED]: 12 red, 10 green, zero errors
[MEASURED]. The exact unittest verdict is `FAILED (failures=12)`.
Failures cover missing hash preservation, valid op-id surrogates, batch removal,
explicit initial phase and the resulting sanitized-fold rejection.

Legacy verification uses discovery pattern `*test*.py` so both `test_*.py` and
existing `u58_test_*.py` / `u57_*_test.py` names run, excluding only this new
`u66` package from the legacy wall suite. The required legacy roots are
`bridge/tests/wall_room`, `bridge/tests/room`, `bridge/tests/plan` and
`bridge/tests/plan_demo`.

Legacy results after verification:

| Suite | Tests [MEASURED] | Failures [MEASURED] | Errors [MEASURED] | Verdict |
| --- | --- | --- | --- | --- |
| `bridge/tests/wall_room` (excluding U66) | 125 | 0 | 0 | OK |
| `bridge/tests/room` | 337 | 0 | 0 | OK |
| `bridge/tests/plan` | 526 | 0 | 0 | OK |
| `bridge/tests/plan_demo` | 17 | 0 | 0 | OK |
| Total legacy | 1005 | 0 | 0 | PASS |

The room suite was verified with `python3 -m unittest discover`, not a
stdin runner: its multiprocessing-spawn test requires an importable entry
point. The initial stdin-runner error was a verification harness issue,
resolved by the standard module invocation; it is not a production defect.
