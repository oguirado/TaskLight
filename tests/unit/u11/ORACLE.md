# U11 oracle (render.test.ts, helpers.ts)

Run against stubs in `src/render/`: 46 tests, 45 RED, 1 green (baseline: valid template does not throw; a no-op stub also passes that).

| Case | Spec rule |
|---|---|
| O1 html literal (headline/summary/next_action) + boolean on text field | B3, O1, B4.6 |
| O2 off-allowlist field (innerHTML, outerHTML, style, onclick, href, __proto__, constructor) | B4.1, O2 |
| O3 injection-shaped class value; class token comes from classMap and swaps on change | B3, B4.6, O3 |
| attr writes allowed attr only; no style/href/src/on*; innerHTML/outerHTML/insertAdjacentHTML never invoked | B3 |
| O4 8/16/20 writes, pending 12/4/0, FIFO, endFrame args, auto-carry, beginFrame x3 | B7, B8, O4 |
| O5 coalescing (3 revs -> 1 write); queue bound = mounted x 8 | B5, O5 |
| O6 stale rev; equal rev accepted; stale before too_long | B4.4, O6 |
| O7 + warm-up: 16 ok / 17th pool_exhausted / no createElement, createElementNS, cloneNode; also across tick/unmount/remount | B1, O7, S4 |
| O8 budget stop (auto-advancing clock); budget 0 still applies 1 | B7, O8 |
| O9 no sync write; request once; re-request after drain | B6, O9 |
| unknown project; order field > project > rev > stale > length > value; bad_rev for -1/1.5/NaN/Inf; 120/121, 600/601 | B4 |
| Template validation (tag, duplicate slot, allowlist slot missing) | B2 |
| Unmount: detach, clear slots, return to pool, drop pending | B11 |
| Stale badge `is-stale` + `data-stale="true"` | B9 |

## Ambiguities / AUSENTE (assumptions encoded)
- How a mounted capsule is located in the DOM is AUSENTE: tests find nodes via `[data-slot="X"]`, indexed by mount order (= DOM order).
- Template root is assumed to carry `slot: 'root'` for the `stale` rule (class on root). Where `data-stale` is written is AUSENTE; tests search the whole container.
- `inference_source` value validation is AUSENTE (B4 has none); only the `data-source` write is tested.
- B10 (which "transition classes" are removed when effects off) is AUSENTE: not tested.
- Stale-rev comparison against pending (unflushed) revs is AUSENTE: only applied revs tested. Re-mounting an id: rev reset AUSENTE.
- `counters().deferred` cumulative vs per-tick semantics AUSENTE: not asserted.
- Clock reads per write are assumed to be the only budget input (auto-advance clock); implementations may read the clock extra times (assertion is 1..4).
- Status/attention enum values: fixture invents `ok|warn`, `low|high`.

## Repair loop 1
Added `repair1.test.ts` (13 tests; 11 fail on the current impl, 2 already hold: slow clock, budget 0). Covers: B5 older pending rev must not replace newer pending (stale_rev); B2/B3 allowlist with unknown key, invalid kind, attr outside AllowedAttr -> `RenderError('allowlist_invalid')`; B7 progress with `maxPatchesThisFrame()=0`, slow clock, budget 0; B10 asserted only through the public `caps.effectsEnabled()` call per tick (transition class name is AUSENTE).
Rejected: the reviewer's `ALLOWED_ATTRS` literal set and `no-effects` class name (not in spec); `poolCapacity` validation (spec gives default only, no error); direct class-removal assertion (class name AUSENTE).

## Repair loop 2
Added `repair2.test.ts` (reviewer r1 HOLD). Covers: B4.4 `lastAppliedRev` monotonic (rev 7 then pending rev 5 on another field must still reject rev 6); B3 class tokens per field (status + stale on one slot); B9 `stale` must be boolean (`'true'` -> `value_not_allowed`) and `false` restores/clears (`classMap.false` applied, `data-stale` removed); B10 effects false observable via public DOM (assumption: the spec does not name "transition classes", test uses the literal token `transition` in `staticClass`, with a true-effects negative control); B2 whitespace/empty `staticClass` -> `RenderError('template_invalid')`, bad `classMap` token -> `RenderError` at construction (code unspecified for classMap); `counters()` returns a copy (frozen copy tolerated).
Rejected: "classMap required for kind:'class'" and "valid maxChars for kind:'text'" (spec B2 lists only tags, duplicate slots, missing allowlist slots; `maxChars` is optional in the types, `classMap` optional too); reviewer "test gaming" finding is covered by the B10 observable test above rather than a spy assertion.
