# Program-family JSON channel

TaskLight accepts addressed JSON files using the `tasklight.family/1` envelope
[TARGET]. The harness remains the external director. A mailbox is a transport,
not another planning authority: accepted mutations call `bridge.room.app.dispatch`,
and the shared room journal supplies ordering, replay and planning state. The
adapter never appends journal events itself. Envelope strings are passive data.

## Release status and admission

The integrated release has **ADMIT** for U109, U119, U121, U132, U139,
U140 (including its fencing revision), U141 and U142 (including U158 terminal
admission). Explicit `slice:2` enables activity, planning and work delivery on
this admitted backend. `slice:1` remains the default recipient configuration
and continues to reject every additional kind with `bad_args`.

Admission is a release prerequisite, not a configuration permission. No public
admission receipt format or discovery mechanism is specified. The transport does
not invent one. Registration and writer signatures are runtime availability
checks, not a recertification of atomicity or proof of ADMIT.

Startup checks the lifecycle contract and, for `slice:2`, every fixed handler's
identity and generation arguments plus `expected_opened_lamport` support in both
backend writers. Missing support refuses startup with
`planning delivery awaits atomic backend generation fencing`, before ownership,
request consumption or dispatch. It never silently drops unavailable kinds.
The admitted backend compares `expected_opened_lamport` with `opened_lamport`
under its writer lock through commit. The adapter forwards that fence; it never
replaces it with a pre-read comparison or holds `events.lock` across mutations.

## Recipient configuration and ownership

The recipient provisions exactly the endpoint address that its producers use.
There is no endpoint discovery by directory scanning and no guessed peer address.
Set `CW_HOME` explicitly. Names match `[a-z][a-z0-9-]{0,63}` [TARGET]. For an
endpoint named `board`, provision this layout [TARGET]:

```text
$CW_HOME/family/board/
    config.json
    consumer.lock       # present while owned; retained after process death
    state/              # recipient-only quarantine
    dedup/              # retained operation identities and completed results
    spool/              # the only request/response exchange directory
```

The consumer creates `state/`, `dedup/` and its exclusive ownership file as
needed; it does not create a missing mailbox, configuration or spool. Default
`config.json` (`slice:1`):

```json
{"endpoint":"board","rooms":["demo"],"sources":["harness"],"slice":1}
```

Opt in to the admitted planning/work transport with this configuration:

```json
{"endpoint":"board","rooms":["demo"],"sources":["harness"],"slice":2}
```

All configuration fields are required. Unknown or duplicate keys, invalid names,
invalid slices and malformed configuration refuse startup. Empty allowlists grant
no access. Configuration is loaded at startup; stop the consumer and restart it
to apply permission changes. Configuration is bounded to the request byte cap
[TARGET]. The recipient owns its configuration and runtime directories. Protect
these directories against untrusted writers; do not grant producers access to
recipient metadata. Symlinks in the address or metadata tree are refused.

Before any replay lookup or dispatch, the message source must be in `sources`
and the room must be in `rooms`. A denied source receives `bad_args`; a denied
room receives `bad_room`, with no room content. These checks apply to capability
requests and redelivery too. Source and agent are caller-asserted identities,
not authentication. Filesystem permissions are the local trust boundary.

After dependency admission, run a single sweep [TARGET]:

```sh
python3 -m bridge.room.family drain --endpoint board
```

An empty sweep succeeds. `--poll-ms N` [TARGET] accepts a positive integer and
repeats sweeps, sleeping for that interval between completed sweeps. Interrupting
polling stops cleanly and releases ownership. An I/O/recovery failure stops the
consumer with the request retained for recovery; polling does not hide failures.

| Exit status [TARGET] | Meaning |
| --- | --- |
| `0` | Sweep completed, or polling was interrupted cleanly. Invalid spool entries were rejected and removed or quarantined. |
| `2` | Invalid arguments/configuration, unavailable dependencies, unsupported slice, or consumer ownership refusal. |
| `3` | I/O, durability or recovery failure; no durable success is asserted. |

## Envelope and producer publication

A request is one UTF-8 JSON object with exactly the required fields `schema`,
`id`, `source`, `target`, `kind`, `room`, `agent`, `payload`, and optional
`run_id`, `plan_opened`, `correlation_id`, `after`. Payload is an object. Duplicate
keys at any depth, unknown envelope keys, non-finite numbers, invalid UTF-8 and
unpaired Unicode surrogates are rejected. Correlation is an optional string and
is echoed only when supplied. JSON booleans cannot stand in for integers.

