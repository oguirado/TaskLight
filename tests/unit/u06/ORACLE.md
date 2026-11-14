# U06 oracle (SN)

Files: `params`, `config`, `run`, `device`, `host`, `rebuild`, `parity`, `firebase`, `static` `.test.ts`; helpers `harness.ts` (fake ModelFactory) and `schemaMock.ts`.
Stub: `src/ai/*` (accept-all `run`, factory never touched, no host guard, wrong defaults, parity returns `[]`, `firebase.ts` typed against the real SDK but getAI per create and uppercase modeConst).

## Case map
| Spec | Test file |
|---|---|
| O1, O2, B3, B4, O6 (params side) | params |
| O9, B5-B8, parseConfig | config |
| O3-O5, O7, O8, O10-O12, B9-B11, B13-B19 | run |
| B12 (gesture-only init, sync fan-out, min progress, failed, needs_gesture) | device |
| O13 | host |
| O14 | rebuild |
| O15, B20 | parity |
| B2 (getAI once, GoogleAIBackend, SDK consts) | firebase (vi.mock of firebase/ai) |
| static grep (sole importer / sole caller) | static |

Isolation: U05 in the repo is still an oracle-phase STUB (accept-all validator, one shared schema object), so every U06 test does `vi.mock("../../../src/schema", ...)` with `schemaMock.ts` (distinct frozen-style schemas per task, strict mini validator, `validateTaskOutput` as a spy). Implementation must import the validator and `TASK_SCHEMAS` from `../schema` (the index). Handles are mapped to tasks by `responseSchema === TASK_SCHEMAS[task].schema`.
Stub-passing tests are true controls (static greps, pure helpers, SDK constant mapping, delegation glue, empty-input cases).

## Mismatches: spec vs installed SDK (firebase 13.3.0, @firebase/ai 3.1.0 typings and runtime)
1. **Casing.** `InferenceMode` values are lowercase (`"prefer_on_device"`, ...) and `InferenceSource.ON_DEVICE === "on_device"`, `IN_CLOUD === "in_cloud"` (d.ts and `esm/index.esm.js` l.449-461). This resolves spec open question 6 in favour of `reference/js/ai.md`; `configuration-options.md` and U05 O12 (uppercase) are wrong for the SDK. B14 (compare against `sourceConst`) is therefore mandatory; `firebaseFactory.modeConst`/`sourceConst` must return the SDK constants, never uppercase strings, and the module's own result `source` stays uppercase `"ON_DEVICE"|"IN_CLOUD"`. Tested in firebase.test.ts.
2. **Part typing.** In 3.1.0 `InlineDataPart` requires `type: 'inlineData'` (and `TextPart` `type: 'text'`), so the spec DI shape `{inlineData:{data,mimeType}}` does not typecheck against `generateContent(Array<string|Part>)`. Runtime fills `type` via `assignPartType`, so it works, but `firebase.ts` must add `type: "inlineData"` in the adapter (done in the stub; test only requires `inlineData` content). The DI seam (`SdkPart`) and B13 stay as written.
3. **`responseSchema` type.** `GenerationConfig.responseSchema` is `TypedSchema | SchemaRequest` (SchemaType enum, `enum: string[]`, mutable). U05 `JsonSchema` (`enum?: readonly string[]`, `type` literal union) and the spec's `responseSchema: object` do not typecheck; `firebase.ts` needs a cast (`as SchemaRequest`). `responseMimeType` is `string`. `responseConstraint?: object` matches.
4. **HybridParams extras.** 3.1.0 runtime warns and ignores any top-level key other than `mode`, `onDeviceParams`, `inCloudParams` (`hybridParamKeys`); B4 params must carry exactly those three (tested). The `ai-public.d.ts` slice at l.1554-1566 shows `inCloudParams?: ModelParams`, so `model` is required in `inCloudParams`.
5. `initializeDeviceModel` and `inferenceSource?: InferenceSource` match the spec. `initializeDeviceModel` rejects on UNAVAILABLE only in `ONLY_ON_DEVICE` mode (no throw for PREFER_*), and returns early for `ONLY_IN_CLOUD`: a PREFER_* instance can look "ready" without a device model, so B12 `ready` does not prove on-device availability; B11 relies on it. Not tested (needs SDK).

## Spec issues found
- **Privacy gap (B3 vs B7/B16).** Five instances exist per TaskId, but tier is per request. A `private` request on a `PREFER_ON_DEVICE` instance is sent to the cloud when the device is unavailable, and B16 only detects it after the prompt has left. Advisory test "privacy gap" in run.test.ts requires the instance serving a private request to be built with mode `ONLY_ON_DEVICE` (e.g. lazily built private variants). Drop it only with an operator ruling; B3 creation count (5 at creation) is still asserted.
- B20 defines "overall red" but no function returns it; test derives it from rows (`any t4 || any ON_DEVICE && !constraintPresent`). Suggest exporting `parityVerdict(rows)`.
- B18 `CLOUD_DISABLED` wording is ambiguous; tested only as `detail` containing it when the call fails with kill switch on and a cloud-only task. `CLOUD_DISABLED` is never an error `code` in any rule.
- Error results: tests require `source` on `SCHEMA_REJECT` and `PRIVACY_VIOLATION` (known), absent on `BAD_SOURCE`.
- B12 progress: tests only drive all five instances before asserting the minimum.
- `appCheckReady` truthy non-boolean values must throw (`!== true`).
- B20 parity does not say whether `initializeDeviceModel` is called on forced ONLY_ON_DEVICE instances; untested.
- U05 is not implemented in the repo despite the brief; integration with the real validator is untested here.

