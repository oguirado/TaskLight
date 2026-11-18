# Harness lifecycle hooks

The harness records deployment and termination even when an agent reports
nothing. These local hooks use no model tokens, provider clients, network,
subprocesses or prompts. JSON strings are passive metadata, including `reason`.
Nothing is printed into model context.

## Entry points and input

Run either entry from the installed project environment:

```sh
python3 -m bridge.room.hook
python3 -m bridge.room.hook_claude --lifecycle
```

Both commands consume exactly one UTF-8 JSON object on stdin. Required nonempty
strings are `event_id`, `room`, `agent`, `state` and `run_id`. State is
`deployed`, `alive`, `finished` or `failed`. Optional `swarm` and `harness` are
nonempty strings of at most 128 characters; optional `reason` is a nonempty
string of at most 512 characters. The shared application validates slug and run
syntax. Room slugs permit lowercase letters, digits and hyphens; agent slugs
also permit dots and underscores. Run IDs permit letters, digits, underscores
and hyphens, with at most 64 characters.

Optional `parent_agent` uses the same agent slug syntax; optional
`parent_run_id` uses the run ID syntax. Each field may be supplied independently.
The child remains `agent`; unresolved parents are retained without registering
that parent. Self-parenting and parent cycles are rejected with `bad_args`.
Both hook entry points preserve these fields in the journal and on replay.

Input is limited to 65,536 bytes, including whitespace. Duplicate JSON keys,
unknown fields, invalid UTF-8, lone surrogates, malformed JSON and trailing
objects are rejected before dispatch. Payloads cannot specify filesystem paths.
The room, agent and run are always explicit: cwd, todo state, environment
identity fallbacks and process exit never supply lifecycle identity.

`CW_HOME` selects the existing room configuration root, as for other room
commands. With it unset, the existing configuration default applies. The target
room is created under that root's `rooms` directory on the first lifecycle
invocation, including its parent metadata. No plan is created; deployment and
agent discovery work independently of planning.

Without `--lifecycle`, the existing adapter continues its todo mirroring. Its
todo transitions never record deployment, liveness or termination. Lifecycle
mode bypasses `hook_state.lock` entirely.

## Executable fixtures

Configure `CW_HOME` for an existing room named `demo`. A deploy/alive/finished
sequence for one explicitly identified run is:

```sh
python3 -m bridge.room.hook <<'JSON'
{"event_id":"deploy-a","room":"demo","agent":"exec-a","state":"deployed","run_id":"r1","harness":"external"}
JSON
python3 -m bridge.room.hook <<'JSON'
{"event_id":"alive-a","room":"demo","agent":"exec-a","state":"alive","run_id":"r1","harness":"external"}
JSON
python3 -m bridge.room.hook <<'JSON'
{"event_id":"finished-a","room":"demo","agent":"exec-a","state":"finished","run_id":"r1","harness":"external"}
JSON
```

For a separate run, deployment followed by failure uses the same interface:

```sh
python3 -m bridge.room.hook_claude --lifecycle <<'JSON'
{"event_id":"deploy-b","room":"demo","agent":"exec-a","state":"deployed","run_id":"r2","harness":"external"}
JSON
python3 -m bridge.room.hook_claude --lifecycle <<'JSON'
{"event_id":"failed-b","room":"demo","agent":"exec-a","state":"failed","run_id":"r2","reason":"executor stopped"}
JSON
```

A wrapper must serialize actual harness-supplied event, room, agent and run IDs
as JSON and pass the bytes to either command's stdin. Persist that exact object
outside the hook until recording and cleanup have been independently verified.
Do not invent a new event ID for a retry. U137 tracks the native wiring
boundary: absent hook events never establish completion. For automatic Claude
Code lifecycle recording, use the native adapter below. Capsule checks for the
read-only wall belong to U114.

## Replay and failure cleanup

To replay, resend an identical fixture, even from a different process or through
the other entry. Event identity and content must remain immutable. The lifecycle
operation ID is the lowercase SHA-256 digest of compact UTF-8 JSON
`["lifecycle",room,agent,run_id,event_id]`, with non-ASCII characters unescaped.
The journal deduplicates it and returns its original Lamport. Reusing an event
identity with different state or metadata is an operation conflict.

