# FB2 fail-first oracle

Scope: `.unit/SPEC.md`, including its final **Placeholder-pinning tests (amendment A-FB2)** and **Oracle** sections. No other final amendment or separate numbered acceptance list is present. M1–M8 are the numbered acceptance cases [CITED].

## Acceptance map

Names below are the literal test-name prefixes in `cli.test.ts`, except where another file is named. Parameterized cases expand into independently reported tests.

| Case | Test names and acceptance evidence |
| --- | --- |
| M1 | `M1 valid public config succeeds; extra measurementId is ignored`; `M1 accepts %s` covers valid bounds and custom hostname fields. `M1 rejects %s before any write`, `M1 rejects missing %s before any write`, `M1 rejects nonobject JSON %j`, malformed/unreadable JSON, missing required options, extension id/site key/origin cases, placeholder fields/prefix semantics, and `M1 rejects a regex-valid lowercase TODO projectId` cover invalid and hostile inputs. `M1 prints one diagnostic line per validation problem` checks aggregate reporting without prescribing wording or stdout versus stderr. Every refusal requires exit status `2` [CITED] and byte identity of the entire fixture, not merely the output files. |
| M2 | `M2 refuses secret-bearing key %s without writing it`, service-account JSON, empty secret values, nested debug data, nested/flat PEM prefixes, and `M2 applies secret refusal in dry-run too`. Refusals require public-web-config guidance and no file creation or modification, including no debug-token output artifacts. |
| M3 | `M3 changes only public config values and preserves every other byte`; `M3 substitutes extension CSP ids without leaving EXT_ID or changing other JSON keys`; `M3 default origin admits both project domains and preserves manifest keys and localhost`; `M3 panel rewrite preserves all bytes except its hosted origin`; `M3 explicit custom HTTPS origin reaches manifests, CSP and panel`. Both manifests, both hosting CSP locations, the iframe, config values, public site key and unrelated source bytes are checked. |
| M4 | `M4 creates the exact project binding and typed defaults for every Remote Config key`. Expected defaults are independently imported from `src/config/keys.ts`, combining `CONFIG_DEFAULTS` and `PROVIDER_FLAG_DEFAULTS`; all keys, stringified default values and STRING/NUMBER/BOOLEAN types are checked. The project binding, template path and preservation of other `firebase.json` keys are also checked. |
| M5 | `M5 rerunning identical inputs changes no bytes`; `M5 changed public values update configured files structurally, including prior extension ids`; `M5 switches custom origin to default and back without retaining stale origins`. Checks include site key, project binding, origins, CSP ids and Remote Config, after placeholders have already disappeared. |
| M6 | `M6 dry-run writes nothing, including absent project/template outputs`; `M6 dry-run reports each file and its affected fields`; `M6 dry-run of changed inputs preserves an already configured tree`; `M1/M6 invalid dry-run inputs still refuse with exit 2 and no writes`. File associations and field names are checked without pinning indentation, quoting or overall report serialization. |
| M7 | `M7 all successful changes stay within the exact file allowlist`; `M7 omitted root uses the copied tool's project root rather than cwd`; `M7 does not follow an output %s symlink outside root`. Full-tree content and symlink snapshots cover unrelated files, tests, dependency sentinels, Git sentinels, built hosting content, input JSON and sibling paths. |
| M8 | `M8 ends with two builds and three separate deploys, printed only (dry-run %s)`. Final command lines cover the production extension build, production hosting build and separate hosting, rules and Remote Config deploys. Harmless command tripwires and a builder sentinel detect accidental execution, including child invocations through the Node executable. |
| A-FB2 | In `amendment.test.ts`, `A-FB2 <test path> accepts placeholder and configured fixture states` runs each actual existing suite against both states and requires the amendment comment. `A-FB2 configured manifest predicates reject a project not matching .firebaserc` and `A-FB2 configured state cannot retain the placeholder reCAPTCHA key` prevent vacuous predicates. No replacement predicate API or source-code shape is assumed. |

The amended suite paths are:

- `tests/unit/u22/config.test.ts`
- `tests/unit/u37c/amend_u13_sw_main.test.ts`
- `tests/unit/u38/g6_manifest.test.ts`

These files are copied and executed, never edited by this oracle lane. The author must amend them as required by A-FB2. Existing assertions run through the real test runner in the disposable project.

## Negative controls

