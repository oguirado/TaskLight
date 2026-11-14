# ORACLE U14 (auth policy + Firestore sync of derived states)

Run: `npx vitest run tests/unit/u14`. Fakes only (in-memory FirestorePort with rules-like commit checks, fake auth, manual clock); no network, no emulator, no `tests/rules/u14`. Now: stubs (`src/sync/*`, no-op `createSync`, throwing `bindFirestore`/`ridOf`) -> 62 FAIL, 8 pass (constants/static/dispose, by design). `tsc` is clean for `src/sync` and `tests/unit/u14`.

## Files
| File | Pins |
|---|---|
| capsule.test.ts | S1, S2, S3, S10, S13, B2, B7, B8, B14 |
| conflicts.test.ts | S4, S5, S6, S7, B11, onStatus |
| ports.test.ts | S8, bindFirestore contract, ridOf, static import/DOM/timer scan of `src/sync/*.ts` |
| auth.test.ts | S9, B1 (3 local_only causes), B3 |
| digest_ledger.test.ts | S11, S12 (B15, B16) |
| failures.test.ts | S14, B17, raw id never in path/doc |
| harness.ts | FakeFs (commit-time rules: workspace/project/capsule/digest/ledger, rev+1, tier key sets, no extra set args), FakeAuth, FakeClock, makeEnv |

## Oracle decisions beyond the spec (flag if the spec owner disagrees)
- Q1 `flush()` attempts every entry eligible now, serially, and resolves; entries held by MIN_INTERVAL or backoff stay `pending`. Tests move time with `clock.advance` then `flush`.
- Q2 No user / disabled / `fs:null`: puts are REFUSED with `LOCAL_ONLY` (not queued), `status.detail` NO_USER / DISABLED / NO_FIREBASE; B3 re-queue applies to states already held when the uid changes.
- Q3 Digest privacy checks both `needs_you` and `revVector` keys (fail-closed); unknown-tier project -> `DIGEST_HAS_PRIVATE`. Digest doc `rev_vector` keys and `needs_you` entries are rids (shape of `needs_you` items is AUSENTE; only "contains rid, no raw id" is asserted).
- Q4 The project doc is part of the capsule entry (not a separate outbox path), so OUTBOX_MAX counts capsule paths; `setTier(p, null)` writes only the project doc.
- Q5 `bindFirestore` calls `initializeFirestore` eagerly at bind; default (undefined) cache = memory; persistent is called without `tabManager`. Modular tx shape assumed: `get(ref)` -> snapshot with `exists()/data()`, `set(ref, data)` with exactly 2 args.
- Q6 `ledger.applyDeltas` resolves after commit (tests step the clock while waiting); rejections are `Error` with message `SYNC_BAD_DELTA` / `SYNC_LOCAL_ONLY`; non-integers, NaN and >2^53 are "unsafe".
- Q7 A late settle after a uid change must not move counters or pending (generation counter, B3).
- Q8 The fake privacy port is deliberately leaky (`project` returns the state verbatim) so U14's own allowlist is what strips text/lens_id/steps/progress and `inference_source` for private.
- Q9 `src/sync` static scan: `firebase/*` only in `ports.ts`; no `firebase/auth|ai`, `ingest`, DOM globals, `setTimeout/setInterval`; relative imports only `./x` or `../schema|reconcile|lens`.
- Not covered: U15 rules emulator parity (`tests/rules/u14` omitted; the fake mirrors the rules file and S13 diffs the key lists against it), App Check, real error codes, listeners.

### Oracle amendment A1-U14 (14 Nov)
S9 asserted that post-switch writes never contain the substring "u1", contradicting the B3 assertion two lines later that the carried-over headline "for-u1" is re-queued. Narrowed to the exact token "u1" (as a value or key).
