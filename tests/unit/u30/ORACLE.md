# ORACLE U30 (template contract, compiler, op applier, versioning + undo)

Spec: specs/SPEC_U30.md. Run: `npx vitest run tests/unit/u30`. Files: helpers.ts, contract.test.ts, ops.test.ts, compile.test.ts, session.test.ts.
Stub (`src/template/`) is accept-all and wrong on purpose; tsc clean for u30; stub result: 84 fail, 8 pass (the 8 are positive/boundary controls that an accept-all stub satisfies; they fail under reject-all).

## Case map
| Spec | Test location |
|---|---|
| T1 | contract: T1 defaults_compile; compile: hash/determinism |
| T2 | contract: T2 (a) 13 slots TOO_MANY_SLOTS + compile refused; (b) see conflict 1 |
| T3, T4 | contract: raw class, className/style/html/on*, url() token, case variants, iframe/Chip; ops: same via ops |
| T5 | compile: tags, STYLE_CLASSES, forbidden keys, attrs, no input string in classes |
| T6 | contract: T6 four codes + controls |
| T7 | ops: T7 (5 ops, 0 ops, fuchsia, missing key, OP_FIELDS, null required keys, BAD_OP, extras) |
| T8 | ops: four_ops_ok (hash differs, input deep-equal and not frozen) + each op alone |
| T9 | ops: atomic (ops[1] SLOT_NOT_FOUND, failure at op 4 of 4, SLOT_EXISTS, revalidation at `ops[`) |
| T10 | contract + ops: CELL_TAKEN, OUT_OF_GRID |
| T11, T12, T13, T15(load) | session |
| T14 | contract: label_safety (+ UTF-16 units, name rules) |
| T15(prompt) | compile: B12 |
| U11 integration | compile: real `createRenderer` mounts compiled specs, paints headline/status, rejects off-map status |
| Negative controls | 13 slots, class string/HTML/url()/off-allowlist component/token, >4 ops, atomicity, hash change per edit, undo exactness |

## Spec conflicts / assumptions (need operator or OP ruling)
1. **12 valid slots are impossible**: B5 forbids duplicate fields and only 10 fields exist (dev binds fewer). T2(b) and T5/T15 "12-slot template" cannot be valid. Oracle asserts only the absence of count/grid/id/cell errors for the 12-slot shape and uses the largest valid template (8 to 10 slots) for compile and prompt-size checks. `PROMPT_TOO_LARGE` is unreachable with valid templates; the negative control only requires ok:false for an invalid 12-slot input.
2. **src/lens (U25) is absent in the repo**: tests do not import it. Lens agreement is tested only on cases the spec fixes (dev has no `progress`; study does; dev has `steps`). Stub declares `LensId` locally; real impl must import from `../lens`.
3. **U11 delta (spec section 6)**: unmodified `createRenderer` throws `allowlist_invalid` on non-PatchField keys (`steps`, `progress`). The oracle filters those two keys before calling it. Once U11 accepts them, drop the filter.
4. `steps` FieldRule shape, `labels` keys (asserted `labels[slotId] === label`), `rule.slot` naming: only "slot exists in tree" is asserted.
5. `url()` inside a label is not rejected by B6 (only `<`, `>`, `://`, `javascript:`); it is rendered as text, so not tested. `url()` is tested as token value and component.
6. Null required op key: either MISSING_FIELD or OP_FIELDS accepted. Structural op errors may come from `validateProposal` or `applyOps`.
7. Ring semantics inferred from T11/T13: history holds previous templates (current excluded), 11 accepts give 10 undos then NOTHING_TO_UNDO. Restore test assumes `save` persists a ring from which a new session restores current + history.
8. `load()` when the store throws, and "invalid ring entries dropped" (ring format is opaque `unknown`): not tested.

## Repair loop 1 (tests only; file `repair1.test.ts`; source: Sol REVIEW HOLD + DISP_02)
Result vs build/U30 impl: 22 tests, 17 fail (each pins a reviewer defect), 5 are controls; existing 92 pass; tsc clean for u30 files. `vi.mock('../../../src/lens')` overrides `getLens` only inside this file.

