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
