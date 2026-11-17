# U145 transport-parity oracle

## Binding corpus and traceability

The seed's function names, command-line flags and output format are unspecified.
The capsule recipe is executed against real transports independently of that
interface. The seed delivery assertion checks the explicitly required artifact;
it does not claim runtime validation of a future seed's unspecified interface.

The supplied `.unit/SPEC.md` ends after its operator-decisions paragraph.
Numbered acceptance cases and final Amendment sections are **AUSENTE — no inventar**.
The case IDs below are local traceability labels for every U145 MUST, oracle,
hostile input, negative control and applicable stop rule in that file. They do
not claim to quote an absent acceptance list.

The seed has no specified callable signature, command flags or result schema.
Its delivery assertion checks the required artifact; the capsule scenario is
executed independently through the shipped CLI. Runtime validation of a future
seed invocation is **AUSENTE — no inventar**. An artifact-presence assertion
alone must not be presented as validation of that future implementation.

| Case | Spec requirement | Test names in `test_scenario.py` |
| --- | --- | --- |
| A1 | Real CLI and MCP recipe; independent fresh `CW_HOME` | `test_a1_to_a5_a8_cli_recipe`, `test_a1_to_a5_a8_mcp_recipe`, `test_a1_cli_and_mcp_agree_on_fresh_independent_homes` |
| A2 | Dependency keys map to returned task IDs; work respects prerequisites | Both `test_a1_to_a5_a8_*_recipe` tests and the parity test |
| A3 | Acquisition and evidence-bearing batch reports | Both recipe tests and the parity test; verified outcomes, readable files and content hashes |
| A4 | Acquisition and report replay retain their original result and append nothing | Both recipe tests and the parity test; whole-home bytes and projections compared |
| A5 | Hook failure, independently verified release, reassignment and eventual completion | Both recipe tests and the parity test; replayed silent hook also changes no state |
| A6 | Capsule variant and required `tools/demo/seed_swarm_fixture.py` | `test_a6_capsule_recipe_five_agents_thirty_tasks`, `test_a6_capsule_seed_is_delivered` |
| A7 | Explicit mailbox stop; default slice stays held | `test_a7_default_slice_one_stops_at_agent_plan`, `test_a7_unadmitted_slice_two_stops_before_delivery` |
| A8 | Journal replay, `plan_get` and `plan_check` agree at completion | Both recipe tests, parity and capsule tests; `test_a8_a10_existing_journal_does_not_validate_forged_green_view`, `test_a8_a10_existing_journal_does_not_validate_forged_check` |
| A9 | Wrong `claim_lamport`, empty `done`, missing evidence path change no state | `test_a9_cli_wrong_claim_lamport`, `test_a9_mcp_wrong_claim_lamport`, `test_a9_cli_empty_done`, `test_a9_mcp_empty_done`, `test_a9_cli_missing_evidence_path`, `test_a9_mcp_missing_evidence_path` |
| A10 | Mock-only all-green run fails the gate | `test_a10_mock_only_all_green_receipts_fail_gate`; the forged-view/check controls prevent accepting a merely nonempty journal |

