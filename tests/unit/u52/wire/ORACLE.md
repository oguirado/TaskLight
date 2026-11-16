# U52 wiring fail-first oracle

Workspace: repository root.
Source: `.unit/SPEC.md`, fully read, SHA-256 `f487ba00fd8e09daccf9d7d851fdd01c1c94c607883f678791974fec71dd2d78` [MEASURED].
Only `tests/unit/u52/wire/**`, `src/app/model_port.ts`, and `src/app/model_services.ts` are written.
The real repository is not used. Both stub files were absent before this flight.
Every exported function body is exactly `throw new Error("U52 stub")`.

## Acceptance mapping

Names below are literal test-title prefixes; parameterized suffixes identify each table case.

| Case | Test file | Test names / asserted contract |
|---|---|---|
| W1 | `services.test.ts` | `W1 golden %s: factory parameters, prompt, schema and source match the pre-U52 adapter`; `W1 no channel: exactly the Firebase ids and default primaries (private ondevice)`; `W1 aiSink applyConfig updates registry Firebase overlays`. Golden parameters are pinned explicitly and compared against the real pre-U52 `driftPortFromFactory`. |
| W2 | `transport.test.ts`, `services.test.ts`, `hosted.test.ts` | All `W2` titles: no-hello silence and `needs_setup`; unsolicited hello; list deadline; rid matching and reverse replies; abort and endpoint cancellation; reset/offline; `host_absent`; unrelated hostile frames; second RuntimePort listener; actual agent_link transcript comparison. `W2 unknown selection without hello leaves model channel silent through drift and init`; `W2 W2-R no host: actual rail opens sheet with Firebase defaults and emits no model frames`. |
| W3 | `services.test.ts`, `hosted.test.ts` | `W3 stop rule 2: every distinct drift review still calls factory.create`; `W3 default drift remains live and hosted services-construction failure still boots ready`; `W3 actual page initialization loops downloading until ready through registry`. The construction-failure test imports the actual hosted page, injects a throwing services constructor, and observes actual boot. |
| W4 | `services.test.ts`, `transport.test.ts` | `W4 local answer carries %s tier, LOCAL_SERVER source and local chip`; `W4 rung %s sends only protocol keys, schema only at rung 1`. Tests answering source, U51 `viewSourceKind`/`chipLabel`, tier and exact wire frame keys. |
| W5 | `services.test.ts` | `W5 offline nack falls back to Firebase ON_DEVICE, fallback true, endpoint health offline`. |
| W6 | `services.test.ts` | `W6 $name: hybrid, drift and classifier never send forbidden endpoint generate`; `W6 screenshot never sends to $id even when selected`; `W6 positive private allow_private local is usable by the hybrid seam`. Covers private/shared remote, private local without opt-in, screenshot against local/opted-in local/remote, and a permitted private-local contrast. |
| W7 | `services.test.ts` | `W7 $mode local answer yields $source verdict with explicit external permission`: real reviewer, actual services/registry, opted-in private endpoint; `PREFER_ON_DEVICE` gives `local`, `ONLY_ON_DEVICE` gives `rules`. |
| W8 | `services.test.ts` | All `W8` titles: default gates; each flag and cloud switch; flag-only activation ordering; unrelated keys ignored; invalid values preserve prior flags; throwing listener registration; cloud-only update; live start/subscription; persisted selection and change subscription. |
| W9 | `boot.test.ts` | `W9 progress every 30s for 5min then ready becomes initialized`; `W9 no progress remains initializing at 59999ms then failed at 60000ms`; `W9 even repeated equal progress re-arms inactivity; silence then fails`; `W9 late progress after %s is ignored`. Tests real boot with a registry-backed HybridPort and fake SDK initialization. Durations are spec fixtures [CITED: SPEC §4.4, W9]. |
| W10 | `services.test.ts`, `hosted.test.ts` | `W10 registry device bound uses the supplied clock, never a real timer`; `W10 injected-clock behaviour plus static ban on globals and required hosted sheet/style wiring`. Behaviour proves clock injection rather than requiring a particular local variable spelling. |
| W11 | `services.test.ts` | `W11 canary prompt never reaches storage, console or selection writes`. Exercises hybrid, drift, and classifier; spies all own callable console methods and Storage.setItem; observes selection writes. |
| W12 | `services.test.ts` | `W12 ledger forwards base counters and shares external counts without persistence`. Independent services start with fresh counts, and base.inc receives only its original counter. |

## Debt micro-unit acceptance and integration gates

U52a/U52b are separate prerequisite owners, not additional wiring assignments. Their test directories are outside this flight's authorized write surface. Their dedicated tests are AUSENTE — no inventar in this workspace. This oracle does not claim to certify the micro-units just because existing regressions pass.

