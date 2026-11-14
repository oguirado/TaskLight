# U38 oracle (SPEC_U38): demo gaps and visual polish

Fail-first tests; no implementation. Run: `npx vitest run tests/unit/u38`, `python3 -m unittest bridge.tests.wall.test_install_u38` (from repo/).
Shared helpers: `helpers.ts` (time, fixtures, a small CSS parser/cascade). `Event.isTrusted` is never redefined.

| Gap | File | Observable contract (names chosen by the oracle) |
|---|---|---|
| G1 | g1_replay | After `room_hello`, the `room_sync.since` = every hello room mapped to `since()[room] ?? 0`; latest hello wins; invalid room entries skipped. Pre-hello sync (after snapshot) unchanged. |
| G2 | g2_sw | `extension/src/sw.ts`: no `site.test`, no module-level boot (importing it with a chrome global registers nothing). `sw_main.ts` boots on import when `globalThis.chrome` exists (inert without it), gate = `chrome.runtime.getManifest().externally_connectable.matches`; exactly one external listener and one native port. |
| G3 | bridge/tests/wall/test_install_u38.py | Launcher text carries the repo root (not only `bridge/`); run from an unrelated cwd with a `bye` frame it emits `hello` then `room_hello` (relay loaded). Existing `-I`/`wall`/`host` tokens stay. |
| G4 | g4_styles | Either `hosting/index.html` `<link rel=stylesheet>`s or css imports in `hosting/src/main.ts`: tokens, wall, views, agents in that order, same-origin, all resolving to real files. |
| G5 | g5_user_hidden | `WallOpts.userAgent?: string`; `toWallVM` builds no task for it (`agent_wall` passes it). Wall DOM shows no user card/text and counts only agent tasks. User messages only in the chat of `to`; no `to` -> no chat. |
| G6 | g6_manifest | `manifest.dev.json` `key`: absent, or base64 DER SPKI (RSA) parsed by `crypto.createPublicKey`; no private key text. |
| V1 | v1_timestamps | `ChatMessageVM.at`, `WallVM.now`, `TaskVM.updated` are `HH:MM` (today) / `Yesterday HH:MM` / `D Mon HH:MM` (local time, English month); no ISO in wall or chat DOM. |
| V2 | v2_progress | `.progress-fill` `--p`: 0 done of 3 = `0%`, 1 of 3 = `33%`, all = `100%`; task with no steps renders no `.progress-fill`; in the hosted cascade the `.progress-track` background resolves to `--c-progress-track` (not `--color-ok` from wall.css). |
| V3 | v3_source_chip | Chip `Rules` (no `.source-ms`, no Gemini/ms text) for `{device,0}`, `{cloud,0}` and `{kind:"rules"}` (new `SourceKind`); `Gemini Nano · on device` / `Gemini · cloud fallback` + ms only when ms > 0. Agent tasks from events render Rules everywhere. |
| V4 | v4_boot_controls | `hosting/src/main.ts` places `.boot-controls > button.boot-btn` x2 ("Sign in with Google", "Download device model", `type=button`) inside `.rail-status`, surviving wall re-renders, no raw button under `#wall`. CSS: `.boot-btn` (color, background, border, radius from tokens, no hex), `:hover`, `:focus-visible`, `.boot-controls`. |
| V5 | v5_model_label | Rail `.status-line[data-model] .status-text` reads `Gemini Nano: checking…` when the wall mount has no model information (empty and populated store). |
| V6 | v6_drawer | `startAgentWall` sets on `chatHost`: class `chat-drawer`, `data-open="true"` when a target agent exists (not `true` without one), role `complementary`/`dialog` + aria label; the chat Close button sets `data-open="false"` (add `onClose` to the chat handlers). CSS (agents.css/views.css): `.chat-drawer` base = fixed bottom sheet (left/right/bottom 0, max-height, z-index, overflow-y auto); `@media (min-width: 1100px)` = right drawer (top/bottom/right 0, left auto, width or max-width, max-height none/100vh); `[data-open="false"]{display:none}`; tokens only (no hex, every `var()` defined in tokens.css); `.chat-drawer .agent-chat` resets `max-width:none|100%` and `margin 0`; transitions disabled under reduced motion. |

Existing suites that encode the old behaviour (u37b `at` ISO strings, u36 chip text for ms 0, u37c wall chat mount, `build.mjs` boot-block strip) will need the matching amendments when U38 lands; this oracle does not touch them.

## Oracle amendment A-U42

- V4: with the placeholder Firebase config (what this suite loads) the boot buttons are hidden; `v4_boot_controls`
  now asserts none are shown and that the "Gemini Nano: checking…" line stays. The real-config placement contract moved
  to `tests/unit/u42/boot_controls.test.ts`; CSS checks unchanged.
- V6: the drawer starts closed (`data-open="false"`) even when an agent exists and opens when the user clicks a task card
  or its `button.task-chat`; `v6_drawer` clicks the Chat button before asserting it is open. Close still closes.