Alive throttling belongs to the shared lifecycle operation: less than 30 seconds
since the last persisted alive returns success without appending. Replaying an
already persisted alive after that window still uses the original receipt.

For failure cleanup, first send the run's `failed` fixture. Inspect the current
`plan_get` projection independently, then replay that same fixture if unfinished
owned tasks remain. The same recipe applies to `finished`. Both states release
only owned tasks outside `done` and `cancelled`; release resets active microtasks
to pending and preserves evidence, completed outcomes, plan phase and other
agents' work. Neither state completes or cancels work or closes a plan. A run
that was never deployed cannot terminate or release tasks. With no active plan,
there is nothing to clean up.

Cleanup reads `plan_get` without `since_rev`. It requires matching recorded
`run_id` and terminal lifecycle, an active plan with `opened_lamport` before the
terminal Lamport, and a matching owner and `claim_lamport` also before that
Lamport. Missing evidence blocks cleanup. Each release rereads these identities
and uses the current task revision plus the captured claim fence. The release
ID hashes compact UTF-8 JSON
`["release",room,agent,run_id,event_id,opened_lamport,task_id,claim_lamport]`.
A stale revision permits at most three retries while more than 200 ms remains;
another owner is never retried. Successor runs, reclaims and reopened plans are
excluded. The shared claim fence protects a reassignment after the read.
The existing takeover threshold remains more than 600,000 ms.

An interruption after lifecycle commit or after a release can leave partial
cleanup. Exact replay resumes the remaining eligible releases without another
lifecycle event. A successful lifecycle receipt does not certify that all
cleanup completed.

## Silence, deadlines and trust

Both lifecycle commands always return exit status zero and empty stdout/stderr,
including malformed input, missing rooms, capacity errors, contention and
internal failures. Exit status means the hook returned; it is never proof of
persistence. Silent failure requires checking the journal or projection and
replaying the original object. The Python API
`run_hook_bytes(raw: bytes) -> dict` exposes shared structured receipts and error
codes before CLI silence is applied. Success has the shape
`{"untrusted":{"ok":true,"lamport":1}}`. Undeployed termination preserves
`not_conformant` and its detail; conflicts preserve `bad_op`.

On POSIX, a 2 second invocation budget includes stdin, imports, dispatch and
cleanup; the CLI reserves 200 ms for interpreter startup and exit overhead.
A BaseException timer interrupts only stdin and lock waits, passing
through broad application exception handlers. Budget checks stop dispatch and
further cleanup after expiry. The timer never interrupts a write or fsync in
progress: critical writes and non-wait import or computation time can therefore
extend wall time beyond the budget. This is a wait-only deadline, not a hard
kill of a storage transaction. No background threads or worker processes survive
return, and unlocking or closing stdin later cannot resume abandoned work.
The invocation temporarily owns the main thread's POSIX alarm timer and restores
its previous handler and timer on return. Embedders should use the synchronous
API on that thread. On non-POSIX platforms elapsed-time checks remain, but
blocking stdin and lock-wait interruption is not guaranteed until U121.
The legacy default todo mode retains its existing timing behavior.

Identity is caller-asserted. Harness-recorded is not authenticated, and this
entry is not an authorization or executor-cancellation mechanism. It records
literal metadata about a run; it neither talks to agents nor controls terminals.

## Claude Code native adapter

Enable automatic session and sub-agent registration without agent cooperation:

1. Install TaskLight in the Python environment used by Claude Code, or ensure
   `bridge` is importable from every project in which the hook runs.
2. Select a room explicitly with `TASKLIGHT_ROOM=demo` in Claude Code's
   environment, or create `.tasklight.json` containing `{"room":"demo"}` in
   the project. The nearest file wins, searching the payload's `cwd` and up to
   seven parents. An invalid explicit selection is skipped without a fallback.
3. Set `CW_HOME` to the same configuration root as the MCP server and wall.
   The shared lifecycle handler creates the room on first use; no plan is needed.
