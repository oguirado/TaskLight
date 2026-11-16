# U10 oracle (reconciler, keyed queue, admission)

Runner: vitest 5 + jsdom. Injected `FakeClock` (manual `advance`, `setTimer`), `FakeInfer` (deferred), `FakeStore` (records every CAS), `FakeLedger`; `requestAnimationFrame` is stubbed with a spy. Only the public API is used (`createReconciler`, `jobKeyId`, `slotId`, `Reconciler` methods). Helpers in `harness.ts`.

## Case to rule to test

| Case | Rule | File / test |
|---|---|---|
| O1 | B1 | jobKey.test.ts (delimiter collisions, per-field variation, slotId) |
| O2 | B3, B9 | queue.test.ts "O2" (calls == [1, 11], pending <= 1, rAF 0) |
| B2 | B2 | queue.test.ts (lower/equal no-op, TypeError on -1, 1.5, NaN) |
| O3 | B4, B5 | queue.test.ts "O3" |
| O4 | B4 | queue.test.ts "O4" (REFUSE queue_full, refusals=1; coalescing never refuses; bound = factor x N) |
| FIFO | B9 | queue.test.ts "B9" |
| unknown / dispose / error | B17, section 4 | queue.test.ts |
| O5 | B6 | admission.test.ts (retryAt 20000; no call at 19999; call at 20000) |
| O6 | B5, B7 | admission.test.ts (cloud 2, on-device 1, hot swap) |
| O7 | B7, B8 | admission.test.ts (downloading to cloud; device_not_ready; re-admit) |
| O12 | B10 | admission.test.ts |
| O13 | B11 | admission.test.ts |
| O8 | B12.1 | effect.test.ts |
| O9 | B12.3 | effect.test.ts |
| O10 | B13 | effect.test.ts (3,rev4 false then 4,rev5 true; two attempts max; retry re-checks) |
| O11 | B12.4 | effect.test.ts (reject vs ok on same flow) |
| O14 | B14 | effect.test.ts |
| O15 | B12.2, B15 | effect.test.ts (prompt swap, templateHash, stale badge) |
| Timeout | B16 | effect.test.ts (abort at 60000, slot released, late resolve ignored) |

Negative cases (O8, O9, O11, O13, timeout) each have a positive control in the same file so a stub that never publishes cannot pass them vacuously.

## Red counts

Against the stub (admit everything, no inference, no publish; `jobKeyId` = naive `|` join): 43 red / 46 total (3 pass). The 3 passing are legitimate controls: identical tuples equal ids, per-field variation distinct, slotId distinctness. The crafted-collision O1 test is red (stub is not injective).

`npx tsc --noEmit -p .`: exit 0.

## Ambiguities resolved

- Dispatch timing: spec says dispatch "only through clock.setTimer". Tests call `clock.advance(0)` after `observe` before expecting an infer call, so both synchronous and zero-delay timer dispatch pass.
- O4 (corrected in repair loop 1): B4 counts PENDING jobs only; the in-flight job does not occupy a queue slot. With N=1 the 3rd distinct pending slot (4th slot overall, 1 in flight) is refused.
- O3: expects pending distinct per slot and each pending revision = 10; pending >= 4 (4 other projects waiting; P1 coalescing placement is not over-specified).
- O9 and O15 seed the store with `observed_rev` <= `source_observed_rev`; initial slot observed_rev from the store is AUSENTE, so tests avoid depending on it.
- O10 re-read: the second CAS is `(4, rev 5)`, taking the re-read store rev (B13).
- B12.2 template mismatch: only asserts the old result is not published (re-enqueue after hash change is not asserted beyond that).
- Freshness with no registration data: `stale` (B15 "no publication exists").
- Published `observed_rev` and `inference_source` for IN_CLOUD paths are only asserted for `source_observed_rev`, `incarnation`, `inference_source`, `updated_at`, `patch`; `observed_rev` value is AUSENTE.
- `CapsulePatch` declared locally as `Readonly<Record<string, unknown>>` (U05 names AUSENTE).
- Spec lists `src/reconcile/__tests__/*` as exclusive files; tests live in `tests/unit/u10/` per the vitest include glob.

## Repair loop 1

Source: cross-family review (HOLD). Real implementation = build/U10; all new/corrected cases red there, stub red in repo.

