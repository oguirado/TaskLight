# U46 oracle (fail-first)

Spec: `specs/SPEC_U46.md` (+ Amendment W0-R). Targets: `src/schema/enums.ts:7`, `src/privacy/{types,policy}.ts`, `firebase/firestore.rules:36,54`.
Files: `fixtures.ts` (independent reference model of section 3, pre-U46 mode table, schema export snapshot), `provider.test.ts` (O1-O5), `source.test.ts` (O1 enum, O6, O7), `static.test.ts` (O8 + R1 text), `tests/rules/u46_sources.test.ts` (R1-R3, emulator, NOT run).
Stubs added: `src/privacy/types.ts` (final types), `src/privacy/policy.ts` (`PROVIDER_KINDS` final; `isProviderKind`, `assertProviderAllowed` throw `U46 stub`). `enums.ts`, `firestore.rules` untouched.

## Counts (`npx vitest run tests/unit/u46`, [MEASURED])
Unit: 177 total, 158 red, 19 green. Red = new behaviour (enum 4-value, `isProviderKind` x20, 90 matrix groups covering 720 cases, O3-O5, validateInferenceSource, O7 ok-under-3-modes, enums.ts literal). Green by design = O6 regression (5), O7 deny-ONLY_ON_DEVICE (2) + bad spellings (1), PRIVACY_TIER, `PROVIDER_KINDS` constant, 720-count check, O8 static (policy hygiene, schema export snapshot, index re-export), private-whitelist text (R1 text parity is RED: pinned to the explicit 4 values).
Rules file: 27 tests, not run (emulator). Expected against current rules: 5 red (R1 text; capsule/digest accept LOCAL_SERVER/REMOTE_PROVIDER x2 each), 22 green (rejections, private denials, baselines).
`tsc --noEmit`: no errors in `tests/unit/u46`, `tests/rules/u46_sources.test.ts`, `src/privacy`.

## Coverage vs spec oracle list
O1 provider.test.ts + source.test.ts | O2 720 cases + order/spot pins | O3 tiers (9 bad) and tasks (7 bad) | O4 bad kinds, truthy non-boolean, missing/non-object opts, partial opts, purity | O5 stop rule 1 (+ private-local needs all three, ok implies endpointEnabled) | O6 sources + modes (3 tiers + unknown tiers x 4 modes + unknown) | O7 | O8 policy.ts (no value import from schema, no forbidden imports/console/DOM), schema export names, enums literal | R1 (also as unit text test, runs without emulator), R2, R3.

## Judgement calls
- J1 R1 text parity is duplicated in `static.test.ts` so it runs without the emulator; the rules file keeps its own copy per spec.
- J2 Result equality uses `toStrictEqual` (`{ok:true}` exactly, no extra keys such as `violation: undefined`).
- J3 "Fresh result object" test: mutating a returned result must not affect later calls (pins no shared mutable constant); a frozen shared constant also passes.
- J4 Unknown tier values tested include `null`, `0`, `{}`, `"Standard"`, `" standard"` (all normalise to private); unknown tasks include non-strings.
- J5 Unknown kind is checked before tier/task normalisation matters; `PROVIDER_KIND_UNKNOWN` also for non-string kinds (5, `{}`).
- J6 `validateInferenceSource` accepting the 4 values is pinned in `source.test.ts` (spec section 6 says validate.ts accepts them with no edit).
- J7 Rules R2: capsule without `inference_source` still accepted; digest without it still denied (existing rules, regression). Rejected values `5`/`{}` assumed denied by `in [...]` (no type error leakage).
- J8 Schema export snapshot (16 names) taken from the repo before U46; `PRIVACY_TIER` regression added.

## Spec ambiguities
- Spec section 4 says "u06 mocks src/schema" yet O8 says "no non-type import from `../schema`": tested on import AND export statements and dynamic import/require.
- `firebase-hybrid` is treated as cloud-capable (section 3 step 3); tests follow, so hybrid never ok for private even though it can run on-device.
- Opts getters that throw / Proxy opts are not tested (totality for exotic objects is unspecified).

## A-U46 amendments for the author (not done here)
- `tests/unit/u05/schema.test.ts:30`: `expect([...INFERENCE_SOURCE]).toEqual(["ON_DEVICE","IN_CLOUD","LOCAL_SERVER","REMOTE_PROVIDER"])`.
- `tests/unit/u05/repair1.test.ts:42`: same 4-value expected list.
Integration also needs: `enums.ts:7` widened, `policy.ts` implemented (VALID_SOURCES local literal, `s !== "ON_DEVICE"` check), `firestore.rules:36,54` widened.
