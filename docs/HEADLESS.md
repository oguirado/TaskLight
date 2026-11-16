# Running TaskLight Headless

TaskLight runs without a browser. AI assistants and developers can manage plans, microtasks, evidence, and shared memory directly from a terminal or an MCP client.

## 1. What headless means

In headless mode, TaskLight exposes two interfaces over the same local room store:

- **Stdio MCP server**: `python3 -m bridge.room.mcp` speaks newline-delimited JSON-RPC 2.0 over stdin and stdout.
- **Parity CLI**: `python3 -m bridge.room` calls the same validated handlers and schemas from the shell.

The desktop configuration is `$CW_HOME/wall.config.json` when `CW_HOME` is
set, otherwise `~/.context-wall/wall.config.json`. The historical
`.contextwall/wall.config.json` location is not a supported default.
Headless planning does not require a desktop config or model endpoint.

Both interfaces read and write the same append-only journal (`rooms/<room>/events.jsonl`) under `$CW_HOME` (default `~/.context-wall`). No browser, extension, or background daemon is needed.

If you open the visual wall later, it replays the same journal with matching fold logic and shows the exact state committed by headless clients.

## 2. Quick start

### Configure an MCP client

Follow [SETUP_WITH_AI.md](SETUP_WITH_AI.md) to register the server, or add this stdio entry to your MCP client configuration (see [MCP.md](MCP.md) for full schemas and error codes):

```json
{
  "command": "python3",
  "args": ["-m", "bridge.room.mcp"],
  "cwd": "<repo-root>",
  "env": { "CW_HOME": "<cw-home-path>" }
}
```

### Discover the protocol and resources

Run from the repository root with fresh scratch storage. Keep this shell's
`CW_HOME` for the next example; never reuse a real credential directory.
The server version, protocol, and current tool count are recorded in [MCP.md](MCP.md).

```sh exec
export CW_HOME="$(mktemp -d)"
python3 -m bridge.room.mcp <<'RPC'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"headless-example","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"resources/list"}
{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"tasklight://guide/headless"}}
RPC
python3 -m bridge.room tools
```

The initialized notification has no response. Resource reads return
`contents:[{uri,mimeType,text}]`; the headless guide is Markdown from this
file, and the planning contract is available at `tasklight://contract`.
Tool calls return `content:[{type:"text",text:<JSON>}]` and `isError`;
decode the JSON text, then unwrap `{"untrusted": data}`. An `isError:true`
result is a failure even if the server process exits successfully.

## 3. Executable scratch plan

This recipe uses the `blank` template and real files in the scratch data
directory. It demonstrates protocol operations, not a software delivery
claim. Software projects should select `autonomous-software` and follow
[PLANNING_CONTRACT.md](PLANNING_CONTRACT.md).
Each CLI call starts a fresh process, exercising restart against the same
journal without a browser. Run after the scratch setup above:

