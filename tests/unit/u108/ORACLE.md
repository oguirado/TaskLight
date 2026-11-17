# U108 fail-first oracle

Specification status: DRAFT, STRATEGY_v11 W1 [CITED]. The supplied specification
identifies I0 as 4528625 [CITED]; the isolated copy has no Git metadata, so its
actual HEAD is AUSENTE — no inventar. Product code is never edited by this oracle.
Amendment B is included.

All paths below are relative to the repository root. TypeScript tests live in
`tests/unit/u108/help.test.ts`; installer tests live in
`bridge/tests/install/u108/test_manifest.py`. The installer directory's
`ORACLE.md` expands its parameterized names.

| Acceptance | Test names and observable gate | Negative contrast |
| --- | --- | --- |
| A1 | `A1/M1 renders Preview and Install recipes in selectable code/pre elements`; `A1/M1 removes the obsolete executable from visible and selectable recipe text`; `M1 explains repository root, loaded extension ID, preview and configuration writes`; `A1 executes both copied recipes in a scratch checkout and preserves existing config`; Python `test_a1_preview_is_zero_writes_and_prints_the_manifest`, `test_a1_existing_config_is_byte_identical_even_when_not_valid_json`, `test_a1_install_then_reinstall_preserves_custom_existing_config`. Parse displayed shell arguments, substitute the fixture ID, execute the copied installer, verify preview output and absence of install artifacts, room allowlisting, manifest/launcher presence, and byte-preserving reinstall. | Missing recipes, the obsolete executable, preview writes, or changed existing config fail assertions. Missing help stops recipe execution before any executable is launched. |
| A2 | `M2 shows the generic MCP heading, launch command and parseable registration`; `M2 explains both path placeholders and the shared CW_HOME for MCP and native host`; `A2 initializes the exact displayed MCP registration and posts an untrusted heartbeat`; Python `test_a2_mcp_heartbeat_reaches_native_room_relay_with_same_home`. Use the displayed command, arguments, working directory and environment; initialize, post status, and verify native relay room frames from the same data directory. | Missing/invalid registration stops execution by assertion; RPC errors, a non-heartbeat event, trusted raw text, or a missing native room event fail. |
| A3 | Python `test_a3_{platform}_{browser}_umask_{mask}_{state}` and `test_a3_windows_registry_preserved_{browser}`. Verify browser destinations, exact manifest fields, launcher/config modes, fresh installs and owned-manifest reinstalls. | Permissive fresh modes and retained owned-manifest modes fail independently. Windows cases assert registration without POSIX mode assertions. |
| A4 | Python `test_a4_room_traversal`, `test_a4_room_semicolon`, `test_a4_room_substitution`, `test_a4_room_bad_tier`, `test_a4_extension_semicolon`, `test_a4_extension_substitution`, `test_a4_extension_backticks`. | Invalid input must return 2 [TARGET] before writes or subprocess/shell entry; snapshots and absent traversal targets discriminate rejection from a partial installation. |
| A5 | Python `test_a5_manifest_permission_oserror_returns_one_without_success`; `test_a5_foreign_manifest_refused_without_mutation`; `test_a5_foreign_launcher_refused_without_mutating_owned_manifest`; `test_a5_foreign_launcher_on_fresh_install_stops_before_config_or_manifest`; `test_a5_amendment_owned_manifest_symlink_is_refused_without_following`; `test_a5_amendment_dangling_manifest_symlink_is_refused_without_creating_target`. | Permission failure must return 1 [TARGET] without `Installed:`. Foreign files and symlinked manifests must return 2 [TARGET]; bytes, modes, symlink identity and target absence are checked. |
| A6 | `A6 negative control rejects the old help command without editing product source`; `A6 Amendment B negative control rejects a restored relative guide href`; Python `test_a6_negative_control_rejects_an_insecure_0664_manifest`. `A6 calibrates recipe execution against the specification fixture` and `A6 calibrates exact MCP registration execution against the specification fixture` execute compliant fixtures to distinguish working instruments from infrastructure failures. | The same recipe/link/mode assertions must reject restored defects. Compliant reference fixtures must pass. Existing baseline defects were checked before authoring the test files. |

Additional MUST coverage:

| MUST | Test names |
| --- | --- |
| M1 | A1 mapping above. The executable must be the documented Python installer; no CLI alias is introduced. Only installer recipes require selectable code/pre elements. |
| M2 | A2 mapping above. Guidance names a generic MCP client or agent harness; product neutrality also remains a capsule content-review check. |
| M3 | `M3 explains allowlisting, MCP and activity without asserting a connection or deployment`; `M3 keeps Close and permits reopening help without registering a room`; Python `test_m3_install_success_reports_no_harness_connection_or_deployment`. |
| M4 | `M4 uses the absolute guide with safe new-tab attributes and keyboard focus`; the A6 relative-link negative control. Exact public URL, `_blank`, `noopener noreferrer`, focusability and hosted-page URL resolution are checked. |
| M5 | A3 matrix and A5 symlink cases. |
| M6 | A4/A5 mappings and Python `test_m6_remove_deletes_only_owned_artifacts_and_keeps_config`, `test_m6_remove_preserves_foreign_manifest_and_launcher`, `test_m6_remove_keeps_foreign_launcher_beside_owned_manifest`. |