| Review item | Verdict | Test | Spec basis / notes |
|---|---|---|---|
| Array getters run; revoked proxy / throwing traps escape | ACCEPTED (BLOCKING) | R1-1 | B2 "without invoking getters", B1 total. Revoked proxy asserts NOT_PLAIN and no throw from every public function. |
| canonicalTemplateJson/templateHash not total (cycle, null, deep nesting) | ACCEPTED | R1-2 | B1. Only "no throw, string, deterministic" is asserted; the failure representation is not specified, so it is not pinned. |
| Hardcoded LENS_ALLOWED; silent lens_id hash fallback | ACCEPTED | R1-3 | B3 (`getLens`), B5 (field bound in lens template), B11 (hash input `canonical|lens.template_hash`). Assumes U25 SLOT_ALLOWLIST field names equal TemplateField names. Absent/empty/non-string `template_hash` -> compile refused (fail-closed reading of "reject unavailable hash prerequisites"). Importing `LensId` from `../lens` is type-only and unobservable at runtime: REJECTED as untestable here and deferred by DISP_02 item 3. |
| Errors always attributed to ops[0] | ACCEPTED | R1-4 | B9 "path set to ops[i]...". Four cases (OUT_OF_GRID, CELL_TAKEN, CODE_LIKE, MISSING_STATUS) pin the responsible op index. |
| steps pooled rows lack write bindings | ACCEPTED, shape-agnostic | R1-5 | B10 "5 pooled rows, max 80 each". Rule shape is AUSENTE (conflict 4, DISP_02 item 2), so tests assert only: 5 span rows each with a distinct slot, rule target is not the wrapper holding the rows, the rule references all 5 row slots and maxChars 80. Exact U11 shape and renderer integration stay deferred to AMEND_B. |
| Mutable preview; accepted state disagrees with compiled hash | ACCEPTED as invariants | R1-6 | B13/B14. Asserts reload hash == current() hash after tampering `pv.next` (reject, snapshot or recompile all pass) and that a forged `next` with `bg-red-500` is never persisted or installed. "Foreign preview" rejection is NOT tested: spec does not bind a preview to a session. |
| Lost updates under concurrent accept/undo | ACCEPTED | R1-7 | B14 (STALE check, T12) and B15. Deferred-save store; concurrent accepts from one base give exactly one ok + STALE_PROPOSAL; two concurrent undos each step back once. |
| One invalid history entry discards the ring | ACCEPTED | R1-8 | B16 "Invalid entries are dropped, never repaired". Ring shape is taken from what the session itself saved (the single array property); invalid `current` still defaults (control). |
| Test-gaming / documented coverage debt (filtered steps/progress, relaxed slot oracle, invalid-ring untested) | REJECTED as NON-BLOCKING | none | Reviewer marks it non-blocking; filtering and slot cap are ratified by DISP_02 items 1-2. Invalid-ring coverage is now added by R1-8. |

## Repair r2 (Sol review; DISP_03 threat model; file `repair2.test.ts`)
Result vs build/U30 impl: 21 new tests, 16 fail, 5 controls pass (existing 111 pass); tsc clean for u30 files. `vi.mock('../../../src/lens')` overrides `getLens` only inside this file.
| Review item | Verdict | Test | Notes |
|---|---|---|---|
| Cross-lens accept saves a template the same session discards on reload (B14/B16) | ACCEPTED (BLOCKING, DISP_03 5: cross-lens mix-up, lost update) | R2-1 | accept of a template whose `lens_id` differs from the session lens must return `ok:false` (reject code not pinned: `SessionReject` has no lens code), no save, state/history unchanged, existing good ring intact; invariant: any `ok:true` accept is restored on reload. |
| Lens descriptor without array `template` gets hardcoded permissions and `lens_id` hash substitute (B3/B5/B11) | ACCEPTED (BLOCKING, DISP_03 5) | R2-2 | 9 descriptors (no template, undefined/null/string/number/object/`{length}`, empty `{}`): validate -> `BAD_LENS`, compile and applyOps refuse, hash is not `fnv(canon|lens_id)`. Control: valid descriptor still passes. |
| Transparent Proxy passes inspection then `structuredClone` throws | REJECTED NON-BLOCKING (DISP_03: Proxy objects) | none | |
| Non-enumerable required property validates then vanishes on clone | REJECTED NON-BLOCKING (non-enumerable keys) | none | |
| Stored ring with throwing getter escapes `load()` | REJECTED NON-BLOCKING (hostile getters; store returns JSON-producible data) | none | |
| `hash.ts` stub-compat comment as test gaming | folded into R2-2 (behaviour, not comment) | | |

## Repair r3 (Sol review r2; DISP_03 items 3+4; file `repair3.test.ts`)
Result vs build/U30 impl: 8 new fail (never-settling load/save, queue recovery, late settlement, timer leak), reject/throw controls pass; existing pass; tsc clean for u30 files.
| Review item | Verdict | Test | Notes |
|---|---|---|---|
| Persistence promises serialized without timeout; never-settling `store.load`/`save` stalls queue forever | ACCEPTED (BLOCKING, DISP_03 3+4) | R3-1, R3-2 | Fake timers; port modes never/reject/throw. load -> `{restored:false}`; accept/undo -> `STORE_FAILED` with current/history unchanged; queued ops behind a stuck one still settle; same preview re-acceptable after failure; late settlement of timed-out load/save does not change state; no timer left pending. The spec gives no number: oracle allows 60 s fake time per queued op (any smaller finite deadline passes). |
| Cancellation of an uncancellable late `save` writing over later persisted state | NON-BLOCKING (port contract; `TemplateStore.save` has no cancel/token in SPEC_U30) | none | Tests only assert session state is not altered by a late settlement; store-side ordering is AUSENTE from spec. |
