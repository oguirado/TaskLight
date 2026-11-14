# U20 oracle (UI shell, onboarding, states, a11y, lens switcher)

Run: `npx vitest run tests/unit/u20`. Stubs in `src/ui/*` throw `U20 stub`; `styles/*.css` are comment-only. Baseline: 140 tests, 121 RED, 19 green (negative static scans pass vacuously; the guard "sources exist / not a stub" is what fails). `tsc` clean for `src/ui` and `tests/unit/u20` (pre-existing errors in `src/ai` are unrelated).

| File | Pins |
|---|---|
| state.test.ts | O1 precedence (B1), O3 progress (B2), O4 CTA (B3), B4, B8 table `BANNER_TEXT` (9 distinct non-empty) |
| announcer.test.ts | `UI_LIMITS`, O10/O11/O14, B14/B15 (<=1 flush/s, latest per key, FIFO, bound 12, truncate 160, dedupe, textContent) |
| keyboard.test.ts | O8, B12, B13 (roving tabindex, clamp, columns<=4, Home/End/Enter) |
| caps.test.ts | O12 `withReducedMotion` |
| onboarding.test.ts | O2, B5-B7 (native button, trusted-only, dedupe, no activate on load/focus/timer, Continue-with-cloud, progressbar ARIA, copy 4 GB/16 GB/22 GB/minutes/cloud) |
| shell.test.ts | banner+badge per mode, O5-O7, O9, O11, O13, lens switcher (B33/A13), plan rows (B34/A13, 0 createElement), template-editor entry (B35), tab order, motion/theme, no inline style, runtime innerHTML spies, dispose |
| static.test.ts | file list, forbidden-API/import scan of `src/ui/**` (comments stripped), `capsuleTemplate()` builds a real U11 renderer, O15 token parity + 4.5:1 contrast + no hardcoded colours in wall.css, reduced-motion CSS |

## Oracle decisions beyond the spec (flag if the spec owner disagrees)
- D1 Shell hooks: root contains a host-provided `[data-wall-container]` (the U11 renderer container); shell sets `role=list` on it, `role=listitem` + roving `tabindex` on cards (via `locator.nodeOf`), and inserts regions before it: `[data-region]` = `onboarding`, `lens-switcher`, `tools`, `wall` (Tab order in that sequence).
- D2 Hooks (data attrs): `[data-role=wall-banner]` + `data-mode`; `[data-role=wall-badge]` + `data-mode` ("On device", "Cloud fallback"); `[data-role=enable-cta]`; `[data-action=continue-cloud]`; `[role=progressbar]`; one `[aria-live]` region (aria-live set to the politeness at flush, aria-atomic=true); `[data-role=focus-banner]`; `[data-role=status-legend] [data-status]`; `button[data-lens=all|dev|study]` with `aria-pressed`; `[data-action=open-template-editor]`; `[role=alert][data-role=template-error]`. Hidden = `hidden` attr or class `is-hidden` (self or ancestor).
- D3 Card writes: status/attention/stale/inference_source go through `renderer.enqueue` (integer rev); badge text ("On device"/"Cloud"/"Private: unavailable") and "Stale" go to pooled slots `badge` / `stale_badge` via textContent. Plan rows write into pooled slots `step_1..step_5` (text + `data-state`), extra rows get class `is-hidden`; max 5. U11 has no `steps` PatchField: AUSENTE, so this bypasses the renderer queue (no node creation).
- D4 `CapsuleCardView` gains `lens_id: string` (B33); `status` is typed `CapsuleStatus` yet study uses other statuses (tests cast). Spec gap: a lens-aware status type. Unknown `lens_id` => hidden.
- D5 New API (not in SPEC_U20): `WallUi.setFilter/setPlan/setTemplateEditorEnabled/reportRenderError/state`, `UiOptions.onOpenTemplateEditor`, `createOnboarding(panel, device)`, `BANNER_TEXT`, `limits.ts` (`UI_LIMITS`), `PlanStep`.
- D6 Announcer: first `say` flushes immediately; later ones wait for `lastFlush + 5000` (queue FIFO, one per flush, per-key latest wins, drop oldest key when >12 queued). 14 distinct keys => flushed t1,t3..t14 (t2 dropped). Progress announced on crossing 25/50/75/100 (text contains the boundary number).
- D7 Keyboard: cursor starts on the first card after `setOrder` (`focused()==="p1"`); Escape handled by the shell (focus to wall container); keydown on the focused card is routed to `handleKey`; focus follows the cursor.
- D8 Reduced motion: `withReducedMotion` toggles `ui-reduced-motion` on `document.documentElement` (no root arg in its signature); the shell also toggles it on `opts.root`. Theme: shell sets `data-theme` on `opts.root`.
- D9 CSS: required tokens `--color-bg|surface|text|text-muted|accent|danger|warning|ok` as 3/6-digit hex in both themes; `--motion-duration` outside theme blocks; `.ui-reduced-motion { --motion-duration: 0ms }` and a `prefers-reduced-motion: reduce` block; wall.css must contain `.is-stale`, `.is-hidden`, `:focus-visible`.
- D10 Conflict left untested: B3 (CTA false for `failed`) vs section 4 ("failed -> no_model with retry CTA"). Detail leak is tested; retry CTA is not.
- D11 `src/ai` import is not scanned (spec forbids it; task allows status enums): only `firebase/*` and `src/sync` are banned.

## AUSENTE (not tested)
Banner copy beyond `BANNER_TEXT` and "Cloud disabled"; governor T3 "Reduced effects" hint; lens-switcher accessible name; `matchMedia`/`onLine` bindings; responsive column count.

## Oracle amendment A3-U20
`click(el, trusted)` no longer redefines `isTrusted` (throws in jsdom). Trusted events are recorded in a module-level `WeakSet`; `trustPredicate` is exported and passed as `isTrusted` via `UiOptions` (harness) and `createOnboarding(panel, device, { isTrusted })`. Added two tests that, without the option, the default `ev.isTrusted` applies (synthetic click -> 0 activations). All other assertions unchanged.

## Repair loop 1
File: `review1.test.ts` (REVIEW_1 BLOCKING findings, filtered by DISP_03).
Included (all classified BLOCKING by DISP_03 #2/#3/#4/#5; inputs are real or injected-port values, JSON-producible):
- R1-1 DevicePort rejection / sync throw on CTA click (#3, #4) -> no unhandled rejection, no escaping error; dedupe kept.
- R1-2 announcer latest-wins per key (B14, #5).
- R1-3 announcer identical-consecutive suppression across keys, without eating an interval (B14, #5).
- R1-4 `progressPct` null outside `downloading` for offline/booting/blocked/kill_switch (B2, #5).
- R1-5 private capsules never show cloud badges; badge refreshed when `privateAvailable` changes without `setCapsules` (B4, #5; privacy tier).
- R1-6 stale patch -> `is-stale` + `data-stale` through `capsuleTemplate()` with the real U11 renderer (B10, #5).
- R1-7 reduced-motion listener leak (#4). The cleanup API name is AUSENTE in spec: the test accepts any of dispose/destroy/close/unsubscribe/cleanup/off/detach on the returned `FrameCaps`; also asserts shell `dispose()` releases motion/theme listeners.
Skipped: none of the 7 findings. The "test gaming" remark in REVIEW_1 required no test. Fabricated hostile objects (Proxy, getters, non-string Error messages): none were listed, none written.
Assumptions: for R1-6 the finding may be already satisfied by the U11 renderer (class rule on `stale` also writes `data-stale`); the test then acts as a pure regression guard.
