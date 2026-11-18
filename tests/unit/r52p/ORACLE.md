# R52P fail-first oracle

`.unit/SPEC.md` has an acceptance row and a Performance admission section. The IDs below identify the cases in those sections. The checkout contains no numbered case list or Amendment section.

| Case | Test in `burst_projection.test.ts` | Assertion |
|---|---|---|
| P1 | `P1 first ordered burst read matches cold full replay` | Prime the seed, ingest the bounded burst, then compare the first `plan(room)` result to a cold `foldPlan` of the complete fixture. Compare projection, invalid and rejected counts, diagnostics, canonical memory history and resolved template. An accepted envelope with a stale operation leaves a rejection receipt and cannot overwrite memory. |
| P2 | `P2 late and reversed arrivals repair the first projection` | Warm the intermediate result in reverse order with a missing predecessor. The first read after the late arrival restores the expected revisions, rejection receipts and history. |
| P3 | `P3 duplicate payloads and malformed envelopes cannot change replay` | An exact duplicate, a conflicting duplicate and an invalid room envelope leave the first admitted payload and room cursor intact. |
| P4 | `P4 replacing a template at the same identity refreshes projection and diagnostics` | Substitute the resolver result at the opening's fixed ID and hash with no event change. A tighter memory constraint changes display values and diagnostics. Canonical history continues to reflect committed memory operations. |
| P5 | `P5 editing a returned projection does not change later reads` | Attempt edits to nested memory, history, diagnostics and template fields. Each later read must match independent replay. The existing read contract allows an immutable copy. |
| P6 | `P6 the first projection meets the burst performance gate` | Assert correctness, freshness and fixture identity before consulting timings. Check median projection ≤40 ms, ingestion ≤4.0 ms and Node peak RSS ≤157 MiB [TARGET]. Candidate admission additionally requires contemporaneous pairs with matched runtimes and scratch storage and a projection median ≤80% of control [TARGET]. |

The reference for P1 through P5 uses fixture inputs directly and never builds expected state using `AgentStore`. The memory versions are hand-derived. The tests exercise the view after bounded retention without asserting cache layout or reducer call counts. The fixture and event timestamps are fixed. Vitest reads already collected measurements for P6.

## Frozen pre-author evidence

Frozen test SHA-256 [MEASURED] `7d2fca4009a0318ecab3a8dfcf51645acbb69735b6acab7fbb6eab9ce87bc350`.

`baseline.json` records five fresh Python and Node runs [MEASURED] of `bridge/tests/bench/adapters.py::typescript` with `bridge/tests/bench/fixtures.py::client_fixture` using `mixed()` and `burst`. The seed and stream identity, equality with the benchmark fixture's expected projection and projection freshness were verified before recording each sample. The scratch directory was on the same disk for all samples. The median was 52.009004 ms for the first `plan(room)` read, 4.353827 ms for ingestion and 149,127,168 bytes for Node peak RSS [MEASURED]. P6 stops on the missed projection ceiling. The earlier 51.913678 ms series [CITED] supplies context only. Browser paint latency is AUSENTE.

Diagnostic profiling on the same pinned fixture started immediately before `tests/bench/adapter.ts` called `plan(room)` after the burst and stopped on return. Of 175 CPU samples, 137 had `foldPlan` on their stack, 3 were in `retainedMemoryHistory`, 28 were attributed to other projection work and 7 were outside attributed projection frames [MEASURED]. A separate instrumented read measured 0.535 ms in array sorts, including 0.351 ms in the two sorts using `compareEvents`, and 0.098 ms in the two store-level structured clones [MEASURED]. These diagnostic runs used instrumentation and are excluded from performance admission.

## Candidate evidence

Run from the candidate root using a pinned control checkout, an existing scratch directory and an output path chosen for the report.

```sh
python3 -B tests/unit/r52p/measure_burst.py \
  --control "$CONTROL_ROOT" --candidate . --scratch "$BURST_SCRATCH" > "$BURST_REPORT"
R52P_BURST_EVIDENCE="$BURST_REPORT" npx vitest run tests/unit/r52p
```

The runner alternates five adjacent pairs [TARGET], invokes the existing benchmark in fresh processes, records raw values and rejects missing or invalid evidence. The gate binds the candidate observations to the current `src/app/agent_store.ts` digest. Without a paired report, the frozen pre-author evidence exercises the known failure. Use the paired evidence for the wave-exit unit run that includes this gate.

The real browser, relay delivery, waiter and the G, S, W, H, D and A acceptance cases are outside the R52P oracle. The common wave-exit gate and cross-family ADMIT belong to integration.
