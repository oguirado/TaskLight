# U82 fail-first setup oracle

Normative source: `.unit/SPEC.md`, status `R29`, including the inline
`A-U82a` amendment in `M6`. The complete supplied file ends at `A6`;
there is no separate final Amendment section.

## Acceptance mapping

| Case | Exact test names or generated name family | Contract |
| --- | --- | --- |
| A1 | `test_a1_default_dev_id`, `test_a1_prod_id_derived_from_prod_key`, `test_a1_invalid_key_{missing,nonbase64,empty,not_der}` | Dev ID `anackbeighghafbocgepfflkiciklmpf`; production key mapping; invalid key produces `invalid_key` and exit failure. |
| A2 | `test_a2_preview_*`, `test_a2_apply_*`, `test_a2_codex_apply_*`, `test_a2_{preserve,conflict,force,malformed}_*`, `test_a2_codex_appends_once_preserves_existing_text`, `test_a2_codex_conflict_force_backup`, `test_a2_claude_code_apply_never_writes_and_command_is_shell_safe` | All requested clients/platforms, exact entries and target paths, dry runs, idempotence, `exists_different`, force/backups, unrelated settings, malformed JSON, atomic replacement, TOML and Claude Code command. |
| A3 | `test_a3_empty_home_missing_checks_have_fixes`, `test_a3_simulated_ready_home`, `test_m5_*` | Ordered checks, explicit failure fixes, real installer-created config with an explicit ID, synthetic extension build, executable native host, dependency and requested-client checks. |
| A4 | `InstallerAmendment.test_a4_default_dry_run_states_dev_id`, `InstallerAmendment.test_a4_default_apply_uses_dev_origin` | Existing `bridge/install.py` must state and apply the dev ID without explicit ID flags. These intentionally expose the existing installer behavior directly. |
| A5 | `test_a5_wall_ready_default`, `test_a5_wall_custom_port`, `test_m1_usage_forbidden_port`, `test_m7_wall_not_ready_is_bounded_failure` | Fake child process and HTTP responses, correct URL, forbidden port rejection, bounded unsuccessful readiness. |
| A6 | Every call through `SetupOracle.invoke`; `test_m1_script_mode_from_unrelated_cwd` | All verbs use `--json`; `json.loads` rejects empty output, stray text and multiple objects; JSON must be an object. Includes successful and failing branches. |

## MUST mapping

| MUST | Tests |
| --- | --- |
| M1 | `test_m1_script_mode_from_unrelated_cwd`, `test_m1_usage_*`, all `invoke` calls |
| M2 | `test_a1_*` |
| M3 | `test_m3_*` |
| M4 | `test_a2_*`, `test_m4_cw_home_environment_override` |
| M5 | `test_a3_*`, `test_m5_*` |
| M6 | `InstallerAmendment.test_a4_*` |
| M7 | `test_a5_*`, `test_m7_*`, `test_m1_usage_forbidden_port` |
| M8 | `test_m8_*`, snapshots in dry-run, malformed, conflict and identical-apply tests; fake runner rejects shell commands |

## Interpretation boundaries

- Python export signatures: AUSENTE in `.unit/SPEC.md`. The minimal
  import seam is `main(argv=None)`, following `bridge/install.py`.
  The stub raises `NotImplementedError("U82 stub")`; script mode calls it.
  No speculative helper exports are imposed on the implementation.
- The output field carrying the ID or dry-run snippet/path is unnamed.
  Tests find the required values/trees without naming those wrapper fields.
  Fields explicitly named by the spec are checked by name.
- `--room` is accepted for MCP config; no additional MCP environment
  entry or room persistence is required because the spec defines neither.
- A malformed key includes missing/empty/non-base64 and base64 that is
  not DER SPKI. Fixtures replace reads, never repository manifests.
- The build subprocess may use relative arguments with repository `cwd`
  or absolute arguments resolving to the same script. No shell is required.
- Atomic client writes use the stdlib replacement boundary `os.replace`.
  Backup names are checked against the specified UTC suffix shape and
  backup contents against exact previous bytes; clocks are faked.
- Doctor readiness fixtures use an explicit ID when invoking the existing
  installer. This keeps A3 independent of the intentional A4 regression.
  Doctor may write within `CW_HOME`; dry-run MCP config must not write.
- Non-ok doctor fixes must be nonempty strings. The spec does not define
  canonical command spellings; tests avoid matching invented fix text.
- A fake process interrupts its foreground `wait` after readiness; failed
  HTTP readiness uses virtual monotonic time and a bounded fake budget.
  There are no real sleeps, ports, browser launches or network requests.