| Case | Review item | Spec rule | File |
|---|---|---|---|
| O4 corrected (pending-only bound) | Premature queue refusal; oracle gaming | B4 | queue.test.ts |
| B2 equal rev + different templateHash is no-op | Equal revisions mutate metadata | B2 | queue.test.ts |
| templateHash test now uses rev 2 (equal rev would be a no-op) | Oracle contradiction with B2 | B2, B12.2 | effect.test.ts |
| R1 lost latest revision on refresh | B3/B12.2 | B3, B12.2 | regress.test.ts |
| R2 kill switch at dispatch (PREFER_IN_CLOUD, ONLY_IN_CLOUD) | B10 | B10 | regress.test.ts |
| R3 revision 0 starts | B2 revision-zero loss | B2 | regress.test.ts |
| R4 retry after rejection; REFUSE repeats truthfully | Retry loss / hardcoded ADMIT | B2, B6, section 4 | regress.test.ts |
| R5 FIFO by snapshot enqueuedAt after replacement; arrival tie-break | B9 | B9 | regress.test.ts |
| R6 sync throw from run | Escaping exception | section 4, B16 | regress.test.ts |

Red counts: build/U10 impl 10 red / 56 total (46 pass: all untouched valid tests plus the corrected effect template test). Repo stub: 53 red / 56 total (3 legitimate jobKey controls pass). tsc errors seen are only in other units (u08).

Rejected / adjusted review items: none rejected. Notes: spec does not say whether replacement refreshes enqueuedAt, so R5 asserts only dispatch order == snapshot enqueuedAt order (either policy passes); the equal-enqueuedAt tie-break is asserted as arrival order (spec silent, deterministic choice). R4 asserts THROTTLE interval (retryAt 20000) because B6 applies to the re-admitted start; B2 "equal is no-op" is read as returning current admission, while section 4 ("next observe re-admits") governs a revision whose inference failed.

## Repair loop 2

Added `repair2.test.ts` (public API + injected FakeClock only). Against current impl: 7 red new / 56 existing green.

| Case | Review finding | Spec rule |
|---|---|---|
| RP1a/b kill-switch flip and device-state flip rewrite a pending job's mode/lane in the same pass that dispatches it; job must leave pending and run exactly once (cloud lane full, P3 waits, flip, advance, resolve all, advance 120 s, calls stay 3) | pending identity lost on reroute | B3, B9, B10 |
| RP2 prompt_version refresh while pending is full: pending <= bound at every step | enqueueFresh bypasses bound | B4 |
| RP3a/b unregisterProject / lowering queue_max_depth_factor: pending <= reported bound immediately | no overflow policy on shrink | B4 |
| RP4 dispose cancels no handle whose timer already fired (counting wrapper on clock) | timeout handles retained | B16 |
| RP5 60 coalesced revisions: outstanding timers <= 3, setTimer calls <= 5 | one timer per observe | B3, B9 |

Rejected / adjusted items: none rejected outright. Deviations: (a) RP1 is deliberately constructed so the rewrite and dispatch occur in one scheduler pass; the review's narrower sequence (kill switch flip then advance past the interval) passes on the implementation because an earlier zero-delay pass already commits the rewrite. (b) Spec is silent on WHICH pending jobs are evicted on shrink, so RP3 asserts only the bound invariant, not victim choice. (c) Spec is silent on deferred refresh intent when full, so RP2 asserts the bound only, not that the refresh is retained. (d) Review's "timeout cancellation handles remain in timers" is not observable via pending-timer count (fired timers leave FakeClock); RP4 observes it through stale cancel calls on dispose. Thresholds in RP5 (<=3 timers, <=5 allocations) are test choices, not spec values.

## Repair loop 3

Added `repair3.test.ts` (public API + FakeClock only). Against current impl: 6 red new / 63 existing green.

