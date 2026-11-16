# U47 oracle (fail-first)

Targets: `src/providers/{types,registry,rungs,index}.ts` (types/constants final incl. Amendment W0-R `tier` in `ModelTransport.generate`; every function body `throw new Error("U47 stub")`). Spec: `specs/SPEC_U47.md`. Fakes only: `FakeHybrid` (3 instances: default, on-device overlay, cloud overlay via `makeHybrid`), `FakeTransport` (scripted list/probe/generate, abortable `hang` and signal-deaf `deaf`), `FakeClock` (no real timers).
Result: 332 tests, 296 red (all `U47 stub`), 36 green by design (shape 6, static 30). `tsc`: no errors in `tests/unit/u47` or `src/providers`.
Validation: a throw-away reference implementation (not kept) passed 331/332 (the one miss is the classifier-mode test, which the reference did not implement); mutants (policy ignored, local budget +1 ms, second hop, rung not lowered after a rung-1 nack) were each killed.

## Files
`fixtures.ts` (fakes, world builder), `policyRef.ts` (test-local copy of SPEC_U46 section 3 installed with `vi.mock("src/privacy/policy")`; records calls; override hook), `shape` (constants/exports), `static` (acceptance 12), `rungs` (toChatMessages, strictParse), `registry` (list/refresh/health/select/resolve/gates/policy delegation/overlays/initDevice), `chain` (acceptance 1,2,3,7,9, rungs, body cap, abort), `privacy` (4,5,6 sweeps), `timeouts` (8), `adapters` (13), `ai_snapshot.json`.

## Coverage vs acceptance
1 chain.default + registry.resolve; 2/3 chain; 4/5 privacy sweeps (8 tasks x 2 tiers x 10 gate states x 7 candidates x 2 selection forms, with non-vacuity controls); 6 privacy (screenshot, 3 tiers x gates x candidates); 7 chain "validators decide" (3 rungs x 5 tasks, valid and invalid); 8 timeouts (29,999/30,000, 59,999/60,000, probe 1,499/1,500, abortable and deaf transports); 9 chain source truth; 10 registry gates; 11 registry health; 12 static; 13 adapters.
Static: sha256 of every `src/ai/**` file (6 files) taken from the files as they were when this oracle was written, stored in `ai_snapshot.json`; file set must also be identical. Also: no `chrome.`/`chrome` (raw text), no DOM/network/console, no real timers/Date/random, no firebase package or `createHybrid` or `../ai/{hybrid,firebase,parity,config}` import, `../schema` value imports limited to `validateTaskOutput`/`TASK_SCHEMAS` (AMEND_A), no U46 violation vocabulary (policy is imported, not re-implemented), no runtime imports of router/agents/app/sync/reconcile (U54 owns those).