- Dependency injection patches standard-library boundaries and direct
  imported aliases, not private production helpers. Platform, HOME,
  environment and PATH lookup are simulated.
- Tests derive runtime absolute paths from their own location and temporary
  homes. No local installation paths or real credentials are stored here.

## Outside this unit

- Guided installers, Firebase deployment, client installation, extension
  browser UI automation, real model inference and the Windows bridge
  portability issues in desktop documentation are outside this oracle.
- The previous U70 requirement to refuse `--apply` without an ID is
  superseded by `A-U82a`. Existing U70 test files remain untouched; their
  old assertions must be reconciled by the integrator when M6 is authored:
  `bridge/tests/install/test_install.py::Installer.test_a6_apply_without_id_refused_without_writes`
  and `bridge/tests/install/test_install.py::Installer.test_m4_no_id_dry_run_explains_extensions_page`.
- Implementation changes to `bridge/install.py` are forbidden on this
  oracle flight. Its expected A4 failures are not infrastructure errors.
- The real checkout is outside this flight. Only `bridge/tasklight_setup.py`
  and `bridge/tests/setup/` are authored here.

## Verification

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/setup -t .
```

The new CLI cases fail with `NotImplementedError: U82 stub`. A4 fails
on the unmodified installer omission/refusal. The existing installer
regression suite is run separately:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/install -t .
```

## Expanded test inventory

Every generated test name is listed explicitly below.

