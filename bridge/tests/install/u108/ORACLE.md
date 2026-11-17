# U108 installer acceptance mapping

See `tests/unit/u108/ORACLE.md` for the complete acceptance/MUST map, baseline
controls, interpretation of the existing MCP envelope, and capsule-only scope.
Test names below belong to `bridge/tests/install/u108/test_manifest.py`.

| Acceptance | Test names |
| --- | --- |
| A1 | `test_a1_preview_is_zero_writes_and_prints_the_manifest`; `test_a1_existing_config_is_byte_identical_even_when_not_valid_json`; `test_a1_install_then_reinstall_preserves_custom_existing_config`. Rendered/copied recipes are tested in `tests/unit/u108/help.test.ts`. |
| A2 | `test_a2_mcp_heartbeat_reaches_native_room_relay_with_same_home`. This launches the documented stdio MCP server, posts the specified activity, and polls the configured native relay with a fixed clock. The TypeScript test additionally parses and executes the displayed registration. |
| A3 | `test_a3_{platform}_{browser}_umask_{mask}_{state}`; `test_a3_windows_registry_preserved_{browser}`. Expansions below. |
| A4 | `test_a4_room_traversal`; `test_a4_room_semicolon`; `test_a4_room_substitution`; `test_a4_room_bad_tier`; `test_a4_extension_semicolon`; `test_a4_extension_substitution`; `test_a4_extension_backticks`. Invalid inputs must stop before all writes and shell/process entry. |
| A5 | `test_a5_manifest_permission_oserror_returns_one_without_success`; `test_a5_foreign_manifest_refused_without_mutation`; `test_a5_foreign_launcher_refused_without_mutating_owned_manifest`; `test_a5_foreign_launcher_on_fresh_install_stops_before_config_or_manifest`; `test_a5_amendment_owned_manifest_symlink_is_refused_without_following`; `test_a5_amendment_dangling_manifest_symlink_is_refused_without_creating_target`. |
| A6 | `test_a6_negative_control_rejects_an_insecure_0664_manifest`, with current baseline enforcement failures from the A3 matrix. Old-command and relative-guide rejection and compliant instrument controls live in `tests/unit/u108/help.test.ts`. Product files are never modified for controls. |

The A3 test-name dimensions are:

| Dimension | Values |
| --- | --- |
| `{platform}` | `linux`, `darwin` (simulated destinations on a POSIX filesystem) |
| `{browser}` | `chrome`, `chromium`, `edge`, `brave` |
| `{mask}` | `0000`, `0002`, `0077` [TARGET] |
| `{state}` | `fresh`, `reinstall_owned_0664`; the latter resets the owned manifest to 0664 [TARGET] before reinstall |
| POSIX gate | Manifest 0600, launcher 0700, new config 0600 [TARGET]; preserved config bytes, exact manifest fields and destinations |
| Windows gate | In-memory HKCU browser registration and preserved config; no POSIX mode assertion |

Preservation tests also cover M3/M6:
`test_m3_install_success_reports_no_harness_connection_or_deployment`,
`test_m6_remove_deletes_only_owned_artifacts_and_keeps_config`,
`test_m6_remove_preserves_foreign_manifest_and_launcher`, and
`test_m6_remove_keeps_foreign_launcher_beside_owned_manifest`.

The OSError gate requires exit 1 [TARGET] and no `Installed:` line.
Foreign artifacts, invalid rooms/extension IDs, and symlinked manifests require
exit 2 [TARGET] with no new installation artifacts. Refusal checks preserve
original bytes and modes; symlink checks preserve the target and the link.
POSIX-only checks are skipped on Windows rather than asserting Unix modes there.

Real browser rendering, viewport/zoom checks, clipboard/navigation, guide content,
screenshots and clone admission remain capsule verification. U133 hook setup,
lifecycle/model/authentication/chat features and hosting changes are out of scope,
not oracle failures.