## Judgement calls (confirm or amend)
- J1 U46 is mocked at `src/privacy/policy` (index re-exports it) with a faithful section 3 reference, so U47 is tested independent of U46's code. `resolve` must reach `assertProviderAllowed` through `src/privacy`; the spy pins args: `policyTask` = task, `"status"` for route/drift; `{loopback, allowPrivate: allow_private, endpointEnabled: health !== "needs_setup"}`; asking tier unchanged. A deny-all/allow-all override proves U47 defers verbatim.
- J2 Private + default provider: `firebase-hybrid` is policy-denied for private (U46 section 3), so default private resolves to `firebase-ondevice` and deps.hybrid is not called. Acceptance 1 is asserted for non-private tiers.
- J3 Blocked chains for private use the terminal `firebase-ondevice` even for `unknown_id` (step 6 beats step 3's "firebase-hybrid"). An unknown tier value also resolves to on-device (fail-closed; literal `tier === "private"` would leak to hybrid).
- J4 Firebase failures other than INPUT_OVER_BUDGET/INPUT_REJECTED/PRIVACY_VIOLATION hop; those three do not; surfaced `code` for them is only constrained to `FIREBASE_FAILED|BLOCKED`.
- J5 Nack/health: `timeout`/`offline` nack and transport reject -> offline; `policy` nack -> `blocked` (Amendment); `bad_reply`, `rate_limited`, `http_error`, `busy` leave `available`. A rung-1 nack lowers the cached rung to 2; descriptor `rung` shows it.
- J6 `needs_setup` endpoint: no transport call, terminal answers, `fallback:true`; whether `resolve` reports it as policy-blocked or as an external primary with hop is not pinned.
- J7 Body cap is measured in UTF-8 bytes of the request (prompt, schema/messages), not characters: 30,000 "e-acute" and 15,000 emoji are over, 40,000 ASCII is under. Exact boundary not pinned.
- J8 `strictParse(text)` has no schema: a bare token matching `[a-z][a-z_]*` is treated as the enum token; prose-wrapped JSON and two JSON values are `null`; code fences not pinned.
- J9 `select(sel)` replaces (not merges); `select({})` returns to default. Unknown ids are kept and become usable after a later refresh.
- J10 `applyRemoteConfig` never calls `applyConfig` on `deps.hybrid` with an overlay (any call it makes must equal the received cfg); overlays created later start from the latest cfg; overlays are never built eagerly. `asHybrid().applyConfig` forwards verbatim and returns deps.hybrid's value.
- J11 Gates: a missing gates object or missing flag = false (fail-closed); `killSwitchCloud` blocks only `firebase-cloud` in U47 (local stays selectable; remote vs kill is U50's computation, not pinned). `firebase-cloud` descriptor is `blocked/remote_config` under kill.
- J12 No timer left armed after a success, nack or probe expiry (`clock.pending === 0`); late transport answers after a timeout are ignored; caller abort -> `ABORTED`, no hop, health untouched.
- J13 Classifier with `mode: ONLY_ON_DEVICE` and default selection uses the on-device overlay (explicit in spec); other modes not pinned. Drift port picks the `drift` group, classifier the `routing` group.
- J14 Hop failure through `generate` returns `ok:false, fallback:true`; its `code`/`providerId` are not pinned (see ambiguity A2).

## Spec ambiguities (not tested, need a ruling)
- A1 Which Hybrid task/projectId `generate` passes to `Hybrid.run` for route/drift and for TaskIds (GenerateRequest has no projectId), and how a Firebase `value` becomes `text` (string vs JSON.stringify).
- A2 `code` and `providerId` of the final failure when both primary and hop fail; hence the asHybrid error-mapping table (`TIMEOUT/OFFLINE/NACK/NEEDS_SETUP/BODY_TOO_LARGE` -> `CLOUD_UNAVAILABLE`, `BLOCKED` -> `PRIVACY_VIOLATION`) is not directly reachable: Firebase hop failures return the inner TaskResult verbatim. Only that verbatim path and a loose "string code, fallback true" check are tested. `ModelTransport` has no path that produces `BLOCKED`.
- A3 `fallback` for private-default answered by on-device, and for screenshot (candidate = answerer?).
- A4 Whether `list()` exposes `blocked` for externals under gates/policy (spec says computed per call, not stored); `modelLabel` for Firebase; whether probe state `blocked` from the host is stored.
- A5 Whether `refresh()` probes keyless remotes, and probe concurrency (serial vs parallel); `killSwitchCloud` vs remote.
- A6 Rung-3 handling for route/drift (strictParse applies to all tasks?).
- A7 Cancel on caller abort (`transport.cancel`) not pinned.

## A-U47r1 (repair loop 1, review HOLD findings 1-5)
New file `repair1.test.ts` (existing tests untouched). Fail-first run on the unrepaired code: 15 tests, 13 failed, 2 passed (the passing two are guards: private ONLY_IN_CLOUD builds no cloud overlay; plain default answer keeps `fallback:false`).
- F1 throwing `transport.cancel` with a deaf generate: timeout (30,000 ms) and caller abort both settle, no timer left.
- F2 throwing `makeHybrid` for `firebase-ondevice` at standard -> hop to `firebase-hybrid` succeeds; private (no hop) -> resolved `FIREBASE_FAILED`.
- F3 Firebase deadline = `TIMEOUTS_MS.ceiling` (120,000 ms = `inference_timeout_ms` default, `src/config/keys.ts:13`) via `deps.clock`: never-settling run -> `FIREBASE_FAILED` (hop where the chain has one), late completion ignored; caller abort -> `ABORTED`, no hop. `transport.list` bounded by `TIMEOUTS_MS.probe` (spec: refresh budget) -> Firebase group only.
- F4 classifier `ONLY_IN_CLOUD` + default -> cloud overlay (`IN_CLOUD`), `deps.hybrid` not run; private never builds the cloud overlay; kill switch -> null (no on-device substitute).
- F5 `fallback = answerer !== step-2 candidate || inner Firebase fallback`; pure helper `chainFallback` exported from `src/providers/registry.ts` (classifier output type has no `fallback`, and adapters pins `toEqual({text, source})`, so the classifier case is asserted on the helper).

## A-U47r2 (repair loop 2, review HOLD findings: clock guards, stale generations)
New file `repair2.test.ts` (existing tests untouched). Fail-first run on the unrepaired code: 12 tests, 9 failed, 3 passed (the passing three are guards: generate with throwing clearTimeout already settles via `safely`; non-stale rung-1 nack lowers rung to 2; non-stale policy nack blocks / non-stale timeout sets offline).
- R1 Injected clock: throwing `clearTimeout` in `boundedList` and `probeOne` -> refresh settles, no `unhandledRejection`. Throwing `setTimeout` -> deterministic structured outcome: list = Firebase group only, probe = `offline` with no `transport.probe` call, generate = resolved `ok:false` (string code) with no transport/Firebase call.
- R2 Stale generations: health/rung mutations from a generation are bound to the endpoint state object captured at call start; after a `refresh()` replaced it, a late `rung_unsupported` nack (rung stays 3), a timeout, a transport rejection (stay `available`) and a `policy` nack (no inherited `blocked`) are ignored.
