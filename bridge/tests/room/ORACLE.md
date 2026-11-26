# U33 oracle (bridge/room)

Run: `cd repo && python3 -I -m unittest discover -s bridge/tests/room -t .` (stdlib only).
Against the stub: 92 tests, 91 fail or error; the 1 pass is a control (`test_real_emit_signature_is_compatible`, U09 `emit` binds with the four observer kwargs).

## Case map
| Spec rule | Tests |
|---|---|
| Event shape, canonical line, UTF-8, id, ts, clock | test_post.Shape |
| Every RoomError code (`bad_room bad_agent bad_act text_too_long bad_re bad_evidence bad_plan bad_step room_full`) | test_post.Shape (text), Codes, Evidence, Cap |
| Evidence hash, <=8, missing/relative/dir/under-room-root/credential basenames | test_post.Evidence |
| 0700 dirs, 0600 files (under umask 0) | test_post.Perms |
| 8 MiB cap, never truncates | test_post.Cap |
| Lamport monotonic/unique, 8 processes | test_post.Concurrency, Shape |
| read/since, torn last line, malformed count | test_read.Read |
| wait filters, timeout None, wake on post | test_read.Wait |
| inbox filter | test_read.Inbox |
| status | test_read.Status |
| CLI verbs, exit 0/2/4/124 | test_cli |
| MCP handshake, 5 tools, each call, isError, untrusted_text, -32601, -32700, survival | test_mcp |
| Hook helper | test_hook |
| HOOK_XPLAT Windows lock fallback | `test_hook.Hook.test_todo_hook_uses_windows_exclusive_lock_without_fcntl` hides `fcntl` in a fresh interpreter and records `msvcrt` calls. The silent entry writes the plan and session state while holding an exclusive lock that is released after the journal lock. |
| HOOK_XPLAT binary writes | `test_hook.Hook.test_log_and_state_open_in_binary_mode` checks that `O_BINARY` reaches the log truncation, log append, and state save calls. |
| Observer cursor | test_observer |

## Judgement calls (spec AUSENTE; implementer must match or raise)
- Subprocesses: `-I` drops cwd, so `python3 -I -m bridge.room` cannot import `bridge` (namespace package). support.py runs `python3 -I -c` with REPO prepended to sys.path and `runpy.run_module(<mod>, run_name="__main__")`; behaviour equals `-m`. Hook entry is `bridge.room.hook_claude` run as `__main__`.
- Cap: spec names no constant; 8 MiB = 8*1024*1024 bytes of file. Test fills the file directly with valid 4 KiB events, plus one run through the real API.
- `evidence=` takes a list of path strings; event stores `[{path, sha256}]`. "Under room root" = under `rooms/<room>/`. Credential regex applies to the basename only; directories are refused.
- `inbox(room, agent, since=0, *, home=None)` (spec omits `home`).
- `status`: `silent_after_s` is not a parameter; the test uses a 1970 ts versus a fresh ts. `open_questions` / `handoffs_without_ack` items may be events or ids; `last_by_agent` is only checked for its keys.
- Missing room via API is untested (only CLI exit 4). Torn tail is skipped, `malformed` is not asserted for it; a blank line is not malformed; a JSON non-object line is.
- CLI success output shape: JSON object, either the event or `{ok, event}`; `read` prints `{events, malformed}` (also without `--json`, no assertion). Refusal stdout is exactly `{"ok":false,"code":C}`.
- MCP: `post_status` posts any non-structured act (act not asserted); steps in `post_plan` are `{text, accept?}` objects; payloads are JSON in `content[0].text` with an `events` list (or the event / `{event}`); each event carries `untrusted_text` and no `text` key. `timeout_s > 60` is not tested; an unknown tool or missing args is either a JSON-RPC error or `isError`. EOF on stdin exits 0.
- Hook: status map pending/in_progress/completed to pending/active/done; the first call per session uses an all-pending list (whether it also emits steps is open); session state is keyed by `session_id`; room slug = lowercase, runs of non-alnum to `-`, stripped (`My Project` -> `my-project`), from the payload/process cwd. Log is `rooms/<room>/hook.log` in an existing room dir.
- Observer: `rooms_glob` globs room directories (`<home>/rooms/*`); room name = dir basename; on a falsy return the poll stops that room, so order is kept and the failed event is retried; other rooms continue.

