# ORACLE U08 (ingest: normaliser, redaction, replay fixture)

Files: `helpers.ts` (fake planted secrets, generators), `normalise.test.ts` (I1-I8, I14, B1/B8/B10),
`digest_replay.test.ts` (B11, I9, I10, I15), `fixture.test.ts` (I11-I13, B14), `pii_home_paths.test.ts`.
Stub: `src/ingest/*` (identity redact, constant digest, passthrough normalise, unvalidated loadFixture). Stub run: 66 fail / 13 pass (the 13 are positive controls and invariants).

Implementer must provide: all of `src/ingest/`, plus committed `fixtures/replay/v1/{manifest.json,events.jsonl}` (5 projects, 200 events, >=1 private, all 9 kinds, normalised + redacted, valid eventIds, digest in manifest). `fixture.test.ts` fails at import until they exist. Fixture text must contain no email/Bearer/AIza/home path (I13 regexes).

Oracle assumptions beyond the spec (AUSENTE in SPEC_U08, flag for review):
- I4 seam: optional third param `normalise(raw, reg, { redactFn })` replaces the redaction step only; the residue check still uses the real classes.
- Digest-mismatch error: spec has no code; test requires `/digest/i` in `path`+`detail` of some error.
- Error paths: only `html` (UNKNOWN_FIELD) is spec'd; other errors use the field name as path (MISSING/WRONG_TYPE/BAD_INT) in tests.
- Home-path usernames (`/home/u`, `/Users/u`, `C:\Users\u`): PII policy is an open question (section 6); `pii_home_paths.test.ts` encodes the stricter ask. Delete the file if the operator rules otherwise.
- `planted.jsonl` is replaced by `PLANTED` in `helpers.ts` (surface is tests/unit/u08).
- Unterminated PEM, `\r` as CONTROL_CHAR (C0 other than \n,\t), digestHex = UTF-8 SHA-256, redact marker for APPCHECK may also be KEY_ASSIGN (only generic `[REDACTED:` asserted there).
- Pre-existing `tests/rules/u15` tsc errors are not from U08.

## Repair loop 1 (review_hydrogen_r0, HOLD)

File: `repair1.test.ts` (R1-R7). Fake secrets are assembled at runtime. Against the current implementation: 12 new tests fail, 4 new pass (guards); all 95 existing pass.
Accepted (spec-supported, concrete failing inputs):
- R1 KEY_ASSIGN `[REDACTED:` prefix bypass (`PASSWORD=[REDACTED:X]<tail>`), B6/B8.
- R2 lowercase/mixed-case `bearer` (B8 fail-closed; the HTTP scheme is case-insensitive and the spec does not restrict case).
- R3 `URL_CREDS` with `:` in the password (`https://admin:pa:ss@10.0.0.1/hook`).
- R4 post-truncation entropy rise (review input, length 2036): B8 requires the forwarded text to be residue-free, B9 truncates after redaction.
- R5 multi-line quoted KEY_ASSIGN value (B6: "only the value is replaced"; secret tail survives).
- R6 `lastSeq` not consulted for BAD_PROJECT_ID / UNKNOWN_PROJECT (B4: only known projects have a sequence; avoids spurious SEQ_REGRESSION); registry tier outside PRIVACY_TIER must not be stamped (B10, CapsuleEvent shape).
- R7 loadFixture float/negative numbers (already enforced; guard only).
Rejected (spec contradicts or is silent):
- APPCHECK_DEBUG ordering: B6 fixes class order (KEY_ASSIGN before APPCHECK_DEBUG), so `token: <uuid>` becoming KEY_ASSIGN is compliant; oracle asserts only the generic marker.
- HOME_PATH extra class: spec section 6 is AUSENTE (operator ruling), not testable.
- canonicalJson on NaN/fractions: B11 defines no behaviour for non-integers; upstream B4 BAD_INT and loadFixture shape checks guard it.
- loadFixture seq monotonicity / all kinds / private tier: B14 requires shape + residue + digest + counts only; B13 invariants are asserted on the committed fixture (I11).
Test seam note: R6 error-code asserts assume `lastSeq` is skipped, so a bad project yields exactly one error code.

## Repair loop 2 (review_hydrogen_r1, HOLD)

