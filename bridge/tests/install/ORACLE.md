# U70 installer fail-first oracle

Status: R27 W3, wave B [CITED: `.unit/SPEC.md`]. Implementation surface:
`bridge/install.py`; oracle surface: `bridge/tests/install/`.
Host identifier: `com.contextwall.bridge`. No production files are changed.

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/install -t .
```

The oracle uses stdlib unittest, temporary homes beneath this test directory,
an isolated environment, injected platform/version/interpreter values, and an
in-memory `winreg` fake. Temporary fixtures are removed. It never launches a
browser or a host, accesses the real registry, uses a network, sleeps, or
introduces clocks/ports. Paths in fixtures are derived at runtime.

## Acceptance map

All names below are methods of `test_install.Installer`.

| Acceptance | Test names | Gate / negative contrast |
|---|---|---|
| A1 | `test_a1_destination_linux_chrome`, `test_a1_destination_linux_chromium`, `test_a1_destination_linux_edge`, `test_a1_destination_linux_brave` | Exact Linux destinations; wrong-browser locations do not pass. |
| A1 | `test_a1_destination_darwin_chrome`, `test_a1_destination_darwin_chromium`, `test_a1_destination_darwin_edge`, `test_a1_destination_darwin_brave` | Exact macOS destinations; Linux-style locations do not pass. |
| A1 | `test_a1_destination_win32_chrome`, `test_a1_destination_win32_chromium`, `test_a1_destination_win32_edge`, `test_a1_destination_win32_brave` | Exact LOCALAPPDATA destination; HOME fallback does not pass. |
| A1 / M1 | `test_a1_default_browser_is_chrome`, `test_m1_invalid_browser_refused`, `test_m1_posix_does_not_import_windows_registry` | Default browser retained; invalid browser refused; POSIX must not import winreg. |
| A2 | `test_a2_windows_round_trip_chrome`, `test_a2_windows_round_trip_chromium`, `test_a2_windows_round_trip_edge`, `test_a2_windows_round_trip_brave` | Manifest, quoted installing interpreter in batch launcher, config argument, exact HKCU key and default value; removal preserves unrelated values in the same key and a separate key. |
| A2 / M6 | `test_a2_remove_preserves_replaced_foreign_registry_value` | A replacement default value is foreign and must survive removal. |
| A3 | `test_a3_posix_launcher_interpreter_config_mode_and_origin` | POSIX platforms: quoted interpreter/config paths with spaces, apostrophes and a literal shell metacharacter; exact origin and private executable permissions. |
| A3 | `test_a3_default_launcher_pins_installing_interpreter`, `test_a3_default_launcher_private_executable_mode` | Independent assertions expose the bare-interpreter and excessive-permission defects without first requiring new CLI options. |
| A4 | `test_a4_requested_rooms_config_created_once` | Repeated room options produce a loadable allow-list; reapply preserves edited config bytes. |
| A4 | `test_a4_cw_home_default_config_and_demo_room`, `test_a4_home_fallback_config` | CW_HOME and HOME fallback paths; default demo/private room; launcher receives config. |
| A4 | `test_a4_existing_config_never_overwritten_even_if_invalid` | Existing config bytes survive even when invalid; no installer repair is assumed. |
| A5 | `test_a5_key_file_derives_origin_and_config_id` | Fixed public DER SPKI fixture, independent hashlib/mapping reference; matching manifest/config IDs. |
| A5 / M4 | `test_a5_unreadable_or_invalid_base64_key_refused_without_writes` | Missing key and malformed base64 are rejected with no installer artifacts or registry writes. |
| A6 | `test_a6_apply_without_id_refused_without_writes` | Every platform refuses no-ID apply before writes. |
| A6 / M5 | `test_a6_old_python_refused_one_line_without_writes`, `test_m5_old_python_dry_run_also_refused`, `test_m5_minimum_python_accepted` | Unsupported version refuses with the specified status and one-line guidance; minimum supported version succeeds. |
| M4 | `test_m4_no_id_dry_run_explains_extensions_page`, `test_m4_invalid_ids_no_writes` | No-ID guidance names chrome://extensions; malformed, wildcard, uppercase and control-bearing IDs are rejected. |
| M3 | `test_m3_hostile_rooms_refused_without_writes` | Traversal-like names, control characters, empty names and unknown tiers fail before writes. |
| M6 | `test_m6_dry_run_with_new_options_writes_nothing`, `test_m6_conflicting_modes_and_unknown_flags_no_writes` | New-option dry runs succeed without writes; conflicting modes and unknown flags refuse without writes. |
| M6 | `test_m6_remove_owned_install_preserves_config_and_unrelated_file` | Removal works without resupplying an ID, deletes owned manifest/launcher, preserves user config and unrelated file, and is idempotent. |
| M6 | `test_m6_foreign_or_malformed_manifest_preserved`, `test_m6_foreign_launcher_refused_and_preserved`, `test_m6_tampered_manifest_cannot_delete_unrelated_target` | Existing ownership checks remain effective; foreign bytes and arbitrary manifest targets survive. |
| M7 | Existing `bridge/tests/wall/` suite plus supersession list below | Baseline regression check; legacy default-ID assertions cannot override M4. |

The generated destination methods are distinct unittest cases, generated from
the expected platform/browser table. They require a successful installation
before checking the exact path; simply rejecting a new option cannot pass.

## Fail-first measurement

Against the supplied installer: 42 test methods [MEASURED], 29 red methods
[MEASURED], 13 green methods [MEASURED], no test errors [MEASURED].
Exact unittest result line:

```text
FAILED (failures=34)
```

The failure count includes failing subtests; it is not the number of red test
methods. Every failure is an AssertionError [MEASURED]. Unsupported options
currently return rejection instead of succeeding, default launcher interpreter
and permission assertions fail, generated config is missing, no-ID apply
incorrectly succeeds, Python version enforcement is missing, and no-ID guidance
is absent. There are no missing-module failures or production stubs.

Existing `bridge/tests/wall/` baseline: 109 tests [MEASURED], all green
[MEASURED], exact result line `OK`. This run includes the U09 installer,
U38 launcher and repair ownership cases; no existing tests were changed.

## Spec ambiguities and legacy supersessions

The full supplied `.unit/SPEC.md` ends at A6. A separate final Amendment section
is AUSENTE. M7 references amendment `A-U70a`; this document records only conflicts
already decided by the explicit M4 requirement, without inventing new behavior.

A room specified without a tier is interpreted as private, consistent with the
stated `demo:private` default. Valid-room tests use private and standard tiers,
accepted by the existing relay. No additional accepted tier is invented.
Malformed options/IDs/keys/rooms use the existing CLI invalid-input exit status
[CITED: `bridge/install.py`]. If both ID sources are supplied, precedence is
AUSENTE; no test chooses it. Missing LOCALAPPDATA, duplicate rooms, unknown
platforms and registry-error rollback policy are likewise not specified and are
not assigned invented contracts. Configuration is validated with existing
`bridge.wall.emit.load_config` and `bridge.wall.room_relay.load_room_config`;
no config spool location, agent name or JSON formatting is prescribed.
Existing configuration is never overwritten, including malformed config; its
presence alone does not prescribe apply success or refusal.

The following legacy cases depend on implicit PINNED_ID installation and are
superseded **only in that setup/default-ID expectation**, under M4/M7 and the
referenced `A-U70a`. Their ownership and launcher requirements remain binding.
They are not edited or skipped by this oracle.

| Legacy file | Exact affected methods | Replacement / retained obligation |
|---|---|---|
| `bridge/tests/wall/test_install.py` | `Installer.test_w13_dry_run_default_writes_nothing` | No-ID dry run now provides ID discovery guidance; `test_m4_no_id_dry_run_explains_extensions_page`. |
| `bridge/tests/wall/test_install.py` | `Installer.test_w13_apply_writes_exact_manifest`, `Installer.test_w13_remove_deletes_only_what_it_wrote`, `Installer.test_w13_foreign_file_refused_and_untouched`, `Installer.test_unparseable_existing_file_is_not_overwritten` | No-ID apply must refuse; explicit-ID equivalents cover manifest, removal, foreign and malformed bytes. |
| `bridge/tests/wall/test_install_u38.py` | `LauncherImportsRoom.test_launcher_text_puts_repo_root_on_the_import_path`, `LauncherImportsRoom.test_launcher_runs_from_unrelated_cwd_and_the_room_relay_loads` | Their `_install` setup must supply an actual ID. U38 import-path and host execution obligations remain; this oracle does not redefine them. |
| `bridge/tests/wall/test_repair1.py` | `F6Install.test_generated_launcher_actually_runs_the_host`, `F6Install.test_remove_never_deletes_unrelated_file_named_in_manifest` | Their setup must supply an actual ID; generated host execution and unrelated-target protection remain required. |
| `bridge/tests/wall/test_repair2.py` | `G2InstallOwnership.test_apply_does_not_overwrite_foreign_launcher`, `G2InstallOwnership.test_remove_keeps_foreign_manifest_with_same_name` | Their `_nm_dir` setup must supply an actual ID; ownership protections remain covered with explicit IDs. |

Unchanged compatible U09 cases: `Installer.test_custom_extension_id_and_invalid_ids`
and `Installer.test_conflicting_or_unknown_flags`. `bridge/tests/wall/ORACLE.md`
W13 remains the legacy reference; its obsolete pinned default does not supersede
M4. The implementation must otherwise preserve the existing wall suites.

## Out of scope

| Surface / finding | Disposition |
|---|---|
| `bridge/room/store.py`, `bridge/room/hook_claude.py`, `bridge/room/mcp.py` | Windows locking and MCP encoding belong to other units. |
| `bridge/wall/native_host.py`, `bridge/wall/__main__.py` | Windows pipe readiness and native frame binary mode belong to other units; no claim of Windows runtime success. |
| `bridge/models/store.py`, `bridge/ctx/paths.py` | Windows ACL/handle confinement belongs to other units. |
| `tools/demo/run_demo.mjs`, `tools/demo/run_tasklight.mjs`, `tools/demo/setup_native.py` | Browser discovery, key-generation dependencies, demo setup and process cleanup belong to other units; only public-key ID derivation is referenced here. |
| `README.md`, `docs/MCP.md`, `package.json`, `package-lock.json` | Setup documentation and Node compatibility are outside the installer surface. |
| Extension deployment, Firebase setup, plan/MCP strategy | No U70 installer assertion depends on these unrelated deliverables. |

This oracle's mandate is limited to the supplied `.unit/SPEC.md` and cited code
inside the isolated project copy.

## AGY_TOOL Antigravity MCP setup

Run `python3 -m unittest bridge.tests.install.test_antigravity` from the
repository root. The tests isolate the home directory and PATH. A fake `agy`
records argv and returns canned listings. Synthetic credentials in JSON and
subprocess output must stay out of setup and doctor output.

| Requirement | Tests in `test_antigravity.AntigravitySetup` | Gate and negative contrast |
|---|---|---|
| R2 | `test_desktop_dry_run`, `test_desktop_different_entry_requires_force`, `test_desktop_malformed_config_is_untouched` | Desktop dry runs use the same home-relative location across platforms and create no files. Conflicts require force. Malformed JSON and invalid UTF-8 survive even with force. |
| R2, R3 | `test_desktop_merge_keeps_private_config_and_backup`, `test_codex_force_backup_keeps_private_mode` | Merge preserves the foreign server and its credential. Output omits both. Backup bytes match the original, and private modes survive with a permissive umask. |
| R4 | `test_cli_dry_run_requires_no_executable`, `test_cli_missing_executable`, `test_cli_existing_tasklight_requires_force`, `test_cli_force_adds_without_removing_existing_entry` | Dry run gives the complete argv and platform command without executing it. Apply refuses a missing executable or unforced conflict. Force permits the native add command. |
| R4 | `test_cli_adds_then_verifies_and_reports_legacy`, `test_cli_add_success_requires_exact_tasklight_name_in_second_list`, `test_cli_failed_list_prevents_add`, `test_cli_failed_add_is_reported_without_command_output`, `test_cli_timeout_is_bounded_and_does_not_echo_output` | Apply verifies through a second list. Similar names and mentions in another entry fail. Legacy removal is advisory. Command failure and timeouts produce clean errors. |
| R5 | `test_doctor_checks_both_registries`, `test_doctor_failures_have_one_line_fixes` | Exact desktop registration and enabled CLI registration pass. Malformed or different desktop entries and a missing CLI produce failures with one-line fixes. |

Before editing the setup tool, the focused suite ran 16 tests [MEASURED] and
reported `FAILED (failures=21)` [MEASURED], including failing subtests.

### AGY_TOOL round 2

| Tests | Gate and negative contrast |
|---|---|
| `test_cli_lists_names_from_real_table`, `test_cli_list_handles_color_spacing_and_markers` | The recorded `agy mcp list` table yields every server name. Headers and blank lines are skipped. ANSI color, variable spacing, and leading markers preserve the names and statuses. |
| `test_cli_existing_tasklight_requires_force`, `test_cli_force_adds_without_removing_existing_entry`, `test_cli_adds_then_verifies_and_reports_legacy`, `test_cli_add_success_requires_enabled_tasklight` | Apply reports `tasklight_status` for a listed entry. A disabled entry still triggers `exists` before add without force and `agy_verify_failed` after add. An enabled entry passes post-add verification. |
| `test_doctor_checks_both_registries`, `test_doctor_fails_for_disabled_tasklight` | Doctor reports the listed status and requires `enabled`. A disabled entry fails with a one-line enable command. |

The focused suite against the round 1 implementation ran 20 tests [MEASURED]
and reported `FAILED (failures=4, errors=4)` [MEASURED] with the updated fixtures.

## XPLAT_INSTALL

Run from the project root with Python's standard library.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest bridge.tests.install.test_xplat_install
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/install -t .
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/setup -t .
```