## Repair loop 1
Source: Sol review r0 (HOLD). New files: `repair1.test.ts` (mocked schema, 11 tests; 10 red on current impl, 1 control green) and `repair1.integration.test.ts` (REAL U05 `../schema`, no mock; 4 tests, green: params reference real `TASK_SCHEMAS`, real validator accept/reject, `runParity` t4).
| Finding | Disposition | Tests |
|---|---|---|
| 1 private handle never initialised (B7/B11/B12) | Accepted | R1 x2: uninitialised device-only handle refuses to generate; failed-init handle gets zero calls |
| 2 `run` can reject (B18) | Accepted | R2 x3: `factory.create` throws; `{response: undefined}`; throwing `inferenceSource` getter |
| 3 meta from mutable config (B3/RunMeta) | Accepted | R3 x2: `applyConfig({prompt_version})` during suspended ok and failing calls must keep configGen 0 / v1 |
| 4 init ownership (B12) | Accepted (spec says new instances need re-init; status `ready` over uninitialised handles contradicts B11/B12) | R4 x3 red (stale completion, stale progress, stale reject) + 1 control (current reinit rejection -> `needs_gesture`) |
| 5 `constraintPresent` via undocumented `handle.params` (B20/O15) | REJECTED | Spec `ModelHandle` has no params and B20 defines no factory receipt; an opaque conforming factory that strips `onDeviceParams` is unobservable for any implementation. Requires a spec change (explicit receipt) first. The spec-defined O15 stripping wrapper test already exists in parity.test.ts. Rationale recorded as a comment in repair1.test.ts. |
Exact status values after a stale completion (R4) are not fixed by the spec; tests only forbid `ready`/`needs_gesture`/stale progress, not a specific replacement state.

## Repair loop 2
Source: Sol review r1 (HOLD). New file: `repair2.test.ts` (mocked schema).
| Finding | Disposition | Tests |
|---|---|---|
| Request blocks on lazy private handle init (B11) | Accepted | R2-1: never-settling init -> run resolves `DEVICE_NOT_INITIALISED`, zero calls |
| Replacement handle admitted before its init completes (B11/B12) | Accepted | R2-2: standard screenshot and private summary after `applyConfig({})` with pending init refused; control: succeeds after init resolves |
| Orphaned `downloading` after `applyConfig` (B12) | Accepted | R2-3: status not `downloading` once nothing is in flight; explicit `initDevice()` restarts to `ready` (control) |
| Parity malformed responses escape reject accounting (B20) | Accepted | R2-4: `{response: undefined}`, `{response: null}`, throwing `inferenceSource` getter counted as rejects |
| Unbounded `readyHandles` retention | REJECTED | internal state, unobservable via public seam without gc; no spec rule |
| `constraintPresent` via undocumented `handle.params` / receipt contract | REJECTED | same as loop 1: spec `ModelHandle` has no params/receipt; needs spec change first |
| On-device source on forced-cloud handle counted clean | REJECTED | B20 rejects = SCHEMA_REJECT/BAD_SOURCE/SDK_ERROR; B16 only defined for ONLY_ON_DEVICE; needs spec change |
| Test-gaming remark | REJECTED | implementation matter |

## Repair r6
Source: Sol review r5 (HOLD). New file: `repair_r6.test.ts` (mocked schema). Against current impl: 14 red new / 126 existing green; tsc clean for the file.
| Finding | Disposition | Tests |
|---|---|---|
| `run` rejects when request accessors or ctx copies throw (B18) | Accepted | R6-1 x10: throwing `prompt`/`tier`/`projectId`/`task`/`image`/`image.data`/`ctx`/`ctx.knownProjectIds` getters, Set with throwing iterator, `ctx` getter throwing on second read: resolve `SDK_ERROR` (`meta.called` false and zero SDK calls where failure precedes generation); plus control |
| Parity never initialises forced ONLY_ON_DEVICE handles (B20) | Accepted | R6-2 x2: init-enforcing factory yields clean on-device row; every on-device handle initialised before its first generate |
| Init failure masquerades as schema rejects / T4 (B20) | Accepted | R6-3 x2: failing init -> `runParity` rejects (setup error), zero generate calls on that handle, no row with rejects/t4 |
| Test gaming via `handle.params` | REJECTED | unchanged from loops 1-2 (spec has no receipt); reviewer does not reopen |
Note: spec B20 is silent on setup-failure reporting; the "runParity rejects with Error" shape follows the review's fix 2, not an explicit spec rule. The throwing-second-read case does not assert `called:false` (SDK may already have been called).

