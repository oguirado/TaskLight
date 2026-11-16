# U76 fail-first oracle

Source: `.unit/SPEC.md`, status R28 [CITED]. The complete file ends at A5;
no Amendment sections are present [MEASURED]. Only tests and oracle documentation
are authored by this unit. Product changes belong to the implementation flight.

Run from the repository root:

```sh
npx vitest run tests/unit/u76 bridge/tests/room/u76
python3 -B -m unittest discover -s bridge/tests/room/u76 -v
npx tsc --noEmit -p .
```

Vitest does not discover Python source files. `tests/unit/u76/bridge.test.ts`
executes stdlib unittest once and reports each individual result as a Vitest case.
It does not reimplement or stub MCP behavior. Standalone unittest discovery works
without the adapter. The adapter's subprocess is bounded and compilation uses
only existing exports.

## Acceptance map

Python names below are methods of `ContractOracle` in
`bridge/tests/room/u76/test_contract.py`. TypeScript names are in
`tests/unit/u76/starters.test.ts`.

| Acceptance | Test names | Verification gate and negative contrast |
| --- | --- | --- |
| A1 / M1 | `lists exactly six starters in the specified order`; `canonical hash equals Python validate_template for the shipped JSON`; `resolves the entire autonomous-software template with the Python canonical hash`; `rejects the wrong autonomous-software hash`; parameterized `rejects hostile or absent id %j` | Exact ordered IDs and full resolved JSON match Python `bridge.plan.template.validate_template`; incorrect hashes and hostile IDs remain unresolved. |
| A2 / M2 | `test_a2_runtime_lists_autonomous_software`; `test_a2_plan_create_starts_in_brief` | Real runtime loading lists `autonomous-software`; creation with `goal`, `repo-scope`, `constraints`, `verification-cmd` succeeds and `plan_get` reports `brief`. A tool error cannot count as successful creation. |
| A3 / M3 | `test_a3_resource_list_shape_and_uniqueness`; `test_a3_resource_exact_shipped_text`; `test_a3_missing_not_listed_and_not_found` | Exact resource descriptor and file contents, versus removal hiding the resource and returning the specified not-found error. |
| A4 / M4 | `test_a4_prompt_list_exact_order_and_schema`; `test_a4_shipped_prompt_exact_fenced_text`; `test_a4_room_agent_final_line`; `test_a4_bad_room_rejected` | Exact descriptors, order, message envelope, extraction, and context suffix; traversal in room is rejected. |
| A5 | `test_a5_shipped_prompt_at_most_250_words` | Count whitespace-separated words in the shipped prompt body; exceeding the specified limit fails. The check is on the base prompt, before optional room context. |

## Additional MUST and hostile-input coverage

| Requirement | Test names | Positive and negative boundaries |
| --- | --- | --- |
| M3 UTF-8 and byte limit | `test_m3_size_limit_inclusive_utf8_bytes`; `test_m3_one_byte_over_limit_not_found`; `test_m3_invalid_utf8_not_found`; `test_m3_empty_utf8_file_is_available` | A valid UTF-8 file exactly at the byte ceiling is listed and read; one extra byte or invalid UTF-8 is neither available nor successfully read. An empty valid file is available. Multibyte text distinguishes bytes from character counts. |
| M3 freshness | `test_m3_reads_latest_bytes_each_call`; `test_m3_listing_rechecks_after_removal` | Writes and removal occur between requests in the same server process. A previous valid read/list cannot authorize stale content after the file changes. |
| M4 optional inputs and exact extraction | `test_m4_omitted_arguments_are_optional`; `test_m4_extraction_uses_only_marked_fence` | No arguments are needed; only the marked text fence is extracted. Outside fences/prose are excluded; body whitespace, blank lines and Unicode remain intact. |
| M4 unavailable contract | `test_m4_missing_file_contract_unavailable`; `test_m4_missing_start_marker_contract_unavailable`; `test_m4_missing_end_marker_contract_unavailable` | Missing file or either marker produces the exact `contract unavailable` message and specified invalid-params error, rather than an unknown-prompt response or partial prompt. |
| M4 invalid inputs | `test_m4_bad_agent_rejected`; `test_m4_room_injection_rejected`; `test_m4_agent_injection_rejected`; `test_m4_nonstring_room_rejected`; `test_m4_nonstring_agent_rejected` | Traversal, injected lines and nonstring values produce the required invalid-params error. These negative controls can already pass while the prompt is wholly unavailable; positive prompt cases prevent that from satisfying the overall gate. |
| M4 preserved descriptors | `test_m4_legacy_prompt_descriptors_unchanged` | Frozen descriptors for `plan_from_template` and `resume_from_memory` match the original prefix exactly. |
| M5 preserved prompt | `test_m5_plan_from_template_text_unchanged` | Independently constructed golden text for `blank`, with hostile closing-fence/closing-envelope text and Unicode in the brief, remains exactly unchanged. |
| M6 regressions | Existing suites listed below | Run existing suites independently of the expected-red U76 cases; their failures cannot be treated as U76 acceptance failures. |