## Baseline observations and interpretation

Before authoring tests, bounded inline assertions exposed the obsolete command,
relative guide URL, and insecure manifest mode. The inline runner reported
`Ran 3 tests` and `FAILED (failures=3)` [MEASURED], with no import errors.
Under umask 0002 [TARGET], the actual manifest mode was 0664 [MEASURED].
These are current-copy observations, not reruns of historical receipts.

The A6 mutation wording is interpreted within the prohibition on editing product
files: the live baseline already contains the missing enforcement and obsolete
help/link defects; additional controls mutate only disposable DOM/file fixtures.
No repaired implementation is claimed to have been mutation-tested.

“Existing untrusted envelope” means the existing legacy `post_status` response
`{"event": {"act": "heartbeat", "untrusted_text": "..."}}`, as implemented by
`bridge/room/app.py`. It does not require a new outer `untrusted` property.
`text` must be absent from the returned event; the post is activity.

Linux/macOS destination checks simulate `sys.platform` on the current POSIX
filesystem; this does not certify execution on a macOS host. Windows uses the
existing in-memory registry fixture. Permission-error injection supports
path/descriptor chmod and private descriptor creation, without requiring a
particular installer helper. Existing configurations are preserved even if
malformed; a successful reinstall must not silently repair them.

DOM assertions avoid new CSS classes, container tags, element IDs and JSON key
order. Fake clocks cover wall rendering and relay polling. Stdio processes
receive complete bounded input and EOF, with a timeout guard; there are no sleeps,
polling waits, application timers, network requests or allocated ports.
Temporary fixtures are cleaned from within the allowed test directories.

## Capsule-only verification and out of scope

Responsive clipping, actual clipboard selection, real Tab/Enter navigation,
browser rendering of the configured room, extension loading, screenshot hashes,
and fresh-clone admission remain capsule checks. The JS tests exercise selection
ranges/focus and the Python test verifies the native room event; these do not
certify pixels or browser navigation. Live guide content is AUSENTE — no inventar:
network access is disabled for this oracle, as allowed by Amendment B.

The specified viewport and zoom matrix remains a capsule target, not a unit-test
failure. Hook installation (U133), lifecycle recording, model controls, a setup
wizard, authentication, chat/liaison features, and hosting/build changes are out
of scope and are not reported as U108 failures.

## Commands

Run from the repository root:

```sh
npx vitest run tests/unit/u108 --no-cache
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/install/u108 -t .
npx tsc --noEmit -p .
```

The expected baseline is assertion-red for the missing behavior and green for
preserved contracts and instrument controls. An import, launch or infrastructure
error is never evidence of a detected product defect.

## Verification on the supplied copy

| Check | Observed result |
| --- | --- |
| New Vitest tests | `Tests  9 failed \| 5 passed (14)` [MEASURED]; every failure is an assertion about missing help behavior. |
| New unittest tests | `Ran 74 tests`; `FAILED (failures=43)` [MEASURED]. The remaining 31 tests pass [MEASURED]; there are no errors [MEASURED]. |
| Installer failure reasons | 40 mode assertions, 2 symlink-refusal assertions, and 1 permission-error exit assertion [MEASURED]. |
| Typecheck | 16 existing diagnostics outside U108, no diagnostics in the new files [MEASURED]. |
| Existing relevant view suites | `Tests  793 passed \| 1 skipped (794)` [MEASURED] across `tests/unit/u36`, `tests/unit/u37b`, `tests/unit/u37c` and `tests/unit/u62`. |
| Preserved installer suites | `Ran 51 tests`; `OK (skipped=1)` [MEASURED] for `bridge/tests/install/test_install.py`, `bridge/tests/wall/test_install.py` and `bridge/tests/wall/test_install_u38.py`. Temporary directories were redirected inside the permitted test directory without editing these suites. |
| Broader existing unit baseline, U108 excluded | `Tests  399 failed \| 10454 passed \| 9 skipped (10862)` [MEASURED]. These unrelated baseline failures are not attributed to U108. |

Typecheck diagnostics originate in `src/ai/config.ts`, `src/ai/hybrid.ts`,
`src/ai/parity.ts`, `src/prompts/templates.ts`, `tests/unit/u07/build.test.ts`,
`tests/unit/u07/versions.test.ts`, `tests/unit/u11/repair1.test.ts`,
`tests/unit/u11/repair2.test.ts`, `tests/unit/u14/harness.ts` and
`tests/unit/u36/archive-source.test.ts`.

Hashes of `src/views/index.ts`, `bridge/install.py` and the preserved installer
test files matched their pre-authoring values after verification [MEASURED].
Only the new test files and acceptance maps are deliverables; generated fixtures
and compile caches were removed.
