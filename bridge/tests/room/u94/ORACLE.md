# U94 fail-first oracle

Status: fail-first oracle written, with Amendment B-U94 applied. The existing-suite
green gate is HOLD because frozen legacy discovery assertions conflict with the
required additive S0 registration. This oracle covers only the
provided SPEC U94 and its cited workspace contracts. No production implementation
is supplied: every function body in `bridge/room/ext/export.py` raises
`NotImplementedError("U94 stub")`. Registration happens at import, never inside
a raising import-time stub. The frozen S0 seam remains unchanged.

## Acceptance mapping

Names below are unittest methods; TypeScript names are in the companion oracle.

| Case | Test names and gates |
| --- | --- |
| A1 | `Discovery.test_a1_discovery_once_complete_schemas_and_no_writes`; `ExportContract.test_a1_both_exports_byte_exact_and_repeated_reads_unchanged`; `test_a1_mcp_wraps_equivalent_data`; `test_a1_frozen_cli_call_matches_mcp_when_u87_is_integrated`. Gate: exact renderer bytes including final newline, exact response keys, one discovery registration, wrapped MCP data and equivalent CLI data. Negative: lost newline, duplicate registration or read mutation cannot pass. |
| A2 | `HistoryContract.test_a2_exact_history_rejects_duplicates_replays_stale_and_other_sections`; `test_a2_limit_two_keeps_latest`; `test_a2_history_survives_plan_closure`; `NegativeControls.test_fixture_gate_accepted_revisions_and_rejected_stale_are_real`. Gate: revisions `[9,5,3]` [TARGET], exact authors/timestamps/text including empty replacement, across closure. Negative: duplicate event IDs, replayed operation IDs, stale writes and unrelated sections never add versions. |
| A3 | `ExportContract.test_a3_empty_room_renderers_and_no_room_creation`; `test_a3_memory_without_plan`; `HistoryContract.test_a3_unwritten_valid_section`; `FileExport.test_m6_file_export_empty_room_does_not_create_journal`. Gate: existing renderers and empty history, no created room/journal. Negative: creating a room just to read fails. |
| A4 | `Arguments.test_a4_hostile_room_and_agent`; `test_a4_invalid_limits_including_amendment`; `test_a4_invalid_what_and_extra_destination`; `test_m5_every_missing_required_argument`; `test_m5_section_syntax_matches_memory_set`; `test_m5_valid_section_boundaries`. Gate: exact error code with unchanged filesystem. Negative: boolean/null/float/string limits, unknown keys, missing required arguments, hostile slugs and invalid selectors cannot pass. |
| A5, amended | All `FileExport` methods in `test_files.py`: relative/absolute/home destinations, empty-room export, captured prefix, traversal/NUL/empty/outside sibling paths, symlink targets/ancestors/files, directory/FIFO outputs, staging failure, no-follow fd traversal, fd-relative staging, staging both documents before replacement, second-replacement rollback, and an injected parent-swap race. Gate: renderer-identical documents and untouched journal; invalid paths give `bad_args`, I/O faults give `export_failed`. Negative: outside-root writes and success on partial replacement cannot pass. |
| A6 | `tests/unit/u94/memory.test.ts`: `A6 uses Revision N and a visible explanation, preserving author and time`; `A6 preserves literal HTML, Markdown, line breaks, and a selectable long token`; `A6 absent revision metadata stays absent and does not become Revision 0`. `styles.test.ts` checks line-preserving text rules. Negative: HTML/Markdown interpretation and invented revision metadata cannot pass. |
| A7, amended | `tests/unit/u94/memory.test.ts` and `styles.test.ts`: archive task/step/duration labels, focusable Restore controls, bounded literal Diary content, Memory wrapping rules, narrow Diary stacking and archive wrapping rules in both themes. Gate: DOM/text/style-rule assertions only. Rendered overflow, wrapping and keyboard traversal at 320/1280 CSS pixels [TARGET] belong to U95 and are not claimed here. |
| A8 | `NegativeControls.test_a8_current_only_history_mutant_fails_a2_assertion` patches only `EXT_DISPATCH["memory_history"]` with the current-only mutant, then executes the actual A2 method. `test_a8_missing_export_newline_mutant_fails_a1_assertion` patches only `EXT_DISPATCH["room_export"]` with a renderer result lacking its memory newline, then executes the actual A1 method. Gate: both acceptance methods must raise `AssertionError`. Negative: an acceptance method that stops detecting its mutant fails the negative-control test. Production files are never mutated. |

## MUST mapping

| MUST | Coverage |
| --- | --- |
| M1 | `Discovery` covers complete descriptors, registration and permitted application imports; `legacy_tools.json` freezes the existing descriptors. Existing-suite comparisons cover legacy behavior. |
| M2 | Export/history journal snapshots, torn final line, exactly one `store.read` per request, subprocess/network prohibitions and empty-room non-creation. No stronger isolation claim is made. |
| M3 | `ExportContract` compares both UTF-8 renderer results, response shapes, newline and projection head; a rejected later write distinguishes head from section revision. |
| M4 | `HistoryContract` checks exact accepted versions, identical/empty replacement text and default/boundary limits; fixture ordering is deliberately noncanonical. |
| M5 | `Arguments` plus complete input schema checks. Omitted `limit` defaults to 100 [TARGET]; null/booleans/floats/strings are rejected. |
| M6 | `FileExport` plus `Discovery.test_m6_first_import_and_discovery_have_no_filesystem_side_effects`; all path attacks and fault injections stay inside per-test scratch storage. First imports run with a scratch home, never the real default home. |
| M7 | Final Amendment B-U94 removes the native `python3 -m bridge.room export` gate from U94. Native wiring and its exit codes are a separate integration unit; no native command is substituted or patched. |
| M8 | Companion TypeScript DOM tests preserve literal text, author/time, required-empty behavior and existing bounds while requiring readable revision copy. |
| M9 | Companion CSS/DOM regression tests; protected `src/views/plan.ts` and `src/views/index.ts` are read-only. |
| M10 | Fail-first runs, executable A8 mutants, existing-suite comparisons and TypeScript baseline comparison; no rendered layout claim. |