| Case | Review finding | Spec rule |
|---|---|---|
| R3-1a/b cloud job in flight, newer revision observed as `private`, IN_CLOUD outcome resolved: nothing IN_CLOUD published, `in_cloud` ledger 0 | B11 uses historical job.tier | B11 |
| R3-2a queue_full refusal, queue drains, same-revision event repeated: not REFUSE, later runs | refused revision stranded | B2, B4, section 4 |
| R3-2b kill_switch_cloud refusal, switch cleared, same-revision event repeated: admitted and dispatched | same | B2, B10 |
| R3-3 start at 0, rev 2 throttled to 20000, at 1000 interval lowered to 5000: dispatch at exactly 5000 | obsolete interval timer | B6 |
| R3-4 prompt_version bump with pending full, no new observations: status eventually runs on v2 (pending <= bound throughout) | deferred refresh lost | B4, B12.2 |

Not covered (spec silent or not observable via public API): lifecycle metadata growth (lastStart on unregister/dispose). Thresholds (12 rounds of 20 s in R3-4) are test choices.

## Repair r6
Source: cross-family review r5 (HOLD). New file: `repair_r6.test.ts` (public API + FakeClock only). Against current impl: 17 red new / 91 existing green; tsc clean for the file.
| Finding | Disposition | Tests |
|---|---|---|
| Work of an unregistered project publishes / recreates a job | Accepted | R6-1: outstanding inference resolved after `unregisterProject` publishes nothing; same with `prompt_version` bump (no new P1 job, no pending P1); control for a registered project |
| `inference_timeout_ms` unvalidated (NaN/negative/zero/Infinity/undefined/string); lane stuck forever | Accepted | R6-2: `createReconciler` and `updateConfig` throw for 7 invalid values; rejected `updateConfig` leaves previous config (60000 timeout still aborts and releases lane); valid-timeout control |
| Throwing validator escapes the continuation, strands revision | Accepted | R6-3: no `unhandledRejection`; lane released; repeating the same observation dispatches again and publishes |
Note: spec lists `inference_timeout_ms` as required with value AUSENTE; "throws on invalid" is the review's fix 2 (spec does not name the error channel). Zero is treated as invalid (non-positive).

## Repair r7 (fault injection)
Source: cross-family review r6 (HOLD: stall after `unregisterProject` of another project; throwing publication ports escape the outcome continuation) plus the standing request to enumerate escaping-exception paths systematically. New file: `fault_injection.test.ts` (public API + harness fakes; no impl access). Against current impl: 937 red new of 1505 new / 108 existing green; tsc clean for the file.
Method: every injected port method (`infer.run`, `validator.validate`, `store.read`, `store.currentIncarnation`, `store.compareAndPublish`, `clock.now`, `clock.setTimer`, `ledger.inc`) is wrapped in a counting Proxy. Eleven scenarios (cycle, CAS conflict, cloud fallback, cloud only, schema reject, device gate, refusal at dispatch, refusal at observe, timeout, unregister-other, dispose) are first run clean to enumerate every call site (port, nth call, step; counter/task as argument). One row is generated per site x fault kind (max 4 sites per port/step/argument group: first, second, middle, last) and the fault fires once. Kinds: sync throw, hostile thrown object, getter throw at access, rejected promise (plain and hostile), never-settling promise, `run` returning undefined or a thenable with a throwing `then`, inference resolving undefined or an object with a throwing `raw`, validator returning undefined or throwing `ok`/`patch` getters, hostile capsule from `store.read`, `setTimer` cancel handle that throws or is not a function.
| Block | Rows | Red |
|---|---|---|
| FI-0 clean baselines (11 scenarios) | 11 | 0 |
| FI-1 matrix (scenario x call site x kind) | 1381 | 898 |
| FI-2 REVIEW BLOCKING 1: unregister another project while a pending job waits behind a full lane (on_device, cloud, bound variants, queued-only variant), time-only wake-up | 4 | 4 |
| FI-3 REVIEW BLOCKING 2: throwing `ledger.inc`, `store.read`, `store.currentIncarnation`, `store.compareAndPublish` (throw, hostile, getter) while a valid job resolves, plus the review's exact `ledger.inc` input | 13 | 13 |
| FI-4 `freshness()` with failing `store.read` (throw, hostile, getter, hostile capsule; seeded and unseeded) | 8 | 8 |
| FI-5 ObservedEvent accessors: Nth read of each field throws (new and coalescing observe) | 39 | 0 |
| FI-6 ReconcileConfig accessors: poisoned after `createReconciler`, after `updateConfig`, and thrown at read #1/#2 during `updateConfig` | 44 | 14 |
| FI-7 hostile projectId objects | 4 | 0 |
| FI-8 census | 1 | 0 |
Invariants per row (listed as a violation list so a failure names every broken one): V1 no unhandled rejection; V2 no exception escapes a clock-timer callback; V3 a public call may only propagate the injected error, never an internal TypeError; V4 no lane or slot leaked after all work drains; V5 other project's job starts and no pending work is stranded while only time passes (not asserted for clock faults, where no wake-up mechanism remains); V6 retry intent for the faulted project (same-revision observe re-admits and publishes P1@1); V7 probe: a fresh project and a newer revision of the faulted project dispatch and publish. Dispose rows assert B17: in-flight aborted, REFUSE disposed, no publish or ledger effect after dispose, no timers left (except `cancel_nonfn`).
Defects exposed (all reds): (1) `unregisterProject` frees a lane without `scheduleDispatch` (review 1); (2) exceptions from `ledger.inc`, `store.*`, `clock.now`/`setTimer`, a bad validator return, or a malformed inference result escape the `outcome.then` continuation as unhandled rejections and drop retry intent; (3) `tryDispatch` aborts its loop when the refusals ledger call or `infer.run` shape handling throws, stranding later pending jobs; (4) `startJob` leaks the in-flight entry when `clock.setTimer` throws, when the cancel handle throws or is not a function (also in `removeInFlight`, `unregisterProject`, `dispose`, which then also skips aborting later in-flight jobs); (5) `freshness` propagates store failures; (6) config read live from the caller's object, so a later poisoned accessor wedges dispatch and timers.
Stances taken (not explicit spec text): (a) a public sync call may propagate the injected port error but nothing else (spec only names TypeError for bad revisions); (b) freshness with unreadable evidence is `stale` (B15: no publication means stale); (c) config must be snapshotted at install (derived from the accessor class in the review; no spec sentence); (d) rows where the same defect repeats across call sites are intentional: they pin each site. Optional triage aid: `FI_DUMP=<file>` writes row -> violations JSON.

