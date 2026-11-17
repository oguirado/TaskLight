# U163 fail-first oracle

The binding source is `.unit/SPEC.md`, read in full. It contains M1–M8 and no final Amendment sections or separate numbered acceptance list. The acceptance numbering below is therefore the specification's MUST numbering. Product files and existing tests remain unchanged.

## Acceptance mapping

| Case | Required behavior | Test names |
| --- | --- | --- |
| M1 | Same function object used by the Wall, MCP, CLI and exporter; no copied rules | `test_shared_function_identity_mcp`, `test_shared_function_identity_cli`, `test_shared_function_identity_export` |
| M2 | Read-time only; raw owner bytes, digests, identities, revisions, cursors and replay remain unchanged | `test_owner_journal_and_hash_unchanged_across_reads`, `test_room_events_preserves_hashes_ids_agents_and_cursors`, `test_folded_projection_preserves_all_structural_values`, `test_idempotent_retry_keeps_revisions_and_journal`, `test_plan_get_since_rev_keeps_historical_memory`; every read case also checks unchanged bytes |
| M3 | Every named output boundary and diagnostic redacts free text after folding | Explicit boundary tables below; `test_tool_room_export_memory`, `test_memory_get_single_section`, `test_free_text_post_step_took`, `test_free_text_microtask_took`, `test_free_text_task_estimate_and_blocked_reason`, `test_direct_export_redacts_both_files_without_journal_changes` |
| M4 | Exact synthetic-password replacement, no raw value, including old memory | All redaction boundary cases; `test_tool_memory_history`, `test_plan_get_since_rev_keeps_historical_memory`, `test_idempotent_retry_keeps_revisions_and_journal` |
| M5 | Clean output bytes and structural fields preserved | All `test_clean_*` boundary cases against `clean_outputs.json`; structural/replay tests under M2; `test_existing_marker_and_unicode_are_unchanged`, `test_empty_inbox_and_timeout_keep_legacy_shapes` |
| M6 | Sanitizer exceptions refuse output; CLI nonzero; export writes nothing | Every failure case in the boundary tables; `test_direct_export_failure_creates_no_files`, `test_direct_export_failure_preserves_existing_files`, `test_sanitizer_failure_on_later_export_text_writes_nothing`; failure diagnostic cases below |
| M7 | Minor server bump, stable protocol/capabilities, public documentation | `test_server_version`, `test_protocol_and_capabilities_are_unchanged`, `test_mcp_docs_explain_wall_redaction_and_owner_raw_journal`, `test_planning_contract_has_one_line_redaction_notice` |
| M8 | Local template text also sanitized without changing template bytes or identities | Template boundary table; `test_template_text_in_prompt_plan_from_template`, `test_template_text_in_prompt_swarm_coordinator` |

## Tool boundaries

Each test sends an actual stdio JSON-RPC request through `bridge.room.mcp.main`, decodes the serialized reply and checks it independently. Fixtures use accepted room operations, never missing modules or prospective APIs.

| Tool | Redaction test | Clean-byte test | Sanitizer-failure test |
| --- | --- | --- | --- |
| `post_status` | `test_tool_post_status` | `test_clean_tool_post_status` | `test_failure_tool_post_status` |
| `post_plan` | `test_tool_post_plan` | `test_clean_tool_post_plan` | `test_failure_tool_post_plan` |
| `post_step` | `test_tool_post_step` | `test_clean_tool_post_step` | `test_failure_tool_post_step` |
| `close_task` | `test_tool_close_task` | `test_clean_tool_close_task` | `test_failure_tool_close_task` |
| `read_inbox` | `test_tool_read_inbox` | `test_clean_tool_read_inbox` | `test_failure_tool_read_inbox` |
| `wait_inbox` | `test_tool_wait_inbox` | `test_clean_tool_wait_inbox` | `test_failure_tool_wait_inbox` |
| `plan_get` | `test_tool_plan_get` | `test_clean_tool_plan_get` | `test_failure_tool_plan_get` |
| `task_add` | `test_tool_task_add` | `test_clean_tool_task_add` | `test_failure_tool_task_add` |
| `task_update` | `test_tool_task_update` | `test_clean_tool_task_update` | `test_failure_tool_task_update` |
| `task_claim` | `test_tool_task_claim` | `test_clean_tool_task_claim` | `test_failure_tool_task_claim` |
| `task_release` | `test_tool_task_release` | `test_clean_tool_task_release` | `test_failure_tool_task_release` |
| `microtask_set` | `test_tool_microtask_set` | `test_clean_tool_microtask_set` | `test_failure_tool_microtask_set` |
| `next_work` | `test_tool_next_work` | `test_clean_tool_next_work` | `test_failure_tool_next_work` |
| `memory_get` | `test_tool_memory_get` | `test_clean_tool_memory_get` | `test_failure_tool_memory_get` |
| `room_events` | `test_tool_room_events` | `test_clean_tool_room_events` | `test_failure_tool_room_events` |
| `room_export` | `test_tool_room_export` | `test_clean_tool_room_export` | `test_failure_tool_room_export` |
| `memory_history` | `test_tool_memory_history` | `test_clean_tool_memory_history` | `test_failure_tool_memory_history` |
| `work_acquire` | `test_tool_work_acquire` | `test_clean_tool_work_acquire` | `test_failure_tool_work_acquire` |

