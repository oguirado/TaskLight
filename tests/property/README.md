# U116 semantic history gate

The independent property project requires the repository's existing Node dependencies
and Python standard library. It makes no provider, model, capsule or network calls.
All runtime state, disposable journals and evidence stay in the property directories.
The root configurations, production code and other tests are never rewritten.

Run the independently discoverable suites:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s bridge/tests/property -t .
PYTHONDONTWRITEBYTECODE=1 npx vitest run --config tests/property/vitest.config.ts --no-cache
```

Run the hardening gate and resource receipt:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m bridge.tests.property.run --stage all --seeds 100 --steps 128
```

Use `--stage baseline` for compatibility alone, or `--stage gates` for the
fail-first U109 protocol contract. Available stage names are `baseline`, `gates`,
`cache` and `lifecycle`. Missing required stages report `BLOCKED` with a reason;
they never become a silent unittest skip or a full acceptance pass. The runner
returns a correctness failure for `BLOCK`, and a distinct incomplete-evidence
result for `INCONCLUSIVE`. Existing unrelated unit failures are not excused by this gate.

## Oracles and reproducibility

`vectors.baseline.json` copies the pre-existing independently authored plan
vectors without recalculating expectations, then adds explicitly authored tie
boundaries. Both adapters receive each vector's same single normalized template.
There is no invented TypeScript multi-template registry. Each complete projection
is compared, including archives, replay receipts, rejection records, revisions and
watermarks. Generated prefixes are compared directly as parsed JSON values and
checked against independently written state, dependency, identity, revision,
rollup, memory and rejection-order invariants. Only object-key order is ignored;
array order, explicit nulls, and missing fields remain observable. Both inputs
are checked for mutation; TypeScript statistics are asserted separately.

The named mandatory baseline transitions are enumerated in
`bridge/tests/property/support.py:MANDATORY`; each has a semantic witness in
`test_semantics.py`, and unvisited transitions fail. The seeded tail includes
arrival reordering, identical duplicates, competing claims, releases, microtask
states, retries, memory and activity. Conflicting same-event-ID payloads are
explicitly outside permutation invariance. The `agent.lifecycle` alphabet entry
is reserved now and produces a baseline rejection, never a simulated deployment.
Repeated seeds reproduce histories and hashes without sleeps or wall-clock input.

`artifacts/report.json` records fixture/template and source hashes, the new-file
candidate-diff digest, seed list, generator version, selected stage, transition
coverage, mutation counts, wall time, child peak RSS and load. Revision metadata
is explicitly absent in a project copy without Git metadata. The cited baseline
revision is not represented as a measured candidate revision. Raw command output
is not persisted. Source paths in evidence are repository-relative.

The runner executes functional checks under load but starts no timing benchmark.
Resource observations at load5 >= 18 are `INCONCLUSIVE`; no runtime budget is
invented. The larger performance workloads remain owned by U115.

## Discriminating controls and storage

The literal specification boundary uses `e-b` before `e-a`. It deliberately
retains those IDs and its explicit `T01` expectation. A separate canonical-ID tie
boundary validates tie ordering without conflating it with event-ID validation.
A baseline rejection of the literal IDs is a reported semantic divergence;
expectations are never weakened to obtain a green suite.

Negative controls cover shared corruption of both adapters, Python and TypeScript
ID-order mutations, a skipped real fsync, an ignored ownership check, stale cached
views, and permissive gate replies. Each mandatory mutation requires an applied
patch/seam, an activation witness, and an independent semantic assertion failure.
`mutants.json` binds targets to source hashes. Missing targets have null counts;
patch misses, imports, timeouts and runner failures cannot increase detections.
The tie mutant first proves the canonical unmutated implementation passes.

The deletion/field-simplification shrinker preserves a witnessed failure and the
ownership claim/conflicting-writer prerequisites. Its planted-failure receipt
contains both histories and the first differing JSON path. Differential failures
also emit original/minimized histories and a path; reduction is deterministic.

Storage tests set temporary `CW_HOME`, inspect actual journal bytes, restart via
the real CLI, retry an identical identity, exercise conflicting op-id reuse,
parse torn tails and malformed complete lines, inject write/flush failures,
and assert write-before-fsync-before-success. The exact CAP boundary and hostile
prototype/reason inputs are covered. These are acknowledgment-order properties,
not a power-loss durability experiment.

## Contract stages

