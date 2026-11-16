# U52b oracle (fail-first)

Targets: `src/providers/registry.ts` (D-U47-1 bounded initDevice, D-U47-2 `firebaseText`), `src/providers/types.ts`. Spec: `specs/SPEC_U52.md` section 3 and acceptance B1-B4. Fakes only (u47 `fixtures.ts`: `world()`, `FakeClock`, `FakeHybrid`, `track`, `policyRef`); no real timers.
Type stub added (type-only, no behaviour): `FirebaseTextRequest`, `FirebaseTextFn`, optional `ProviderDeps.firebaseText` in `src/providers/types.ts`. `DEVICE_STATUS_BOUND_MS` is NOT added (a value); a shape test is red until U52b exports it (= 10,000).

## Result (host run, `npx vitest run tests/unit/u52b tests/unit/u47`)
- u52b: 55 tests, 46 red, 9 green by design (controls). u47: 359/359 green, unchanged. `tsc`: no errors in `src/providers` or `tests/unit/u52b`.
- Green by design: settle-before-bound returns status and leaves no timer; default resolving `failed`; rejection before bound propagates; failed attempt not cached as in-flight; overlay rejection swallowed; overlay `failed` does not alter default status; pre-aborted signal; status/summary/screenshot still use `Hybrid.run` with `firebaseText` present; absent `firebaseText` keeps `Hybrid.run` task `status`, projectId `""`.
- Files: `init.test.ts` (D-U47-1, 22: 16 red), `firebase_text.test.ts` (D-U47-2, 33: 30 red).

## Judgement calls (confirm or amend)
- J1 Directory is `tests/unit/u52b/` (task order); SPEC_U52 writes `tests/unit/u52/b/`. Move if the spec path wins.
- J2 "Init failure -> deterministic failed status": a resolved `{state:"failed"}` is returned verbatim at once. A REJECTION propagates (SPEC section 3: "rejection propagates as today"), pinned as such; rejection after the bound is swallowed and the returned `downloading` stands.
- J3 "Later resolution updates status": the fake `deviceStatus()` is a passthrough, so it is pinned observably: after the bound, late resolve/reject raise no unhandled rejection, clear the in-flight slot, and the next `initDevice` is a fresh `deps.hybrid.initDevice` (inits 2). A joiner arriving before landing gets the real status inside its own fresh bound.
- J4 Progress clamp: NaN -> 0, +Infinity -> 1, <0 -> 0, >1 -> 1 (spec says clamp to [0,1], 0 if none; NaN/Infinity extrapolated). The caller's `onProgress` still receives raw forwarded values (not pinned for joiners).
- J5 Overlay init start time (concurrent with, or after, the default) is not pinned; only that, with a ready default, each live overlay is initialised once and never awaited. No overlay is constructed by `initDevice`.
- J6 Mode table pinned for both route and drift on `firebase-ondevice` (ONLY_ON_DEVICE) and `firebase-cloud` (ONLY_IN_CLOUD) selections, and for `firebase-hybrid`: route = classifier mode verbatim, drift = private or kill switch ? ONLY_ON_DEVICE : PREFER_ON_DEVICE. Private + classifier ONLY_IN_CLOUD: only "no cloud mode reaches firebaseText" is pinned (existing block path; whether a call is made at all is not).
- J7 A throwing/rejecting `firebaseText` on classifier -> `null`; on drift port -> throw; via `generate` -> `FIREBASE_FAILED`, hop per existing rules (ondevice -> hybrid with PREFER_ON_DEVICE for drift). Ceiling 120,000 ms.
- J8 `firebaseText` request `signal` is only asserted to be an `AbortSignal` (identity not pinned); `schema` equals the classifier `constraint` / drift schema verbatim; text is not validated against the status schema.
- J9 With `firebaseText`, no overlay is built for route/drift (`makeHybrid` not called).
- J10 `firebaseText` tests build a sibling registry with `createProviderRegistry({...w.deps, firebaseText})` from a u47 `world()`; the policy mock is the u47 `policyRef`.
- No amendment A-U52b needed: u47 "initDevice initialises every live overlay" stays green under the stated behaviour.

## A-U52b-r1 (repair loop 1, Sol HOLD: reentrancy + retention)
- File `repair1.test.ts`: 7 tests, 7 red before the fix [MEASURED] (`npx vitest run tests/unit/u52b/repair1.test.ts`: 7 failed).
- Reentrancy (3): a joiner created inside a synchronous progress callback never resolves `not_initialised`; it gets `downloading` (last progress) at its own bound, or the real status / real rejection when the attempt settles first; one `deps.hybrid.initDevice`.
- Retention (4): no stats/debug hook exists, so retention is pinned via progress delivery: after 50 expired bounded retries, forwarded progress reaches 0 expired callbacks and only the active one; late completion resolves the active waiter, leaves 0 clock timers and clears the in-flight slot (next call = fresh init). Bound expiry and `clock.setTimeout` failure (first caller and joiner) each detach that waiter's callback only.
- After fix (`registry.ts` only; `types.ts` untouched): 7/7 green; `npx vitest run tests/unit/u52b tests/unit/u47 tests/unit/u46 tests/unit/u50 tests/unit/u06` 34 files / 1982 tests passed [MEASURED]; tsc grep `src/providers|tests/unit/u52b` = 0 lines.