## Scope and resolved ambiguities

- The fenced prompt body excludes the newline belonging to each fence delimiter;
  all interior whitespace is preserved. The context suffix is appended on a new
  final line. Behavior with only room or only agent supplied is unspecified and
  is not constrained beyond the defined optional-argument and invalid-input cases.
- No new prompt size limit, duplicate-marker selection rule, malformed-fence
  recovery rule, or runtime enforcement of the document's agent workflow is
  invented. The documented resource availability limits are exercised as stated.
- Runtime creation remains advisory by default; the oracle supplies a valid task
  and complete brief without introducing unrelated strict memory requirements.
- Each Python test copies real bridge code, planning templates and the contract
  into a temporary repository under `bridge/tests/room/u76/`; subprocess imports
  resolve against that copy. Only copied contract data is mutated. Each request
  goes through the existing JSON-RPC dispatcher. The clock is fixed; there is no
  network, listening port, elapsed-time sleep or model call.
- Keep repository-snapshot demo tests serial with build tests: the build suite
  temporarily changes generated artifacts while the demo suite snapshots them.

## A-U76a: orchestrator-owned legacy expectation changes

| Existing location | Assertion affected after implementation | Ownership |
| --- | --- | --- |
| `tests/unit/u64/templates.test.ts` | `A9 %s is normalized, deeply frozen and matches bundled JSON` compares `STARTER_TEMPLATE_IDS` against the old list ending in `data-ml`. | Out of scope: A-U76a amends the pinned list. |
| `bridge/tests/room/u57_mcp_v2_test.py` | `ResourceOracle.test_03_prompts_and_fences` pins the prompt-name set to `plan_from_template`, `resume_from_memory`. | Out of scope: A-U76a adds `planning_contract`. |
| `tests/unit/u67/helpers.ts` | `IDS` covers the original starter subset; it does not assert total starter count. | Existing subset tests remain valid; no mandatory amendment inferred. |

## Measured fail-first result

Combined oracle: 36 cases [MEASURED], comprising 8 TypeScript cases [MEASURED]
and 28 stdlib Python cases [MEASURED]. Exact Vitest summary:

```text
Test Files  2 failed (2)
     Tests  19 failed | 17 passed (36)
```

Standalone Python summary: `Ran 28 tests` and `FAILED (failures=17)` [MEASURED];
there are no unittest errors [MEASURED]. The red assertions are the missing
starter/order, contract-resource responses and contract-prompt responses.
Runtime template loading, plan creation, hash parity and preserved legacy controls
are green. Expected failures are not import, discovery or collection failures.

Existing suite results, excluding the expected-red new cases:

| Suite | Result |
| --- | --- |
| Vitest unit, excluding `tests/unit/u76/**` | `Test Files  285 passed (285)`; `Tests  9233 passed | 1 skipped (9234)` [MEASURED] |
| `bridge/tests/room`, pattern `*test*.py`, excluding `.u76.` cases | `Ran 381 tests`; `OK` [MEASURED] |
| `bridge/tests/plan` | `Ran 526 tests`; `OK` [MEASURED] |
| `bridge/tests/plan_demo`, pattern `*test*.py`, serial run | `Ran 17 tests`; `OK` [MEASURED] |

The demo suite initially hit its repository-snapshot assertion while unit build
tests ran concurrently, then passed unchanged when run alone [MEASURED].

`npx tsc --noEmit -p .` exits unsuccessfully on existing files outside U76
[MEASURED]. It reports no diagnostic in `tests/unit/u76/` [MEASURED]. Existing
diagnostic paths are `src/ai/config.ts`, `src/ai/hybrid.ts`, `src/ai/parity.ts`,
`src/prompts/templates.ts`, `tests/unit/u07/build.test.ts`,
`tests/unit/u07/versions.test.ts`, `tests/unit/u11/repair1.test.ts`,
`tests/unit/u11/repair2.test.ts`, `tests/unit/u14/harness.ts`,
`tests/unit/u36/archive-source.test.ts`, `tests/unit/u72/repair1.test.ts`, and
`tools/demo/vite.demo.config.ts`. Repairs are outside this flight's surface.