`room_export` also has `test_tool_room_export_memory`; the normal matrix uses the plan projection. The normal `memory_get` case reads all sections; `test_memory_get_single_section` reads an explicit section. Historical sections are checked both through `memory_history` and `plan_get(since_rev=...)`.

## Resource boundaries

| Resource | Redaction test | Clean-byte test | Sanitizer-failure test |
| --- | --- | --- | --- |
| `tasklight://rooms/{room}/plan` | `test_redacted_resource_plan` | `test_clean_resource_plan` | `test_failure_resource_plan` |
| `tasklight://rooms/{room}/memory` | `test_redacted_resource_memory` | `test_clean_resource_memory` | `test_failure_resource_memory` |

## Prompt boundaries

| Prompt | Redaction test | Clean-byte test | Sanitizer-failure test |
| --- | --- | --- | --- |
| `resume_from_memory` | `test_redacted_prompt_resume_from_memory` | `test_clean_prompt_resume_from_memory` | `test_failure_prompt_resume_from_memory` |
| `plan_from_template` | `test_redacted_prompt_plan_from_template` | `test_clean_prompt_plan_from_template` | `test_failure_prompt_plan_from_template` |
| `swarm_coordinator` | `test_redacted_prompt_swarm_coordinator` | `test_clean_prompt_swarm_coordinator` | `test_failure_prompt_swarm_coordinator` |

## CLI boundaries

These call the existing `bridge.room.__main__.main` in-process and capture stdout, stderr and the return code. Wait cases have immediately available events or an explicit zero timeout; no real timer elapses. The export cases inspect both `PLAN.md` and `MEMORY.md`.

| Verb | Redaction test | Clean-byte test | Sanitizer-failure test |
| --- | --- | --- | --- |
| `post` | `test_redacted_cli_post` | `test_clean_cli_post` | `test_failure_cli_post` |
| `read` | `test_redacted_cli_read` | `test_clean_cli_read` | `test_failure_cli_read` |
| `wait` | `test_redacted_cli_wait` | `test_clean_cli_wait` | `test_failure_cli_wait` |
| `status` | `test_redacted_cli_status` | `test_clean_cli_status` | `test_failure_cli_status` |
| `call` | `test_redacted_cli_call` | `test_clean_cli_call` | `test_failure_cli_call` |
| `export` | `test_redacted_cli_export` | `test_clean_cli_export` | `test_failure_cli_export` |

## Templates

The fixture is an actual validated local template with matching recomputed hash. Its name, summary, brief labels, phase labels/exits, task-type labels/hints, granularity rule and memory labels/hints contain the canary. The tests require its original hash and id in output and byte-identical local storage after reads.

| Surface | Redaction test | Clean-byte test | Sanitizer-failure test |
| --- | --- | --- | --- |
| `list_templates` | `test_redacted_template_list_templates` | `test_clean_template_list_templates` | `test_failure_template_list_templates` |
| `get_template` | `test_redacted_template_get_template` | `test_clean_template_get_template` | `test_failure_template_get_template` |
| `tasklight://templates/{id}` | `test_redacted_template_resource` | `test_clean_template_resource` | `test_failure_template_resource` |

## Diagnostics and errors

Unknown user-supplied argument names exercise real error messages that echo text. Both errors must remain errors and leave the journal unchanged; their details must be sanitized. The specification does not assign a new refusal code, so tests accept an MCP tool error or JSON-RPC error on sanitizer failure rather than pinning a new code.

| Tool | MCP error text | CLI error text | MCP failure | CLI failure |
| --- | --- | --- | --- | --- |
| `plan_create` | `test_diagnostic_mcp_plan_create` | `test_diagnostic_cli_plan_create` | `test_failure_diagnostic_mcp_plan_create` | `test_failure_diagnostic_cli_plan_create` |
| `plan_check` | `test_diagnostic_mcp_plan_check` | `test_diagnostic_cli_plan_check` | `test_failure_diagnostic_mcp_plan_check` | `test_failure_diagnostic_cli_plan_check` |

## Hostile inputs

`test_hostile_{surface}_{kind}` expands to an individually discoverable test for each cell below. Examples are synthetic data, not another pattern list; expected replacements come directly from the existing Wall redactor. Each cell compares decoded free text with the exact Wall result, preserves raw journal bytes and requires the example to trigger redaction. The prompt cells decode the fenced JSON, detecting invalid serialization as well as raw echoes.

