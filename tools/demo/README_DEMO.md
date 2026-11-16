# Context Wall: local end-to-end demo (no Firebase project)

Room `events.jsonl` → `bridge.wall` native host → extension SW → wall page (Vite dev), and back:
wall chat → SW → native host → room `question` event. SPEC_U37, "Local demo without Firebase".
A second half exercises MCP v2 planning: an agent creates a plan over stdio JSON-RPC and the wall
renders the plan band and the Memory view.

## Run

```
node tools/demo/run_demo.mjs            # cwd = repo; real window if DISPLAY is set
node tools/demo/run_demo.mjs --headless # headless=new
node tools/demo/run_demo.mjs --keep     # leave Chrome + Vite running afterwards
node tools/demo/run_demo.mjs --no-mcp   # skip the MCP v2 planning + Memory step
```
Set `TASKLIGHT_DEMO_DIR` to choose the working directory; `--dir` overrides it. Flags: `--dir`, `--headless`, `--keep`, `--no-mcp`.
Chrome is discovered from the `CHROME` env var, then `google-chrome`, `google-chrome-stable`, `chromium`,
`chromium-browser`, `microsoft-edge`, `brave-browser` on PATH, then macOS app bundles; a clear
"browser not found" error is printed when none exists.
Exit code 0 means plan rendered, the drift chip (Rules) showed, a `question` from `wall-user` reached the room, and — unless `--no-mcp` — the MCP `plan_create` plan and the `Memory` view both rendered.
Everything lives in `--dir` (default `$TASKLIGHT_DEMO_DIR`, else `<os tmpdir>/tasklight-demo/`): `profile/` (throwaway Chrome profile with
`NativeMessagingHosts/com.contextwall.bridge.{json,host.sh}`), `cwhome/` (CW_HOME), `keys/` (demo RSA key pair, 0600),
`ext/` (built extension), `wall.config.json`, `logs/` (`run_demo.log`, `pids.json`, `vite.log`, `chrome.log`,
`native_host.stderr.log`, `page_console.log`, `room_events.json`, `summary.json`), `shots/` (`1_plan.png`, `2_drift.png`, `3_chat.png`, `4_plan_v2.png`, `5_memory.png`).

## Steps the script runs
1. Demo key: RSA-2048 under `keys/`. The public key (base64 DER SPKI) goes into the BUILT manifest only; id = sha256(DER)[:32] mapped 0-f → a-p.
   The `key` in `extension/manifest*.json` is not a valid public key (96 bytes, OpenSSL cannot parse it).
2. `node extension/build.mjs --manifest dev --key-file keys/demo_pub.b64 --out ext` (Vite build API, IIFE bundles).
3. `python3 tools/demo/setup_native.py …`: wall config with `rooms.allow=[{room:"demo",tier:"private"}]`, launcher
   (`cd repo && python3 -m bridge.wall host --config …`), host manifest with `allowed_origins=[chrome-extension://<id>/]`.