| Rule | Gate | Negative contrast |
| --- | --- | --- |
| R1 | Simulated Windows install and client writes use inherited permissions. Doctor accepts a registered readable batch launcher with no executable bit. Simulated macOS keeps private manifest and launcher modes with optional POSIX APIs removed. | Windows doctor rejects missing registry registration and an unlaunchable suffix. macOS doctor rejects a launcher whose executable bit was removed. |
| R2 | Windows browser profiles and the installer prefer `LOCALAPPDATA`. Claude Desktop prefers `APPDATA`. Linux uses `XDG_CONFIG_HOME` and Chrome's documented environment overrides. macOS uses Application Support and honors `CODEX_HOME`. | Competing directories test precedence. Unset Windows variables test the alternate AppData directory. |
| R3 | Claude Code and Antigravity CLI render argv with Windows quoting or POSIX shell quoting. A Windows sharing violation retries an adjacent unique file. Codex's TOML round-trips Unicode paths. | An independent `.tmp` file survives. A permanent macOS replacement error returns `write_failed`, preserves the original bytes and cleans the temporary file. Same-second backups retain both originals. |

- Before editing either implementation, the initial regression tests reported `Ran 10 tests in 0.011s` [MEASURED] and `FAILED (failures=8, errors=1)`.
- The two additional backup and Unicode regression tests reported `Ran 2 tests in 0.004s` [MEASURED] and `FAILED (errors=2)` before their fixes.
- The final targeted run reported `Ran 12 tests in 0.010s` [MEASURED] and `OK`.
- The install suite reported `Ran 155 tests in 1.683s` [MEASURED] and `OK (skipped=1)`. The setup suite reported `Ran 133 tests in 0.306s` [MEASURED] and `OK (skipped=2)`.
- Default wall-room discovery reported `Ran 113 tests in 0.714s` [MEASURED] and `OK`. The separate U58 relay oracles still report failures under the wider discovery pattern.
- With a temporary HOME, Claude Desktop, Cursor, Gemini and Antigravity printed `mcpServers` JSON. VS Code printed `servers` JSON, Codex printed TOML, Claude Code printed `command`, and Antigravity CLI printed `command` and `command_argv`. Each returned `ok: true` and left HOME empty [MEASURED].
- Native Windows and macOS verification is pending.