| Spec case | Owning test surface / oracle obligation | This flight |
|---|---|---|
| A1 | `tests/unit/u52/a/**`: pending fs.txn cancelled by dispose/auth change settles flush without writes/backoff | Dedicated test names AUSENTE — no inventar; prerequisite, not authored. |
| A2 | `tests/unit/u52/a/**`: transaction timeout still causes transient/backoff | Dedicated test names AUSENTE — no inventar; prerequisite, not authored. |
| A3 | `tests/unit/u52/a/**`: reentrant timestamp privacy change suppresses digest write | Dedicated test names AUSENTE — no inventar; prerequisite, not authored. |
| A4 | Existing `tests/unit/u14/**`, `tests/unit/u54/**` regression suites | Included in the passing full existing-unit run. |
| B1 | `tests/unit/u52/b/**`: default init bound and last progress | Dedicated test names AUSENTE — no inventar. W10 checks the injected bound only as a wiring seam. |
| B2 | `tests/unit/u52/b/**`: pending overlay does not delay default | Dedicated test names AUSENTE — no inventar; prerequisite, not authored. |
| B3 | `tests/unit/u52/b/**`: single-flight default init | Dedicated test names AUSENTE — no inventar; prerequisite, not authored. |
| B4 | `tests/unit/u52/b/**`: firebaseText mode table and no Hybrid.run for route/drift | Dedicated test names AUSENTE — no inventar. W1/W3 check real Firebase-text composition; existing u47 remains green. |

Gate suites `u06`, `u22`, `u37b`, `u37c`, `u39`, `u42`, `u46`, `u47`, `u50`, `u54` passed before adding the oracle: `Tests 2822 passed (2822)` [MEASURED].

## Contract decisions and limits

- W2-R takes precedence for hosted U51 integration: actual `createModelSheet`, `ModelSheetSnapshot`, rail `[aria-controls="model-sheet"]`, selection/reset/refresh intents and stylesheet. No `mountModelSheet` API is invented. W2-R does not publish a replacement `ModelServices.sheet()` signature. To satisfy the expressly requested exact §4.2 signature, the stub declares a local `ModelSheetFeed` with the supplied §5 shape; it is not imported from U51 and its obsolete feed methods are not pinned by tests. The orchestrator must reconcile that remaining public signature before implementation.
- `ProvidersClock` aliases the existing exported providers `Clock`; no new clock implementation or package is assumed.
- `SelectionStore.onChange` is typed with a ModelSelection callback, the value needed for the specified storage-to-registry synchronization. W2-R specifies no constructor/export name for the frame-backed store, so no such function is invented. Its externally observable get/set/reset frames are exercised through the hosted page.
- No-host silence covers all `model_*` sends, including selection traffic; a frame-backed store therefore must defer its sends until hello. Extension-side pre-hello replies are not a license for the page to violate W2.
- Screenshot is a TaskId on Hybrid.run; DriftPort and ClassifierPort expose no screenshot operation. The screenshot axis is tested at Hybrid.run, while tier/provider denial is tested through all relevant seams.
- The supplied LiveConfig seam is expected to be started by composition and to refresh flags after start and notifications, following §4.2. Tests assume only a fake RemoteConfigPort. SDK support for concurrent listeners remains AUSENTE — no inventar.
- The W10 static check rejects global timers/Date.now while allowing calls on the injected clock; it does not reject the required clock method name itself.
- Forward-compatible reviewer options are cast only at the old TypeScript union boundary. The actual reviewer, registry, adapter and boot remain under test.
- Hosted end-to-end tests first exercise the public service prerequisite, then execute the actual hosted module with fake Firebase ports and factory. Current stubs stop these tests before their downstream UI assertions; red status does not establish that later assertions already pass.
- All new tests fake global timers. Model transport uses the injected fake clock. Promise observations have a finite microtask budget. No network, real model, emulator, polling wait, or real sleep is used.
- Reconcile/digest/sync/router page composition, a demo local runtime, persistent external counters, and unrelated U41 boot status remain outside scope.

## Verification receipts

New oracle: `npx vitest run tests/unit/u52/wire`:

```text
 Test Files  4 failed (4)
      Tests  57 failed (57)
```

Counts are [MEASURED]. Every reported error group is `Error: U52 stub`; no missing import, TypeScript or assertion failure accounts for the red result. Failure groups may aggregate parameterized tests.


Existing suites: `npx vitest run --project unit --exclude "tests/unit/u52/wire/**"`:

```text
 Test Files  237 passed (237)
      Tests  8120 passed | 1 skipped (8121)
```

Counts are [MEASURED].  Rules/emulator suites are not run because this flight forbids network.

`npx tsc --noEmit -p .` exits nonzero on existing diagnostics. Before and after output is byte-identical: SHA-256 `63069af808525ab4f55a3749ca53ab2ca4edc110b320c4a0bb7b8031e3b8cfe6` [MEASURED]. There are no diagnostics in the newly authored paths.

Mandate scoped to the supplied SPEC and cited workspace surfaces.