## Repair r8 (cross-family review r7; threat model DISP_03)
New file: `repair_r8.test.ts` (public API + harness fakes). Against current impl: 6 red of 8 new; all existing green; tsc clean for the file.
Accepted (BLOCKING, item 5 race between our own async steps / B11 privacy): final publication guard checks tier before awaiting `store.currentIncarnation`/`store.read`; a private promotion, `unregisterProject`, or incarnation change inside any post-ledger call of those ports must still block publication (hook fired at every nth call after the `in_cloud` increment, call count measured by a probe run; no CAS attempted for unregister/incarnation; no IN_CLOUD publish for private).
Rejected as NON-BLOCKING under DISP_03 (known debt, no test): `genByProject` unbounded tombstone growth; NaN/invalid `ondevice_concurrency` / `queue_max_depth_factor` (spec leaves domains unspecified; only `inference_timeout_ms` validated).

## Amendment A1-U10r8 (orchestrator)
The incarnation mutation on the final pre-CAS currentIncarnation read is excluded: closing it requires the atomic compareAndPublish port contract (declared in Codex ACCEPTANCE_SCOPE.md); a check-then-act reconciler cannot observe it. All other positions remain asserted.

## Repair r9 (cross-family review r8; threat model DISP_03)
New file: `repair_r9.test.ts` (public API + harness fakes). Against current impl: all new reds are the two BLOCKING items; all existing tests green; tsc clean for the file.
Accepted (BLOCKING, injected-port failures / B2): a throwing `clock.now` during `observe` (call #1, #2 or #3, first and coalescing observe) must not consume the revision: work or retry intent is retained and a repeated observation or time alone dispatches exactly one job.
Accepted (BLOCKING, invalid numeric configuration; supersedes the r8 NON-BLOCKING ruling on concurrency/depth): `ondevice_concurrency`, `cloud_concurrency`, `min_inference_interval_ms`, `queue_max_depth_factor` are rejected at `createReconciler` and `updateConfig` for NaN, +/-Infinity, negative, undefined, null, string; concurrencies additionally for non-integer. A rejected update preserves the previous config.
Stances (not explicit spec text): zero is NOT asserted either way (disables-admission semantics undefined); `queue_max_depth_factor` and interval may be fractional/zero-valid; a clock error may propagate from `observe`.