## Repair loop 1 (cross-family review, 13 Nov)
`test_review1.py`: R1 Lamport from top-level field only + unknown plan step keys → `bad_plan`; R2 a complete fragment without trailing newline never yields duplicate or non-increasing Lamports; R3 non-finite or negative `timeout_s`/`poll_s` rejected without stalling (store, CLI rc 2); R4 non-string act/step state → `bad_act`/`bad_step` (no TypeError); R5 slugs use full match (no trailing newline); R6 concurrent hook runs: exactly one plan per session id, no malformed lines.

## Repair loop 2 (second review, HOLD)
`test_review2.py`, one TestCase per BLOCKING finding:
- F1 evidence symlinks: containment, credential basename and regular-file checks apply to the resolved target (target under room root, target `token.txt`/`secret.txt` incl. chained links, directory target, dangling link: `bad_evidence`). A valid symlink to a regular file is accepted; judgement call: the recorded `path` is `os.path.realpath(given)` and `sha256` is the target content hash.
- F2 append never truncates: a torn fragment (after events, or alone) survives a post byte-for-byte; the file grows by the new line plus at most 1 separator byte; `read` never returns the fragment; Lamport continues from complete events; a refused `room_full` append leaves the file byte-identical.
- F3 JSON-valid but invalid events (wrong types, missing fields, bad act, non-int lamport, non-str text, bad `re`/`to`) are skipped by `read`/`wait`/`inbox`/`status`, counted in `malformed` by `read`; `status` never raises (also via CLI). Open: whether their lamports feed the next Lamport (test only requires >= 4).
- F4 MCP: no `id` key means notification, no reply (known, unknown and `notifications/*` methods); unknown method with id (incl. `notifications/nope`): -32601; `id: null` is a request, reply carries `id: null`.
- F5 CLI argument errors (unknown verb, missing flags, bad int/float, unknown flag, extra positional): exit 2, stdout is exactly one JSON line `{"ok":false,"code":<str>}` (argparse text only on stderr).
- F6 hook helper under umask 022 and 0: every dir under CW_HOME is 0700, every file 0600, no stray `*.tmp` or unknown file in the room dir; checked after normal runs, refused-post runs (`CW_AGENT="BAD AGENT"`) and invalid-stdin runs.

## Oracle amendment A-U43 (close_task)

SPEC change (joint demo with ViewPoint): the MCP server exposes a sixth tool `close_task {room, agent, outcome}` that
posts a U33 `close` act whose text is `outcome` (string, non-blank, at most 240 characters; room/agent validated by the
store like the other tools). Errors are `isError` results with the RoomError code (`bad_args`, `text_too_long`,
`bad_room`, `bad_agent`). Amended: `test_mcp.py` `TOOLS` and `Handshake.test_tools_list` (5 -> 6 tools, `outcome`
required). New: `Tools.test_close_task_posts_close`, `Tools.test_close_task_outcome_limit`.


## U57 TaskLight fail-first oracle

Source: `.unit/SPEC.md`, including binding Amendment W0-R. The preceding U33
map is retained. U57 changes only the two test modules and this map.

Run new oracles (stdlib unittest):

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room -t . -p 'u57*test.py'
```

Run preserved room suites separately:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room -t .
```

The mandated filenames do not match default discovery's `test*.py`. The explicit
pattern above is necessary; no discovery hook or other file is modified.

