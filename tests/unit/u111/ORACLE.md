# U111 fail-first oracle

Source: `.unit/SPEC.md`, including binding Amendment B. The spec status is
DRAFT; W1/D7, KEEP under Amendment A1 [CITED]. Its inspected baseline is
I0 = `4528625` [CITED]. Runtime receipts supplied with the spec are
AUSENTE — no inventar. These tests create their own results; they do not
claim that the baseline implements U109 or U110.

All paths below are relative to the repository root. Product files are
read-only. There are no product stubs or replacement implementations.

## Execution and mirror

Run `npx vitest run tests/unit/u111` and `npx tsc --noEmit -p .`.
`oracle.test.ts` runs `run_oracle.py` once and exposes every Python case as
an individual Vitest test. The Python source can also run through
`python3 -B -m unittest discover -s tests/unit/u111 -p 'test_*.py'`.

This is the explicit `tests/unit/u111/` mirror allowed by Amendment B's
alternative to `bridge/tests/room/u111/`. The assignment restricts writes
to the former, so no physical files are added to the latter. Both entry
points exercise the same Python MCP cases, not independent approximations.

No network calls, liveness waits or clock advancement are needed: this unit
produces steering text. MCP subprocesses use bounded pipe communication;
the timeout is a failure watchdog, not a timing assertion. Temporary homes,
symlinks and file fixtures live under this test directory and are removed.
Bytecode generation is disabled for subprocesses. Permission errors are
injected rather than relying on chmod behavior under elevated users.

## Acceptance mapping and gates

| Spec case | Test names in `test_mcp.py` | Verification gate | Negative contrast |
| --- | --- | --- | --- |
| A1 / M1 | `test_A1_discovery_exact_new_arguments`, `test_A1_legacy_prompt_metadata_unchanged`, `test_A1_stdio_shapes_and_no_room_creation`; `test_A4_*_executor_workflow` | Both new metadata entries, preserved legacy signatures, JSON-RPC message shape, targeted and untargeted selection | Missing prompt, extra argument metadata, error response, or room creation fails an assertion |
| A2 / M2 + Amendment B | `test_A2_*` | Required strings, object-only arguments, unknown-key rejection, existing room/agent/task validators, inclusive brief byte boundaries, all C0/C1 controls, template lookup, no mutation/deployment/provider calls | Invalid inputs must yield exactly `-32602` / `invalid params`; unavailable template must yield `unknown template`; a nonexistent home must stay absent |
| A3 / M3 | `test_A3_*`; `test_A6_*_remove_passive_fence` | Every supplied value and every embedded template field survives JSON serialization inside the existing passive-data fence; instruction region prohibits obeying data | Closing tags, backticks and template newlines cannot escape; removed fencing must produce AssertionError after the live candidate passes |
| A4 / M4–M6, M8 + Amendment B | `test_A4_*`, `test_M6_*_protocol_and_stop_rules`, `test_M8_guide_harness_workflow_and_expiring_liveness` | Harness-led assignment before deployment, ordered eligible claim/activation, coarse boundary reporting, outcome/evidence, stable attempt identity, beat discovery/skip, handoff, human routing, protocol target qualifications and stop rules | I0 identity and release checks fail independently; reserved identifiers and named harness products are rejected |
| A5 / M7 + Amendment B | `test_A5_*` | Exact UTF-8 guide and metadata, inclusive byte limit, unavailable-file error policy, injected helper seam, symlink parity, unchanged existing resources/tools | Oversized, missing, unreadable, invalid-UTF-8 and dangling-link sources cannot be discovered or read; malformed/unknown URIs remain `-32602` |
| A6 | `test_A6_*` | The corresponding live candidate must pass before each mutation is assessed | Frozen I0 executor fails identity and release separately; removing each prompt fence fails; appending each reserved identifier or public harness product fails on every amended surface |
| M8 guide examples | `test_M8_guide_copyable_prompts_get_requests`, `test_A4_guide_exclusions` | Copyable JSON requests for both new prompts execute against the real dispatcher; guide follows all relevant workflow and privacy constraints | Missing guide/examples, malformed requests, deferred identifiers, product names and local deployment details fail |

