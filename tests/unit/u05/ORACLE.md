# U05 oracle (SN)

Files: `tests/unit/u05/schema.test.ts` (single suite). Stub: `src/schema/*` (accept-all validator, empty enums, zero LIMITS, non-frozen generic schemas).

| Case | Rule |
|---|---|
| constants | spec 2 (LIMITS, enums) |
| O1 status_valid_bare | B6 |
| O2 status_off_enum (+case) | B6/B8 |
| O3 summary_boundary_ok | B9 |
| O4 headline_121 / summary_601 | B9 |
| O5 summary_extra_key | B8 |
| O6 truncated_json | B7, B4 |
| O7 missing_and_wrongtype, sorted | B4, B8 |
| O8 control_char (+DEL, \n\t ok) | B10 |
| O9 private_tier_text (3 fields, 3 tiers) | B13 |
| O10 digest_hallucinated_project (+no ctx) | B11 |
| O11 digest_dup_and_overflow (+12 ok) | B11 |
| O12 source_casing | B12 |
| O13 enum_parity | B6 |
| O14 schema_shape (+frozen, keywords, required==props) | B1, B2, B3 |
| O15a raw_too_large/empty; O15b/c patch empty/unknown key | B5, B14 |
| N1 non-JSON/non-object | B7 |
| N2 wrong type/enum/length on other tasks | B8, B9 |
| N3 prototype-pollution keys | B8 |
| N4 determinism, no mutation | B4 |
| N5-N6 BAD_INT, non-object state | B13 |
| N7-N10 patch values, ints, version/hash, private, non-object | B14, B13 |
| B1 property names, B3 tamper-proof | B1, B3 |

Ambiguities resolved:
- Error `path` format: asserted only for top-level task fields (`headline`, `html`, `note`, `status`). Nested/digest/patch paths are AUSENTE; those tests assert `code` only.
- Sort order: path then code, plain `<` string comparison (spec says "sorted", comparator AUSENTE).
- B6: enum trimmed whitespace around a JSON-quoted literal accepted (`  "blocked" \n`); other forms AUSENTE.
- B5 order: whitespace-only raw longer than 8192 asserted as TOO_LARGE_RAW (raw.length check, not trimmed); empty check is on trimmed text.
- Prototype keys (`__proto__`, `constructor`, `prototype`) asserted as UNKNOWN_FIELD (via JSON.parse own keys).
- Schema `status.schema` asserted `{type:"string", enum, nullable:false}` per B1.
- Patch with PRIVATE_TEXT: B13 applied to patch fields for tier private (B14 says B13 applies); BAD_SOURCE for patch inference_source.
- Digest brief/reason limits BRIEF_MAX/REASON_MAX applied (REASON not directly tested). Items with extra keys: AUSENTE.

Stub red counts: 27 red / 30 total vs accept-all stub. The 3 green are positive controls by design (O1, O3, patch positive control); they fail against a reject-all stub.
tsc: no errors in src/schema or tests/unit/u05; unrelated pre-existing errors in tests/rules/u15 (missing @types/node, not my surface).

## Repair loop 1

File: `tests/unit/u05/repair1.test.ts` (11 tests; 10 red / 11 vs current impl; R10 stays green by design; old 30 tests still pass).

| Case | Review item | Rule |
|---|---|---|
| R1 LIMITS frozen, mutation inert | HOLD 1 | B3 |
| R2 4 enum arrays frozen, push inert | HOLD 2 | B3 |
| R3 non-string raw -> WRONG_TYPE, no throw | HOLD 4 | B4 |
| R4 unknown task id rejected, no digest fallthrough | HOLD 4 | B4 (never throws) |
| R5/R6 Date/Map/Set/RegExp/class/array/fn -> NOT_OBJECT (state, patch) | HOLD 3 | B7 |
| R8/R9 unknown/invalid tier with text fails closed (ok:false) | HOLD 5 | B13 |
| R10 known tiers positive control (green by design) | - | B13 |
| R11/R12 writer_uid / patch projectId control char/DEL -> CONTROL_CHAR | HOLD 5 | B10 |

Rejected / loosened:
- Exact error code for unknown task and unknown tier is not in the spec (review suggests ENUM_VIOLATION or PRIVATE_TEXT): asserted only `ok:false` and no throw.
- Review wording "treat unknown tier as private" is one of two options; not pinned.
- A test that `patch.fields` non-plain-object is rejected passed against the current impl, so it was dropped (no red value).

## Amendment A1-U05v2 (orchestrator)
SPEC_U05v2 adds keys to LIMITS; the v1 constants test now uses toMatchObject (the 8 v1 keys keep their exact values); v2 tests assert the new keys.