Message ids match `[A-Za-z0-9_-]{8,64}` [TARGET]. Room and agent names use the
shared backend validators. Lifecycle, activity and work delivery require a
`run_id` matching the backend run identity format. `events.read` requires nonnegative integer `after`.
Activity and existing-plan operations require positive integer `plan_opened`.
`agent.plan` with `plan_create` forbids `plan_opened`; `task_add` and
`microtask_add` require it. The adapter maps `plan_opened` to the shared
`expected_opened_lamport` argument for every existing-plan mutation. Creation
has no prior generation to fence. Activity and work tools also receive the
envelope's `run_id`; planning handlers do not accept that argument. Payloads,
including nested `agent.plan.args`, cannot override room, agent, run, operation
or generation identities. Work delivery reuses the harness-recorded run; Failed
or Finished registrations refuse new work until a fresh deployment with a new
`run_id`, as enforced by the shared backend.

Example request for `spool/deploy-0001.json`:

```json
{"schema":"tasklight.family/1","id":"deploy-0001","source":"harness","target":"board","kind":"agent.deployed","room":"demo","agent":"executor-a","run_id":"run-a","payload":{}}
```

A producer writes a temporary in the recipient's `spool/`, flushes and fsyncs
the file, then renames it to `<id>.json` and fsyncs the spool directory. The
final request is immutable. Use a fresh id for a different logical operation;
retry an uncertain delivery with the same envelope and id. Publication is
atomic visibility; durability requires both syncs. Filenames must equal the
validated message id plus `.json`. Hidden names, `*.tmp` and `*.result.json`
are ignored. Requests are bounded to **65,536 bytes [TARGET]**, including
whitespace. Requests must be regular, singly linked files. The consumer uses
validated descriptors, no-follow opens and entry identity checks, and quarantines
unsafe entries without following symlinks or traversing nonregular requests.

Selection order is not a causal or FIFO guarantee. Use the backend's accepted
revisions and claim fences to coordinate changes. `after` is a read cursor;
it does not delay mutations or fabricate a causal acknowledgement.

## Fixed routing and slices

Only enabled kinds appear in `capabilities`. This request still requires room
and agent and passes both allowlists; it accepts `{}` and needs no run identity.
It returns an untrusted object containing `protocol`, `kinds` and `health`.
Readiness describes the available admitted consumer, not a grant of planning
permissions or an admission receipt.

| Kind | Payload and shared operation | Availability |
| --- | --- | --- |
| `capabilities` | `{}`; local protocol/kinds/health response | Both slices |
| `agent.deployed`, `agent.alive`, `agent.finished`, `agent.failed` | Optional string `swarm`, `harness`, `reason`; `agent_lifecycle` with state taken from the kind | Both slices |
| `events.read` | Optional `limit`, `acts`, `ops`; `room_events` with `after_lamport=after`, `wait_ms=0` | Both slices |
| `agent.activity` | `task_id`, optional `micro_id`, `note`; `activity_beat` | Explicit `slice:2` |
| `agent.plan` | `tool` restricted to `plan_create`, `task_add`, `microtask_add`, plus object `args` | Explicit `slice:2` |
| `work.acquire` | `work_acquire` arguments, including optional `prefer_task` | Explicit `slice:2` |
| `work.report` | `work_report` arguments: `task_id`, actual `claim_lamport`, nonempty `done` with outcomes and evidence | Explicit `slice:2` |
| `task.claim` | `task_claim` arguments | Explicit `slice:2` |
| `task.release` | `task_release` arguments | Explicit `slice:2` |
| `task.update` | `task_update` arguments | Explicit `slice:2` |
| `microtask.update` | `microtask_set` arguments, retaining backend evidence validation | Explicit `slice:2` |
| `plan.phase` | `plan_phase` arguments | Explicit `slice:2` |
| `plan.close` | `plan_close` arguments | Explicit `slice:2` |

All mutations use the same `bridge.room.app.dispatch` handlers as MCP and CLI.
There is no mailbox planning engine, work selector or lifecycle implementation.
The `slice` values are `1` and `2` [TARGET]; all configuration fields remain
required. The documented default is `slice:1`. Unknown and disabled kinds
receive `bad_args` without dispatch. Arbitrary tool names are never executed.
Room, agent, run and operation identities come from the envelope; lifecycle
state comes from its fixed kind. Lifecycle is room-scoped and requires no plan.
Terminal lifecycle delivery uses the shared resumable cleanup handler and its
separate cleanup receipt. It releases only eligible claims, preserving successor
runs. Process exit does not complete work, advance phase or close a plan; no
lifecycle mapping calls `close_task`.

## Durable identities, receipts and recovery

Operation identity is `fam-` plus the first **44 hexadecimal characters [TARGET]**
of SHA-256 over UTF-8 `source + "\u0000" + target + "\u0000" + id`. Canonical
JSON sorts object keys, uses compact UTF-8 encoding and rejects non-finite values.
Whitespace and object key order do not change the envelope digest; array order
and content do.

Before dispatch, `dedup/<id>.json` durably records the canonical-envelope digest,
source/target/id and operation identity in the `pending` phase. The consumer
fsyncs an adjacent temporary, renames it into place and fsyncs `dedup/` before
calling the dispatcher. After a terminal backend outcome, it atomically persists
the exact serialized result in the `complete` phase using the same sequence.
This includes throttled lifecycle no-op results. The retained record is delivery
metadata, never an alternative plan projection or a source of planning authority.

