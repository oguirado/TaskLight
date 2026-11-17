# U128 fail-first oracle

Status: DRAFT, fail-first tests frozen before implementation. Normative input:
`.unit/SPEC.md`, including its final Amendment B. Production surfaces remain
`bridge/room/ext/events.py` and `bridge/room/store.py`; neither is changed here.
This directory contains tests and their independent reference only.

## Reproduction

From the repository root, with stdlib unittest:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u128 -t .
```

All fixture homes are temporary children of this test directory and are removed
after each test. New tests deny network connections and real sleeps. Wall time,
message IDs and clocks are deterministic. MCP and CLI adapters run in process;
no daemon, socket, port or child process is required.

## Acceptance map

Names below refer to methods in `test_contract.py` (`ContractOracle`),
`test_state.py` (`StateOracle`), `test_waits.py` (`WaitOracle`) and
`test_work.py` (`WorkOracle`). Counts and bounds in this map are [TARGET], as
specified by `.unit/SPEC.md`; expected event values are [CITED: Acceptance].

| Case | Test names | Required result |
|---|---|---|
| A1 | `test_a1_frozen_reference_explicit_pages`; `test_a1_first_page_and_repeat_are_identical`; `test_a1_second_page_preserves_addressing` | First page e1/e2, head 4, next 2, more true; second page e3/e4, next/head 4, more false. Repeats are equal. |
| A2 | `test_a2_filters_and_head_independence`; `test_a2_or_within_arrays_and_between_arrays`; `test_a2_reader_slug_does_not_filter_authors`; `test_m1_default_limit_and_upper_bound` | OR within arrays, AND between them; missing operations excluded; empty/unknown/incompatible filters match nothing. Head is unfiltered; caller is not author filter. Defaults and accepted limit endpoints remain fixed. |
| A3 | `test_a3_equal_cursor_and_immediate_future`; `test_a3_missing_and_empty_journals_are_read_only` | Equality is not resync; future cursor returns immediately even at maximum wait; missing/empty journals have head 0 and produce no files. |
| A4 | `test_a4_send_chain_exact_to_re_and_literal_text`; `test_a4_send_replay_preserves_receipt_and_journal`; `test_m2_omitted_fields_are_absent_and_input_is_unchanged`; `test_m2_present_nulls_are_preserved_literally` | All four room_send acts retain stored to/re and literal text. Replay returns the original receipt with unchanged journal/cursor count. Absent fields stay absent. |
| A5 | `test_a5_malformed_utf8_invalid_schema_and_torn_tail`; `test_m4_existing_validation_rejects_hostile_records`; `test_m6_room_events_wait_observes_newline_completion`; `test_m6_store_wait_observes_newline_completion` | Invalid records and the parseable unterminated event do not affect head. Newline completion exposes the event without reader repair. |
| A6 | `test_a6_hostile_arguments_fail_before_journal_access`; `test_m1_tool_contract_and_registry_stay_fixed` | bad_room/bad_agent/bad_args, bool rejection, limit/wait bounds, malformed filters, missing/unknown keys. Invalid calls must fail before open/stat/journal lookup. No tool or argument is added. |
| A7 | `test_a7_room_events_unchanged_parses_initial_view_only`; `test_a7_store_wait_unchanged_parses_initial_view_only`; `test_a7_room_events_nonmatch_then_addressed_question`; `test_a7_store_wait_nonmatch_then_all_predicates_match`; `test_m6_store_wait_exclude_agent_is_independent`; `test_a7_filtered_timeout_reports_latest_valid_head`; `test_a7_store_wait_nonmatches_timeout_to_none`; `test_m6_available_results_return_without_sleep`; `test_m6_sub_poll_deadline_is_capped_monotonically`; `test_m6_waits_observe_replacement`; `test_m7_missing_room_waits_create_nothing` | Initial parse only while metadata is unchanged; act/agent/exclude_agent/to predicates preserved. Nonmatches advance eventual head, not match satisfaction. Deadlines use monotonic time; timeout and immediate return semantics remain fixed. |
| A8 | `test_a8_disordered_cold_and_reused_reader`; `test_a8_replacement_invalidates_same_length_and_mtime`; `test_a8_truncation_invalidates_and_resyncs`; `test_a8_same_size_in_place_rewrite_invalidates`; `test_a8_storage_home_and_room_isolation`; `test_a8_resolved_home_alias_follows_changed_target`; `test_m3_foreign_records_cannot_raise_requested_room_head`; `test_m3_differential_grid_cold_and_reused`; `test_m5_disorder_requires_historical_match_fallback`; `test_m5_sparse_filters_require_full_reader_results` | Independent full-reader equality for disorder, historical cursors, sparse filters, replacement/truncation/rewrite and resolved home/room isolation; no stale results. |
| A9 | `test_a9_old_projection_mutant_is_rejected`; `test_a9_last_lines_mutant_is_rejected`; `test_a9_polling_reparse_mutant_is_rejected`; `test_a9_mcp_cli_parity_and_untrusted_wrapper` | Each named mutant is rejected by an assertion gate, not by an import/runtime failure. Both adapters return the same exact untrusted payload and satisfy the independent oracle. |

## Amendment B and read-only gates

All numeric limits in this table are [TARGET: Amendment B].

| Requirement | Test names | Gate |
|---|---|---|
| B1 tail bounds | `test_b1_warm_recent_suffix_parses_at_most_512_records`; `test_b1_warm_recent_suffix_reads_at_most_524288_bytes`; `test_b1_recent_append_keeps_bounded_work_and_correctness`; `test_b1_warm_suffix_includes_malformed_parse_attempts` | Proven monotonic reused recent suffix: at most 512 record attempts and 524288 payload bytes per query. Explicit cold work is separately metered, never hidden in setup. Historical/disordered/sparse fallbacks retain full-reader correctness. |
| B1 boundary invalidation | `test_b1_boundary_digest_invalidates_unchanged_stat_tuple` | Rewrite the final boundary at equal size while preserving dev/ino/size/mtime_ns; changed projected data must be returned. Identity and mtime changes have separate A8 cases. |
| B2/B4 coherent views | `test_b4_mid_parse_append_produces_one_complete_view`; `test_b4_mid_parse_replacement_produces_one_complete_view` | Actual decoding triggers the mutation. Return one captured before/after view; never a mixed head/page. The append inserts an equal-Lamport event into the first page and raises head, making mixing observable. |
| B3 legacy reconciliation | External owner gate, described below | No admission until the owner-approved U89 amendment is present. |
| B4 private stored keys | `test_b4_request_digest_and_extra_keys_do_not_leak` | Only required keys and present op/to/re may escape; request_sha256, op_id, evidence and arbitrary stored extras stay private. |
| B4 equal Lamports | `test_b4_equal_lamport_boundary_preserves_stable_legacy_cursor` | Stable physical tie ordering before pagination, strictly greater scalar cursor on the next request. |
| M7/B4 read-only boundary | `test_m7_all_read_surfaces_preserve_torn_bytes_and_take_no_writer_lock`; `test_m7_no_persistent_index_or_sidecar`; `test_b4_read_only_mutant_is_rejected` | _read_all/read/inbox/waits preserve bytes, names, modes, write times and identities, create no sidecar and acquire no writer lock. A torn-tail repair mutant must fail that same footprint gate. |
| Work-counter non-vacuity | `test_meter_observes_invalid_utf8_and_decoding_outside_read_all` | Invalid UTF-8 consumes a record attempt before JSON; direct parsing outside _read_all is counted, and parser-only work invents no I/O. |

## Reference and ambiguity decisions

`support.full_read` independently scans every newline-terminated record in the
captured bytes, rejects malformed UTF-8/JSON and invalid fixture records, filters
by room, stable-sorts, and computes head/page/cursor/resync. It calls no
production reader, projector or validator. Literal expected output for the
addressed second page is frozen independently of the reference projector.
The reference fixture domain covers heartbeat, message acts and the exact
memory.set fixture; unsupported plan/step/operation schemas stop the reference
with an assertion instead of guessing. Existing schema suites remain responsible
for those additional schemas.

Optional fields are copied by presence: explicitly stored null to/re values are
retained because existing validation permits them; omitted keys never acquire
null values [CITED: M2/M4]. Equal Lamports retain the scalar-cursor behavior even
when a page boundary skips remaining equal values [CITED: M3].

A coherent captured view may precede an append/replacement that occurs during
parsing [CITED: M4]. The race tests accept either coherent view. Amendment B's
metadata checks and at most three coherence retries remain required
[TARGET: Amendment B]; the exhausted
retry response is AUSENTE — no inventar. These tests introduce no new error
code or undocumented retry-helper API, and do not claim to certify an unspecified
exhaustion response.

Cold monotonicity proof can require the full-reader fallback [CITED: M5]. Work
limits are asserted on reused proven recent suffixes and a monotonic append;
cold work is retained separately as `cold_work`. `WorkMeter` counts UTF-8/JSON
attempts and validation independently, using the maximum to avoid counting a
record repeatedly across stages. It counts invalid records and observes parsing
outside _read_all. Payload accounting covers builtin/io opens, Path reads,
read/readline/readlines/readinto/read1/readinto1, and os.read/os.pread. Boundary
reads are included. These counters are a deterministic unit gate, not a claim
that the existing benchmark adapter measures all possible future I/O/parser
implementations.

## Separate owner gates and scope

| Gate or surface | Status | Handling |
|---|---|---|
| U121 ADMIT dependency | Evidence AUSENTE — no inventar | Required before U128 admission; no dependency receipt is manufactured by this lane. |
| `bridge/tests/room/u89/test_events.py:54` | Owner-approved amendment AUSENTE — no inventar | Existing test forbids to. It is deliberately untouched. STOP admission until its owner reconciles optional to/re under M8/B3; do not weaken A1. |
| U109 gates and U110 idempotency/durability | Preserved existing suites | Test files and production code remain untouched; room_send replay is additionally pinned here. |
| `room-tail-near-cap`, `bridge/tests/bench/fixtures.py:77`, `bridge/tests/bench/adapters.py:72`, U115 latest/filtered/future | Hardening INCONCLUSIVE in this deterministic unit lane | Benchmark infrastructure belongs to its owner. Statistical quiet-window measurements, fixture hash, cold/warm bytes and parser work, p50/p95/p99, RSS and load admission must be supplied before performance admission. Missing telemetry cannot be interpreted as PASS; correctness failure is BLOCK. |
| U96, U134, daemon, persistent index, compaction, authentication, UI, chat and terminal controls | OUT OF SCOPE | No implementation, transport, registration, legacy-oracle edit or benchmark-infrastructure change is made. |

Hardening timing gates remain at most 10 ms latest-page p95, five warmups,
thirty paired runs, and no start at load5 greater than or equal to 18
[TARGET: Hardening check]. A deterministic unittest run does not establish these
measurements or a performance admission verdict.

## Baseline verification

Observed results [MEASURED]:

| Suite | Tests | Assertion failures | Errors | Result |
|---|---:|---:|---:|---|
| U128 | 57 | 16 | 0 | 41 green; expected fail-first red |
| U89 | 125 | 0 | 0 | OK |
| U109 | 165 | 0 | 0 | OK |
| U110 | 48 | 0 | 0 | OK |

Exact U128 summary line [MEASURED]:

```text
FAILED (failures=16)
```

The U128 failures identify missing to/re projection, payload rereads/reparses on
unchanged waits, and unbounded recent-tail work. Negative-control self-checks
pass by catching the intended assertion failures. Import errors, infrastructure
failures, expectedFailure markers and skips are not used as substitutes.

This mandate and its oracle are limited to the supplied spec and the cited repository surfaces.
