# TLCLI fail-first oracle

The binding corpus is `.unit/SPEC.md`. It ends with the documentation requirement
following M1–M6. Final Amendment sections and separately numbered cases are
**AUSENTE — no inventar**. This oracle applies to that supplied TLCLI spec.

| Case | Acceptance gate and negative contrast | Test names in `test_tlcli.py` |
| --- | --- | --- |
| M1 | Discover every registered operation at runtime. Compare launcher stdout bytes and status with `call` for each operation, a literal Unicode write, malformed or non-object JSON, missing and extra arguments, dispatched `bad_args` and `bad_op`, and unknown, path-like and shell-like tool names. Refusals leave storage untouched. | `ToolParity.test_m1_launcher_registry_parity`, `ToolParity.test_m1_launcher_literal_write`, `ToolParity.test_m1_launcher_refusals` |
| M2 | Keep `post`, `read`, `wait`, `status`, `export`, `tools`, `call`, `run` and `wave`. Register a test-local tool for each reserved verb, compare pre/post registration behavior, and call each colliding tool explicitly. Pin room output, missing-room and timeout refusals, export files, and supervised command parsers. | `LegacyPrecedence.test_m2_legacy_verbs_win_when_each_name_is_registered_as_a_tool`, `LegacyPrecedence.test_m2_legacy_room_verbs_keep_existing_results`, `LegacyPrecedence.test_m2_run_and_wave_keep_their_dedicated_parsers` |
| M3 | Exercise `python3 -m bridge.room <tool>` directly with the same parity fixtures. A dispatcher double checks successful delivery of nonempty objects for the entire real registry, including tools that need a populated journal for a live success. | `ToolParity.test_m3_module_registry_parity`, `ToolParity.test_m3_module_literal_write`, `ToolParity.test_m3_module_refusals`, `ToolParity.test_m3_module_passes_nonempty_objects_for_every_registered_tool` |
| M4 | Invoke executable `bin/tasklight` directly and through `sh` over a relative symlink chain from a caller directory with spaces, shell metacharacters and a decoy package. An interpreter probe checks the documented `python3`, process replacement, exact argv, binary streams, exit status, and the absence of an absolute home path. | `LauncherAndHelp.test_m4_launcher_resolves_relative_symlink_from_hostile_cwd`, `LauncherAndHelp.test_m4_launcher_execs_documented_python_with_literal_argv_and_streams` |
| M5 | `tasklight --help` emits one JSON line with all legacy verbs and live tool names and leaves room storage untouched. Prose or omitted entries fail the gate. | `LauncherAndHelp.test_m5_help_lists_verbs_and_live_tool_names_on_one_json_line` |
| M6 | Exercise real MCP stdio discovery, a success, and a refusal. Compare the new write path's raw `rooms/<room>/events.jsonl` with the identical legacy write on fresh storage. Preserve existing test files and run the relevant legacy suites alongside the oracle. | `CompatibilityAndDocs.test_m6_mcp_discovery_success_and_refusal_keep_wire_contract`, `ToolParity.test_m1_launcher_literal_write`, `ToolParity.test_m3_module_literal_write` |
| Docs | `docs/CLI.md` has an example for every verb and registered operation. `README.md` and `docs/SETUP_WITH_AI.md` each point to the guide. | `CompatibilityAndDocs.test_docs_cli_has_one_example_for_every_verb_and_operation`, `CompatibilityAndDocs.test_docs_readme_and_setup_each_point_to_cli_guide` |

## Interpretation and scope

- `call` supplies the stdout bytes and status for parity. An unknown tool
  currently yields `bad_args` with exit status `2` [MEASURED]. A dispatched
  `bad_args` or `bad_op` yields exit status `3` [MEASURED]. The refusal
  fixtures verify those reference results before comparing the alias.
- Help uses `--help`. JSON field names, ordering and layout remain open.
  `SETUP` refers to `docs/SETUP_WITH_AI.md`, the setup runbook linked from
  `README.md`. The docs check accepts a launcher command in inline or fenced
  code, and accepts `call` syntax for operation examples.
- MCP handler behavior beyond the compatibility probes, work admission and
  evidence policy, terminal task release, family mailbox admission, and
  `run`/`wave` lifecycle internals belong to their owning units. Any upstream
  HOLD on those features is outside TLCLI acceptance.
- Fixtures use local scratch directories, fixed clocks and event IDs for byte
  comparisons, offline execution, and bounded subprocesses. The wait fixture
  uses a zero-duration deadline. Production files and existing tests are
  outside the oracle write surface.

## Verification

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/tlcli -t .
```

The unchanged implementation gives **16 tests, 12 assertion failures, 4 passes,
and 0 errors** [MEASURED]. The exact unittest verdict is `FAILED (failures=12)`
[MEASURED]. The failures cover absent `bin/tasklight`, absent direct dispatch
in `bridge/room/__main__.py`, and missing CLI docs and links.

The compatibility run of `test_cli`, `test_mcp`, `u94c.test_cli_export`,
`u57legacy.test_mcp_v2`, `cld2.test_supervise` and `cld2.test_wave_startup`
finished with `OK` across 95 tests [MEASURED].
