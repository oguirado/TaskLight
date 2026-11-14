# U25 oracle (lens contract / registry / validator)

Files: `helpers.ts` (reference FNV-1a, canonical JSON, dev/study fixture descriptors, T9 variant), `contract.test.ts` (validateLens, B1-B16, L3-L7, L14, L15), `registry.test.ts` (L1, L2, L8-L13, registry, floors, hash).
Stub in `src/lens/`: accept-all `validateLens`, `getLens` returns `{}`, `ids()` empty, hash `00000000`, floors all null, `effectiveMode` returns requested. Constants (`limits.ts`, `SLOT_ALLOWLIST`, types) are real. `lenses/dev.ts`, `lenses/study.ts` are empty placeholders.
Status vs stub: 149 red / 162. The 13 green are positive controls, constants and the Error subclass; they must stay green after implementation.

## Interpretation choices / ambiguities (for operator or reviewer)
1. Error paths use dot form with numeric indices (`task_schemas.plan.schema.properties.steps.items.properties.text.maxLength`, `template.1.field`, `layout.order`). Spec only says "full path".
2. B7 (built-in vocabularies) is asserted on the registry content only. The validator is generic: L3 requires an 8-status study descriptor to validate and L8 a renamed status to validate, so the validator cannot hard-pin statuses.
3. Fixture schemas keep U05 camelCase property keys (`projectId`); B3 is read as applying to string values, not to schema property names.
4. Codes left open by the spec are asserted loosely: `required` incomplete or `nullable:true` (SCHEMA_MISMATCH), prompt_pack id mismatch (only `ok:false`), bad `step_rows` 3 and bad `layout.order` (only `ok:false`), malformed `template_hash` (only `ok:false`), Date/Map/Set (NOT_PLAIN or REMOTE_CODE).
5. Proxy detection (B2) is tested with `util.types.isProxy`; the validator needs the same primitive.
6. Built-in dev/study template exact slot lists are not pinned (spec gives only: progress only in study, checklist in both). Fixtures use dev without focus_banner, study with it; tests assert consistency only.
7. `lensHash({})` is compared to a reference FNV-1a of `"{}"` (U07 `hashString` is still a stub in this repo, so no import).
8. Cyclic descriptors: only "does not throw, not ok" is required.
9. `buildRegistry([])` behaviour is unspecified and untested.

## Repair loop 1
Accepted (BLOCKING): review #1 hidden/non-enumerable/symbol/accessor properties (B1, B2, B4, B16: accessors never invoked, hidden fields not silently dropped), #2 plan schema exactness (B10: extra `enum`/`items`/`properties` at any node -> SCHEMA_MISMATCH), #3 CODE_LIKE classification for template `slot`/`field`/`write` and `layout.order` (B3 applies to every non-label string; domain code BAD_TEMPLATE/BAD_LAYOUT may also be present). Tests: `repair1.test.ts`.
Rejected: none of the review items; hidden non-enumerable data property rejection code is asserted only as `ok:false` (spec gives no code).

## Repair loop 2
Accepted (BLOCKING): review #1 sparse arrays (B2/B6/B10: holes in any descriptor array incl. statuses/enum -> reject), #2 extra array properties (B3/B16: non-index own keys on arrays, incl. non-canonical index strings, -> reject, never silently dropped), #3 import direction (spec §1: `src/lens/` -> `src/schema/` only; test scans module specifiers in `src/lens/**`, all must be relative; `node:util` fails). Tests: `repair2.test.ts`.
Note on #3: Proxy detection (B2) is still required; ORACLE item 5's `util.types.isProxy` is only the test-side primitive. The oracle does not dictate the implementation primitive; spec amendment may be needed if no portable detector exists (AUSENTE in spec).
Rejected NON-BLOCKING: B7 vs L3/L8 ambiguity (already documented as interpretation 2; spec-consistent: validator generic, registry content pinned). No test change.

## Amendment R8 (orchestrator)
Under the operator threat model (strategy/DISP_03_threat_model.md) Proxy-backed inputs are non-blocking debt: "Proxy-backed value -> REMOTE_CODE" is skipped with that reason.
