# U63 fail-first oracle

This oracle covers the supplied SPEC_U63 and its final binding Amendment W0-R.
All paths below are relative to the repository root. Production functions are
deliberate stubs throwing "U63 stub"; types, limits, schema data and barrel exports
are declarative contracts. A passing static/schema-contract test is expected.
No network or physical device is used. Timers and ports are injected fakes.

## Numbered acceptance cases

Parameterized titles expand separately for task_review and plan_brief.

| Case | Test file | Test names |
|---|---|---|
| P1 | tests/unit/u63/prompt.test.ts | P1 retains identity and urgent items at maximum legal sizes; P1 caps microtasks before packing; P1 W0-R20 final reduction handles all non-pending items and escaping; P1 reductions remove memory before sacrificing microtask outcomes; P1 small memory survives without mutating caller data |
| P2 | tests/unit/u63/prompt.test.ts | P2 excludes surplus prose and preserves exact progress; P2 reduces long slices without changing exact counts; P2 W0-R8 dependency-ready blocked tasks keep exact ready counts |
| P3 | tests/unit/u63/prompt.test.ts | P3 replaces every ASCII control, collapses whitespace and caps text; P3 W0-R20 task/brief fences injection and escapes closing markers |
| R1(a) | tests/unit/u63/rules.test.ts | R1 blocked microtask; R1 blocked task; R1 blocked precedes cancelled |
| R1(b) | tests/unit/u63/rules.test.ts | R1 empty microtasks; R1 cancelled precedes empty |
| R1(c) | tests/unit/u63/rules.test.ts | R1 missing outcome; R1 whitespace outcome |
| R1(d) | tests/unit/u63/rules.test.ts | R1 all done |
| R1(e) | tests/unit/u63/rules.test.ts | R1 in progress; R1 all-done and in-progress reasons distinguish progress |
| R2(a) | tests/unit/u63/rules.test.ts | R2 active brief is bounded and deterministic; R2 ready brief is bounded and deterministic |
| R2(b) | tests/unit/u63/rules.test.ts | R2 closed brief is bounded and deterministic |
| R2(c) | tests/unit/u63/rules.test.ts | All R2 tests, including R2 empty brief is bounded and deterministic; R2 hostile titles and long blockers preserve single-line bound |
| V1 | tests/unit/u63/reviewer.test.ts | V1 private rejects source ... and forces device mode; V1 private device response is accepted; V1 W0-R20 raw port emits nothing for ... |
| V2 | tests/unit/u63/reviewer.test.ts | V2 kill switch rejects ...; V2 ... defaults or clamps external permission |
| V3 | tests/unit/u63/reviewer.test.ts | V3 explicit grant preserves source ... verbatim; V3 standard raw port accepts ...; V3 rejects unknown source even with external grant |
| V4 | tests/unit/u63/reviewer.test.ts | V4 malformed response ... falls back |
| V5 | tests/unit/u63/reviewer.test.ts | V5 invalid resolver ... emits nothing; V5 sync/async port failure returns rules and retries; V5 timeout ... defaults to bounded clock and retries; V5 positive custom timeout is honored; V5 caller abort preAborted=... is immediate; V5 malformed task/plan ... never throws; V5 malformed port result ... never rejects; V5 hostile getters and cyclic malformed inputs settle safely |
| V6 | tests/unit/u63/reviewer.test.ts | V6 serialises review and brief jobs across one instance; V6 ... privacy isolates successful standard result; V6 optional memo stays within its advertised bound |
| V7 | tests/unit/u63/reviewer.test.ts; tests/unit/u63/static.test.ts | V7 injected clock exclusively owns timers and success cleanup; V7 static direct timers have a single fallback construction |

## Behaviour rule traceability

| Spec rule | Coverage |
|---|---|
| 4.1 privacy and mode | V1, V2, V6 |
| 4.2 source truth | V1, V2, V3 |
| 4.3 no emission without capable resolver | V1 raw-port gate, V5 invalid resolver |
| 4.4 budget and reduction | P1 |
| 4.5 rollup-only brief | P2 |
| 4.6 sanitization and fencing | P3 |
| 4.7 strict parsing | S1 schemas match the supported contract; S2 task/brief rejects ...; S3 task/brief cleans controls and truncates valid long output; S4 accepts verdict ...; S4 rejects unknown verdict; S4 accepts nonempty brief (tests/unit/u63/schema.test.ts); V4 |
| 4.8 deterministic rules | R1, R2 |
| 4.9 serialisation, config, abort, clock | V5, V6, V7 |
| 4.10 optional bounded privacy-safe memo | V6; V5 transient retry cases |