| Acceptance case | Tests in `u57_mcp_v2_test.py` unless stated otherwise |
|---|---|
| 1. Handshake and golden prefix | `IdentityOracle.test_01_initialize`, `test_01_golden_legacy_schemas`, `test_01_twenty_tools_and_amended_schemas` |
| 2. Fourteen happy tool paths, IDs, readiness, evidence | `HappyOracle.test_02_templates_and_hash`, `test_02_all_edit_tools_and_entity_revisions`, `test_02_next_work_dependencies`, `test_02_evidence_hash_and_persisted_mapping`, `test_02_memory_before_plan_and_entity_revision`; `ErrorOracle.test_07_advisory_and_deterministic_findings` exercises `plan_check` |
| 3. Resources and prompts | `ResourceOracle.test_03_resources_and_discovery_are_read_only`, `test_03_missing_resources_and_invalid_uris`, `test_03_prompts_and_fences` |
| 4. Eleven new error codes | `ErrorOracle.test_04_no_plan`, `test_04_plan_exists`, `test_04_unknown_template`, `test_04_bad_template`, `test_04_bad_op`, `test_04_not_found`, `test_04_stale_rev`, `test_04_dep_cycle`, `test_04_claimed_by_other`, `test_04_limit_exceeded`, `test_04_not_conformant`; `test_04_missing_and_duplicate_dependencies`, `test_04_required_revisions_and_forbidden_keys` |
| 5. Replay and scoped operation identities | `ReplayOracle.test_05_task_add_replay_and_agent_scope`, `test_05_memory_replay_ignores_changed_payload`, `test_05_batch_retry_and_no_op_id_runs_normally` |
| 6. Ownership, takeover, exact boundary, legacy activity | `ErrorOracle.test_04_claimed_by_other`, `ReplayOracle.test_06_takeover_strict_boundary_and_legacy_activity` |
| 7. Advisory/strict creation, zero partial append | `ErrorOracle.test_07_advisory_and_deterministic_findings`, `test_07_strict_conforming_creation`, `test_04_not_conformant`, `test_04_dep_cycle`; `HostileOracle.test_09_capacity_and_atomic_rejection` |
| 8. Untrusted strings and escaped passive prompt data | `ResourceOracle.test_08_canaries_only_inside_complete_envelopes`, `test_03_prompts_and_fences`; every successful v2 call also asserts the complete wrapper |
| 9. Hostile inputs and stdio survival | Every `HostileOracle.test_09_*`: generated cases cover boolean, NaN, infinity, fraction and unsafe integer for each of `base_rev`, `limit`, `since_rev`; generated dangerous-key cases cover `__proto__`, `constructor`, `prototype`; named cases cover cyclic data, pre-disk argument validation, real-stdio nonfinite values, optional revisions, operation byte cap, capacities, Unicode/string limits, evidence, identifiers, torn/malformed JSON. Traversal URIs: `ResourceOracle.test_03_missing_resources_and_invalid_uris` |
| 10. Legacy regression | Existing `test_mcp.py` unchanged, plus all existing room tests via default discovery; `IdentityOracle.test_01_golden_legacy_schemas` freezes the actual pre-U57 definitions |
| 11. Two-process serialized updates | `u57_race_test.RaceOracle.test_11_two_process_task_update`, `test_11_two_process_memory_set`, `test_11_two_process_task_claim` |

Additional stop rule: `HostileOracle.test_12_no_network_and_stdlib_imports` checks
imports and blocks socket creation while querying metadata. No test opens a
listener. Takeover uses a fixed patched clock, not elapsed waits. Process pipe
reads, barriers and joins have bounded watchdogs, without sleeps. Race workers
run the real `bridge.room.mcp` module in separate interpreters; a barrier releases
requests against the same home. They assert one winner, no rejected append,
strictly parsed complete log lines and identical read projections in both servers.

### Binding decisions and limits

- Amendment W0-R wins over earlier table rows: `task_update.assignee` is refused;
  nullable `state`, `reason`, `estimate` are supported. `microtask_add.base_rev`
  is required, while `task_add`, claim and release revisions are optional but
  checked if supplied. Missing required revision is `bad_op`; mismatch is
  `stale_rev`. Task/memory mutations leave the plan revision unchanged.
- Persist `micro.set.micro_id` and `op.evidence`; reject `micro.set.base_rev`.
  Evidence hashes are independently computed from temporary runtime files.
- Memory is legal before an active plan; first write uses revision zero.
  `plan_get.tasks[].microtasks` is nested, with no duplicate top-level list.
- Every complete v2 data payload is `{"untrusted": payload}`. Resource text
  serializes that wrapper. Prompt fences need not use a particular prose label
  or delimiter width; they must explicitly mark passive data, contain canaries
  and escape marker-closing input.
- Discovery separates concrete `resources/list` URIs from
  `resources/templates/list` patterns. Missing valid resource is `-32002`;
  traversal/malformed URI is `-32602`. Read snapshots and write-lock rejection
  protect side-effect freedom without forbidding shared locks.
