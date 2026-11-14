# U05 v2 oracle (SN)

Files: `helpers.ts` (loose-typed v2 entry points `vTask/vState/vPatch`, fixtures), `lens.test.ts`, `plan.test.ts`, `devcompat.test.ts`. Spec: `specs/SPEC_U05v2.md` (B1-B3, B6, B8-B11, B13-B14, B16-B21).
Stubs (additive only, in `src/schema/`): `STEP_STATE`, `LENS_ID_RE`, `STATUS_RE` (enums.ts, real values); `LensStatus/PlanStep/PlanOutput` types; `lens.ts` (`DEV_LENS` data, `validateLensVocab` throws); `taskSchemasFor` throws (schemas.ts); 3 new `RejectCode` members; `export * from "./lens"`. Not stubbed: `LIMITS` additions, `TaskId` "plan", `CapsuleState`/`CapsulePatch`/`ValidateCtx` type changes, `lens` params (tests reach them through casts in helpers.ts).
Expected on this stub: tests/unit/u05 green; u05v2 new tests FAIL (v1 behaviours that pass are listed below).

## Conflict to resolve (implementer / reviewer)
v1 `tests/unit/u05/schema.test.ts` "constants" asserts `LIMITS` `toEqual` the 8 v1 keys, but spec 2 adds 5 keys to `LIMITS`. Both cannot hold. u05v2 asserts `toMatchObject` on the 13 keys. Resolution needs a ruling: update that single v1 assertion, or export the new limits from a separate object. `LIMITS` was therefore not touched in the stub.

## Cases
| Case | File | Rule |
|---|---|---|
| constants, LENS_ID_RE, STATUS_RE, DEV_LENS | lens | spec 2 |
| V1 study_status_ok (bare/quoted/screenshot) | plan | B6 |
| V2 dev_status_under_study (+done shared, +study vocab under dev, +state/patch, +custom lens) | plan | B6, B8, B17 |
| V3 plan_boundary_ok (5x80, empty) | plan | B18 |
| V4 plan_six_steps | plan | B11 |
| V5 step_fields (exact sorted pairs; +missing/wrong type/proto keys; \n\t ok, DEL) | plan | B8-B10 |
| plan top level (required, unknown, non-array, parse, size) ; B20 no derived consistency | plan | B18, B20 |
| V6 progress_bounds (table, state, patch, private) | plan | B19 |
| state lens_id/steps/progress, step paths, V9 private_steps (+[] , fail-closed tier), V10 state, V11 state, BAD_LENS first | plan | B9-B11, B13, B16, B17, B21 |
| V12a-d patch (+path forms, no per-index patch), V10/V11 patch | plan | B13, B14, B17, B21 |
| V7 schemas_for_lens (6 keys, enums, plan shape, frozen, memo by lens_id, TASK_SCHEMAS = dev minus plan, == U25 study descriptor) | lens | B1-B3 |
| plan schema as responseConstraint / responseSchema (pure JSON, B2 keywords only, no integer/min/max, schema-instance parity for all 6 tasks) | lens | B2, B3 |
| V8 bad_lens (17 inputs, boundaries, taskSchemasFor, memo conflict, ctx.lens path `lens`) | lens | B16, B3 |
| V13 dev_regression (53 v1 cases: default == explicit DEV_LENS == v1; state values gain `lens_id:"dev"`) | devcompat | B21 |

## Interpretations beyond the spec text (flag if wrong)
- Paths: state `steps[i].f`, `lens_id` ; patch `fields.steps[i].f`, `fields.progress`; BAD_LENS path `lens` is the sole error. LENS_MISMATCH / lens_id WRONG_TYPE paths: only code asserted for mismatch, path `lens_id` for WRONG_TYPE.
- V12a/V10 patches carry top-level `lens_id:"study"` (absent would read as dev and mismatch STUDY).
- Plan task takes `ctx.lens` (optional) but is lens-independent; `validateTaskOutput` reads the lens from `ctx.lens`.
- `taskSchemasFor` memo: equal lens (also a structurally equal copy) returns the same `value` reference.
- Non-finite progress in states (NaN) -> BAD_INT; unknown privacy tier fails closed for steps (as v1 for text).
- v1 behaviours that legitimately pass on the stub: LENS_ID_RE/STATUS_RE value test, determinism, 47 of 53 devcompat cases.