4. Run `python3 -m bridge.room.hook_claude_native --print-settings` and merge
   its `hooks` object into your Claude Code `settings.json`, preserving existing
   settings. Every generated entry is an asynchronous command with matcher `*`.
   The adapter never edits settings itself.
5. Start a Claude Code session, then launch a sub-agent and check the agent
   inventory. Sessions use harness `claude-code`; sub-agents carry both
   `parent_agent` and `parent_run_id` links to the session.

| Claude Code event | Lifecycle |
| --- | --- |
| `SessionStart` | Session `deployed` |
| `UserPromptSubmit`, `PreToolUse` | Acting agent `alive`, throttled together |
| `Stop` | Acting agent `alive`; the session remains open |
| `StopFailure` | Acting agent `failed` |
| `SessionEnd` | Session `finished` |
| `SubagentStart` | Sub-agent `deployed`, linked to the session |
| `SubagentStop` | Sub-agent `finished` |

The acting agent is the sub-agent when `agent_id` and `agent_type` are present;
otherwise it is the session. Session slugs are `cc-` plus the first ten SHA-256
hex characters of `session_id`. Child slugs use the normalized `agent_type`
(up to 24 characters) and the first eight SHA-256 hex characters of `agent_id`.
Run IDs are stable hashes, with child runs scoped to their session. Retry IDs
include the hook name, hashed native identities and tool-use identity; events
without a tool-use ID use a process ordinal and canonical input fingerprint.
The ordinal is zero for the single stdin event, preserving exact replay.
Only digests cross the lifecycle boundary. Repeated identical payloads deduplicate
across processes, including after the heartbeat window expires.