## Binding amendment traceability and scope

| W0-R row | Disposition |
|---|---|
| 1 | Supplied specifications are not declared absent. Their implementation receipts remain unverified. |
| 2 | Out of scope: U55–U61 operation kinds and op_id validation. |
| 3 | Out of scope: U55–U57/U60 micro.set, evidence and MCP mapping. |
| 4 | Out of scope: U55/U57/U60 task mutations and assignment. |
| 5 | Out of scope: U55–U57/U60 revision checks. |
| 6 | Out of scope: U55–U57/U60 revision advancement and last_lamport. |
| 7 | Out of scope: U55/U60 canonical persistence projection. U63 consumes structural inputs. |
| 8 | P2 preserves readiness counts independently of blocked state. Persistence, memory lifecycle, reopening and Agenda eligibility belong to U55/U60–U62. |
| 9 | Out of scope: U55/U60/U61 identifier allocation and event ordering. Fixture identifiers use canonical forms where applicable. |
| 10 | Out of scope: U55–U57/U60 ingestion idempotency and replay-map keys. |
| 11 | Out of scope: U55–U57/U60 takeover and room activity. |
| 12 | Out of scope: U55 operation byte caps and error codes. |
| 13 | Out of scope: U55/U60 event validation and cross-language parity. U63 malformed-input safety is covered independently by V5. |
| 14 | Out of scope: U55–U57/U60 templates, hashes and conformance. |
| 15 | Out of scope: U55-owned fixtures/plan/templates.v1.json and fixtures/plan/vectors.v1.json; U60 parity. |
| 16 | Out of scope: U56 post_ops atomic batch API in bridge/room/store.py. |
| 17 | Out of scope: U57 MCP resource discovery, wrappers and errors. |
| 18 | Out of scope: U58 redaction, paging and cursor rules. |
| 19 | Canonical state maps to U63 status at the U61/U64 integration boundary. PlanVM, MemoryVM, DiaryEntryVM, TaskVM.nanoVerdict, WallVM.plan/diary/memory and PlanVerdictVM belong to U62. Nested tasks[].microtasks is represented directly by the structural task fixture. No unspecified adapter export is invented. |
| 20 | P1 final reductions, P3 delimiter escaping, V1 pre-invocation privacy gate, V2 raw-port external default and V3 explicit external grants. |

The final SPEC_U63 amendment requests canonical-projection adapters but supplies
no names, signatures or complete adapter input contract. Executable adapter tests
are deferred until that API is frozen; this is a contract gap, not a failed test.
U61/U64 integration and ModelServices.driftPortFor wiring, U67 generation, template
conformance, Firebase persistence, views, multi-turn chat and physical Nano/W4
latency or quality are outside this oracle. No implementation or device receipt
is asserted.

## Ambiguities resolved

- W0-R20 overrides raw-port private/kill-switch acceptance: privacy_blocked before
  generate. The same fail-closed gate applies to an explicit ONLY_ON_DEVICE floor.
- Standard raw ports default to allowExternal=false. Explicit bindings grant
  local/remote; device/cloud keep their reported source.
- Synchronous generate throws and asynchronous rejections are port_error;
  only an unresolved call reaching its deadline is timeout. Resolver failures
  are no_port. This follows the reason-code contract rather than conflating
  the three branches in V5's prose.
- Memoisation is optional. Tests require isolation, bounded storage if used,
  and retry after timeout, aborted and port_error; they do not require cache hits.
- Packer container layout, exact rules wording, optional field minima and escape
  spelling remain implementation choices. Tests inspect semantic records and
  parseable fenced JSON rather than snapshots.
- ASCII output controls become spaces; overlength valid responses are accepted
  with a 160-character result ending in "...". Extra output keys are not rejected
  because the spec does not require additionalProperties=false.
- Budget order is tested observationally: memory is gone if outcome detail is
  sacrificed; urgent items survive the specified maximum-size mixed fixture.
  Final fallback may shrink optional fields enough to retain all non-pending
  items, so omissions are checked when present rather than forced unnecessarily.
- Static clock inspection bounds native calls to one fallback construction per
  timer kind in the same file. Type-only method signatures are excluded; runtime
  tests additionally prohibit native timer access with an injected clock and
  prohibit Date.now. No compiler API dependency is assumed.
