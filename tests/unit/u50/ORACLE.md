# U50 oracle (fail-first)

Targets: `src/config/keys.ts` (+ `types.ts`). Stubs `parseProviderFlags`, `externalProvidersPolicy` throw `U50 stub`; types, `PROVIDER_FLAG_DEFAULTS` (true/true) and `PROVIDER_FLAG_SPECS` are final per SPEC_U50 Amendment W0-R. Files: `flags.test.ts`, `static.test.ts`.
Result: 68 tests in u50 (60 red, all `U50 stub`; 8 green by design: static + constants shape), u16 110 green (5 files), `tsc` clean for `tests/unit/u50` and `src/config`.

## Coverage
O1 defaults/specs (frozen), O2 parse (exact true/false, 15 bad values x default/prev, throwing getter, per-key independence, hostile non-string results), O3 8-row matrix against an independent reference plus literal table, O4 end-to-end defaults `{true,true}`, O5 u16 tables keep 20 keys, O6 purity, static guards (P4: no URLs/names/keys, no side effects, index re-export, `WallConfig` untouched).

## Judgement calls (confirm or amend)
- J1 Oracle 3 `kill:true` rows give `{local: external, remote: false}` (W0-R).
- J2 Non-string getter results (undefined, null, number, object) -> `INVALID_KEPT` with default/prev, never throw. Spec only mentions `""`/strings.
- J3 Throwing getter: warning has no `raw` property at all (`"raw" in w` is false).
- J4 Bad values include whitespace variants (`"true "`, `"\ttrue"`, `"true\n"`); no trimming.
- J5 Defensive policy inputs (`undefined`, `"true"`, `1`, `{}`) count as false for each flag independently.
- J6 Returned `flags` is a fresh object (not the frozen defaults); returned policy is fresh and frozen per call.
- J7 Warning order is not pinned (compared by key or by code only) except single-warning cases.
- J8 Static guard slices `keys.ts` from the first `PROVIDER_FLAG_DEFAULTS` occurrence; it forbids `localhost`, `openai`, `anthropic`, `ollama` and `https?://` in that slice, comments stripped.
- J9 Oracle 7 (`tsc` clean, u16 not worse) is verified by the run commands, not by a test.
