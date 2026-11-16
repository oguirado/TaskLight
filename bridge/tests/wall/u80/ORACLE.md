# U80 fail-first oracle

Source: `.unit/SPEC.md`, status R28. The complete supplied file ends after A7; no Amendment sections are present.

## Acceptance map

Python names below belong to `RoomPolicy` in `bridge/tests/wall/u80/test_room_policy.py`.
The Vitest adapter `tests/unit/u80/bridge.test.ts` executes each Python case independently,
so the requested Vitest command includes the bridge assertions rather than silently ignoring Python files.

| Case | Tests | Gate and negative contrast |
| --- | --- | --- |
| A1 | `test_A1_private_floor_denies_remote`, `test_A1_standard_floor_admits_remote`, `test_A1_declared_private_wins` | Exact `policy` nack and no transport call for denial; a standard room reaches transport and returns a result. |
| A2 | `test_A2_missing_room_uses_strictest`, `test_A2_only_standard_admits`, `test_A2_floor_order_independent` | Omission applies the strictest configured floor regardless of allow-list ordering; standard-only permits transport. |
| A3 | `test_A3_unknown_room_denies`, `test_A3_unknown_room_local_opt_in_denies`, `test_A3_unknown_room_without_config_denies` | Unknown slug is `policy`, including local opt-in and an absent allow-list; known standard room is the positive control. |
| A4 | `test_A4_local_private_opt_in_admits`, `test_A4_local_without_opt_in_denies` | Same room and declared tier, only `allow_private` changes admission. |
| A5 | `tests/unit/u80/extension.test.ts`: `A5 accepts and keeps room %s`, `A5 rejects malformed room %j without forwarding`, `A5 unknown extra keys stay rejected %j` | Valid room forwarded unchanged with correlated result; hostile room and unknown keys rejected before host send. |
| A6 | `tests/unit/u80/page.test.ts`: `A6 model_port carries room at rung %s`, `A6 no room means no room key` | Present room survives all existing rungs; absent room is omitted. |
| A7 | `tests/unit/u80/plan.test.ts`: `A7 binds task review and brief to room %s` | Real plan wiring, reviewer, services, registry and page transport reach a fake frame channel; every generation frame contains the requested room. |

## MUST coverage beyond acceptance examples

| MUST | Additional tests / gate |
| --- | --- |
| M1 | `test_M1_malformed_room_is_structural`, `test_M1_explicit_null_room_is_structural`, `test_M1_unknown_keys_still_rejected`; extension slug boundaries, newline, non-string values, schema coexistence, optional legacy room. |
| M2 | All admission cases build through the existing native-host factory from the real room allow-list shape. No new constructor parameter or private floor representation is prescribed. Missing-room cases directly detect missing host floor wiring even before room frames are supported. |
| M3 | `test_M3_declared_shared_denies_remote`, `test_M3_shared_cannot_weaken_private_floor`, `test_M3_shared_local_standard_floor_admits`; page screenshot tests cover both remote and private-enabled local selections. |
| M4 | A3 variants. |
| M5 | `test_M5_empty_config_preserves_standard`, `test_M5_empty_config_preserves_private_denial`, `test_M5_missing_room_local_requires_opt_in`, `test_M5_missing_room_local_opt_in_admits`. |
| M6 | Page registry propagation and omission tests; A7 verifies observable frames rather than a new internal API. |
| M7 | Every denial asserts exact `policy` and no transport invocation. Logs are checked for request, completion, key and room canaries. `test_M7_denial_log_uses_policy` permits silence; if logging occurs it must identify policy. |
| M8 | Existing bridge wall/model suites, existing Vitest unit project and TypeScript diagnostics are separate regression gates. Existing failures must not be attributed to U80. |

## Interpretation and boundaries

- Room grammar is the existing `bridge/room/store.py` `ROOM_RE`, mirrored in extension tests. Explicit null is malformed; omission is distinct.
- Existing room configuration accepts private and standard rooms. Shared is tested as a declared tier; this unit does not add shared room configuration or a new floor vocabulary.
- The spec's `ModelRequest` identifier is absent from the supplied implementation. Its existing request interface is `GenerateRequest` in `src/providers/types.ts`; tests pass an ordinary structurally extended request without importing a future symbol, suppressing type errors or introducing stubs.
- Agent chat suggestion generation under `src/agents` is AUSENTE in this snapshot. That directory exposes legacy drift review, not a room-aware suggestion generator. No invented entry point or test of another unit's UI is introduced. Known-room page/provider propagation and the existing plan review caller are tested.
- Screenshot transport semantics are preserved at the existing provider boundary; screenshot is not invented as a model-frame tier.
- Firebase deployment, App Check, actual model output quality, remote transport/DNS, UI changes, shared-room configuration and other strategy units are out of scope. Existing suites retain their own coverage of those surfaces.

## Determinism and stop rules

New Python tests mock store reads and generation transport, freeze monotonic time and execute worker targets synchronously. They create no sockets, files, real worker threads or sleeps. TypeScript tests reuse injected clocks/channels; the Python adapter has a bounded process watchdog. No model service or external network is contacted.

An allowed room being rejected, a forbidden request reaching transport, a non-policy denial, leaked content, dropped room identity, malformed room acceptance, unexpected keys passing validation, an import/runtime error, or added TypeScript diagnostics fails the relevant gate. Current red cases must be assertion failures caused by missing U80 behavior. Test-only legacy controls may pass.

All assertions and interpretations are scoped to `.unit/SPEC.md` and the cited files in this workspace.

## Verification receipt

Required command: `npx vitest run bridge/tests/wall/u80 tests/unit/u80`.
Measured summary [MEASURED]:

```text
 Test Files  4 failed (4)
      Tests  26 failed | 24 passed (50)
```

The Python adapter contributes twenty-two unittest cases [MEASURED]; they are counted once in the Vitest total. All red outcomes are assertion failures for missing room admission, validation or propagation; no import errors, missing exports, type errors or stubs cause the red results.

Existing unit project, excluding U80 [MEASURED]:

```text
 Test Files  288 passed (288)
      Tests  9273 passed | 1 skipped (9274)
```

Existing `bridge/tests/wall` and `bridge/tests/models`, excluding U80: `LEGACY SUMMARY tests=285 failures=0 errors=0 skipped=0` [MEASURED].

`npx tsc --noEmit -p .` exits unsuccessfully on sixteen existing diagnostics [MEASURED], with the same thirty-four diagnostic output lines before and after adding these tests [MEASURED]. There are no diagnostics in `tests/unit/u80` [MEASURED]. Existing diagnostic files are `src/ai/config.ts`, `src/ai/hybrid.ts`, `src/ai/parity.ts`, `src/prompts/templates.ts`, `tests/unit/u07/build.test.ts`, `tests/unit/u07/versions.test.ts`, `tests/unit/u11/repair1.test.ts`, `tests/unit/u11/repair2.test.ts`, `tests/unit/u14/harness.ts` and `tests/unit/u36/archive-source.test.ts`. These pre-existing errors are outside this oracle's write surface.
