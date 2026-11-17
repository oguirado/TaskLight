# Synthetic benchmark infrastructure

All fixtures contain synthetic data. No provider, agent launcher, production instrumentation,
room content, root configuration or production file is changed. The reference revision is
`4528625acafa5e435c4b34b6d1fd6adfacee6dd3` [CITED]. Executed working-copy sources are
identified by hashes; an unverified checkout is never presented as a verified revision.
Self-pairs establish repeatability and make no speedup claim. Timings do not confer admission.

Run from the project root with the existing dependencies installed. The native TypeScript
adapter requires Node with type stripping and loader hooks; its version is recorded on execution.
Python uses only the standard library. Scratch, caches and output stay in these benchmark directories.

```sh
mkdir -p tests/bench/.scratch tests/bench/.cache tests/bench/artifacts
export PYTHONDONTWRITEBYTECODE=1
export TMPDIR="$PWD/tests/bench/.scratch"
export npm_config_cache="$PWD/tests/bench/.cache/npm"
export npm_config_update_notifier=false
python3 -B -m unittest discover -s bridge/tests/bench -t .
npx vitest run --config tests/bench/vitest.config.ts --configLoader native
npx vitest run --project unit --configLoader native --cache=false
npx tsc --noEmit -p .
```

The local Vitest configuration includes only the new suites. The existing unit project includes
only its existing test directory. Native config loading and disabling the existing project's cache
avoid configuration compilation and cache output elsewhere. JSDOM is used solely for escaping
correctness, never for browser timing.

## Fixtures and correctness

`oracle.json` freezes planning, ownership, progress, memory revisions and rejection receipts.
Both languages check that oracle independently. A mixed journal has 10,000 events [TARGET],
including duplicate IDs, late accepted operations, addressed markup, non-op activity and rejected
operations. Frozen ingestion counts are 9,901 accepted and 99 duplicates [TARGET]. The owner
remains `alice` because the latest non-op activity prevents takeover, even when display retention
has pruned that event. Every operation remains in the public history.

Room admission checks serialized UTF-8 bytes against the production CAP before writing.
The tail fixture is CAP minus 256 bytes [TARGET], with a full-read reference for latest, filtered
and future cursors. Tests also check the real dispatcher `untrusted` envelope, existing error codes,
and a valid hostile append returning `room_full` without changing the journal hash.

The client soak generates 100,000 events in chunks of at most 512 [TARGET]; it never persists
that oversized stream as a room. The complete seed journal plus stream is hashed incrementally.
Burst input includes actual memory updates, so freshness checks cannot pass on heartbeats alone.
Ingestion, subsequent projection reads, browser update latency and mutations are separate fields.
Heap observations include process heap trend and, when exposed GC is available, post-GC retained
heap slope. Public display retention is distinguished from internal journal retention; a bounded
display does not prove bounded internal storage. GC, generation and hashing remain outside timing.

The concurrency adapter synchronizes eight writer processes [TARGET], each making a real
acknowledged planning mutation. It records every acknowledgement interval, failures, final journal
bytes/hash and exact-once identities, ordering, mutation payloads and folded task count. Spawn,
barriers, joins, setup and correctness checks are excluded. All children are joined or terminated.

Negative controls cover agreeing no-ops, omitted accepted operations, missing work, mismatched
fixture hashes, a swallowed `room_full`, duplicate acknowledgements without persistence,
heartbeat substitution for swarm derivation, hostile rooms and markup, and missing telemetry.
Correctness failure is `BLOCK`; infrastructure or telemetry absence is `INCONCLUSIVE`.

## Authoritative measurement

A separate orchestrator must grant a quiet window after verification has finished. The harness
never creates a grant. Pass its JSON using `--quiet-window-receipt "$QUIET_WINDOW_RECEIPT"`.
Its contract is:

```json
{
  "schema": "tasklight-bench/quiet-window-v1",
  "granted": true,
  "exclusive": true,
  "verification_running": false,
  "expires_at": 0
}
```

`expires_at` must be a future Unix timestamp supplied by the grantor; the expired example is
rejected. Reports retain the receipt content hash, never its path. An exclusive nonblocking
file lock prevents overlapping timing in this workspace.

Before any callback starts, and throughout warmups and paired observations, measured load5
must be below 18 and MemAvailable at least 20 GiB [TARGET]. Missing data, an expired grant,
lock contention, load5 at or above 18, or insufficient memory prevents further work. Load5
above 24 is a stop boundary [CITED]. A crossing preserves partial raw evidence and invalidates
its authority. Incomplete samples and unavailable RSS are never represented as zero.

```sh
python3 -B -m bridge.tests.bench.run --output tests/bench/artifacts/registry.json
python3 -B -m bridge.tests.bench.run --quiet-window-receipt "$QUIET_WINDOW_RECEIPT" \
  --output tests/bench/artifacts/registry.json
```

The first command deliberately records `INCONCLUSIVE` without a grant. Exit status is success
for a complete passing registry, a distinct nonzero status for `BLOCK`, and another for
`INCONCLUSIVE`; no absent adapter silently passes. Select a benchmark with `--benchmark`.

Each real variant performs five untimed warmups per side and thirty paired observations [TARGET],
alternating side order. Each side receives identical fixture hashes and fresh equivalent state
under an isolated `CW_HOME`. Python hot intervals use `time.perf_counter_ns`; TypeScript uses
`process.hrtime.bigint`. Setup, generation, correctness, hashing, GC and subprocess startup are
excluded. Percentiles use nearest rank, `ceil(p*n)`. Reports preserve every raw interval, pair
order, before/after load and memory, command/exit result, process scope and source artifact hashes.
Python RSS is its process lifetime high-water mark. Node observations use fresh processes;
concurrency RSS is the maximum individual high-water mark across coordinator and writers,
not an aggregate swarm footprint. Acknowledgement raw samples are retained separately from
the primary maximum-per-burst observation.

Optimization targets are assessed separately. A correct baseline remains `PASS` when slow.
JSON and its SHA-256 are referenced by the adjacent Markdown summary. Generated artifacts are
ignored by version control and can be handed to the orchestrator for publication separately.

## Unavailable prerequisites

| Registry boundary | Reported prerequisite |
|---|---|
| `diary-scroll-10k` browser render/scroll | `INCONCLUSIVE`: `AUSENTE` real browser runner; fixture retained |
| `wall-event-burst` browser latency/mutations | `INCONCLUSIVE`: `AUSENTE` real browser runner; ingestion is a distinct variant |
| `swarm-vm-derive` | `INCONCLUSIVE`: `AUSENTE` verified U112/U136 adapter at pinned reference |
| `lifecycle-burst` | `INCONCLUSIVE`: `AUSENTE` U132 `agent_lifecycle` adapter |
| `room-concurrency` acquisition variant | `INCONCLUSIVE`: `AUSENTE` frozen U119 protocol, distinct from reference writes |
| `room-recover-checkpoint` | Not applicable until U102; `INCONCLUSIVE`, no fabricated timings |

Reservations contain 15 agents, 40 tasks and 12 microtasks per task [TARGET]. Lifecycle calls
retain `room` and `run_id`, using `agent_lifecycle` arguments and an explicit relative schedule.
There are 105 attempted calls [TARGET]: 45 distinct transitions, 45 exact replays and 15 fresh-ID
throttle attempts [TARGET]. Throttle attempts precede terminal transitions. Committed counts,
journal bytes and bytes per committed lifecycle event remain null until a real adapter exists.
The presence of a source file or a heartbeat implementation cannot satisfy that prerequisite.

This implementation is limited to the supplied benchmark specification and the verified existing-function surfaces.
