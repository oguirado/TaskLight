# U52a ORACLE (SPEC_U52 section 2: D-U54-1, D-U54-2)

File: `engine.test.ts` (15 tests; 11 RED, 4 green controls on current code). Regression: u54 + u14 unchanged and green.
Run: `cd repo && npx vitest run tests/unit/u52a tests/unit/u54 tests/unit/u14`.

## Cases
- D-U54-1 dispose (7): control pending-before-dispose (green); flush settles after dispose; nothing written / no backoff timer / no 2nd txn; late txn value ignored; late txn rejection ignored, no unhandled rejection; dispose() resolves and post-dispose flush settles (green, guard); two joined flush callers settle.
- D-U54-1 auth (4): sign-out and uid switch via the engine user callback settle the stuck flush; late value/rejection ignored; new user's fresh flush works afterwards.
- D-U54-2 (4): control no tier change -> written (green); LOCAL_SERVER + timestamp flips to private -> not attempted; REMOTE_PROVIDER + flips to shared -> not attempted; control no-op flip (green).

## Judgement calls
- Hung txn = test-local `fs.txn` override returning a controllable promise (u14 `mode: "hang"` has no late-completion handle). Late completion resolves `{conflict:false,wrote:true}`.
- "Within fake time" = `clock.advance(120_000)` after dispose/auth change; exceeds TXN_TIMEOUT_MS (10 s) so only the cancel path (timer disarmed by cancelAllTimers) can settle; also asserts `timerCount()==0` (cancelled is not transient: no backoff).
- Tier flip is done by mutating `env.tiers` inside a replaced `fs.timestamp`, armed after putDigest. Asserts `attemptedTo('digests')==0` (stronger than committed: spec says build the doc before the final check, so tx.set is never reached); `timestampCalls>0` proves the hook ran.
- Unhandled rejection: `process.on('unhandledRejection')` per test.
- Did not pin the resolved SyncStatus value of the stuck flush beyond being defined.
- Capsule branch unchanged per spec: not tested. Spec lists path `tests/unit/u52/a/`; task order says `u52a/`, followed.

## A-U52a-r1 (repair loop 1, review HOLD: cancelled txn callback still stages writes)
File: `repair1.test.ts` (6 tests; 4 RED, 2 green controls on pre-fix code). Pre-fix run: `Tests 4 failed | 2 passed (6)`.
- Fake `fs.txn` really invokes the callback; first `tx.get` pauses on a deferred, later gets return null; `tx.set`/`tx.update` recorded.
- digest x {dispose, uid switch u1->u2} (2 RED), capsule x {dispose, uid switch} (2 RED): flush settled before resume; after resume the callback completes and must stage nothing; written counter 0.
- Controls (2 green): no cancellation -> digest/capsule `set` staged under `workspaces/u1/...`, written 1.
- r1b ledger path, file `repair1b.test.ts` (3 tests; 2 RED, 1 green control pre-fix: `Tests 2 failed | 1 passed (3)`): applyDeltas txn callback paused on first `tx.get`; dispose / uid switch u1->u2; resume -> nothing staged and the call rejects `SYNC_LOCAL_ONLY` (ledger caller requeues). Control: ledger `set` under u1, call resolves.

## A-U52a-r2 (repair loop 2, review HOLD: capsule privacy change during txn reads)
File: `repair2.test.ts` (4 tests; 3 RED, 1 green control pre-fix: `Tests 3 failed | 1 passed (4)`). Project name via `metaName` = `SECRET-PROJECT-NAME`, capsule `summary` = `PRIVATE-CANARY`.
- Paused first `tx.get` (repair1 pattern, staged data recorded); p1 meta -> private + `setTier("p1", latest)`; resume -> no staged doc contains canary or name, no capsule with `summary`, no `privacy_tier:"standard"` project; replacement entry pending (1).
- Same with meta flip + `setTier` inside a synchronous `fs.timestamp` (first call) during doc construction.
- Control (green): no tier change -> capsule with canary and project with name staged under u1, written 1.
- Replacement: second flush runs a 2nd txn, pending 0, written 1, one private capsule (no `summary`) and one `privacy_tier:"private"` project, no canary/name anywhere.