File: `repair2.test.ts` (R2-1..R2-7). Fake secrets are built at runtime by string concatenation.
Accepted:
- R2-1 KEY_ASSIGN with quoted key (`{"api_key":"..."}`, `{"password": "..."}`, `'my_token'`), B6 "NAME: value", B8 fail-closed.
- R2-2 KEY_ASSIGN value with an escaped quote (`PASSWORD="abc\"def_secret"`): B6 "only the value is replaced" means the whole value.
- R2-3 URL_CREDS with `]` in user or password.
- R2-4 quoted BEARER token (B6 `Bearer <token>`).
- R2-5 `-0` for `ts`/`sourceSeq`: rejected or normalised to `+0` (B11 integers; canonicalJson would serialise 0).
- R2-6 `replayDigest` order invariance when sort tuples tie (B12 "invariant to input order"; eventId is the only available tie-break).
- R2-7 HOME_PATH: STAYS. Spec amendment by orchestrator (privacy-first default; SPEC section 6 PII policy was AUSENTE). `pii_home_paths.test.ts` is kept; R2-7 adds `C:/Users`, end-of-text and dotted-username cases. Spec text (section 2 RedactClass / section 6) should be amended to include HOME_PATH.
Rejected:
- canonicalJson on non-integers (`1.5`, `NaN`): B11 defines no behaviour for direct calls; guarded upstream by B4/B14 (same as loop 1).
- `validateManifest` unknown fields on `manifest.projects[i]`: B14 specifies shape checks for events and digest/counts only; no rule rejects extra manifest keys.
- `normalise` third argument `opts`: documented I4 seam above, not a spec violation and not observable by a behavioural test.
- Test-gaming remark (`opts.redactFn`): implementation matter.

## Repair loop 3 (review_sol, HOLD)

File: `repair3.test.ts` (R3-1..R3-4). Fake secrets built at runtime by concatenation; HOME_PATH redaction stays per orchestrator decision.
Accepted:
- R3-1 `reg.lastSeq` throwing must reject (B4: forwarding requires `sourceSeq > lastSeq`; unavailable evidence cannot satisfy it). No specific code asserted (spec fixes none).
- R3-2 B8 "residue check re-runs every class on the output": via the documented identity `redactFn` seam, quoted assignment keys (`"password"`, `'my_token'`), quoted/single-quoted BEARER tokens and `]` in URL user/password must give `REDACT_RESIDUE` (the classes B6 replaces must also be detected). Marker-exempt control included.
- R3-3 B11/B12 deterministic SHA-256 across hosts: `digestHex` equals node SHA-256 over UTF-8 with and without `TextEncoder` (stubbed), including terminal/lone surrogates (native replaces with U+FFFD).
- R3-4 B8 "No original text is retained anywhere in U08 output or errors": unknown property names carrying secret-shaped text must not appear in `errors[].path`; `html` still reported at path `html` (I5). Asserted only on absence of the secret, not on the replacement path text.
Rejected: none (all four findings are supported by B4/B6/B8/B11/B12).

## Repair loop 4 (fuzz)

