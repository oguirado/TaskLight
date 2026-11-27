# TaskLight Desktop Setup

An external harness deploys and directs agents; TaskLight displays their shared
plans, coarse microtasks, identity, harness, current work, state, liveness,
dependencies and progress. Keep terminals and human conversations in the harness.
This guide sets up the local desktop wall and MCP server.

For browser-free plans and memory, use [HEADLESS.md](HEADLESS.md).

## 1. Requirements

- `git`
- Node.js `>= 22` (the demo uses the global `WebSocket`)
- Python `>= 3.10` (`bridge/install.py` exits with code 3 on older versions)
- A Chrome-family browser: Google Chrome, Chromium, Microsoft Edge, or Brave

## 2. Get the code and install

Clone the repository and install JavaScript dependencies:

```sh
git clone <repo-url> <repo>
cd <repo>
npm ci
```

Build the extension with the development manifest (it allows the wall on `http://localhost`; the production manifest is for the hosted wall):

```sh
node extension/build.mjs --manifest dev --out <extension-dir>
```

Load the extension in your browser:

1. Open `chrome://extensions` (or the extensions page for Chromium, Edge, or Brave).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `<extension-dir>`.
4. Copy the shown **Extension ID** (`<extension-id>`).

## 3. Install the native host

Run a dry run first (the default, writes nothing) to inspect the target paths and config:

```sh
python3 bridge/install.py --browser chrome --extension-id <extension-id> --room demo:private
```

Supported `--browser` values are `chrome` (default), `chromium`, `edge`, and `brave`. You can pass `--key-file <der-spki-base64>` instead of `--extension-id`, add `--config <path>` (default `<cw-home>/wall.config.json`), and repeat `--room NAME[:tier]` (tier defaults to `private`). `<cw-home>` is `$CW_HOME` when set, otherwise `~/.context-wall`; the native host, the MCP server and the wall must all use the same one. The config path is `$CW_HOME/wall.config.json` when `CW_HOME` is set,
otherwise `~/.context-wall/wall.config.json`; the historical
`.contextwall/wall.config.json` path is not a supported default. Apply the installation:

```sh
python3 bridge/install.py --browser chrome --extension-id <extension-id> --room demo:private --apply
```

What `--apply` writes:

- **Config**: creates `wall.config.json` with your rooms if missing (never overwrites an existing file).
- **Linux**: manifest `com.contextwall.bridge.json` and mode-`0700` launcher `com.contextwall.bridge.host.sh` (executing the installing Python interpreter) under:
  - Chrome: `~/.config/google-chrome/NativeMessagingHosts/`
  - Chromium: `~/.config/chromium/NativeMessagingHosts/`
  - Edge: `~/.config/microsoft-edge/NativeMessagingHosts/`
  - Brave: `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/`
- **macOS**: same files under `~/Library/Application Support/` + `Google/Chrome/NativeMessagingHosts/`, `Chromium/NativeMessagingHosts/`, `Microsoft Edge/NativeMessagingHosts/`, or `BraveSoftware/Brave-Browser/NativeMessagingHosts/`.
- **Windows**: manifest and `com.contextwall.bridge.host.bat` under `%LOCALAPPDATA%\TaskLight\native\`, plus the default value of `HKCU\Software\<vendor>\NativeMessagingHosts\com.contextwall.bridge` where `<vendor>` is `Google\Chrome`, `Chromium`, `Microsoft\Edge`, or `BraveSoftware\Brave-Browser`.

To uninstall only the files and Windows registry value created by the installer:

```sh
python3 bridge/install.py --browser chrome --remove
```

Never pass `--apply` and `--remove` together (exits with code 2).

## 4. Connect your AI client over MCP

The MCP server (`bridge/room/mcp.py`) speaks newline-delimited JSON-RPC 2.0 over stdio (`protocolVersion` `"2024-11-05"`, `serverInfo.name` `"tasklight"`). Running the script path directly bootstraps `sys.path` from any working directory and writes UTF-8 bytes regardless of locale.

Generic stdio configuration (use the same `<cw-home>` as the native host; `<python-executable>` is the Python you installed with, for example `python3` on Linux and macOS or `py` on Windows):

```json
{
  "command": "<python-executable>",
  "args": ["<repo>/bridge/room/mcp.py"],
  "env": { "CW_HOME": "<cw-home>" }
}
```

The snippets below follow each client's documented MCP format at the time of writing; if a key name differs in your version, follow the client's own MCP docs and keep the same command, args and env.

**Claude Code**:

```sh
claude mcp add tasklight -e CW_HOME=<cw-home> -- <python-executable> <repo>/bridge/room/mcp.py
```

For automatic Claude Code session and sub-agent visibility, enable the
[Claude Code native adapter](HARNESS_HOOKS.md#claude-code-native-adapter): run
`python3 -m bridge.room.hook_claude_native --print-settings`, merge the emitted
`hooks` into Claude Code's settings, and select a room with `TASKLIGHT_ROOM` or
`.tasklight.json`, using the same `CW_HOME` as the wall. Lifecycle hooks create
rooms as needed and hash native identities; prompts, tool input/output,
transcript paths and assistant messages are never recorded.

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.tasklight]
command = "<python-executable>"
args = ["<repo>/bridge/room/mcp.py"]

[mcp_servers.tasklight.env]
CW_HOME = "<cw-home>"
```

