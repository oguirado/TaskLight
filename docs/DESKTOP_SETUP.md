# TaskLight Desktop Setup

This guide covers running the TaskLight wall and MCP planning server on your own desktop before or without a Firebase project.

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

## 5. First plan in 2 minutes

Ask your connected AI agent to run these MCP tools against `room: "demo"` (or any room listed in your `wall.config.json`):

1. `list_templates` to inspect available planning templates.
2. `plan_create` with `template_id: "web-app"`, a `title`, `brief`, and `tasks` (each with microtasks).
3. `task_claim` to assign a task to the agent (agents can also query `next_work`, advance phases with `plan_phase`, and close with `plan_close`).
4. `microtask_set` to mark a microtask `done` with an `outcome` and optional `evidence`: a list of up to 8 absolute paths to files that show the work (a plain string is rejected with `bad_evidence`; credential files are refused).
5. `memory_set` (for example section `"architecture"`) with `base_rev: 0`.

Open the wall (next section). It shows the live plan band (title, phase chips, progress, tasks and microtasks) and the **Memory** view.

## 5b. Open the wall locally

Until the hosted wall is deployed, serve it from your clone with the extension origin allowed:

```sh
VITE_EXTENSION_ORIGINS=chrome-extension://<extension-id> npx vite --config tools/demo/vite.demo.config.ts --host 127.0.0.1 --port 5173 --strictPort
```

Then browse `http://localhost:5173/` (use `localhost`, not `127.0.0.1`: the development manifest only allows `http://localhost/*`). The page connects to the extension, the extension starts the native host, and the rooms in your `wall.config.json` appear as workspaces.

### Model routing and liaison

`firebase-hybrid` remains the factory default for every task group,
including `liaison`. App Check remains mandatory for Firebase. Local and
network model servers are optional user-configured endpoints managed
through the native host; no network endpoint or credential ships with
TaskLight. See [MODELS.md](MODELS.md) for configuration and privacy rules.
The liaison drafts messages and summaries; only a human sends them to
executors. An unavailable liaison leaves direct messaging and planning usable.

## 6. Try it without installing anything

The local demo runs an isolated profile, ephemeral native host, local wall server, and MCP planning path without modifying your desktop browser:

```sh
node tools/demo/run_demo.mjs
```

Set `CHROME=/path/to/browser` to choose a specific binary; otherwise it searches `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge`, and `brave-browser` on `PATH` and standard macOS app bundle paths. Pass `--no-mcp` to skip the MCP v2 planning and Memory checks.

## 7. Platform notes and known limits

Open items from repository audits not yet resolved:

- **MCP blocking call**: `wait_inbox` polls synchronously until its timeout, blocking other requests or cancellation on that connection.
- **MCP handshake**: `initialize` always answers protocol `"2024-11-05"`. Full tool schemas come from `tools/list`; `docs/MCP.md` lists purposes only.
- **Windows native host & file paths**: `bridge/wall/native_host.py` uses `select.select` on stdin, which can stall on Windows pipes, and lacks explicit CRT binary-mode setup (`bridge/wall/__main__.py`). `bridge/models/store.py` and `bridge/ctx/paths.py` still use POSIX-only primitives (`os.getuid`, `O_DIRECTORY`, `O_NOFOLLOW`, `fchmod`).
- **Windows Claude hook**: `bridge/room/hook_claude.py` still imports `fcntl` unconditionally.
- **Process observer**: `ProcObserver` (`bridge/wall/observers.py`) is Linux-only and disabled on macOS and Windows.
- **Demo portability**: `tools/demo/run_demo.mjs` still uses `sh`, `openssl`, and negative-PID process-group cleanup. `tools/demo/run_tasklight.mjs` still hardcodes Linux Chrome and relies on `sh`, `openssl`, `python3`, negative-PID cleanup, and `/proc` for `--stop`.
- **Hosted wall**: Firebase hosting and project config are pending; the normal production panel points to `https://site.test/`.

## 8. Troubleshooting

- **Native host not found**: verify the manifest exists at the OS location above, its `path` points to `com.contextwall.bridge.host.sh` (or `.bat`), and `allowed_origins` is `["chrome-extension://<extension-id>/"]`. On Windows, verify the `HKCU\Software\...\NativeMessagingHosts\com.contextwall.bridge` default value equals the manifest path.
- **Wall shows no plan**: the MCP server, the native host and the wall must share one `<cw-home>` (`$CW_HOME` or `~/.context-wall`), and the `room` used in `plan_create` must be in the config's room list (`--room` at install time).
- **Extension ID changed after reload**: unpacked extensions without a pinned key get a new ID if loaded from a different directory. Copy the new ID from `chrome://extensions` and re-run `python3 bridge/install.py --browser <b> --extension-id <new-id> --apply` (or pass `--key-file`).