File: `redaction_fuzz.test.ts` (seeded mulberry32 PRNG, no deps; every fake secret assembled at runtime). Matrix: 23,548 generated cases = 10 classes x ~50-230 variants x 26 contexts (quotes ' " `, brackets, JSON/YAML/env/CLI, string start/end, multiline, unicode neighbours, case variants) + 700 multi-secret lines + 10 classes x 256 straddles of the 2000-char cap (+emoji parity) + the review's 8 concrete inputs. Unicode lookalike separators are not generated: the spec does not require catching them.
Invariants: A) `normalise` accepted => no secret in any field and `hasRedactResidue(text)` false, rejected => errors never echo it; B) if `redact().text` still holds a secret, `hasRedactResidue` must be true; C) `redact().text` holds no secret.
Result vs current `src/ingest`: existing 141 tests pass; fuzz file 147 failing `it`s. Variants tagged `[robust]` are common real-world shapes of a spec class, the rest are named by B6.
Failing classes (A/B/C all leak unless noted):
- EMAIL (1430 cases): any 3+-label domain is eaten by `jwt` first, leaving `local@[REDACTED:JWT]`; residue says clean (review #2). Also special local chars (`'` `!` `&` `=` `?` ...) leave a local-part prefix [robust].
- KEY_ASSIGN (950): dotted names swallowed by `jwt` (review #1, `config.db.password=...`); unterminated `"`/`'` value leaks words after the first space (review #3); real newline inside quotes; escaped quote inside quotes; backtick value with spaces; `:=`, `=>`, double-encoded JSON `{\"password\":\"v\"}`, `'name': 'v'` [robust]. Also 350 rejects (fail-closed, not a leak).
- PRIVATE_KEY (208): hyphenated header `RSA-PSS`, `EC-P256` (review 4b) [robust].
- URL_CREDS (156): `@` in userinfo, `@` in password, empty user `redis://:pw@` [robust].
- HOME_PATH (546): `C:\\Users\\u` (JSON-escaped), `c:\users`, `C:\USERS`, non-ASCII username tail [robust].
- MULTI (270) inherits the above. @cap: EMAIL, HOME_PATH, KEY_ASSIGN, URL_CREDS, PRIVATE_KEY leak the same way at the cap boundary.
- Non-leak finding (B7/B14): truncation right after a marker (`key: [REDACTED:X]…`) yields accepted text with `hasRedactResidue` true (ellipsis defeats the marker exemption): API_KEY 60, APPCHECK_DEBUG 70, KEY_ASSIGN 96, JWT 4 cases.
Clean: BEARER, JWT, HIGH_ENTROPY, APPCHECK_DEBUG, API_KEY (no leaks; API_KEY/APPCHECK reject 120/580 cases fail-closed).

## Repair r5 (hydrogen-api review; threat model DISP_03)
New file: `redaction_fuzz_r5.test.ts` (seeded PRNG, fake secrets built at runtime). Against current impl: 10 red of 93 new (all KEY_ASSIGN); 515 pass incl. all existing; tsc clean for the file. Matrix: all 9 B6 classes x 8 encodings (d0 raw, d1/d2/d3 JSON escape depth, shell single-quoted, shell double-quoted, shell $'...', shell-dq of d1) + JSON-in-JSON (2 and 3 levels); KEY_ASSIGN also x 4 names x 4 separators x 10 value bodies (`\n \t \/ A \\n`, real NL/tab, spaces, escaped quote, bare) x quote kinds, plus the review's two literal inputs.
Accepted (BLOCKING, DISP_03 item 1, privacy leak + B8): KEY_ASSIGN double-escaped quote bypass at `redact.ts:55,152`. Note: the review's suggested regex fix turns the review inputs and d1 green but leaves d2/d3, JSON-in-JSON, shell-sq (`'\''`) and escaped-quote-inside-escaped-quote red (depth-aware closing delimiter needed). Other 8 classes are green at every depth.
Rejected as NON-BLOCKING (no test): B7 `)`/backtick marker exemption, BEARER backtick/space-quoted tokens, `validateManifest` `projects[i]` hygiene/extra keys, spec-sync drift (HOME_PATH, `opts`).

## Repair r6 (hydrogen-api review r5; threat model DISP_03; file `redaction_fuzz_r6.test.ts`)
Against current impl: 26 red of 82 new (all KEY_ASSIGN and BEARER; other 7 classes green incl. marker-prefix and escaped wrappers); 598 pass incl. all existing; tsc clean for the file. Fake secrets built at runtime (seeded PRNG).
Accepted (BLOCKING, DISP_03 1 + 5): (1) KEY_ASSIGN escaped inner quote at depth >= 1 followed by delimiter (space/comma/semi/}/]/tab/nl/comma-space/ellipsis; double- and single-quoted; raw and literal-d1 docs x 8 encodings + json-in-json 2/3 levels; review exact input); (2) BEARER with `\"`, `\\\"`, `\'` quoted tokens (+ lowercase/tab, tails, JSON-wrapped) x all encodings; (3) quoted marker-prefix bypass `PASSWORD="[REDACTED:X] secret"` (tags X, lowercase x, KEY_ASSIGN, class, HIGH_ENTROPY; quotes ", ', `, escaped; unquoted control) for every one of the 9 classes x all encodings. Invariants C/B/A as in r5; plus redact() must count the redaction and report KEY_ASSIGN/BEARER for the review inputs.
NON-BLOCKING (recorded, no test): dead branch in `nextIsDelimiter` (redact.ts:76-82, style); `HOME_PATH` RedactClass spec drift (§2/§6); `normalise` extra `opts` param (`redactFn` test seam, I4).
Note: the oracle pins behaviour (no leak, residue agreement, fail-closed), not the review's suggested regexes.