The shared vectors now use legitimate U109 event sequences; pre-U109 permissive
expectations are historical compatibility data, not the current gate oracle. `contracts.GateContracts` invokes the real `bridge/room/mcp.py` handler,
`python3 -m bridge.room`, and shared `bridge/room/app.py` dispatch. Domain errors
must agree, have nonempty detail and leave bytes unchanged. The U109 contract
checks ownership, dependency activation/completion, optional claim fences,
release/reset and cancellation/closure independently of lifecycle.

Cache semantic controls compare both store views to full refolds after every
ingestion, an earlier event and changed resolver content; each stale-view control
must first prove the expected result changes. A production invalidation target is
absent at baseline, so its mutant and U113 stage remain `BLOCKED`.

`contracts.json` records U132's required interface, states, injected millisecond
clock offsets for alive throttling, retention/interleaving matrix and hostile
controls. Its frozen projection shape, confirmed implementation anchors and
reviewed fixture hash are explicitly null. U132 lifecycle execution and an actual
ignore-lifecycle mutant remain `BLOCKED` until those reviewed bindings exist.
Text heartbeats never stand in for harness lifecycle facts. Updating a contract
requires explicitly reviewed frozen expectations and fixture/source rebindings;
no runner generates expectations from a candidate fold.

## Acceptance evidence map

| Acceptance | Executable evidence | Limit |
|---|---|---|
| A1 | `FrozenVectors`, shared-corruption controls, seed/hash checks, TypeScript shared vector test | Expectations are frozen separately from the folds. |
| A2 | Literal and canonical tie vectors, duplicate probes, both ID-order mutants | The literal-ID TypeScript discrepancy blocks acceptance. |
| A3 | `StorageProperties` lost reply/restart test; generated takeover boundary witnesses | Real CLI restart, deterministic event clocks. |
| A4 | Torn-tail/malformed-byte storage test; hostile Lamport/prototype tests | Torn final lines add no events. |
| A5 | `contracts.GateContracts` plus distinct baseline vectors | U109 is integrated; the gate contract runs through all transport adapters. |
| A6 | Reserved generator alphabet and explicit lifecycle contract matrix | U132 implementation, anchors and frozen shape are absent; BLOCKED. |
| A7 | Late-ingestion/resolver store-view test and stale-view negative controls | U113 invalidation target is absent; BLOCKED. |
| A8 | Ownership shrink control, hash-bound mutation receipts, infrastructure classifier controls | Infrastructure failures remain separate from semantic detections. |

## U116r1 refresh: integrated U109

Frozen expectations remain explicitly authored and are never regenerated from a
candidate fold. The reviewed changes are:

| Vector / control | Change | Binding requirement |
|---|---|---|
| `plan_close` | The owner explicitly cancels `T01` at its current task revision before closing. The frozen task is cancelled, never done; readiness and blocked counts clear, microtask results and memory remain, and the close revision, timestamp and watermark advance. | U109 MUST M6: every task must be done or explicitly cancelled before close; M7: no rejection appended. |
| `reopen_preserves_memory` | Uses the same cancellation before close, followed by reopen; archive close time and reopen revision, timestamp and watermark advance while memory and its revision remain unchanged. | U109 MUST M6 and M7; reopening resets plan tasks while preserving memory. |
| Other frozen vectors and generated activation spine | Reviewed for shortcuts; successful microtask writes already have an earlier owner claim, and generated dependent activation follows prerequisite cancellation. No other frozen vector needed amendment. | U109 MUST M3: assignee-only writes and satisfied dependencies before active/done. |
| `ignore-ownership-control` | Match the current foreign-owner check immediately before optional claim fencing, exactly once, in a disposable module. Preserve the unassigned, fencing and dependency checks. The conflicting writer must activate the seam, change a microtask, and fail an independent ownership assertion; shrinking retains claim/writer prerequisites. | U109 MUST M3 and M8: ownership gate and semantic negative control. |

`fixture-hashes.json`, `source-baseline.json` and `mutants.json` bind this refresh
to the supplied integrated candidate. Previous changed source hashes remain in
`source-baseline.json` as historical provenance; the current bindings do not claim
that this candidate is I0 or that old unit-suite results were rerun. Source bindings
are frozen before verification, and production files remain read-only.

The `literal_equal_lamport_reverse_id` vector deliberately retains literal `e-b`
then `e-a` and its independent `T01` expectation. Python accepts these IDs;
TypeScript rejects both as `bad_op`. This remains a correctness finding, not an
expected failure or skip. The separate canonical-ID vector continues to exercise
ID ordering and both tie mutants. Full acceptance remains blocked by the literal-ID
finding, and cache/lifecycle contract bindings remain explicitly `BLOCKED`.