| Test class | Test method |
| --- | --- |
| `SetupOracle` | `test_a1_default_dev_id` |
| `SetupOracle` | `test_a1_invalid_key_empty` |
| `SetupOracle` | `test_a1_invalid_key_missing` |
| `SetupOracle` | `test_a1_invalid_key_nonbase64` |
| `SetupOracle` | `test_a1_invalid_key_not_der` |
| `SetupOracle` | `test_a1_prod_id_derived_from_prod_key` |
| `SetupOracle` | `test_a2_apply_claude_desktop_darwin` |
| `SetupOracle` | `test_a2_apply_claude_desktop_linux` |
| `SetupOracle` | `test_a2_apply_claude_desktop_win32` |
| `SetupOracle` | `test_a2_apply_cursor_darwin` |
| `SetupOracle` | `test_a2_apply_cursor_linux` |
| `SetupOracle` | `test_a2_apply_cursor_win32` |
| `SetupOracle` | `test_a2_apply_gemini_darwin` |
| `SetupOracle` | `test_a2_apply_gemini_linux` |
| `SetupOracle` | `test_a2_apply_gemini_win32` |
| `SetupOracle` | `test_a2_apply_vscode_darwin` |
| `SetupOracle` | `test_a2_apply_vscode_linux` |
| `SetupOracle` | `test_a2_apply_vscode_win32` |
| `SetupOracle` | `test_a2_claude_code_apply_never_writes_and_command_is_shell_safe` |
| `SetupOracle` | `test_a2_codex_appends_once_preserves_existing_text` |
| `SetupOracle` | `test_a2_codex_apply_darwin` |
| `SetupOracle` | `test_a2_codex_apply_linux` |
| `SetupOracle` | `test_a2_codex_apply_win32` |
| `SetupOracle` | `test_a2_codex_conflict_force_backup` |
| `SetupOracle` | `test_a2_conflict_claude_desktop` |
| `SetupOracle` | `test_a2_conflict_cursor` |
| `SetupOracle` | `test_a2_conflict_gemini` |
| `SetupOracle` | `test_a2_conflict_vscode` |
| `SetupOracle` | `test_a2_force_claude_desktop` |
| `SetupOracle` | `test_a2_force_cursor` |
| `SetupOracle` | `test_a2_force_gemini` |
| `SetupOracle` | `test_a2_force_vscode` |
| `SetupOracle` | `test_a2_malformed_claude_desktop` |
| `SetupOracle` | `test_a2_malformed_cursor` |
| `SetupOracle` | `test_a2_malformed_gemini` |
| `SetupOracle` | `test_a2_malformed_vscode` |
| `SetupOracle` | `test_a2_preserve_claude_desktop` |
| `SetupOracle` | `test_a2_preserve_cursor` |
| `SetupOracle` | `test_a2_preserve_gemini` |
| `SetupOracle` | `test_a2_preserve_vscode` |
| `SetupOracle` | `test_a2_preview_claude_code_darwin` |
| `SetupOracle` | `test_a2_preview_claude_code_linux` |
| `SetupOracle` | `test_a2_preview_claude_code_win32` |
| `SetupOracle` | `test_a2_preview_claude_desktop_darwin` |
| `SetupOracle` | `test_a2_preview_claude_desktop_linux` |
| `SetupOracle` | `test_a2_preview_claude_desktop_win32` |
| `SetupOracle` | `test_a2_preview_codex_darwin` |
| `SetupOracle` | `test_a2_preview_codex_linux` |
| `SetupOracle` | `test_a2_preview_codex_win32` |
| `SetupOracle` | `test_a2_preview_cursor_darwin` |
| `SetupOracle` | `test_a2_preview_cursor_linux` |
| `SetupOracle` | `test_a2_preview_cursor_win32` |
| `SetupOracle` | `test_a2_preview_gemini_darwin` |
| `SetupOracle` | `test_a2_preview_gemini_linux` |
| `SetupOracle` | `test_a2_preview_gemini_win32` |
| `SetupOracle` | `test_a2_preview_vscode_darwin` |
| `SetupOracle` | `test_a2_preview_vscode_linux` |
| `SetupOracle` | `test_a2_preview_vscode_win32` |
| `SetupOracle` | `test_a3_empty_home_missing_checks_have_fixes` |
| `SetupOracle` | `test_a3_simulated_ready_home` |
| `SetupOracle` | `test_a5_wall_custom_port` |
| `SetupOracle` | `test_a5_wall_ready_default` |
| `SetupOracle` | `test_m1_script_mode_from_unrelated_cwd` |
| `SetupOracle` | `test_m1_usage_bad_manifest` |
| `SetupOracle` | `test_m1_usage_forbidden_port` |
| `SetupOracle` | `test_m1_usage_missing_client` |
| `SetupOracle` | `test_m1_usage_missing_manifest_value` |
| `SetupOracle` | `test_m1_usage_missing_verb` |
| `SetupOracle` | `test_m1_usage_nonnumeric_port` |
| `SetupOracle` | `test_m1_usage_unknown_client` |
| `SetupOracle` | `test_m1_usage_unknown_flag` |
| `SetupOracle` | `test_m1_usage_unknown_verb` |
| `SetupOracle` | `test_m3_build_default` |
| `SetupOracle` | `test_m3_build_explicit_out` |
| `SetupOracle` | `test_m3_build_failure` |
| `SetupOracle` | `test_m3_cw_home_environment_override` |
| `SetupOracle` | `test_m3_runner_missing_node_reports_json_failure` |
| `SetupOracle` | `test_m4_cw_home_environment_override` |
| `SetupOracle` | `test_m5_config_malformed` |
| `SetupOracle` | `test_m5_config_no_rooms` |
| `SetupOracle` | `test_m5_cw_home_not_directory` |
| `SetupOracle` | `test_m5_detected_browsers_all_checked` |
| `SetupOracle` | `test_m5_extension_wrong_id` |
| `SetupOracle` | `test_m5_missing_vite` |
| `SetupOracle` | `test_m5_native_darwin_brave` |
| `SetupOracle` | `test_m5_native_darwin_chrome` |
| `SetupOracle` | `test_m5_native_darwin_chromium` |
| `SetupOracle` | `test_m5_native_darwin_edge` |
| `SetupOracle` | `test_m5_native_launcher_missing` |
| `SetupOracle` | `test_m5_native_launcher_not_executable` |
| `SetupOracle` | `test_m5_native_linux_brave` |
| `SetupOracle` | `test_m5_native_linux_chrome` |
| `SetupOracle` | `test_m5_native_linux_chromium` |
| `SetupOracle` | `test_m5_native_linux_edge` |
| `SetupOracle` | `test_m5_native_manifest_malformed` |
| `SetupOracle` | `test_m5_native_origin_wrong` |
| `SetupOracle` | `test_m5_node_bad_version` |
| `SetupOracle` | `test_m5_node_missing` |
| `SetupOracle` | `test_m5_node_too_old` |
| `SetupOracle` | `test_m5_node_version_command_failed` |
| `SetupOracle` | `test_m5_python_boundary` |
| `SetupOracle` | `test_m5_python_too_old` |
| `SetupOracle` | `test_m5_requested_client_present_and_different` |
| `SetupOracle` | `test_m5_requested_clients_missing` |
| `SetupOracle` | `test_m5_templates_missing_autonomous_software` |
| `SetupOracle` | `test_m7_wall_not_ready_is_bounded_failure` |
| `SetupOracle` | `test_m8_credentials_never_opened_and_writes_confined` |
| `SetupOracle` | `test_m8_readonly_commands_do_not_change_home` |
| `InstallerAmendment` | `test_a4_default_apply_uses_dev_origin` |
| `InstallerAmendment` | `test_a4_default_dry_run_states_dev_id` |