- Same `(agent, op_id)` replays the accepted result despite changed payload;
  batch retry must not hit `plan_exists` or append a partial batch. A fresh
  agent does not replay. Takeover equality fails; valid assignee legacy activity
  resets the silence interval.
- U55 template fixtures in `fixtures/plan/templates.v1.json` provide the neutral
  local runtime template permitted by U57, avoiding reliance on U59 starters.
  Missing accept is represented by an empty accept string to exercise semantic
  conformance without conflating missing required MCP fields with findings.
- Invalid primitive argument types may use existing `bad_args` or canonical
  `bad_op`; malformed room/agent keep their legacy codes. Nonstandard JSON
  NaN/Infinity may be rejected at parsing or as tool argument validation.
- The pre-U57 handshake and exact-six-tool discovery assertions in existing
  `test_mcp.Handshake` are inherently incompatible with U57's changed identity
  and twenty-tool list. They pass unchanged on this baseline. A future integrated
  v2 suite must reconcile those obsolete metadata expectations; their legacy
  tool behaviour and frozen schemas remain required.

### Out of scope (not U57 failures)

U55 reducer internals, archive/reopen and duplicate-ingestion vectors, schema
publication, and fixture parity belong to `bridge/plan/**`,
`schemas/planning-template.v1.schema.json`, and `fixtures/plan/**`. U56's direct
`post_ops` API implementation/lock unit tests belong to `bridge/room/store.py`
and `bridge/tests/room/u56_op_store_test.py`; U57 tests atomic outcomes through
MCP rather than requiring private call structure. U59 owns
`templates/planning/**`. U58 relay redaction/paging owns
`bridge/wall/room_relay.py` and `bridge/tests/wall_room/**`. U60 cross-language
fold parity, U61 adapters, U62 view models/styles, U63 privacy and model budgets,
U65 `docs/MCP.md`, U66 Firestore and U70 ViewPoint emission are out of scope.
Actual client resource/prompt support is AUSENTE — no inventar; this oracle
checks server protocol behavior only. No dependency stubs are added or invoked
as direct unit tests. Unsupported v2 calls must fail assertions at the MCP
boundary, never fail imports or silently skip.

### Baseline verification

Measured on the supplied pre-U57 implementation: 63 test methods, 60 red and
3 green, no errors or skips. Unittest counts failing subtests separately:
`FAILED (failures=69)`. The green controls are the golden legacy schemas,
malformed/torn stdio survival and stdlib/no-network metadata checks. Red results
are assertions against unsupported v2 tools/methods or outdated server metadata,
not imports or dependency-stub exceptions. Default room discovery remains green:
130 tests, `OK`. These are baseline observations, not claims that U57 is complete.

## U56 fail-first oracle (binding Amendment W0-R)

Sources: `.unit/SPEC.md` in full, `bridge/room/store.py`, `bridge/room/mcp.py`,
`bridge/wall/room_relay.py`, U55 public interfaces in `bridge/plan/`, and the shared
`fixtures/plan/templates.v1.json`. Timestamp bounds are cited from
`src/app/agent_store.ts` (`TS_MAX_ABS`). Production files are never changed.

