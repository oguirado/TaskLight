# Context Wall: local end-to-end demo (no Firebase project)

Room `events.jsonl` → `bridge.wall` native host → extension SW → wall page (Vite dev), and back:
wall chat → SW → native host → room `question` event. SPEC_U37, "Local demo without Firebase".

## Run

```
node tools/demo/run_demo.mjs            # cwd = repo; real window if DISPLAY is set
node tools/demo/run_demo.mjs --headless # headless=new
node tools/demo/run_demo.mjs --keep     # leave Chrome + Vite running afterwards
```
Set `TASKLIGHT_DEMO_DIR` to choose the working directory; `--dir` overrides it.
Exit code 0 means plan rendered, the drift banner showed "Reviewed by rules", and a `question` from `wall-user` reached the room.
Everything lives in `--dir` (default `$TASKLIGHT_DEMO_DIR`, else `<os tmpdir>/tasklight-demo/`): `profile/` (throwaway Chrome profile with
`NativeMessagingHosts/com.contextwall.bridge.{json,host.sh}`), `cwhome/` (CW_HOME), `keys/` (demo RSA key pair, 0600),
`ext/` (built extension), `wall.config.json`, `logs/` (`run_demo.log`, `pids.json`, `vite.log`, `chrome.log`,
`native_host.stderr.log`, `page_console.log`, `room_events.json`, `summary.json`), `shots/` (`1_plan.png`, `2_drift.png`, `3_chat.png`).

## Steps the script runs
1. Demo key: RSA-2048 under `keys/`. The public key (base64 DER SPKI) goes into the BUILT manifest only; id = sha256(DER)[:32] mapped 0-f → a-p.
   The `key` in `extension/manifest*.json` is not a valid public key (96 bytes, OpenSSL cannot parse it).
2. `node extension/build.mjs --manifest dev --key-file keys/demo_pub.b64 --out ext` (Vite build API, IIFE bundles).
3. `python3 tools/demo/setup_native.py …`: wall config with `rooms.allow=[{room:"demo",tier:"private"}]`, launcher
   (`cd repo && python3 -m bridge.wall host --config …`), host manifest with `allowed_origins=[chrome-extension://<id>/]`.
4. `bridge.room post --act open` (creates the room directory).
5. Vite dev (`tools/demo/vite.demo.config.ts` = hosting config + `styles/*.css` links) on 127.0.0.1, browsed as `http://localhost:<port>/`
   (the dev manifest's `externally_connectable` lists `http://localhost/*` only), `VITE_EXTENSION_ORIGINS=chrome-extension://<id>`.
6. Chrome 157 `--user-data-dir=profile --remote-debugging-port --enable-unsafe-extension-debugging`, CDP `Extensions.loadUnpacked`.
7. Open the wall, post plan v1 live, screenshot; step 0 `active`, plan v2 that rewrites step 0, screenshot; type into the chat with
   CDP `Input.*`, click Send, check `bridge.room read --json`, screenshot. Then stop the process groups it started.

## Known gaps found by the demo
- History is not replayed to a fresh page: `agent_link` sends `room_sync` with `since: store.since()`, which is `{}` until the
  store has seen a room, and `RoomRelay._handle_sync` replays only rooms named in `since`. `room_hello` lists the rooms but does not seed
  `since` with 0. Events posted before the page opened never show; the demo therefore posts plan v1 after the page links.
- `sw.ts` self-boots at module load with a `https://site.test/*` gate. Bundled together with `sw_main.ts`, that instance would disconnect
  every `http://localhost` port. `build.mjs` removes that boot block from the bundle only.
- The U09 launcher (`bridge/install.py`) puts only `bridge/` on `sys.path` and runs module `wall`, so `bridge.wall.room_relay`
  (`from bridge.room import store`) cannot import and the room relay stays off. `setup_native.py` uses `python3 -m bridge.wall` from the repo instead.
- Nothing links `styles/*.css` from `hosting/`; the demo config injects them.
- The wall shows the user agent (`wall-user`) as its own task card ("no plan yet", "needs input") after a chat message.

# Tasklight: ViewPoint agents on the wall (`run_tasklight.mjs`)

This command runs the same local wall pipeline as `run_demo.mjs`. It allows the rooms `viewpoint` and `demo` and adds the U40 observer, `python3 -m bridge.viewpoint watch --root R --room viewpoint --interval 0.5`.

```
node tools/demo/run_tasklight.mjs --check [--headless]     # readiness table; exit 1 on any FAIL
node tools/demo/run_tasklight.mjs --replay [--headless]    # 4 synthetic runs -> wall; screenshot shots/replay.png
node tools/demo/run_tasklight.mjs --viewpoint              # observe the REAL default runs root (read-only), until Ctrl-C
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
  - room `viewpoint` holds 4 tasks, agents `chatgpt-agent`, `gemini-agent`, `wikipedia-agent`, `arxiv-agent`,
    titled `<Capsule> · <goal>` (U42);
  - each task has at least 3 steps and a `close`;
  - the wall text shows all 4 goals;
  - (U42) the card summaries carry no raw `(rc N)` verdict, no card says "Waiting for a plan", and the chat drawer is closed.

U42 labels (observer): the capsule comes from the goal, then the target name (chatgpt/openai → ChatGPT, gemini → Gemini,
wikipedia → Wikipedia, arxiv → arXiv, else ViewPoint). The agent is `<capsule>-agent`; overlapping runs of one capsule get
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
| ChatGPT | Ask ChatGPT about on-device AI | 4, all verified |
| Gemini | Ask Gemini to compare hybrid inference | 4, all verified |
| Wikipedia | Search Wikipedia for Firebase | 3, all verified |
| arXiv | Find the latest arXiv paper on small language models | 5; the last is blocked, and the report has rc 1 (`BROWSER_STEP_BLOCKED`) |

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
