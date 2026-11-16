# U87 fail-first oracle

Specification: `.unit/SPEC.md`, status `STRATEGY_v10`, wave `A/A3`, including
binding Amendment `A-U87-1`. `S0` is frozen. Acceptance outcomes remain [TARGET]
until the application and adapters are implemented.

| Acceptance | Python tests in `test_contract.py` | Vitest mirror in `tests/unit/u87/contract.test.ts` |
| --- | --- | --- |
| A1 | `DiscoveryOracle.test_a1_tools_complete_object_and_no_writes`, `test_a1_cli_only_startup`, `test_a1_real_module_discovery_and_call` | `A1 discovery, complete schemas, no writes`; `A1 CLI-only extension startup`; `A1 real module discovery and call` |
| A2 | `ParityOracle.test_a2_<tool>` for every name below; `test_a2_same_dispatcher_for_every_tool` | `A2 all tools: complete payloads, journals and common dispatch spy` |
| A3 | `ErrorOracle.test_a3_empty_room_no_plan`, `test_a3_stale_microtask_detail_and_no_append` | `A3 no_plan detail`; `A3 stale_rev detail and no append` |
| A4 | `ErrorOracle.test_a4_syntax_<case>`, `test_a4_missing_<tool>`, `test_a4_handler_bad_args_exits_three`; `RegressionOracle.test_a4_mcp_invalid_envelopes_preserve_rpc_errors`, `test_a4_real_stdio_malformed_json_and_recovery` | `A4 syntax versus handler bad_args`; `A4 RPC envelopes` |
| A5 | `BoundaryOracle.test_a5_all_schema_paths`, `test_a5_<create/add>_<field>_<maximum/overflow/invalid/nullable>`, `test_a5_create_tasks_<maximum/overflow/empty>`, `test_a5_standalone_<case>`, `test_a5_null_microtask_arrays_normalize_to_omission`, `test_a5_task_add_dependencies_use_ids`, `test_a5_nested_microtask_unknown_keys_and_required_text`; `ErrorOracle.test_a5_template_membership_dependencies_and_cycles` | `A5 schema paths and required sets` |
| A6 | `ErrorOracle.test_a6_hostile_task_no_append`, `test_a6_path_traversal_no_outside_directory`, `test_a6_tool_names_and_json_remain_data` | `A6 hostile nested task`; `A6 traversal` |
| A7 | `DiscoveryOracle.test_a7_<cli/mcp>_first_synthetic_extension`, `test_a7_room_error_detail_<cli/mcp>_first`; `RegressionOracle.test_a7_missing_modules_skip_and_internal_dependency_propagates` | `A7 S0 extension startup in both orders` |
| A8 | `MutationOracle.test_a8_remove_dispatch_from_each_adapter`, `test_a8_omit_extension_dispatch`, `test_a8_remove_nested_items`, `test_a8_strip_detail`; `RegressionOracle.test_oracle_<dispatch/detail/nested_items>_control_is_not_vacuous` | `A8 dispatcher bypass mutation`; `A8 extension omission mutation`; `A8 nested items mutation`; `A8 stripped detail mutation`; independent checker controls |
| A9 | `RegressionOracle.test_a9_legacy_commands_exact_outputs_and_exits`, `test_a9_import_app_silent_and_no_mcp_dependency`; `DiscoveryOracle.test_a9_unexpected_exception_sanitized` | `A9 legacy CLI`; `A9 app import`; `A9 sanitized unexpected exception` |
| A-U87-1 | `PromptOracle.test_amendment_executor_loop_appended_and_existing_entries_exact`, `test_amendment_executor_loop_steering`, `test_amendment_executor_loop_rejects_invalid_slugs` | `A-U87-1 prompt list`; `A-U87-1 executor steering`; `A-U87-1 argument validation` |
| M1 I/O guard | `RegressionOracle.test_oracle_application_stdout_control_is_not_vacuous` | `M1 independent app I/O checker control` |

The existing tool names covered individually are `post_status`, `post_plan`,
`post_step`, `close_task`, `read_inbox`, `wait_inbox`, `list_templates`,
`get_template`, `plan_create`, `plan_get`, `plan_check`, `plan_phase`,
`plan_close`, `task_add`, `task_update`, `task_claim`, `task_release`,
`microtask_add`, `microtask_set`, `next_work`, `memory_set`, `memory_get`.
Their complete successful payloads and journal bytes, plus existing descriptors,
are frozen in `expected.json` from the pre-implementation MCP handlers.
Fixtures use the existing neutral template from `fixtures/plan/templates.v1.json`.

The syntax suffixes are `malformed`, `array`, `null`, `scalar`, `missing_json`,
`missing_tool`, `unknown_tool`, `extra_arg`. Missing-argument cases cover every
tool with required arguments; `list_templates` has no required arguments.
Boundary fields are `title`, `accept`, `estimate`, `deps`, `microtasks`,
`micro_text`, `micro_accept`; nullable scalar checks cover `assignee`, `estimate`.
`test_a5_unicode_<title/micro_text>_<maximum/overflow>` also checks character
counts with astral Unicode input, rather than treating UTF encoding bytes as characters.
Standalone cases are `text_maximum`, `text_overflow`, `empty_text`,
`accept_maximum`, `accept_overflow`, `null_accept`.

## Scaffold, assumptions and limits

The exact new application's export names and signatures are **AUSENTE** from
the specification. The scaffold uses provisional `dispatch(name, args)` only;
its body raises `NotImplementedError("U87 stub")`. This spelling is not a
normative assertion: behavioral tests enter the public CLI/MCP adapters and
the dispatch spy observes application frames rather than importing that name.