## Execution and gates

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u145 -t .
```

The real scenario gate requires persisted operations, no rejected journal
entries, exact equality between the journal fold and `plan_get`, matching
conformance from `plan_check`, completed microtasks, and evidence with verified
hashes. Its negative contrasts are successful-looking responses with no
journal, a forged projection, and a forged conformance result. They must fail
that same gate.

Hostile-report gates compare durable files and both read APIs before and after
rejection. The missing-path report includes a valid first completion followed
by an invalid later completion, so partial commit also fails. A corrected
request with the same operation identity must still succeed.

`process.py` runs the shipped `bridge.room`, `bridge.room.mcp`,
`bridge.room.hook` and `bridge.room.family` entry points in fresh subprocesses.
CLI results, MCP `content[].text`/`untrusted` results, and individual family
results are decoded according to their existing contracts. No backend,
dispatcher, persistence or projection is mocked in positive scenarios.
Clocks and entropy are deterministic; sockets and sleeps are denied; hook
alarms are replaced. Each recipe uses a finite task budget. Subprocess
timeouts are hang watchdogs, not the clock used by assertions.

All scratch homes and evidence are dynamically allocated below this test
directory and removed by cleanup. The evidence API requires absolute paths
outside the room directory; test sources contain only computed paths, never
machine-specific path literals. No provider, GUI, HTTP server, port or polling
consumer is started. Each family invocation performs one bounded drain.

## Recipe and capsule choices

The default recipe uses the specified executor/task counts and dependencies
`[[], [], [], [k1,k2], [k3,k4], [k5]]`. It maps returned IDs rather than assuming
task numbering. The third executor fails while owning unfinished work; a
surviving executor reacquires it. Completed tasks are never released.
Each report contains all acquired unfinished microtasks and real evidence.
Survivors finish through the hook; the failed executor remains Failed.

The capsule test runs the specified larger agent/task counts against a shipped
template with enough declared capacity. `blank` cannot hold that variant while
passing `plan_check`. Additional tasks form a bounded continuation of the
default dependency graph, assigned among surviving executors. Selection uses
the existing template contract, without editing templates or relaxing
conformance.

The seed's command-line flags, return shape and exported function names are
**AUSENTE — no inventar**. The delivery gate therefore asserts the explicitly
required seed file exists before attempting any import. The capsule recipe
itself is executed against the real backend in the separate capsule test.
This deliberately does not certify the seed's unspecified invocation interface:
file presence alone is insufficient to establish its runtime behavior. A
future seed adapter requires the author's documented public invocation; no
invented API is pinned here. No production stub is created by this oracle.

## Mailbox stop point and out-of-scope cases

After separate `agent.deployed` requests for the default executors have real
successful receipts, the first required planning delivery, `agent.plan`,
returns `bad_args` under default `slice:1`. `agent.activity`, `work.acquire`
and `work.report` are also held and append no room events. Drain success alone
does not turn these rejections into success. `slice:2` stops before delivery
with `planning delivery awaits atomic backend generation fencing`.
No CLI mutations are mixed into this mailbox scenario, and no all-mailbox
parity or production admission is claimed.

| Adjacent unit or constraint | Treatment |
| --- | --- |
| U139 lifecycle throttle-window crash recovery | Out of scope; no clock-window recovery claim |
| U140 atomic generation fencing | Out of scope; held mailbox boundary is preserved |
| U141 cleanup parity across every terminal transport | Out of scope; only the specified real hook failure is exercised |
| U142 terminal-slug work refusal and mismatched run identity | Out of scope; failed executors receive no new work, harness-recorded run IDs are reused |
| U143 enabling mailbox planning/work kinds | Out of scope; stop at the held boundary, no admission bypass |
| U144 public documentation and prompts | Out of scope; no shared documentation is edited |
| U155 persona and rendered capsule assessment | Out of scope; the larger fixture recipe is verified without a GUI or persona score |
| `src/app/swarm_vm.ts` / `deriveSwarmViewModel` | Read-only constraint preserved; no frontend edits |

No product file, shared test file, template, admission state, commit, push or
deployment is changed. The mandate is limited to the supplied U145 spec and
the existing transport contracts inspected in this isolated project copy.

## Verification

Discovery command, from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u145 -t .
```

Result: **16 tests, 15 green, 1 red [MEASURED]**. Exact runner summary [MEASURED]:

```text
Ran 16 tests in 72.213s

FAILED (failures=1)
```

The sole red case is `test_a6_capsule_seed_is_delivered`: an assertion that
`tools/demo/seed_swarm_fixture.py` exists. It is currently missing. There are no
import failures. Both real transports, the capsule recipe, hostile inputs,
negative controls and held mailbox boundaries pass [MEASURED].

Existing regression modules `bridge.tests.room.test_cli`,
`bridge.tests.room.test_mcp` and `bridge.tests.room.test_hook` pass:
**37 tests [MEASURED]**, summary `OK`. Interpreter bytecode generation was
disabled, and temporary output was directed beneath this oracle directory.
This is a targeted regression result, not a claim that every repository suite
was run.
