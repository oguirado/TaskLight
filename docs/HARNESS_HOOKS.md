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

Input is limited to 65,536 bytes, including whitespace. Duplicate JSON keys,
unknown fields, invalid UTF-8, lone surrogates, malformed JSON and trailing
objects are rejected before dispatch. Payloads cannot specify filesystem paths.
The room, agent and run are always explicit: cwd, todo state, environment
identity fallbacks and process exit never supply lifecycle identity.

`CW_HOME` selects the existing room configuration root, as for other room
commands. With it unset, the existing configuration default applies. The target
room must already exist under that root's `rooms` directory. A missing room is
silently skipped; a lifecycle invocation never creates a room or plan. Provision
the room separately before registering deployment.

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
Do not invent a new event ID for a retry. Native lifecycle event names and
mappings are AUSENTE; native wiring belongs to U137. Capsule checks for the
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