**Gemini CLI** (`~/.gemini/settings.json` or the project's `.gemini/settings.json`):

```json
{
  "mcpServers": {
    "tasklight": {
      "command": "<python-executable>",
      "args": ["<repo>/bridge/room/mcp.py"],
      "env": { "CW_HOME": "<cw-home>" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "tasklight": {
      "command": "<python-executable>",
      "args": ["<repo>/bridge/room/mcp.py"],
      "env": { "CW_HOME": "<cw-home>" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "tasklight": {
      "command": "<python-executable>",
      "args": ["<repo>/bridge/room/mcp.py"],
      "env": { "CW_HOME": "<cw-home>" }
    }
  }
}
```

**Antigravity 2 desktop app and Antigravity CLI** — follow the [Antigravity setup guide](ANTIGRAVITY.md) for their separate registries.

### Check discovery before writing

From the repository root, with the same `CW_HOME`, run:

```sh
python3 -m bridge.room tools
```

Compare the descriptors with MCP `tools/list`, and inspect `initialize` and
`prompts/list`. [MCP.md](MCP.md) records the live inventory and handshake.
The installer preview writes nothing; only `--apply` installs native host files.

## 5. First plan in 2 minutes

Ask your connected AI agent to run these MCP tools against `room: "demo"` (or any room listed in your `wall.config.json`):

1. `list_templates` to inspect available planning templates.
2. `plan_create` with `template_id: "web-app"`, a `title`, `brief`, and `tasks` (each with microtasks).
3. `work_acquire` to claim eligible work and activate its first microtask without takeover. Alternatively use `next_work` then `task_claim` and `microtask_set`.
4. `work_report` to batch coarse microtask completions with outcomes, real evidence paths and the acquired `claim_lamport`; the same append transaction activates the next pending item. See [MCP.md](MCP.md) for its discovered shape and [HEADLESS.md](HEADLESS.md) for a scratch walkthrough. The granular `microtask_set` path remains supported; a plain evidence string is rejected with `bad_evidence`, and credential files are refused.
5. `memory_set` (for example section `"architecture"`) with `base_rev: 0`.

Open the wall (next section). It shows the live plan band (title, phase chips, progress, tasks and microtasks) and the **Memory** view.

## 5b. Open the wall

With the TaskLight extension loaded and the native host installed, open the
hosted wall in a dedicated window:

```sh
./bin/tasklight open --browser chrome
```

On Windows, run `python -m bridge.room open --browser chrome` from the
checkout. The launcher looks for the profile with the TaskLight extension.
See the [CLI guide](CLI.md#open-the-wall-in-its-own-window) for browser, URL
and size options.

To use the local development wall, serve it from your clone with the extension origin allowed:

```sh
VITE_EXTENSION_ORIGINS=chrome-extension://<extension-id> npx vite --config tools/demo/vite.demo.config.ts --host 127.0.0.1 --port 5173 --strictPort
```

Then run `./bin/tasklight open --url http://localhost:5173/`. Use `localhost`
to match the origin allowed by the development manifest. The page connects to
the extension, the extension starts the native host, and the rooms in your
`wall.config.json` appear as workspaces.

### Model routing and legacy liaison

`firebase-hybrid` remains the factory default for every task group,
including `liaison`. App Check remains mandatory for Firebase. Local and
network model servers are optional user-configured endpoints managed
through the native host; no network endpoint or credential ships with
TaskLight. See [MODELS.md](MODELS.md) for configuration and privacy rules.
Retained chat and liaison controls are legacy, with no new investment. The
liaison drafts only; human conversations and questions belong in the harness.
Unavailable legacy inference does not block planning. Private Nano narration
stays on-device; unavailable generation uses **Rules summary** without cloud
narration or room writes.

### Lifecycle and harness provenance

Use [HARNESS_HOOKS.md](HARNESS_HOOKS.md) for the landed neutral hook contract;
hooks record lifecycle without model calls. Reuse the harness-recorded `run_id`
for executor beats, stable per attempt. Failure or exit releases eligible open
work, never closes the plan. Check cleanup separately from lifecycle persistence.
Terminal task release remains **HOLD** pending upstream resolution. Mailbox
slice 2 remains **HOLD** under [FAMILY_CHANNEL.md](FAMILY_CHANNEL.md), even when
its underlying tools appear in discovery. Exact pin launch settings are AUSENTE.

Keep **Antigravity 2 (agent-reported)** and **Antigravity 2 (harness-recorded)**
distinct. Antigravity 2 native wiring and live compatibility remain pending;
see [HARNESS_ANTIGRAVITY.md](HARNESS_ANTIGRAVITY.md) for the owner contract.
The label alone is not evidence of automatic harness integration. These labels
and all lifecycle identity remain caller-asserted, not authentication.

## 6. Try it without installing anything

The local demo runs an isolated profile, ephemeral native host, local wall server, and MCP planning path without modifying your desktop browser:

```sh
node tools/demo/run_demo.mjs
```

Set `CHROME` to the path of your browser executable; otherwise it searches `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge`, and `brave-browser` on `PATH` and standard macOS app bundle paths. Pass `--no-mcp` to skip the MCP v2 planning and Memory checks.

## 7. Platform notes and known limits

Open items from repository audits not yet resolved:

- **MCP blocking call**: `wait_inbox` polls synchronously until its timeout, blocking other requests or cancellation on that connection.
- **MCP handshake**: `initialize` always answers protocol `"2024-11-05"`. Full tool schemas come from `tools/list`. See [MCP.md](MCP.md) for usage and argument examples.
- **Windows native host & file paths**: `bridge/wall/native_host.py` uses `select.select` on stdin, which can stall on Windows pipes, and lacks explicit CRT binary-mode setup (`bridge/wall/__main__.py`). `bridge/models/store.py` and `bridge/ctx/paths.py` still use POSIX-only primitives (`os.getuid`, `O_DIRECTORY`, `O_NOFOLLOW`, `fchmod`).
- **Windows Claude hook**: `bridge/room/hook_claude.py` still imports `fcntl` unconditionally.
- **Process observer**: `ProcObserver` (`bridge/wall/observers.py`) is Linux-only and disabled on macOS and Windows.
- **Demo portability**: `tools/demo/run_demo.mjs` still uses `sh`, `openssl`, and negative-PID process-group cleanup. `tools/demo/run_tasklight.mjs` still hardcodes Linux Chrome and relies on `sh`, `openssl`, `python3`, negative-PID cleanup, and `/proc` for `--stop`.

## 8. Troubleshooting

- **Native host not found**: verify the manifest exists at the OS location above, its `path` points to `com.contextwall.bridge.host.sh` (or `.bat`), and `allowed_origins` is `["chrome-extension://<extension-id>/"]`. On Windows, verify the `HKCU\Software\...\NativeMessagingHosts\com.contextwall.bridge` default value equals the manifest path.
- **Wall shows no plan**: the MCP server, the native host and the wall must share one `<cw-home>` (`$CW_HOME` or `~/.context-wall`), and the `room` used in `plan_create` must be in the config's room list (`--room` at install time).
- **Extension ID changed after reload**: unpacked extensions without a pinned key get a new ID if loaded from a different directory. Copy the new ID from `chrome://extensions` and re-run `python3 bridge/install.py --browser <b> --extension-id <new-id> --apply` (or pass `--key-file`).