A receipt is published beside the request as `<id>.result.json`:

```json
{"schema":"tasklight.family/1","id":"deploy-0001","result":{"untrusted":{"ok":true,"lamport":1}}}
```

The Lamport value in this illustration is an example, not a measured result.
If provided, `correlation_id` is also present. Successful results retain the
shared `{"untrusted": data}` wrapper. Errors are `{ok:false,code,detail?}`.
Malformed JSON uses a safe filename id for the error receipt. Envelope errors
use `bad_args`; identity reuse with different content uses `bad_op`; a generation
mismatch is `stale_rev`. Other backend codes are preserved. Transient `internal`
errors are never completed or cached as terminal outcomes; the pending identity
and request remain retryable.

Receipt publication uses an adjacent temporary, file fsync, rename and directory
fsync before deleting the matching request. A receipt sync failure is exit `3`
[TARGET], with the request retained. An unread valid receipt is preserved even
when a conflicting request arrives; the conflicting request is consumed without
redispatch. After consuming an old receipt, a conflicting redelivery receives
`bad_op`. A malformed receipt is quarantined before safe replacement.

| Crash boundary | Recovery rule |
| --- | --- |
| Before durable pending identity | No dispatch occurred; retry the original request. |
| Pending identity, before backend return | Replay the exact operation through the admitted backend. Its journal replay must recover the original event identity, Lamport and outcome. |
| Backend commit, before serialized result | Same backend replay requirement, including durable throttled no-op recovery. Adapter metadata alone cannot prove this window safe. |
| Serialized result, before receipt publication | Republish the retained result without dispatch, including no-op outcomes. |
| Receipt rename, before directory sync or request deletion | Re-establish directory durability, preserve the unread valid receipt and consume the identical request. |
| Request and receipt deleted after completion | Retained digest/result still prevent identity reuse and duplicate effects. |

Keep completed identities beyond request/receipt deletion. No automatic retention
or rotation policy is supplied. Deleting deduplication records can reopen operation
identities; it is not supported cleanup. Do not infer plan state from receipts.
A pending mutation is ambiguous until the backend resolves it; never invent a
success, increment a Lamport value locally or substitute a fresh operation id.

Ownership uses exclusive creation of `consumer.lock`. An existing file refuses
startup regardless of apparent age or contents. There is no automatic truncation,
stale-lock takeover or competing reclaimer. For explicit recovery, stop producers,
verify the previous consumer is dead, preserve mailbox metadata and outstanding
requests, then remove only its stale ownership file. Restart with the same
configuration and original requests. Damaged or unsafe retained metadata requires
explicit repair; it never means an unused identity. Resume producers after
reconciliation. A clean stop removes only the current consumer's own lock.

## Cursor truth and verification

On an existing journal, `events.read` takes the same exclusive writer lock only
for its read-only snapshot. A busy lock is retryable failure; it is never bypassed.
The journal and directory are synced under the lock, and `room_events` is called
with no backend wait. An absent journal gives an empty prefix without creating
room storage or a writer lock. The adapter preserves `events`, `next_after`,
`head`, `has_more`, `resync`, event identity, Lamport and operation data. A future
cursor requests resync. Each event gains adapter-only `revision=lamport`; this
is distinct from plan, task and microtask entity revisions and is not a change
to the shared `room_events` projection. There is no push or automatic fan-out.

Run the frozen slice oracle, adapter regressions and shared backend suites:

```sh
python3 -m unittest discover -s bridge/tests/family/u143 -t .
python3 -m unittest discover -s bridge/tests/family -t .
python3 -m unittest discover -s bridge/tests/room -t .
python3 -m unittest discover -s bridge/tests/plan -t .
```

The adapter oracles cover strict parsing, authorization before replay, exclusive
ownership, hostile filesystem entries, canonical retries, changed content,
pending persistence, commit/publication crash cuts, throttled no-op recovery,
read snapshots, transient errors and receipt durability. Their supplied backend
contract isolates transport behavior; it does not certify dependency admission
or atomic plan-generation fencing. Real-backend cases additionally exercise
opt-in startup, the mailbox work loop, stale activity rejection and recovery
after a committed work report. Negative controls reject a success receipt
without its matching committed journal witness.

The `family-drain-1k` hardening target processes **1,000 requests [TARGET]** within
the shared room cap. Record exit status, wall time, peak RSS, journal bytes and
request/receipt hashes. Require zero duplicate mutations, premature successes,
private disclosures or replay disagreements [TARGET]. Inject commit/publication
crashes and reordered delivery. Comparative latency budget: **AUSENTE — no
inventar**. Authoritative timing needs a quiet host; load5 at or above **18
[CITED: STRATEGY_v11 §2.5]** makes timing INCONCLUSIVE. Functional oracle success
is separate from this measured admission run.