| Mutant | Gate that must reject it |
| --- | --- |
| Skip validation | Any `M1 rejects ...` or M2 refusal: wrong exit status or a changed full-tree snapshot fails. Regex-valid placeholder input prevents relying only on format checks. |
| Write during dry-run | The M6 snapshots include the whole fixture and initially absent generated files; any write fails. |
| Leave `<EXT_ID>` | The M3 CSP test and `assertOrigins` require the supplied extension id in both CSP files and explicitly reject `<EXT_ID>`. |

Tests never catch a stub error as success. Each acceptance test first invokes the documented CLI; child stderr is attached to exit-status assertions. Thus the provisional stub fails each test for `Error: FB2 stub`, rather than missing imports, syntax errors, dependency lookup or a synthetic API mismatch.

## Isolation and bounded execution

`harness.ts` creates disposable projects below this test directory and removes them after each test. Only copied tools run. No command targets the working project or another checkout. Runtime paths are derived from module URLs; published fixtures and this report contain no machine-specific paths.

The CLI is launched with an explicit argument array and a preload that denies networking before the tool starts. No application port is opened, and no behavioral assertion waits for a clock or timer. Subprocess deadlines and output-size limits are watchdog bounds, not timing-based acceptance criteria. Nested amendment runs execute the actual existing suites with their existing fake clocks/ports and caching disabled; their reports and copied dependencies stay inside the disposable project.

All successful CLI writes must be confined to:

- `src/app/firebase-config.public.ts`
- `firebase.json`
- `hosting/headers.json`
- `extension/manifest.json`
- `extension/manifest.dev.json`
- `extension/src/panel/panel.html`
- `.firebaserc`
- `firebase/remoteconfig.template.json`

## Resolved ambiguities

- **Pure exports/signatures absent:** the spec names none for the new tool. Tests exercise only the documented CLI. The provisional stub exports `main(argv)` solely as scaffolding; this is not a required implementation API. Every stub function body throws `new Error("FB2 stub")`.
- **Root:** the omitted-root case means the repository containing the copied `tools` directory, independent of the caller's working directory.
- **Hostname grammar:** use unambiguous public/reserved DNS-shaped fixture names. URL schemes, paths, whitespace and empty strings are rejected; unspecified IDN, IP-literal, single-label and trailing-dot policy is not pinned.
- **Secret containment:** “contains” applies recursively, including otherwise ignored extra fields. Secret-named keys are refused even when empty. All hostile values are synthetic.
- **Custom origin:** replace the hosted origin; default deployment requires both project-domain aliases. Development keeps its existing local match and public manifest key. Array ordering and JSON whitespace are not pinned.
- **Symlinks:** a tool may safely replace an output symlink, or refuse before writing. Following it into a sibling is forbidden. Refusal must leave the entire fixture unchanged.
- **Command output:** final successful and dry-run output uses the build/deploy sequence supplied with the spec. Quoting and command prefixes are not pinned. Invalid input prints diagnostics only.

## Out of scope

- Editing the existing A-FB2 suites is the author lane's work; this lane only verifies their required behavior.
- `hosting/vite.config.ts` tests for the literal `PLACEHOLDER_` anywhere in the shipped config, while M3 requires preserving `PLACEHOLDER_PREFIX` and every non-value byte. These requirements leave that existing build gate false after valid configuration. Changing the build gate, deleting the prefix or changing surrounding source is outside this oracle's authorized files and outside the exact M3 rewrite surface. It is an explicit specification conflict, not an additional failing acceptance case.
- Building, deployment, console setup, authentication enablement, App Check enforcement, live AI receipts, visual verification, submission/video/license work and other campaign units are not performed or reported as oracle failures.

## Verification receipt

- Final oracle run: all acceptance tests fail on `Error: FB2 stub`; no failure is caused by loading, parsing or another runtime error [MEASURED].

```text
 Test Files  2 failed (2)
      Tests  124 failed (124)
```

The counts in this verbatim summary are [MEASURED]. No oracle test is green [MEASURED].

- The existing referenced suites pass with `42 passed` [MEASURED]. A separate temporary harness probe confirmed these suites also pass in the disposable placeholder project; that probe was removed.
- `npx tsc --noEmit -p .` reports the same `16` baseline diagnostics [MEASURED], byte-identical to the pre-edit output. No diagnostic names an oracle file [MEASURED].
- All files outside the authorized test directory and stub retain the same aggregate content digest as the pre-edit inventory [MEASURED]. No existing project or suite file was edited.

This oracle is scoped to the provided specification and the cited files in the isolated project copy.
