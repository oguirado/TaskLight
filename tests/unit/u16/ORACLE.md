# U16 oracle (Remote Config live switch)

Spec: `specs/SPEC_U16.md` + `specs/SPEC_AMEND_C.md` (U16: B26-B28, A10). Threat model: `strategy/DISP_03_threat_model.md`.
Files: `helpers.ts` (reference FNV/canonical JSON, independent default table, fake `RemoteConfigPort`, recording sinks, virtual `Timers`), `parse.test.ts` (O1-O4, hash, sink projections), `live.test.ts` (O1, O5-O15 dynamic), `modes.test.ts` (AMEND_C B26-B28, A10), `rc_adapter.test.ts` (`firebase_rc.ts` through `vi.mock("firebase/remote-config")`), `static.test.ts` (O15 static, import discipline).
Stubs in `src/config/`: `types.ts`, `keys.ts` (CONFIG_DEFAULTS, KEY_SPECS: real constants), `parse.ts`, `hash.ts` (returns `00000000`), `live.ts`, `badge.ts`, `firebase_rc.ts` (no firebase import), `modes.ts` (MODE_KEYS and defaults real, parser/resolver throw), `index.ts`. tsc clean for these files.
Status vs stub: 104 red / 110. The 6 green are constants and static negative controls (no firestore/ai/rAF/console in src/config, file presence, no firebase import outside `firebase_rc.ts`); they must stay green.

## Interpretation choices (for operator / reviewer)
1. Delta vs base conflict: AMEND_C redefines `ConfigSnapshot`, `CONFIG_DEFAULTS` and `parseConfig` with a different shape (`modes`, `invalid`). Base shape kept for `ConfigSnapshot {cfg,gen,hash,activatedAt}` and `CONFIG_DEFAULTS: WallConfig`; the AMEND_C shape is exported as `ModeSnapshot`, `MODE_SNAPSHOT_DEFAULTS`, `parseConfig`, `resolveMode` (`src/config/modes.ts`). `resolveMode` takes `Pick<ModeSnapshot,"modes"|"kill_switch_cloud">`.
2. `WallConfig` gains `mode_plan` and `mode_template` (default `PREFER_ON_DEVICE`): O1 "18 keys" becomes 20 keys. `AiConfig` and `ReconcileConfig` have no such keys, so they are never pushed to a sink; they still change `hash`/`gen`.
3. O1: baseline for sink/fetch counters is taken after `start()`; whether defaults are pushed to sinks at start is not asserted. Remote values present at start (gen 1) must propagate once (B8/B9).
4. Throttle (O11): the rejected fetch inside `start()` counts as the first of the three (timers 60000, 120000, 240000); cap 3600000 asserted for the 7th+ retry.
5. Non-throttle fetch failure at start: only "defaults snapshot, start resolves, a retry timer exists, not `throttled`" is asserted (spec: "polling is retried", interval unspecified).
6. `data-cloud-off` value is asserted `"true"` when cloud-off, anything but `"true"` otherwise.
7. `resolveMode`: private tier with unknown source (null) resolves `ONLY_ON_DEVICE` (privacy, mirrors U06 B7); `mode_screenshot` always `ONLY_ON_DEVICE`; kill switch overrides all keys (B28). Study status ordering is not asserted (AUSENTE).
8. Threat model additions (BLOCKING classes 3/4): sink returning a rejected promise, rejected `activate()`, throwing `getString`/`setDefaults`/`onConfigUpdate`, dispose racing an in-flight fetch, overlapping pushes (single propagation), unhandled rejections. A never-settling `fetchAndActivate` is not tested (no timeout is specified; flagged as spec gap).
9. SPEC O15 greps `src/**` for `firebase/remote-config`: done via real file scan, plus positive control that `firebase_rc.ts` itself imports it and uses only `asString`.