4. `bridge.room post --act open` (creates the room directory).
5. Vite dev (`tools/demo/vite.demo.config.ts` = hosting config + stylesheet `<link>` tags) on 127.0.0.1, browsed as `http://localhost:<port>/`
   The stylesheet list is parsed from `hosting/src/main.ts` with `tools/demo/demo_lib.mjs` (`parseStylesheetImports`),
   so the demo always links tokens, wall, views, plan, model_selector and agents in app order
   (the dev manifest's `externally_connectable` lists `http://localhost/*` only), `VITE_EXTENSION_ORIGINS=chrome-extension://<id>`.
6. Chrome discovery via `CHROME` or PATH app bundles, `--user-data-dir=profile --remote-debugging-port
   --enable-unsafe-extension-debugging`, CDP `Extensions.loadUnpacked`.
7. Open the wall, post plan v1 live, screenshot; step 0 `active`, plan v2 that rewrites step 0, screenshot (drift chip shows `Rules`); click the task `button.task-chat`, type into `textarea.chat-input`, click `button.chat-send`, check `bridge.room read --json`, screenshot `3_chat.png`.
8. MCP v2 (skipped with `--no-mcp`): spawn `python3 -m bridge.room.mcp` with the demo `cwhome` as `CW_HOME`, then `plan_create` (template `web-app`, 3 tasks), `task_claim`, `microtask_set` to `done`, and `memory_set` (`architecture`). Wait for the wall to show the plan title and the `Memory` view entry, screenshot `4_plan_v2.png`, open the Memory view, screenshot `5_memory.png`. The summary gains `planV2` and `memory`; exit code 0 needs plan, drift, question, planV2 and memory.
9. Stop the process groups it started. `--keep` leaves them up.

## Known gaps
- Fresh-page replay still has a handshake race: the native host announces `room_hello` at startup and the
  extension only fans it to already-subscribed ports, so a late page can miss the announcement; the page-side
  repair depends on receiving it (covered by a separate unit, not claimed fixed here).
- Replay stops after the first page: the relay caps a sync at 500 events and the page has no continuation
  for `room_synced.more`, so large rooms need a paging fix.
- Service-worker startup can run twice (`sw_main.ts` starts on import and the generated entry calls
  `startSwMain` again), leaving two workers competing for extension ports.
- Custom templates loaded from `CW_HOME/templates/` have no wall metadata entry, so unwritten required
  Memory sections never render as empty-required; the MCP `web-app` template path used by this demo is covered.

# Tasklight: ViewPoint agents on the wall (`run_tasklight.mjs`)

This command runs the same local wall pipeline as `run_demo.mjs`. It allows the rooms `viewpoint` and `demo` and adds the U40 observer, `python3 -m bridge.viewpoint watch --root R --room viewpoint --interval 0.5`.

```
node tools/demo/run_tasklight.mjs --check [--headless]     # readiness table; exit 1 on any FAIL
node tools/demo/run_tasklight.mjs --replay [--headless]    # 4 synthetic runs -> wall; screenshot shots/replay.png
node tools/demo/run_tasklight.mjs --viewpoint              # observe the REAL default runs root (read-only), until Ctrl-C
node tools/demo/run_tasklight.mjs --viewpoint --no-observer # wall only: cards come from cooperative agents (context-wall MCP)
node tools/demo/run_tasklight.mjs --stop                   # stop what a previous --keep run started
```

Options:

| Option | Effect |
|---|---|
| `--dir D` | Working directory. Default: `$TASKLIGHT_DEMO_DIR`, else `<tmpdir>/tasklight-demo` |
| `--port N` | Vite port. 5998 is refused |
| `--speed X` | Replay time scale. `2` is twice as fast |
| `--root D` | Runs root |
| `--cw-home D` | CW_HOME to use |
| `--keep` | Leave the processes running |
| `--exit` | Windowed `--replay` exits after its check |
| `--duration S` | Headless `--viewpoint` stays up for S seconds (default 5) |
| `--history` | `--viewpoint` repaints runs that existed before the start (default: `--prime`) |
| `--ext-dir D` | Use a prebuilt unpacked extension instead of running `extension/build.mjs` |
| `--no-observer` | `--viewpoint` only: do not start the U40 observer. Use it when agents post their own cards through the `context-wall` MCP server (`post_plan`, `post_step`, `close_task`), so each capsule shows one card. The start line prints `mode=viewpoint (cooperative only, observer OFF)` or `(observer ON)` |
| `--shots N` | `--viewpoint`: save a screenshot every N seconds to `<dir>/shots/live_<HHMMSS>.png`; `--stop` also ends the runner |

What the `--check` rows test:
- display: refuses DISPLAY `:98`. In headless mode, DISPLAY is removed for child processes.
- node 22 or later, and Chrome.
- vite: installed, and the port is free.
- extension id: from the demo key.
- native host manifest: written into the throwaway profile. It asserts `rooms.allow` holds `viewpoint` and `demo`, and that the launcher is executable.
- CW_HOME: which one is used.
- observer: the import, a construct + poll on an empty temp root, and `watch --once` (rc 99 means the U40 stub).
- replay writer: `--once` into a temp root writes 4 runs, and the real root is refused (rc 3).
- MCP: `bridge.room.mcp` answers `initialize` and `tools/list`, and lists `post_plan`, `post_step` and `post_status`.

What the run modes do:
- `--replay` and `--viewpoint` run the same table first and refuse to start if any row FAILs.
- Run order: build the extension, start Vite and Chrome, load the extension over CDP, open the wall, start the observer, then (replay only) run `tools/demo/vp_replay.py`.
- The observer starts only after the wall page has linked, because history is not replayed to a fresh page.
- `--replay --headless` exits 0 when all of these hold:
  - the replay rc is 0;
  - room `viewpoint` holds 4 tasks, agents `arxiv-agent`, `github-agent`, `gemini-agent`, `wikipedia-agent`,
    titled `<Capsule> · <goal>` (U42);
  - each task has at least 3 steps and a `close`;
  - the wall text shows all 4 goals;
  - (U42) the card summaries carry no raw `(rc N)` verdict, no card says "Waiting for a plan", and the chat drawer is closed.

U42 labels (observer): the capsule comes from the goal, then the target name, then any url/href/host field in the run JSON
(A-U42b: arxiv → arXiv, gemini / deepmind.google → Gemini, github → GitHub, wikipedia → Wikipedia; plan B mdn /
developer.mozilla.org → MDN, plan C hugging face / huggingface.co → Hugging Face; no match → title is the bare goal, agent `viewpoint-agent`). The agent is `<capsule>-agent`; overlapping runs of one capsule get
`-2`, `-3`. A goal (or an MCP `post_plan` title) that already starts with `[<Capsule>]` is kept as is. The wall turns a
`<CODE> (rc N)` close into "Completed — all steps verified", "Stopped — a step was blocked" or "Failed (<CODE>)"; the raw
code stays in the last step's detail (or its note when that step is blocked).

Output files are in `--dir`:
- `logs/run_tasklight.log`
- `logs/tasklight_check.json`
- `logs/tasklight_summary.json`
- `logs/observer.log`, `logs/replay.log`
- `logs/tasklight_pids.json`. It records each pid with its start time, so `--stop` never signals a reused pid.
- `shots/replay_mid.png`, `shots/replay.png`

CW_HOME:
- `--replay` and `--check` use the throwaway `<dir>/cwhome`. Replay resets only the room `viewpoint` and the observer cursor there.
- `--viewpoint` uses `$CW_HOME`, else `~/.context-wall`, so cooperative agents posting through the `context-wall` MCP server reach the same wall. See `ANTIGRAVITY_SETUP.md`.

Hard rules:
- The launcher refuses DISPLAY `:98`, port 5998, and a replay root under `/dev/shm/vqa-cu`.
- It never starts ViewPoint or MetaViewer and never uses a real Chrome profile.
- It stops only the process groups it started.

## Replay fixture (`vp_replay.py`, stdlib)

`python3 tools/demo/vp_replay.py [--root D] [--speed X] [--once] [--seed N] [--quiet]` writes 4 parallel runs over about 20–30 s with jitter. The default root is `$TASKLIGHT_DEMO_DIR/vp_runs`.

| Capsule | Goal (verbatim) | Steps |
|---|---|---|
| arXiv | Search arXiv for AI agent | 5; the last is blocked, and the report has rc 1 (`BROWSER_STEP_BLOCKED`) |
| GitHub | Search GitHub for context wall | 4, all verified |
| Gemini | Open the Gemini models page on deepmind.google | 3, all verified |
| Wikipedia | Search Wikipedia for Google DeepMind | 3, all verified |

Each step writes four files: `intent-<pid>.json`, `dispatch-mw-<pid>.json`, `receipt-<pid>.json` and `readback-<pid>.json`. Each run ends with `moves.json` and `report.json`.

How the files are written:
- The schema follows `strategy/night/N0_viewpoint_schema.md`.
- Every write is atomic: a hidden `.tmp` file, fsync, then rename. The observer never sees a partly written `*.json`.
- `action.text` values are harmless sample strings.
- Any root under `/dev/shm/vqa-cu` is refused with exit code 3. The refusal is a string check first, so nothing in that tree is read.

## Known gap (14 Nov, 01:25)
`extension/build.mjs` currently fails with "sw.ts boot block not found":
- The U38 integration removed the `sw.ts` self-boot block.
- `build.mjs` still requires that block, so it can strip it.
- This breaks `run_demo.mjs` and `run_tasklight.mjs --replay|--viewpoint`. `--check` is not affected.

The fix belongs in `extension/build.mjs`: in the `cw-sw-entry` transform, return `null` when `SW_BOOT_RE` does not match, instead of throwing. Until then, build the extension elsewhere and pass `--ext-dir`.