`FutureCase` exercises the scaffold sentinel before each new behavior scenario.
Consequently the present red result identifies the requested stub error, rather
than cascading unknown-command failures in the unchanged adapters. After the
sentinel is replaced, all substantive adapter, schema, journal and mutation
assertions execute. Present red counts are prerequisites failing, not evidence
that those later assertions or application-level mutations have passed.
`RegressionOracle` and its independent checker controls run without that gate.

The generated-schema interpreter accepts nullable union types or `anyOf`/
`oneOf` representations. Required fields compare as sets. Prompt wording is
checked for the mandated operations, ordering, cadence and conditional beat
omission, without imposing a verbatim new prompt. Existing prompt descriptors
remain exact and in order. Optional `task_id` receives no invented validation
rule: only room/agent slug validation is specified in the amendment.

M4's single declarative source is a production-review gate: paired schema and
boundary checks verify the public contract, but cannot prove internal reuse.
No table layout, helper names, validator library or implementation architecture
is prescribed by these tests. The app must perform no input/output; import
silence, stdin guards on calls, stdout guards for application frames, disk
snapshots and the MCP-import prohibition are tested. Real module startup
separately checks both `tools` and `call list_templates --json '{}'`, including
complete stdout framing.

Vitest runs the authoritative stdlib Python behavioral cases in bounded child
processes because U87 adds no TypeScript production API. It does not implement
an alternative dispatcher. Tests fix clocks and event identifiers, refuse socket
creation and sleeps, use zero-duration waits, and clean scratch fixtures created
under this test directory. Subprocess timeouts are termination guards only.

## Mutation controls and gates

| Step | Verification gate | Negative contrast |
| --- | --- | --- |
| Scaffold/readiness | Exact `NotImplementedError("U87 stub")` cause; no import errors or missing dependency failures | An unrelated exception does not qualify as the intended red cause |
| Successful calls | Parsed payloads and entire journals equal both adapters and `expected.json`; application-frame spy observes common dispatch for every tool | An adapter emitting an otherwise identical cached response without dispatch must fail the spy |
| Extensions | Synthetic listed `events` module calls S0 `register(tool, handler)` at import; discovery is unique and calls match after either import order | Remove only synthetic handler entries from live maps while retaining descriptors; both call checks reject the omission |
| Schemas | Real discovery passes all nested shape and boundary checks | Delete nested `items` from a deep copy of discovery; the same schema oracle must fail |
| Error detail | Exact `str(RoomError)` detail, matching errors and unchanged journal bytes | Strip `detail` at MCP result framing; the same error oracle must fail |
| Restoration | Unpatched calls and schema checks pass again | A mutation that persists outside its context is a failure |

All mutations are in memory, with automatic restoration, and are conditional
on a healthy implementation. No production file is patched by a test. Stop on
a wrong red cause, any added type error, an existing-suite regression, a secret
scan finding, or a write outside the authorized test paths and app scaffold.
Absence of evidence does not pass a gate.

The measured pre-oracle room suite reports `Ran 210 tests` / `OK` [MEASURED].
The measured Vitest baseline is `9360 passed | 2 skipped (9362)` [MEASURED].
The pre-oracle typecheck has `16` existing diagnostics [MEASURED]; no new
diagnostic, including in these files, is allowed [TARGET]. The broader existing
Python suites and secret scan remain integration gates; green U87 behavior
and real application-mutation results are unavailable until implementation.

## Verified scaffold state

The Python oracle reports `Ran 141 tests` and `FAILED (errors=131)` [MEASURED]:
all errors end in `NotImplementedError: U87 stub`; the remaining `10` tests
pass [MEASURED]. Vitest reports `19 failed | 7 passed (26)` [MEASURED], with
the same scaffold cause. These are prerequisite failures; application mutation
controls await implementation. All `22` frozen MCP payloads and complete
journals independently match `expected.json` [MEASURED].

The existing Vitest baseline remains `9360 passed | 2 skipped (9362)`
[MEASURED]. Typecheck retains `16` existing diagnostics, with none in these
test files [MEASURED]. The secret scan reports no findings [MEASURED].
Broader Python discovery runs `1618` existing tests with `3` skips and a
single failure in `bridge.tests.setup.test_setup.SetupOracle.test_a5_wall_ready_default`
[MEASURED]. That same test fails in a standalone process without importing
U87: its assertion compares a resolved dependency symlink with the workspace
path. This existing isolated-copy baseline failure is an integration HOLD,
not a U87 acceptance failure; repairing setup or dependencies is outside the
authorized write surface.

## Commands

Run from the repository root:

```sh
python3 -B -m unittest discover -s bridge/tests/room/u87 -t .
npx vitest run tests/unit/u87
npx tsc --noEmit -p .
```

## Out of scope

| Unit/surface | Treatment |
| --- | --- |
| U89 `bridge/room/ext/events.py` | Synthetic registration exercises only the frozen seam; no real implementation required |
| U90 `bridge/room/ext/activity.py`, activity semantics | `executor_loop` describes conditional `activity_beat`; no beat implementation or real timer required |
| U94 `bridge/room/ext/export.py`, CLI `export`, `PLAN.md`, `MEMORY.md` | No production edit and no acceptance failure for missing export behavior |
| U95 docs | No documentation edits outside these test directories |
| S1 composer, S2 projection/UI helper, S3 event cursor | Their implementations belong to other units; not U87 failures |
| Daemon, identity, cancellation policy, plan semantics | Existing semantics are exercised for compatibility, not extended |

The mandate is limited to the supplied specification and confirmed repository surfaces.