Generated names expand into individual tests. For example,
`test_A2_swarm_coordinator_brief_number` and
`test_A2_executor_loop_task_id_null` are separate cases. C0/C1 sweeps use
subtests so each forbidden character is checked without nondeterminism.

## Resolved ambiguities

- Amendment B's no-control-character rule supersedes the earlier A3
  expectation of accepting literal newline bytes in a brief. Literal
  newlines are rejected; accepted hostile briefs contain escaped newline
  text. Embedded template fields still carry literal newlines, closing
  tags and backticks, testing serializer containment without weakening
  brief validation.
- MCP argument metadata has names, descriptions and required flags, as
  the existing prompts do; string types are checked through requests.
  Description prose and a new helper's spelling are deliberately unfrozen.
- An injected reader handles the actual `docs/SWARM.md` location through
  either Python open form. An independent call-trace assertion requires
  a callable path/reader helper exposed in `mcp.py`, with no required name.
  Symlinks follow the existing Markdown reader policy: a readable valid
  target works, while a dangling target is unavailable. No new symlink
  confinement policy is invented.
- Text checks operate on the instruction region after removing passive
  fences. They inspect required tools, ordering and semantic clauses,
  allowing surrounding prose, payload layout and helper names to vary.
- No universal inventory of harness brands is supplied. Exclusion checks
  cover the public product spellings in `contracts.PRODUCTS`; each spelling
  has a live-candidate mutation check on every amended surface. This is a
  bounded lexical oracle, not a claim of recognizing every possible brand.
- `legacy.json` freezes existing public prompt/tool/resource metadata and
  the defective executor text. Existing resource bodies are pinned by
  digests instead of copying deployment examples into this directory.
  The fixture is evidence for preservation and mutation, not a stub server.

## Verification at the inspected baseline

Vitest was run with `--no-cache --no-fsModuleCache --configLoader runner`
to prevent its caches and compiled configuration from writing outside the
allowed test directory. Observed summary [MEASURED]:

```text
 Test Files  1 failed (1)
      Tests  166 failed | 57 passed (223)
```

All failing Python records are assertion failures; there are no runner,
import or infrastructure errors [MEASURED]. Missing prompt/resource behavior
and the existing executor defects account for the failures.

`npx tsc --noEmit -p .` reports no diagnostics in these added files
[MEASURED]. Its existing diagnostics are byte-identical when this test
directory is excluded: 16 errors [MEASURED]. No production fixes are
included for those unrelated errors.

Selected existing MCP, planning-contract and headless-resource suites have
53 passing tests [MEASURED]. Separately, the older
`bridge.tests.room.u57_mcp_v2_test` has 29 existing failures [MEASURED],
including assertions that reject the current error `detail` field. Those
are outside the numbered U111 acceptance cases; they are not relabeled as
U111 failures or repaired by changing production files.

## Out of scope

U109 implements ownership/dependency/close gates, `claimed_by_other`,
`not_conformant` with `detail`, revision conflicts and optional
`claim_lamport`; U110 implements addressed `room_send`, recipient checks,
evidence records and acknowledgements. U111 tests their qualified guidance
only. Missing runtime gates or messaging implementations are not failures.

U120/U131 own acquisition and lifecycle implementation/extensions. U124
owns the integration exercise. UI changes, authentication, providers,
terminal/human-chat features, executable lifecycle hooks, hook installation,
session pins, capsule checks and benchmark budgets are outside this oracle.
TaskLight tool discovery is frozen to prevent adding tools in this unit.

This oracle is limited to `.unit/SPEC.md` and the inspected workspace surfaces.
