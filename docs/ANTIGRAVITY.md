# Antigravity 2 and TaskLight

Connect TaskLight to the Antigravity 2 desktop app, the Antigravity CLI, or both.

## 1. Scope and versions

| Client | MCP registry |
| --- | --- |
| Antigravity 2 desktop app | `~/.gemini/antigravity/mcp_config.json` on Linux |
| Antigravity CLI `agy` 1.5.18 [CITED] | Separate native `agy mcp` registry |

Register TaskLight separately in each client you use. The setup tool was exercised on Linux with a temporary home and a fake `agy`.

Not verified yet: the desktop app version, its configuration path on macOS and Windows, loading or reloading TaskLight inside the desktop app, and native lifecycle hooks.

## 2. Prerequisites

- Python 3.10 or newer [CITED] and a TaskLight checkout.
- Antigravity 2 or the Antigravity CLI. Put `agy` on `PATH` for CLI registration.
- A writable TaskLight storage directory. Use one checkout per `CW_HOME`.

## 3. Install TaskLight

Clone or download TaskLight and open a terminal in the checkout root. Run the commands below there. On Windows, use your installed Python executable in place of `python3` if it has a different name. Registration starts the MCP server from the checkout and needs no package installation or elevated privileges. To install the optional browser wall, follow the [desktop setup guide](DESKTOP_SETUP.md).

## 4. Desktop app entry

Preview the entry, then apply it:

```sh
python3 bridge/tasklight_setup.py mcp-config --client antigravity --json
python3 bridge/tasklight_setup.py mcp-config --client antigravity --apply --json
```

Both commands return this JSON shape. The example replaces machine-specific paths with placeholders.

```json
{"ok": true, "client": "antigravity", "file": "<home>/.gemini/antigravity/mcp_config.json", "snippet": {"mcpServers": {"tasklight": {"command": "<python-executable>", "args": ["<repo>/bridge/room/mcp.py"], "env": {"CW_HOME": "<cw-home>"}}}}, "restart_hint": "restart antigravity so it loads the new MCP server"}
```

The setup tool uses the same home-relative path on all platforms. The expected paths are `~/.gemini/antigravity/mcp_config.json` on macOS and `%USERPROFILE%\.gemini\antigravity\mcp_config.json` on Windows. The desktop entry uses `command`, `args` and `env`. Antigravity also accepts optional `timeoutSeconds` [CITED].

The preview leaves the file untouched. Apply merges `mcpServers.tasklight`, preserves other servers, and succeeds without rewriting a matching entry. If apply changes an existing file, the backup retains its permission bits. Malformed JSON returns `invalid_json` and leaves the file untouched.

## 5. CLI entry

```sh
python3 bridge/tasklight_setup.py mcp-config --client antigravity-cli --json
python3 bridge/tasklight_setup.py mcp-config --client antigravity-cli --apply --json
```

The preview prints the command and its exact argument order. Use the actual `command` output if you prefer to register manually.

```json
{"ok": true, "client": "antigravity-cli", "command_argv": ["agy", "mcp", "add", "--env", "CW_HOME=<cw-home>", "tasklight", "<python-executable>", "<repo>/bridge/room/mcp.py"], "command": "agy mcp add --env CW_HOME=<cw-home> tasklight <python-executable> <repo>/bridge/room/mcp.py"}
```

Apply lists the registry, adds the entry and lists it again. Success requires an `enabled` entry.

```json
{"ok": true, "client": "antigravity-cli", "tasklight_status": "enabled"}
```

If `legacy_entry` is true, register and verify `tasklight` first. If you no longer use the old entry, remove it from the CLI registry using the reported `legacy_hint`.

```sh
agy mcp remove context-wall
```

## 6. Match `CW_HOME`

Set `CW_HOME` before registration if you use a custom storage directory. Use that same directory for both MCP entries, the wall launcher and the browser native host. If unset, TaskLight uses `~/.context-wall` under the user's home.

## 7. Verify

Run the check for each client you configured. Replace `chrome` with `chromium`, `edge` or `brave` if you use that browser with the wall.

```sh
python3 bridge/tasklight_setup.py doctor --browser chrome --client antigravity --json
python3 bridge/tasklight_setup.py doctor --browser chrome --client antigravity-cli --json
```

Look for the corresponding entry in `checks`. The overall command can fail if unrelated prerequisites for the browser wall are missing.

```json
{"id": "mcp_antigravity", "status": "ok", "detail": "mcp antigravity ok"}
{"id": "mcp_antigravity-cli", "status": "ok", "detail": "tasklight listed by agy", "tasklight_status": "enabled"}
```

The desktop check compares the file entry with the expected configuration. The CLI check confirms the registry lists `tasklight` as enabled. Reopen the client and check whether it shows TaskLight's tools. The server answers MCP `initialize` with protocol `2024-11-05` and identifies itself as `tasklight` version `0.3.0` [MEASURED]. Use `tools/list` and `prompts/list` for discovery. Then create a [first plan](MCP.md#copy-paste-your-first-plan) and check its room, title and claimed owner on the wall if you installed it.

## 8. Lifecycle reporting without native hooks

Use the explicitly enabled [agent-reported fallback](HARNESS_ANTIGRAVITY.md#lifecycle-modes-and-stop-gates) only after discovering `agent_lifecycle` and establishing that a hook is absent for the run. Set `harness` to `Antigravity 2 (agent-reported)`. Report `deployed` before work, followed by truthful `alive`, `finished` or observed `failed` as applicable. Keep the same `run_id` for that attempt. Send `activity_beat` every 30 seconds [CITED] while assigned work is active. Expired beats mean **Liveness unknown**. The `Antigravity 2 (harness-recorded)` label is reserved for hook reports. Both labels are caller-asserted.

## 9. Troubleshooting

- `agy_not_found` means `agy` is missing from `PATH`. The desktop registration can be used independently.
- `exists` means the CLI already lists `tasklight`. Inspect the registry before using `--force`, which allows the setup tool to attempt another add.

```sh
agy mcp list
```

If the list shows `tasklight` as disabled, enable it:

```sh
agy mcp enable tasklight
```

- `agy_verify_failed` means the CLI add succeeded but the follow-up list did not confirm an enabled entry.
- `exists_different` means the desktop file already contains a different entry. Review the change before adding `--force` to the desktop apply command.
- If tools are missing, check the registry for the client you opened. If the wall is empty, check `CW_HOME` and confirm the room is allowed in `wall.config.json`.

## 10. Security

The desktop MCP file and its backups can contain other servers' credentials. Keep them private and out of logs and issue reports. For troubleshooting, share only the TaskLight entry with machine-specific paths redacted. Keep credentials out of launchers and shell history.
