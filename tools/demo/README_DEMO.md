# TaskLight local end-to-end demo

The demo connects a private room to the Wall through the native host, development
extension, and Vite. It exercises the retained Messages drawer and the shared
planning tools without a Firebase project.

## Run

From the repository root with dependencies installed:

```sh
node tools/demo/run_demo.mjs
node tools/demo/run_demo.mjs --headless --dir <fresh-directory>
node tools/demo/run_demo.mjs --headless --no-mcp --dir <fresh-directory>
node tools/demo/run_demo.mjs --keep
```

Use Node.js 22 or later, Python 3.10 or later, and a Chrome-family browser.
The demo uses Node to generate the extension key. It discovers browsers on
`PATH`, in macOS application bundles, and in Windows program and user
installation directories. Set `CHROME` to select a specific executable.
Pass `--headless` to run without a window. On Linux, an unset `DISPLAY`
also selects headless mode.
`--dir` overrides `TASKLIGHT_DEMO_DIR` and the default temp directory
`tasklight-demo`. Use a fresh directory for separate evidence from each run.

The directory holds the throwaway browser profile, room data, demo key, built
extension, Vite cache, and evidence. `logs/run_demo.log` records checks and
tool replies. `logs/room_events.json` and `logs/summary.json` record the room
events and verification results. The demo stops the Chrome and Vite children
it starts. `--keep` leaves them running.

Linux and macOS use a native messaging launcher in the throwaway browser
profile. Windows uses a batch launcher and a per-user registry entry named
for the demo extension. The demos remove their Windows registration when
they stop their children. After a local `run_demo.mjs --keep` session, close
Chrome and Vite and pass the demo's manifest to
`python tools/demo/setup_native.py --unregister <manifest> --browser <browser>`
to remove the entry. The default browser for that command is `chrome`.

## What the demo verifies

1. Generate a demo key, build the development extension, and set up the native
   host in the throwaway profile. Post `open` to create the room before starting
   Vite and Chrome. Load the extension and open the Wall over CDP.
2. Open the Wall view and confirm the legacy plan title and first step. Mark
   that step active, open the task in **Messages (legacy)**, and post a plan
   revision that replaces the active step. Check that the drift banner shows
   both the removed step and its replacement.
3. Send a question through the legacy drawer. Compare its delivery receipt
   with the persisted room event and check the delivered text in the drawer.
4. In the MCP run, seed the required `web-app` memory sections with
   `memory_set` and `base_rev: 0`. Use `plan_create` to create a strict plan
   with two microtasks and require `plan_check` conformance. Confirm the plan
   and task titles in the Wall view.
5. Register the agent with `agent_lifecycle`. Use `next_work` and `plan_get`
   to find ready work and the current task revision, then call `task_claim`.
   Use the returned claim and microtask ID with `microtask_set`. Complete one
   microtask with `hosting/index.html` as evidence after checking its page
   title and mount. Confirm the task appears under its owner in Agents and
   that the exact Architecture section text appears in Memory.

| Summary field | Screenshot under `--dir` | Required evidence |
| --- | --- | --- |
| `plan` | `shots/1_plan.png` | Shared plan and task titles in Wall, or the legacy title and first step with `--no-mcp` |
| `drift` | `shots/2_drift.png` | Legacy drift verdict and both changed steps in the drawer |
| `question` | `shots/3_chat.png` | Delivered question and matching room receipt |
| `planV2` | `shots/4_plan_v2.png` | Registered agent owns the task and has completed one microtask |
| `memory` | `shots/5_memory.png` | Exact text written to Architecture |

An MCP refusal prints its code and fails the run. The summary exit gate
requires all five checks by default. `--no-mcp` skips the shared-plan setup
and checks only `plan`, `drift`, and `question`.

## Known gaps

- The drift and question checks use the retained legacy Messages drawer. The
  shared plan check covers creation, ownership, and partial progress.
- The room replay path caps a sync response at 500 events. The demo uses a
  fresh, small room and posts the scenario after the wall connects.
- The demo uses the shipped `web-app` template. Custom template metadata
  from `CW_HOME/templates/` is outside this walkthrough.

# Tasklight: ViewPoint agents on the wall (`run_tasklight.mjs`)

This command runs the same local wall pipeline as `run_demo.mjs`. It allows
the rooms `viewpoint` and `demo` and adds the U40 observer,
`python -m bridge.viewpoint watch --root R --room viewpoint --interval 0.5`.
For live observation on macOS or Windows, use `--root` to point at your
runs directory. Replay supplies its own root.

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
- Node.js 22 or later, Python 3.10 or later, and a Chrome-family browser.
- vite: installed, and the port is free.
- extension id: from the demo key.
- native host manifest: written into the throwaway profile and registered for
  the selected browser on Windows. Readiness checks the launcher and the
  `viewpoint` and `demo` entries in `rooms.allow`.
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
- `logs/tasklight_pids.json` records the live runner and child PIDs for
  diagnostics. `--stop` authenticates to the runner and uses its child handles.
- `shots/replay_mid.png`, `shots/replay.png`

CW_HOME:
- `--replay` and `--check` use the throwaway `<dir>/cwhome`. Replay resets only the room `viewpoint` and the observer cursor there.
- `--viewpoint` uses `$CW_HOME`, else `~/.context-wall`, so cooperative agents posting through the `context-wall` MCP server reach the same wall. See `ANTIGRAVITY_SETUP.md`.

Hard rules:
- The launcher refuses DISPLAY `:98`, port 5998, and a replay root under `/dev/shm/vqa-cu`.
- It never starts ViewPoint or MetaViewer and never uses a real Chrome profile.
- It stops only the child processes it started.

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
