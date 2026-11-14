# Antigravity 2 setup: ViewPoint agents on the Tasklight wall

Use this file to show ViewPoint Computer-Use agents on the local Context Wall. You add the MCP entries yourself.
These tools never read or change the Antigravity config file, because it can hold credentials.

There are two ways to show the agents:

| Path | What the agent does | What appears on the wall |
|---|---|---|
| Zero-config (U40 observer) | Nothing | One task for each ViewPoint run. The title is the goal, each step is an action, and receipts set each step to done or blocked. The run closes when `report.json` appears. |
| Cooperative (this file) | Calls `post_plan`, `post_step` and `post_status` on the `context-wall` MCP server | The agent's own task, with a capsule label and your step wording, next to the observer's task |

## 1. Start the wall

From the repo root:

```
node tools/demo/run_tasklight.mjs --viewpoint
```

This command starts the following:
- the Vite wall
- a throwaway Chrome profile with the extension
- the native host, with rooms `viewpoint` and `demo` allowed
- the U40 observer, which reads the real runs root and never writes to it

The command prints the `CW_HOME` it uses. By default that is `~/.context-wall`, or `$CW_HOME` if you set it. The `context-wall` MCP entry below must use the same `CW_HOME`.

Run `node tools/demo/run_tasklight.mjs --check` first. Its last row confirms that the MCP server answers `initialize`.

## 2. MCP server entries

Add the two entries under the MCP servers section of Antigravity 2. The JSON below shows only the shape; keep the key names your Antigravity version already uses for its existing entries.

```json
{
  "mcpServers": {
    "context-wall": {
      "command": "python3",
      "args": ["-m", "bridge.room.mcp"],
      "cwd": "/home/admin/Documentos/FireBase_BuildHybridAI/repo",
      "env": {
        "PYTHONPATH": "/home/admin/Documentos/FireBase_BuildHybridAI/repo"
      }
    },
    "viewpoint-agent": {
      "command": "python3",
      "args": ["-I", "/home/admin/Documentos/ViewPoint/hackathon/vp_mcp/vp_mcp.py"],
      "env": {
        "VP_MCP_SESSION": "/tmp/claude-1000/vparm64/vp_mcp_session.json"
      }
    }
  }
}
```

Notes:
- **`context-wall`**
  - `CW_HOME` is left unset, so the default `~/.context-wall` is used. That matches `run_tasklight.mjs --viewpoint`.
  - If you start the launcher with a different `CW_HOME` or `--cw-home D`, add `"CW_HOME": "D"` to `env`.
  - If your client ignores `cwd`, `PYTHONPATH` is enough for `-m bridge.room.mcp` to load.
  - Tools: `post_status`, `post_plan`, `post_step`, `read_inbox`, `wait_inbox`.
- **`viewpoint-agent`**
  - `VP_MCP_SESSION` points to a file that exists only while a ViewPoint take is running.
  - Outside a take, the server has no session to attach to. This is expected and not a config error.
  - Start the take first, then let the agent use the tools.

## 3. Agent instruction (ready to paste)

Replace `<capsule>` with the lowercase slug (`chatgpt`, `gemini`, `wikipedia` or `arxiv`). Replace `<Capsule>` with the display name (`ChatGPT`, `Gemini`, `Wikipedia` or `arXiv`).

```
You report your browser work live on the Tasklight wall through the context-wall MCP server.
Room: "viewpoint". Agent id: "<capsule>-agent" (lowercase letters, digits, "-", "." or "_" only).

1. Before each ViewPoint task, call post_plan with:
   room "viewpoint", agent "<capsule>-agent", title "[<Capsule>] <goal>" (at most 120 characters),
   steps: one object per planned action, e.g. [{"text": "Click the search box"}, {"text": "Type the query"},
   {"text": "Press Enter", "accept": "results page visible"}]. Use 1 to 12 steps. Each "text" is at most 80
   characters, and each optional "accept" is at most 160 characters. No other keys.
2. When you start an action, call post_step with room "viewpoint", agent "<capsule>-agent", index i (0-based) and
   state "active". After the action, call post_step again with the same index and state "done", or "blocked" if it
   failed. Add an "outcome" of at most 240 characters.
3. If you need an extra step, call post_plan again with the same title and the full list, with the new step
   appended. Never remove or reorder steps that were already posted.
4. At the end, make sure every step is "done" or "blocked". Then call post_status with room "viewpoint",
   agent "<capsule>-agent" and text "closed: <one-line result>".
5. Never put typed text, passwords, tokens, cookies or page content into any title, step, outcome or status.
   Describe the action instead, e.g. "Type the search query".
```

The `context-wall` MCP server has no `close` tool. Step 4 therefore ends the task with the final step states and a `post_status` summary.
A `close` event comes only from the U40 observer, when ViewPoint writes `report.json`, or from `python3 -m bridge.room post --act close`.

## 4. Zero-config path

The agents do not need to post anything. The U40 observer (`python3 -m bridge.viewpoint watch --room viewpoint`, started by `run_tasklight.mjs`) paints each run from ViewPoint's own run files:

| Run file | Wall update |
|---|---|
| `intent-*.json` | Adds a step, with its plan entry and `active` state |
| `receipt-*.json` | Marks the step `done`, or `blocked` if the receipt is not verified |
| `report.json` | Posts `close` with the text `<verdict_code> (rc N)` |

The observer only reads `*.json` files, never copies `action.text`, and never writes under the runs root.

In `--viewpoint` mode the observer starts with `--prime`, so runs that existed before the launcher started are not repainted. Pass `--history` to repaint them.

To rehearse without ViewPoint, run:

```
node tools/demo/run_tasklight.mjs --replay
```

It writes 4 synthetic runs (ChatGPT, Gemini, Wikipedia, arXiv) into a temporary root and shows them on the wall.