```sh exec
python3 - <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys

home = Path(os.environ["CW_HOME"])
assert home.is_dir()
room, agent = "demo", "worker-a"

def call(name, **args):
    args = {"room": room, "agent": agent, **args}
    result = subprocess.run(
        [sys.executable, "-m", "bridge.room", "call", name,
         "--json", json.dumps(args)], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    payload = json.loads(result.stdout)
    return payload.get("untrusted", payload)

def revision():
    return call("plan_get")["plan"]["rev"]

# Discovery tools do not accept room or agent arguments.
subprocess.run([sys.executable, "-m", "bridge.room", "call",
                "list_templates", "--json", "{}"], check=True)
subprocess.run([sys.executable, "-m", "bridge.room", "call",
                "get_template", "--json", '{"template_id":"blank"}'], check=True)
for section, text in {
    "goal": "Verify a scratch artifact and its evidence.",
    "mission": "Exercise local headless planning only.",
    "rules": "Use scratch storage only; contact no external service.",
}.items():
    call("memory_set", section=section, text=text, base_rev=0,
         op_id="seed-" + section + "-0001")
call("plan_create", template_id="blank", title="Scratch verification",
     brief={"goal": "Verify a local scratch artifact"}, strict=True,
     op_id="scratch-plan-0001", tasks=[{
         "key": "artifact", "title": "Verify scratch artifact", "type": "task",
         "phase": "execute", "accept": "Artifact contents verified",
         "microtasks": [{"text": "Write scratch artifact"},
                        {"text": "Verify artifact contents"}]}])
assert call("plan_check")["conformance"]["ok"]
assert call("next_work")["items"]
call("task_claim", task_id="T01", op_id="scratch-claim-0001")
call("plan_phase", phase="execute", base_rev=revision(),
     op_id="scratch-phase-0001")
proof = home / "proof.txt"
for index, micro in enumerate(("T01.M01", "T01.M02"), 1):
    call("microtask_set", id=micro, state="active",
         op_id=f"scratch-active-{index:04}")
    call("activity_beat", task_id="T01", micro_id=micro,
         run_id="scratch-run", op_id=f"scratch-beat-{index:04}")
    if index == 1:
        proof.write_text("scratch evidence\n", encoding="utf-8")
    assert proof.read_text(encoding="utf-8") == "scratch evidence\n"
    call("microtask_set", id=micro, state="done",
         outcome="Scratch artifact contents verified", evidence=[str(proof.resolve())],
         op_id=f"scratch-done-{index:04}")
call("task_release", task_id="T01", op_id="scratch-release-0001")
# Repeat the same logical operation: replay must not append another event.
assert call("task_release", task_id="T01",
            op_id="scratch-release-0001")["replayed"]

# Restart/resume ladder: memory, plan, inbox, evidence, then next work.
call("memory_get")
state = call("plan_get")
call("read_inbox")
assert proof.read_text(encoding="utf-8") == "scratch evidence\n"
assert call("next_work")["items"] == []
assert state["tasks"][0]["microtasks"][0]["evidence"][0]["sha256"]
call("memory_history", section="goal", limit=10)
call("plan_phase", phase="review", base_rev=revision(),
     op_id="scratch-review-0001")
call("plan_close", base_rev=revision(),
     outcome="Scratch artifact written and verified; no application changes made",
     op_id="scratch-close-0001")
for what in ("plan", "memory"):
    exported = call("room_export", what=what)
    assert exported["format"] == "markdown"
    print(exported["text"])
PY
```

For a direct shell call, the syntax is
`python3 -m bridge.room call <tool> --json '<args>'`; for example:

```sh exec
python3 -m bridge.room call memory_history --json '{"room":"demo","agent":"worker-a","section":"goal","limit":10}'
python3 -m bridge.room call room_export --json '{"room":"demo","agent":"worker-a","what":"plan"}'
python3 -m bridge.room call room_export --json '{"room":"demo","agent":"worker-a","what":"memory"}'
```

`room_export` and `memory_history` are shipped tools. Exports return
`{format:"markdown",text,rev}`; history returns `{section,versions}` with
accepted `{rev,by,ts,text}` updates newest first. The CLI prints their
`{"untrusted": data}` envelope, as MCP does inside its text result.