Prompt/tool heartbeat dispatches are limited to one per agent/run per 15 seconds,
using small, locked timestamp files under the room's `runtime` directory. Ignored
heartbeats do not advance that timestamp, and a failed dispatch does not consume
the window. `Stop` bypasses this adapter throttle. The shared lifecycle handler's
existing 30-second alive journal throttle still applies. Only documented
`SessionEnd` reasons (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`)
are retained, always within 64 characters; other values are omitted.

Raw session IDs (`session_id`), raw agent IDs (`agent_id`), prompts, `tool_input`,
`tool_response`, transcript paths (including `agent_transcript_path`) and
`last_assistant_message` are **never recorded** in the room, runtime files or
logs. The adapter sends only hashed identity, lifecycle state, harness, parent
links and an allowed terminal reason through the existing lifecycle dispatch.
It reads one UTF-8 JSON object, at most 65,536 bytes. Unknown events, malformed
input, missing configuration and store errors return silently with exit status
zero and empty stdout. Only the explicit `--print-settings` mode prints JSON;
it does not read stdin or require a room. A successful process exit alone does
not prove persistence. Native hooks report observed events; a missing hook or
an unobserved crash does not establish completion.

## Codex native adapter

Install TaskLight in the Python environment used by Codex, or make `bridge`
importable from every project in which the hook runs. Select the room with
`TASKLIGHT_ROOM=demo` in Codex's environment, or a `.tasklight.json` containing
`{"room":"demo"}` in the project. Discovery checks the payload's `cwd` and up
to seven parents. The nearest configuration is authoritative, including when
invalid; an invalid explicit environment selection also has no fallback. Set
`CW_HOME` to the configuration root used by the MCP server and wall. The shared
lifecycle handler creates the room on first use; no plan is needed.

Generate the Codex `hooks.json` document with:

```sh
python3 -m bridge.room.hook_codex_native --print-settings
```

Merge its `hooks` object into user `~/.codex/hooks.json` or trusted project
`.codex/hooks.json`, preserving existing hooks. The command only prints settings;
it neither reads stdin nor installs configuration. Non-managed hooks require
hash-specific review and trust through `/hooks`; changing a hook invalidates
that trust. Automation that independently vets its hooks can use
`--dangerously-bypass-hook-trust` for that invocation. Project trust is a
separate requirement. Commands run in the session's working directory, so the
same Python environment must be able to import TaskLight there.

| Codex event | Lifecycle |
| --- | --- |
| `SessionStart` | Session `deployed` |
| `SessionEnd` | Session `finished`, retaining reason `other` when present |
| `SubagentStart` | Sub-agent `deployed`, linked to the session |
| `SubagentStop` | Sub-agent `finished` |
| `Stop` | Session `alive`; the session remains open |
| `Interrupt` | Session `alive`; the session remains open |
| `UserPromptSubmit`, `PreToolUse` | Acting agent `alive`, throttled together |

`PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact` and unknown
events are ignored, including child `PreCompact` events. Generated handlers
are asynchronous with timeout 10 seconds, except `SessionEnd` and `Interrupt`,
which are synchronous with timeout 3 seconds and omit `async`. No matcher is
needed. Codex's `SessionEnd` reports an observed session end with reason
`other` and cannot report failure. For Codex lanes launched through
`tasklight run` or `tasklight wave`, the lane wrapper records failure from
the child process's exit status. Native hooks only add lifecycle visibility.

Sessions use harness `codex`, agent `cx-` plus the first ten SHA-256 hex
characters of `session_id`, and run `cx-` plus the first sixteen. Child agents
use the normalized `agent_type` prefix (up to 24 lowercase ASCII letters,
digits and hyphens, with `agent` as fallback) followed by the first eight digest
characters of `agent_id`. Child runs are `cx-` plus the first sixteen child
digest characters, a hyphen, and the first ten session digest characters.
`SubagentStart` includes `parent_agent` and `parent_run_id` for that session.
On prompt and pre-tool events, a present `agent_id` identifies the child even
when `agent_type` is omitted. Locked runtime metadata retains the child's first
successfully registered identity across later missing or changed type metadata.

Prompt/tool heartbeats share one dispatch per agent/run per 15 seconds in each
room. The timestamp advances only after a successful lifecycle receipt;
`Stop` and `Interrupt` bypass this adapter throttle. The shared lifecycle
handler's existing alive journal throttle still applies. Runtime files contain
only the hashed identity and heartbeat timestamp. Native IDs, prompts, tool
inputs or outputs, model, transcript paths and `cwd` never enter room records.
Only hashed identities, state, harness, parent links and the allowed reason
cross the existing lifecycle dispatch boundary; the adapter never opens or
appends the room journal itself.

The adapter accepts at most 65,536 UTF-8 JSON bytes, including whitespace.
Malformed input, duplicate keys, non-finite constants, invalid identities,
missing configuration and storage failures return silently with exit status
zero and empty stdout/stderr. Only `--print-settings` prints output. Exit status
alone does not prove persistence: check the agent inventory independently.
Missing hooks and unobserved crashes do not establish completion.


## Diagnose native hook setup

Run the doctor from the project with the same environment as the harness.

```sh
python3 -m bridge.room.ext.doctor
python3 -m bridge.room.ext.doctor --harness codex --cwd .
```

The default harness is `claude-code` and the default directory is the current
working directory. The command emits one JSON object and exits zero when the
checks pass or one when a check finds a problem. Each problem contains a fixed
`code` and a one-line `hint`.

- `room` gives the selected slug and its source using the native room lookup
  order. Existence is checked under `CW_HOME` and readability uses the checked
  journal reader. The doctor leaves the room untouched.
- `journal` reports file size and available bytes under the room cap.
  `heartbeat_free_bytes` reflects the lower ceiling for alive events.
- `hook` gives the expected command and the events where it appears in the
  user and project settings. For Claude Code, the doctor inspects
  `.claude/settings.json` and `~/.claude/settings.json` (or
  `$CLAUDE_CONFIG_DIR/settings.json`). For Codex, it inspects `.codex/hooks.json`
  and `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`). It checks project
  files starting at `--cwd` and walking up its parents. Hook settings must be
  regular files. The report omits other settings content and leaves harness
  trust and activation to the harness.
- `last_lifecycle` shows the latest committed event for the selected harness
  by Lamport order. A readable journal with no matching event reports `null`.
  Start a harness session and rerun the doctor to confirm recording.