## Gaps and choices

- Direct exporter symbol/signature: AUSENTE in SPEC U94. The provisional stub is
  `export_room(room: str, out: str) -> dict`. Only `support.file_export` adapts this
  name. It is not an extra conformance requirement; if the implementation chooses
  another direct-call API, change this adapter rather than the behavioral tests.
  No success return shape is imposed. The unspecified direct-error representation
  accepts either `RoomError(code, message)` or an explicit error dictionary;
  tool handlers must raise `RoomError` as required by S0.
- U87 generic CLI `call` is AUSENTE in the supplied `bridge/room/__main__.py`.
  Its equivalence test skips explicitly until that upstream hook lands. This is
  upstream integration, not a U94 behavioral failure. MCP equivalence is active.
- The final amendment supersedes the earlier native-hook HOLD. No native CLI
  export test is counted as a U94 failure.
- Empty destination is rejected. `.` is allowed as the home directory because
  it contains no forbidden traversal component. Fallback home follows
  `CW_HOME`/`~/.context-wall`, including an empty `CW_HOME` value.
- No numerical narrow breakpoint is supplied by the final amendment. CSS tests
  require an explicit pixel `max-width` covering 320 but excluding 1280 CSS pixels
  [TARGET]; they do not freeze an otherwise unspecified implementation value.
- Rollback is tested with a transient second-replacement fault and a working
  recovery path. Atomic replacement of the pair and recovery under an additional
  rollback fault remain out of scope. Failure-path temporary-file names/cleanup
  are not additional conformance requirements.
- Existing Diary outcome truncation is preserved. Its literal-text assertion uses
  the exported existing bound; U94 cannot modify `src/views/plan.ts`.

## Execution and stop rules

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u94 -t .
npx vitest run tests/unit/u94 --no-cache
npx tsc --noEmit -p .
```

All fixtures use fixed timestamps and explicit Lamports. Python uses stdlib
unittest, temporary directories under this test package, no network and no sleep.
TypeScript uses fake time, a refusing fetch stub, jsdom and both theme attributes.
The generic CLI subprocess, when available, has a bounded timeout.

Stop on syntax/import/fixture errors or TypeScript diagnostics in these tests:
those are broken oracles, not expected red. Python behavioral red must come from
`NotImplementedError: U94 stub`. Since the authorized stub surface contains no
TypeScript module and `src/views/memory.ts`/`styles/views.css` cannot be edited,
TypeScript red must be direct assertions against missing U94 UI behavior, not an
invented TS stub. Registration/schema, legacy regressions, fixture gates and
negative controls can already pass.

Out of scope: U87 dispatch implementation, native CLI export wiring, U95 rendered
evidence, archive generations/restore semantics, history UI transport, import,
cited memory units, consolidation, new seams, pairwise transactional replacement,
and changes to `memory_set`, `resume_from_memory` or S1-S3.

## Freeze verification and existing-suite conflict

| Check | Observed result |
| --- | --- |
| U94 Python | 43 methods: 35 red, 7 green, 1 upstream skip [MEASURED]. Exact summary: `FAILED (errors=95, skipped=1)`; errors include subtests. Every error is `NotImplementedError: U94 stub`. |
| U94 Vitest | Exact summary: `Tests 12 failed \| 16 passed (28)` [MEASURED]. All failures are direct assertions for missing revision/readability behavior, without import/type/fixture errors. |
| TypeScript | 16 existing diagnostics; no U94 diagnostics [MEASURED]. Diagnostic output is byte-identical to the measured baseline. |
| Full Vitest | `Tests 91 failed \| 9416 passed \| 2 skipped (9509)` [MEASURED]. The measured pre-oracle run had `Tests 79 failed \| 9400 passed \| 2 skipped (9481)` [MEASURED]; the entire delta matches the focused U94 run. |
| Existing Python with required registration | 1800 methods [MEASURED]; exact summary: `FAILED (failures=16, errors=131, skipped=3)`. Existing unrelated failures remain; see the discovery conflict below. |

Two legacy tests are incompatible with S0's required additive discovery:
`bridge/tests/room/test_mcp.py::Handshake.test_tools_list` requires exactly the old
tool count, and
`bridge/tests/room/u69/test_contract.py::Contract.test_a3_append_tools_in_order`
requires exactly the old full name list. Together they pass when the new module
is temporarily absent (`OK`) and fail after restoring its required registrations
(`FAILED (failures=2)`) [MEASURED]. The stub was restored byte-for-byte. These
assertions cannot both remain green while A1 discovers `room_export` and
`memory_history`; old descriptors themselves remain unchanged. Updating those
legacy assertions is outside this oracle's authorized write surface. No dispatch
masking, conditional registration or protected-file edits were used to hide this
conflict. This existing-suite gate remains HOLD; U94 ADMIT is not claimed.

An exploratory existing-Python run disabled the module only in its parent
interpreter; its child interpreters still discovered the on-disk module. That
run is not treated as a pristine full-suite baseline. The isolated legacy
comparison above establishes the conflict directly.
