# U15 rules oracle (emulator suite, `tests/rules/u15/rules.test.ts`)

Run: `npm run test:rules` (emulator port 8187 in `firebase.json`; 8080 was occupied on the host).
Result vs allow-all stub `firebase/firestore.rules`: 43 RED (negatives), 13 GREEN (positives), 56 total. Emulator started fine.

| Case | Spec rule | Kind |
|---|---|---|
| O1 unauth (get capsule/workspace/template, write) | B2 | neg |
| O2 non-member get/list/read digest, ledger, project, workspace | B3 | neg (G7) |
| O3 viewer capsule update/create | B6 | neg |
| O4 rev skip, O5 replay, rollback, create rev 2 | B7 | neg (G7 for O4) |
| O6 headline 121 / summary 601 | B10 | neg (G7) |
| O7 boundary 120/600 | B10 | pos |
| O8 private tier text (headline, summary, next_action, inference_source) | B11/H4 | neg (G7) |
| O9 private minimal, O10 editor full, owner update, create rev 1 | B7/B8 | pos |
| O11 off-allowlist key, O13 status "banana" | B8, B9 | neg |
| O12 unknown subcollection/top-level (read+write) | B1 | neg |
| writer_uid mismatch, partial update w/o rev, capsule delete editor, missing project doc | B7, B6, E7 | neg (hypotheses) |
| Projects/workspaces: owner-only, tier enum, exact keys, ws create owner-only, ws update owner, ws delete denied | B4, B5 | mixed |
| Digests: member read, editor create, viewer denied, bad source/oversize/extra key, immutable | B12 | mixed |
| O14 templates: create ok, update/delete denied, extra key denied | B13 | mixed |
| O15 ledger: decrease denied, increase by viewer ok, non-member/extra/neg/float denied, delete denied | B14 | mixed |

Positives passing under allow-all (expected): member reads, O7, O9, O10, owner update, new capsule rev 1, owner project create, ws create self-owner, editor digest create, template create, ledger increase/new day.

## Ambiguities / AUSENTE
- Status enum: U05 stub `src/schema/enums.ts` has arrays empty at runtime; tests hardcode `running|waiting_input|blocked|failed|done|idle` and "banana" as invalid.
- `attention`: spec says number (hypothesis), U05 type is string enum (`low` etc.). Tests use `"low"`; rules should not type-check `attention`.
- Reason codes (spec §5) are not assertable in the emulator; only allow/deny.
- Hypothesis cases (writer_uid, capsule delete owner-only, ws delete denied, E7, digest immutability) are marked in test names; relax if spec revised.
- `observed_rev` integer>=0 check and template-hash==hash(spec) are not tested (hash check TO VERIFY, B13).
- Emulator suite lacks cases for `STATUS_ENUM` parity (E5) and ledger `day` format (AUSENTE).

## Amendment A1 (orchestrator, after author flight)
H2 "editor creates new capsule at rev 1" targeted project p3, which was not seeded, so it contradicted E7 (missing project -> deny). p3 (standard tier, no capsule) is now seeded in beforeEach. "create with rev 2 denied" now fails for the rev guard, not for the missing project.

## Repair loop 1
Tests live in `tests/rules/u15/` by orchestrator decision; review item 4 (separate predicate suite files under `firebase/`) is a spec-relocation question and is NOT created here.
- Coverage fix: project create/editor/viewer/invalid-tier/extra-key cases now target unseeded `p4`; a separate case covers update of seeded `p3`.
- New regression tests: B4 empty members, demote last owner, invalid role (denied), ownership transfer keeping an owner (allowed); B7 `rev` int; B10 headline/summary/next_action string-only (array, map, number denied); B12 digest `brief` string-only; E5 parity (rules `status in [...]` text equals `CAPSULE_STATUS` from `src/schema/enums.ts`, plus every value allowed and "banana" denied).
- Double rev: the JS SDK serialises 5.0 as integerValue, so a true double 5.0 is not producible. Used a seeded malformed `rev: 4.5` (rules disabled) then incoming 5.5 (4.5+1 equality holds); `5.5` over int 4 is also tested (already denied by equality).
- Run vs current rules (build/U15, stub enums): 69 tests, 60 pass, 9 FAIL as intended (3 B4, rev-int, 3 string fields, digest brief, E5 text). E5 fails there because build's enums.ts is still the empty stub; with real enums the text-parity check matches the current status list. The "every value" E5 test also throws on empty CAPSULE_STATUS (anti-vacuity guard).

## Amendment A2 (orchestrator)
Typecheck-only fix in the E5 tests: optional chaining on the regex match and a widened length guard. No behaviour change.

## Repair loop 2
- cross-family review r1 (HOLD) items covered: E7 unknown stored `privacy_tier` (string "unknown" and non-string 7, seeded with rules disabled) + text fields must be DENIED, create and update; `shared` still allowed. Capsule `inference_source`: "OTHER" and a map denied, ON_DEVICE / IN_CLOUD accepted. H1: text-header test requires `firebase/firestore.rules` line 1 to start with `// TO VERIFY`.
- REJECTED (orchestrator decision, not tested): review request for separate predicate files (`firebase/predicates.ts`, `model.ts`, fixtures, `firebase/tests/*`) under `firebase/`; emulator-only suite at `tests/rules/u15/` stays authoritative.
- Spec amendment / E2 Unicode-length status: out of test scope.

## Repair loop 3
- Oracle fix: viewer digest-create negative now targets unseeded `digests/d2` (true CREATE path); viewer update of seeded `d0` kept as a separate immutable-update assertion.
- New regression tests: `observed_rev` -1 / 1.5 / "4" / null / missing denied (standard tier, valid rev increment), private tier -1 / 1.5 / string denied, 0 and 999 allowed.
- Unicode (B10/E2) MEASURED on emulator (probe, then removed): rules `.size()` counts UTF-16 code units, not code points: max accepted headline = 60 emoji (U+1F600, 2 units each = 120), 120 CJK (BMP), 120 "e-acute". Hence `.size()` equals JS `.length` and matches the spec; no defect, no limitation. Tests: CJK 120/121 and 600/601, emoji 60/61, 300/301 (summary), digest brief 300/301.
- Result vs current rules (build/U15): 89 tests, all pass (no new defects found; observed_rev and Unicode behaviours are already enforced). Residual: the `// TO VERIFY` header on firestore.rules remains a README/E2 provenance item; deployment gating is the orchestrator's call.