`plan_get` returns `no_plan` before creation and after closure; exports
can still render the folded closed plan and memory. Closing is not proof
of acceptance or message delivery, and read receipts are unavailable.
On restart, follow the full [resume ladder](PLANNING_CONTRACT.md#5-resume-after-context-loss)
before writing. Reuse the same `op_id` only for a retry of the same action.
On `stale_rev`, re-read the relevant plan, task, or memory section and
reconcile before retrying with its current revision; never guess a revision.

## 4. Executor loop and event cursor

### The executor loop

Executors follow a five-step cycle, also available through the `executor_loop` MCP prompt (`room`, `agent`, optional `task_id`):

1. **Claim**: call `next_work` to find ready work, then `task_claim`. Taking over an unresponsive assignee's task requires `takeover: true` after more than 600,000 ms (10 minutes) of silence.
2. **Activate**: call `microtask_set` with `state: "active"`.
3. **Beat every 30 s**: call `activity_beat` with `{room, agent, task_id, micro_id?, run_id, note?, op_id?}`. It returns `{ok, lamport, beat_ts}`. Only the current task assignee can beat (`claimed_by_other` otherwise). Use a fresh, stable `run_id` (`[A-Za-z0-9_-]{1,64}`) per attempt; beats from a retired `run_id` are ignored, and the wall marks liveness `unknown` if no valid beat arrives within 90 seconds.
4. **Record evidence**: call `microtask_set` with `state: "done"`, `outcome`, and `evidence`.
5. **Release or advance**: move to the next microtask or call `task_release` when handing off.

### The event cursor

`read_inbox` and `wait_inbox` only return addressed messages and unaddressed `question` or `handoff` events. They exclude ordinary planning and memory updates. Meanwhile, `plan_get` with `since_rev` folds state through a historical revision rather than streaming new changes.

To follow all room activity, call `room_events`:

```json
{
  "room": "demo",
  "agent": "watcher",
  "after_lamport": 0,
  "limit": 50,
  "acts": ["op"],
  "ops": ["plan.open", "micro.set", "memory.set"],
  "wait_ms": 5000
}
```

- `limit` accepts `1..500` (default `100`); `wait_ms` accepts `0..30000` (default `0`).
- Within `acts` or `ops`, values combine with OR; between `acts` and `ops`, filters combine with AND. An empty array matches nothing.
- Advance `after_lamport` to `next_after` after each batch.
- If `resync` is `true` (for example, `after_lamport > head`), reload state with `plan_get` and `memory_get`, then reset `after_lamport` to `head`.
- **Use a dedicated process for waiting**: positive `wait_ms` (and `wait_inbox`) blocks its stdio JSON-RPC connection until a match arrives or the timeout expires. Run long waits in a separate process so normal tool calls never stall.

## 5. CLI parity

Existing room subcommands remain available:

- `python3 -m bridge.room post`
- `python3 -m bridge.room read`
- `python3 -m bridge.room wait` (exits `124` on timeout)
- `python3 -m bridge.room status` (exits `4` when the room is missing)

Parity commands invoke the same validated handlers as the MCP server:

- `python3 -m bridge.room tools` — print `{"tools":[...]}` matching MCP `tools/list`.
- `python3 -m bridge.room call <tool> --json '<args>'` — run any tool with a JSON object and print the decoded payload (`{"untrusted": ...}` for v2 and extension tools).
- `python3 -m bridge.room export --room R --out DIR` — write `PLAN.md` and
  `MEMORY.md` beneath `$CW_HOME/DIR`. Relative paths only; traversal,
  symlinks and paths outside `$CW_HOME` are refused (`bad_args`, exit `2`);
  write failures return `export_failed` (exit `3`). To get the Markdown
  without files, use `call room_export`.

Exit codes for `tools` and `call` are stable:

- `0`: success.
- `2`: invalid CLI syntax, malformed JSON, non-object JSON, or unknown tool (prints `{"ok":false,"code":"bad_args"}`).
- `3`: dispatched tool error (prints `{"ok":false,"code":"...","detail":"..."}` without the `untrusted` wrapper).

## 6. Concurrency, trust, and limits

- **Concurrent processes**: multiple stdio MCP servers and CLI calls can share one `$CW_HOME`. Mutations serialize on `events.lock`, validate `base_rev`, call `fsync`, and deduplicate retries by `(agent, op_id)`.
- **Trust boundary**: `agent` identifiers are caller-asserted. Any local process that shares `$CW_HOME` can act under any agent name. Treat `$CW_HOME` as a same-user trust boundary.
- **Hard limits**:
  - 40 tasks per active plan.
  - 12 microtasks per task.
  - 8 MiB maximum size per room log (`events.jsonl`). Keep `activity_beat` at 30-second intervals to preserve room capacity.
  - 12 memory sections per room, up to 2,000 characters per section.

## 7. Privacy and the liaison slot

Each room enforces a privacy tier that governs the `liaison` assistant slot and model relays:

| Room tier | Allowed liaison providers |
|---|---|
| `private` | `firebase-ondevice` only (local endpoints only if `allow_private` is enabled); remote endpoints denied. |
| `standard` | Any enabled provider; defaults to `firebase-hybrid` (on-device first, cloud fallback) or user-configured `remote-openai-compatible` endpoints. |
| `shared` | On-device, `firebase-cloud`, and local endpoints; `remote-openai-compatible` endpoints denied. |

The liaison slot drafts, clarifies, and summarizes messages between the human and executors. It has no authority to claim tasks, mark work done, or issue rulings. Its behavior is **drafts only, human sends**: the human's message is saved first, and the liaison never sends messages to executors automatically.

If the liaison slot is empty, unavailable, or blocked by room policy, direct human-to-executor messages and all planning and memory tools continue to work. Closing the browser never triggers a cloud fallback, and on-device browser inference is unavailable in pure headless runs.