## Repair r7 (fault injection)
Source: Sol review r6 (HOLD, `errMessage` throws) plus the standing request to enumerate escaping-exception paths systematically instead of one per round. New file: `fault_injection.test.ts` (mocked schema, harness fake; no impl access). Against current impl: 157 red new of 1160 new / 140 existing green; tsc clean for the file.
Method: every injected dependency method (`factory.create`, `factory.modeConst`, `factory.sourceConst` and its two members, `handle.generateContent`, `handle.initializeDeviceModel`, the schema validator, the caller's `onProgress`) is wrapped in a counting Proxy. Each scenario (std lifecycle incl. two private tiers and an auto re-init; parity) is first run clean to enumerate every call site (port, nth call, step); one row is generated per site x fault kind and the fault fires once. Kinds: sync throw, hostile thrown object, getter throw at access, rejected promise, never-settling promise, undefined/null result, throwing `response`/`text`/`inferenceSource` getters, throwing `text()`, bad source, validator returning undefined or throwing `ok`/`errors` getters, throwing `onProgress`.
| Block | Rows | Red |
|---|---|---|
| FI-0 clean baselines | 2 | 0 |
| FI-1 matrix (scenario x call site x kind) | 511 | 24 |
| FI-2 thrown/rejected values of 8 shapes (message getter, `Object.create(null)`, trapping Proxy, Error with throwing message, non-string message, null, symbol, bigint) at every generateContent/initializeDeviceModel/text() site | 560 | 120 |
| FI-3 review BLOCKING inputs (throwing message getter, `Object.create(null)`) for explicit init, lazy private init (rejected and sync throw), run classification | 8 | 6 |
| FI-4 request accessors, Nth read of each field | 45 | 0 |
| FI-5 deps/config/patch accessors incl. ownKeys Proxy | 25 | 0 |
| FI-6 runParity case accessors (prompt, image, image.data, image.mimeType, ctx, knownProjectIds, iterator) | 8 | 7 |
| FI-7 census | 1 | 0 |
Invariants per row: W1 no unhandled rejection; W2 `run` never rejects and returns the spec code (ONLY_ON_DEVICE -> ON_DEVICE_UNAVAILABLE, ONLY_IN_CLOUD -> CLOUD_UNAVAILABLE, else SDK_ERROR; malformed response, throwing text() or validator -> SDK_ERROR; unknown source -> BAD_SOURCE); W3 `initDevice` never rejects, `deviceStatus` never throws, public sync calls propagate only the injected error; W4 status per spec (explicit init failure `failed`, auto re-init failure `needs_gesture`, failed lazy private init `failed` and not stuck in `downloading`); W5 after the fault is cleared `initDevice` -> ready and standard, screenshot, private, cloud-only requests work and a failed `applyConfig` did not bump `configGen`; W6 hybrid progress callback never throws into the SDK; W7 parity.
Defects exposed (all remaining reds): (1) `errMessage` throws for hostile reasons (the review BLOCKING input) at explicit init, lazy private init (also leaves an unhandled rejection and a stale `lazyPending`) and in the `generateContent` catch (code degrades to SDK_ERROR instead of the mode classification); (2) `runParity` aborts the whole run when a case accessor throws (the snapshot runs outside any boundary) instead of counting that case as a reject like `run` does for B18.
Stances taken (not explicit spec text): (a) parity case accessor faults count as rejects (B20 lists SDK_ERROR as a reject and `run` maps accessor throws to SDK_ERROR); (b) factory/init setup faults in parity may reject but only with the injected error (follows R6-3); (c) `factory.create` returning a non-handle is not generated (contract violation outside the requested fault classes); (d) never-settling `generateContent`/init promises have no timeout in U06, so the tests only require that they do not wedge later work (W5), not that they settle. Optional triage aid: `FI_DUMP=<file>` writes row -> violations JSON.

## Repair r8 (init rejection must not wait for siblings)
Source: Sol review r7b (HOLD, B12): `initDevice` and the auto re-init after `applyConfig` wait on `Promise.allSettled`, so a rejection next to a never-settling init leaves status `downloading` forever. New file: `repair_r8.test.ts` (vitest fake timers, harness manual init mode). Against current impl: 9 red new of 16 new / existing 1307 green.
Cases: explicit init, rejection of handle 0/1/4 with 4 pending siblings -> `failed` (detail kept); rejection + 3 resolved + 1 pending -> `failed`; later `initDevice` after prompt failure reaches ready; auto re-init, rejection of replacement 0/2/4 or mixed with resolved siblings -> `needs_gesture`. Guards (green today, must stay green): late sibling settlement never reverts failed/needs_gesture, stale-attempt rejections ignored (new initDevice, second applyConfig), success still waits for all five handles, ONLY_ON_DEVICE blocked with no SDK call after failure.
Stance: only `deviceStatus()` is required to flip promptly; the `initDevice()` promise may still settle after siblings.