| Kind | MCP | CLI | Export | Prompt |
| --- | --- | --- | --- | --- |
| `private_key` | `test_hostile_mcp_private_key` | `test_hostile_cli_private_key` | `test_hostile_export_private_key` | `test_hostile_prompt_private_key` |
| `bearer` | `test_hostile_mcp_bearer` | `test_hostile_cli_bearer` | `test_hostile_export_bearer` | `test_hostile_prompt_bearer` |
| `jwt` | `test_hostile_mcp_jwt` | `test_hostile_cli_jwt` | `test_hostile_export_jwt` | `test_hostile_prompt_jwt` |
| `key_assign` | `test_hostile_mcp_key_assign` | `test_hostile_cli_key_assign` | `test_hostile_export_key_assign` | `test_hostile_prompt_key_assign` |
| `url_creds` | `test_hostile_mcp_url_creds` | `test_hostile_cli_url_creds` | `test_hostile_export_url_creds` | `test_hostile_prompt_url_creds` |
| `appcheck` | `test_hostile_mcp_appcheck` | `test_hostile_cli_appcheck` | `test_hostile_export_appcheck` | `test_hostile_prompt_appcheck` |
| `email` | `test_hostile_mcp_email` | `test_hostile_cli_email` | `test_hostile_export_email` | `test_hostile_prompt_email` |
| `high_entropy` | `test_hostile_mcp_high_entropy` | `test_hostile_cli_high_entropy` | `test_hostile_export_high_entropy` | `test_hostile_prompt_high_entropy` |

`test_injection_fences_are_passive_and_secret_is_redacted` adds quotes, a closing data fence and instruction-like text without executing that text.

Archived free text has separate `test_archived_plan_text_mcp`, `test_archived_plan_text_resource` and `test_archived_plan_text_cli` cases: a secret-bearing plan is closed and followed by a clean plan using the same template. Archive titles and outcomes must be redacted without changing owner history.

## Negative controls and stop rules

- Bypass sanitization at any listed boundary: its independent canary test requires the exact `password=[REDACTED:KEY_ASSIGN]` replacement and forbids `hunter2-SYNTHETIC` anywhere in captured output. Template prompts and the memory export variant have separate checks.
- Redact on write instead: owner-byte assertions, mutation-tail assertions, raw-journal checks, digest/revision comparisons and replay checks fail. Tests do not demand that a failed output undo an already-authorized append; output redaction is read-time behavior.
- Duplicate the rules instead of sharing the function: runtime function-object witnesses fail even if the textual replacements happen to match. Profiling compares the exact callable exposed by `bridge.wall.emit` and imported by the relay; no new sanitizer API name is imposed.
- Make the shared sanitizer raise: `broken_redactor` replaces the existing Wall function and all currently bound bridge import aliases, including an exception whose message contains the canary. Tool/resource/prompt outputs must refuse safely; CLI must return nonzero; exporter must leave new and existing destination files untouched. A later-text fault checks that previously rendered output is not published early.
- Do not start network calls or real sleeps: they raise immediately in every new fixture. Wall-clock, monotonic clock and random token generation are deterministic. Temporary homes and exported files stay within this test directory and are cleaned up. No subprocesses are needed by the new oracle.

## Clean-byte reference and design choices

`clean_outputs.json` freezes the current clean MCP wire replies, CLI stdout and Markdown contents with deterministic fixture identities. It is loaded as passive data and is never regenerated during tests. Export's acknowledgment contains no free text; the tests compare clean rendered file bytes, successful status and the exact JSON acknowledgment bytes. Shared redaction must not add a secret echo to an acknowledgment.

Structural preservation uses independently folded raw events and replaces only the seeded free-text canary in the expected projection. Additional high-entropy but valid template ids, agent slugs and operation ids distinguish schema-aware redaction from indiscriminate string rewriting. Full event comparisons include original template hashes, event ids, Lamport positions and cursor progression.

Post-fix behavior and mutation-kill measurements against an author implementation: AUSENTE. The current implementation itself is the measured bypass control; all new missing-behavior failures are assertions, not imports or missing symbols.

## Measured baseline

The new discovery run executes **165 tests: 129 red, 36 green, zero errors** [MEASURED]. Its exact final summary is:

```text
FAILED (failures=129)
```

Green cases pin clean legacy behavior, raw storage, timeouts, existing markers and unchanged protocol/capabilities. Red cases expose output leaks, missing shared-sanitizer invocation/refusal, the old server version and absent documentation. No existing test has been amended.

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u163 -t .
```

Existing CLI/export boundary regressions passed **66 tests** [MEASURED]: `bridge/tests/room/test_cli.py`, `bridge/tests/room/u94/test_contract.py`, `bridge/tests/room/u94/test_files.py`, `bridge/tests/room/u94/test_repair1.py` and `bridge/tests/room/u94c/test_cli_export.py`. A fresh independent run of `bridge/tests/room/u57_mcp_v2_test.py` had **32 assertion failures among 60 tests** [MEASURED], without importing this oracle. Its old tool/prompt inventory, exact error-envelope and replay expectations are baseline drift; they were not changed here. Whole-project suite status: AUSENTE.

## Out of scope

- TS-side `HOME_PATH` parity in `src/ingest/redact.ts:414` is specification debt, not a U163 failure.
- U164 evidence enforcement, U161 historical-template folding, visual UI changes, authentication and deployment are outside this oracle.
- Existing legacy-suite drift is reported separately and is not counted as a new U163 failure. Existing tests and production files remain untouched.