Run from the repository root (stdlib unittest only):

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s bridge/tests/room -t . -p '*test*.py'
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s bridge/tests/room -t .
```

The first command discovers both the required `u56_*_test.py` names and existing
`test_*.py` suites. Default discovery alone excludes the required U56 filenames;
it is the separate unchanged-suite regression gate, not a U56 success receipt.

Gate: new tests fail through assertions about missing U56 behavior; negative
contrast: import errors, dependency stub exceptions, skipped cases, and accidental
fixture exceptions do not establish this gate. Each operation helper first asserts
the additive `post(..., op=...)` signature, preventing incidental TypeError errors.
`post_ops` likewise has an explicit callable assertion. Reader tests independently
exercise actual reader behavior without those guards. Legacy controls must pass.

### Numbered SPEC acceptance map

The numbers below are SPEC section 5 acceptance identifiers [CITED]. Names are
methods in the explicitly listed modules; wildcard suffixes enumerate separately
registered unittest methods, not estimated subtest counts.

| Case | File | Test names |
|---|---|---|
| 1 | `bridge/tests/room/u56_legacy_compat_test.py` | `LegacyCompat.test_all_legacy_acts_golden_bytes_and_read_models`, `test_legacy_error_*`, `test_legacy_explicit_op_none_preserves_wire_bytes` |
| 2 | `bridge/tests/room/u56_legacy_compat_test.py` | `test_legacy_plan_rejects_op_before_directories_or_lock`, `test_op_rejects_legacy_plan`, `test_op_rejects_legacy_step`, `test_legacy_event_with_op_is_invalid` |
| 3 | existing `bridge/tests/room/test_*.py` | unchanged default discovery regression gate, including CLI, MCP, hook, observer, read, post and prior review tests |
| 4 | `bridge/tests/room/u56_op_store_test.py` | `OpStore.test_all_ten_kinds_persist_canonical_and_fsync`, `test_nested_and_legacy_evidence_remain_independent`, `test_constants` |
| 5 | `bridge/tests/room/u56_op_store_test.py` | `test_static_*`, `test_hostile_clock_*`, `test_exact_utf8_byte_cap_and_one_over`, `test_unicode_codepoint_limit_and_ordinary_text` |
| 6 | `bridge/tests/room/u56_op_store_test.py` | `test_plan_exists`, `test_no_plan`, `test_task_add_self_cycle`, `test_transitive_cycle`, `test_task_limit_and_cancelled_ids_consumed`, `test_micro_limit`, `test_missing_task`, `test_missing_dependency`, `test_unknown_template` |
| 7 | `bridge/tests/room/u56_op_store_test.py` | `test_replay_after_plan_revision_advanced` |
| 8 | `bridge/tests/room/u56_op_store_test.py` | `test_changed_payload_replays_first_accepted_event`, `test_cross_agent_id_is_independent_and_omitted_id_never_replays` (amended first-result behavior) |
| 9 | `bridge/tests/room/u56_op_store_test.py` | `test_reader_valid_op_corrupt_lines_and_torn_tail`, `test_reader_rejects_contamination_and_hostile_integers`, `test_room_cap_preserves_file_and_releases_lock` |
| 10 | `bridge/tests/room/u56_op_concurrency_test.py` | `OpConcurrency.test_revision_*`, `test_optional_revisions_accept_matching_and_omitted`, `test_micro_updates_parent_task_revision`, `test_task_and_memory_changes_do_not_advance_plan_revision` |
| 11 | `bridge/tests/room/u56_op_concurrency_test.py` | `test_two_process_revision_race` (spawned processes, real file locks, synchronized start, exact winner and loser, complete lines) |
| 12 | `bridge/tests/room/u56_op_concurrency_test.py` | `test_claim_guard_and_strict_silence_boundary`, `test_latest_legacy_activity_including_out_of_order_timestamps`, `test_invalid_room_activity_does_not_extend_claim`, `test_already_owned_claim_release_and_unassigned_micro` |

### Additional binding amendment and stop-rule coverage

| Requirement | Tests / scope |
|---|---|
| Atomic batch commit, retry, forward references, final DAG, strict conformance, total capacity | `OpStore.test_batch_success_and_retry_do_not_duplicate_members`, `test_batch_forward_dependency_resolves_before_commit`, `test_batch_cycle_is_atomic`, `test_batch_late_invalid_op_is_atomic`, `test_batch_strict_conformance_failure_is_atomic`, `test_batch_strict_conformant_creation_succeeds`, `test_batch_capacity_failure_is_atomic` |
| Memory before/after plans; closed-plan writes; reopening with fresh IDs | `test_memory_before_plan_and_closed_plan_rules` |
| Markdown remains passive | `test_markdown_is_never_authoritative`; generation is optional, so generation timing/layout is not prescribed |
| Hostile payloads | `test_static_*`: cyclic/non-JSON data, nonstring keys, dangerous keys including nested brief, boolean/non-finite/unsafe revisions, forbidden/unknown fields, invalid op IDs, collection caps; `test_hostile_clock_*`: timestamp types, safe integers and timestamp bound |
| Legacy stop rule | Byte-identical canonical lines with fixed IDs, clock and hashed file evidence; exact read/wait/inbox/status returns; legacy error codes; independent unchanged-suite gate |

### Resolutions and explicit gaps

- Amendment W0-R overrides older conflicting expectations: explicit null `op_id`
  is `bad_op`; differing retry payloads return the first accepted event; missing
  required revisions are `bad_op`, mismatches are `stale_rev`; `task.add` revision
  is optional. `micro.set` has `micro_id`, nested `op.evidence`, and no `base_rev`.
  Nullable task mutation fields are accepted; `status` and `assignee` updates fail.
- Only plan operations advance plan revision. Task/micro changes advance task
  revision. A nonblocking independent lock acquisition after refused operations checks that
  the lock is released without risking a blocked probe write. Silence uses maximum prior assignee activity,
  including legacy events, with strictly greater than the specified boundary.
- The supplied U55 implementation is stubbed. Tests do not replace its validator,
  reducer, template parser, or errors. For integration tests, wrappers around the
  documented public `fold_plan` and `apply_op_event` functions supply the shared
  template via their existing `templates` keyword. The real functions still run.
  This avoids prescribing an unspecified store template-loading path or registry.
  Already-imported aliases are wrapped by identity, not by private symbol names.
  Completing U55 is a prerequisite for those integration assertions after U56's
  missing public API is supplied; U55's current stubs are not classified as U56 defects.
- Batch call shape is the documented list of operation dictionaries. The spec
  supplies no separate call-level `op_id` keyword: the minimal retry interpretation
  uses `plan.open.op_id` as the batch identity. Local-key syntax and member-result
  envelopes are AUSENTE — no inventar. Forward references use canonical allocated
  task IDs; tests assert persistence and replay identity without freezing an
  undocumented return container or private local-key grammar. This interpretation
  needs reconciliation if a later explicit batch envelope supersedes it.
- Atomic creation's strict negative uses a shape-valid task lacking acceptance and
  required project memory; the positive supplies both. Thus `not_conformant` cannot
  be substituted by ordinary shape rejection or an always-rejecting batch API.
- Normal operation text is not subjected to template control/code rejection.
  Canonical compact UTF-8 controls operation size; Unicode code points control
  string limits. Torn tails are ignored without increasing malformed count;
  complete corrupt lines increase it. Legacy event evidence remains independent.
- New tests contain no network calls, real sleeps, wall-clock dependence or port
  allocation. Multiprocessing waits have bounded watchdog timeouts for deadlock
  detection; operation timestamps remain fake. Generated temporary runtime files
  are cleaned using the existing room test helper.

### Out of scope (not U56 failures)

| Owner | Paths / contracts |
|---|---|
| U55 | `bridge/plan/**`, `schemas/planning-template.v1.schema.json`, `fixtures/plan/**`: validator internals, complete projection/archive/rollup/replay-map parity, finding-code vectors, Markdown rendering/format, template authoring |
| U57 | `bridge/room/mcp.py`: tools/resources/prompts, resource discovery, protocol errors and untrusted envelopes |
| U58 | `bridge/wall/room_relay.py`: redaction, hostile traversal, paging past `REPLAY_MAX` |
| U59 | `templates/planning/**`: starter templates |
| U60 | TypeScript reducer and cross-language projection parity |
| U61–U63 | VM adapters, Agenda eligibility, rendering, AI budgets/fencing/privacy and device-only routing |
| U66 / U70 / U71 / U73 | Firestore mirror/rules, ViewPoint v2 operations, simultaneous plans, HTTP transport |

Implementation success receipts remain AUSENTE — no inventar. Red oracle receipts
establish missing behavior, not a passing U56 implementation.


### U56 verification receipt

New oracle: 110 tests [MEASURED], 101 assertion failures [MEASURED], 9 green
legacy controls [MEASURED], no errors [MEASURED]. The additive operation API,
atomic batch API, constants and reader behavior are missing. No import failures
or U55 stub exceptions occurred. The separate original-suite run passed all
130 tests [MEASURED]: `Ran 130 tests in 30.310s`, `OK`.

Final combined discovery: 240 tests [MEASURED], 101 red [MEASURED], 139 green
[MEASURED], including every original room test. Exact summary:

```text
Ran 240 tests in 29.564s

FAILED (failures=101)
```

No production file or dependency stub was edited. The existing legacy oracle map
above is retained. Runtime syntax and public-path checks passed [MEASURED].
