# U37a oracle (bridge/wall/room_relay.py)

Run: `cd repo && python3 -I -c "import sys,unittest;sys.path.insert(0,'.');unittest.main(module=None,argv=['x','discover','-s','bridge/tests/wall_room','-t','.'])"` (stdlib only).
Against the stub: 77 tests, 72 fail or error, 5 pass (controls: ROOM_LIMITS values, 4 static checks). A throwaway reference implementation (kept outside the repo) passed 77/77 with the U09 candidate `emit.py`.

## Case map
| Spec rule | Tests |
|---|---|
| ROOM_LIMITS values | test_config.Limits |
| load_room_config: allow list, tier to floor, ROOMS_MAX 12/13, bad slugs, structure | test_config.LoadRoomConfig |
| sanitize_event: field-wise redaction, exempt id/sha256, residue to None | test_sanitize |
| prime/poll: only new, cursor per room, frame cap drop+count, malformed never raises | test_poll |
| handle: non-room None; room_sync replay, REPLAY_MAX, more, rid | test_handle.NonRoomFrames, Sync |
| room_post ack/nack, forced agent, to/re, rate, text rules, U33 codes, structural rc 2 | test_handle.Post |
| stats counters | test_handle.Stats |
| no text on stdout/stderr/logs (in-process and fd-level subprocess); stdlib only; redact from bridge.wall.emit | test_privacy |

## Redaction dependency
Tests are independent of U09 by default: `Base` replaces `redact` with an identity fake (patched on `bridge.wall.emit.redact` AND on `room_relay.redact` if present). Only `test_sanitize.SanitizeRedaction` uses the real `redact` and skips with a clear reason while it raises NotImplementedError. Note: the current repo `emit.py` stub is a passthrough (does not raise), so those tests run and fail, which is the correct fail-first state. Planted value is `FAKE_API_KEY=planted-fake-value-0042` (KEY_ASSIGN class), built at runtime.
Residue = `redact(redact(x))` reports count > 0 (same rule as U09 emit lines 499-500).
Trap: `bridge/wall/__init__.py` re-exports `emit`, so `import bridge.wall.emit as e` / `from bridge.wall import emit` yield the FUNCTION. Use `from bridge.wall.emit import redact` (or importlib).

## Judgement calls (spec AUSENTE; implementer must match or raise)
- `send(frame: dict)`; `clock() -> seconds float` (monotonic style); event `ts` comes from the U33 store, not the relay clock.
- `load_room_config` returns `{"rooms":[{"room","floor"}...] (config order), "agent", "orchestrator": str|None, "home": str|None}`; `RoomRelay(rcfg, ...)` takes that dict. `None` for: non-dict, missing/empty/non-list `allow`, 13+ rooms, duplicate rooms, bad slug, tier not `private|standard`, extra keys in `rooms` or an allow entry, bad agent/orchestrator (U33 AGENT_RE), empty/non-str home. Extra top-level cfg keys are ignored.
- Home precedence: `home=` kwarg, else `rcfg["home"]`, else CW_HOME (store default).
- `sanitize_event` returns a deep copy (input untouched), `None` for non-dict or residue.
- `poll`: ascending lamport per room, rooms in config order; cursor advances past dropped events (no retry); `room_event` live frame keys exactly `t,v,room,floor,event`; replay adds `rid`. Rooms created after `prime()` are picked up from lamport 0. Never creates directories.
- `handle` returns 0 for any handled room frame (including nacks), 2 structural, None non-room. Only `room_sync`/`room_post` are room frames upstream.
- `room_sync`: only rooms listed in `since` AND allowed are replayed (others skipped silently, no frame); per room: `room_event`* then `room_synced{rid,room,upto,more}`; `upto` = lamport of last replayed event, or the `since` value if none; `more` true only if events remain beyond REPLAY_MAX. Replay does not move the live cursor. Dropped events still count toward REPLAY_MAX consumption/upto.
- `room_post` structural (rc 2, nothing written): v != 1 (or non-int), missing/invalid rid, missing/extra keys (including `agent`, `id`, `lamport`), non-str room/text/to/re, `act != "question"`. A well-typed but unknown/bad-slug room is semantic: `room_not_allowed`.
- Check order: structural, then room allow+directory (`room_not_allowed`), then text (`text_too_long` by UTF-8 bytes > 4096; empty or any C0 control, incl. newline, gives `bad_args`), then rate (`rate_limited`), then the store call (its RoomError code is forwarded). Only acked posts consume rate budget; limit is global (not per room), tested only at the same instant and +2.0 s (window style not pinned).
- Stats keys (ints, snapshot copy): `events_sent` (live + replay frames), `dropped_residue`, `dropped_oversize`, `posts_acked`, `posts_refused` (includes rate_limited), `structural`.
- Not tested: `to: null`/`re: null` (only "no crash"), room_full end to end (only via mocked store error), room_hello (not in U37a API), exact float window of the rate limiter.

## Repair loop 1 (Sol review)
`test_review1.py`: R1 a failed room_event send during replay never lets room_synced.upto skip it, and a retry recovers all events; R2 a NaN/±inf clock never lets more than POSTS_PER_SEC posts through.

## U58 oracle — operation redaction and replay paging

Scope: `.unit/SPEC.md`, including binding amendment W0-R item 18. Existing U37a documentation above is historical and is preserved. U58 changes only the test modules below and this shared directory-level `ORACLE.md`. No production stubs are authorized: `bridge/wall/room_relay.py` remains unchanged. Current failures must therefore be behavioral assertions, not manufactured `NotImplementedError("U58 stub")` exceptions.

All commands start in `the repository root`. Disable bytecode writes with `PYTHONDONTWRITEBYTECODE=1`.

The required filenames do not match unittest's default `test*.py` pattern. Run:

```sh
cd the repository root && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/wall_room -t the repository root -p 'u58_test_*.py'
```

Use `-p '*test*.py'` for existing plus U58 tests, or omit `-p` to run the unchanged existing-suite discovery gate. No skip or expected-failure markers conceal missing U58 behavior.

### bridge/tests/wall_room/u58_test_op_redact.py — acceptance map

Tests below are methods of `OpRedaction`.

| Numbered acceptance case | Exact test names |
|---|---|
| O1: all planted positions, real redactor, both relay routes, non-mutation, Stop rule 1 | `test_o1_all_positions_real_redactor_live_and_replay` |
| O1: all operation kinds, unchanged JSON scalars and deep copy | `test_o1_each_operation_kind_and_json_scalars` |
| O1: optional operation payload on legacy act | `test_o1_operation_on_legacy_act_is_also_redacted` |
| O1 / W0-R 18: identifiers, hashes, keys and kind values have no exemption | `test_o1_identifiers_and_hashes_have_no_exemption` |
| O2: second-pass residue in nested value or key | `test_o2_nested_value_residue_sanitize`, `test_o2_key_residue_sanitize` |
| O2: live/replay drops, accounting, clean successor and live cursor | `test_o2_nested_value_residue_live_and_sync`, `test_o2_nested_key_residue_live_and_sync` |
| O3: redactor exceptions and non-string results | `test_o3_redactor_exception_sanitize`, `test_o3_bad_redactor_return_sanitize`, `test_o3_redactor_exception_live_and_sync`, `test_o3_bad_redactor_return_live_and_sync` |
| O4: input fits frame cap but redaction expands beyond it; live/replay drop and live cursor progress | `test_o4_redaction_expands_past_frame_cap_live_and_sync` |
| O5a: missing operation, null, string, list | `test_o5_missing_operation`, `test_o5_invalid_operation_containers` |
| O5b: malformed operation attached to legacy act | `test_o5_legacy_act_with_invalid_operation` |
| O5c: non-JSON values and non-string dictionary keys | `test_o5_non_json_values_and_keys` |
| O5d: excessive mixed dictionary/list nesting | `test_o5_excessive_mixed_container_depth` |
| O5e: distinct keys collide after masking | `test_o5_redacted_key_collision` |
| O5 positive controls: valid renamed key, shallow nesting, legacy null payload | `test_o5_noncolliding_keys_are_replaced`, `test_o5_shallow_containers_and_legacy_null_operation` |
| O6: private floor | `test_o6_private_operation_floor` |
| O6: all legacy acts, golden frame bytes and stats | `test_o6_legacy_golden_frames_and_stats` |
| W0-R 18: copy failures, including pre-traversal recursion failure | `test_w0r18_copy_failure_sanitize`, `test_w0r18_copy_failure_live_and_sync`, `test_w0r18_precopy_recursion_failure_is_closed` |
| W0-R 18: cyclic dictionary/list payloads | `test_w0r18_cycles` |
| W0-R 18: NaN and signed infinities, drop accounting and cursor | `test_w0r18_nonfinite_numbers`, `test_w0r18_nonfinite_live_and_sync` |
| W0-R 18: serialization/UTF-8 failure cannot reach send | `test_w0r18_unencodable_string_never_reaches_send` |
| Behavior rule 1: silent public calls with hostile data | `test_silent_hostile_public_calls` |

### bridge/tests/wall_room/u58_test_paging.py — acceptance map

Tests below are methods of `Paging`.

| Numbered acceptance case | Exact test names |
|---|---|
| O7: 1250 operations, page sizes 500/500/250, upto 500/1000/1250, more true/true/false, ascending, no duplicates/skips | `test_o7_1250_operations_three_pages` |
| O8: exactly 500 and 501 events | `test_o8_exactly_500_is_terminal`, `test_o8_501_requires_second_page` |
| Behavior rule 10: empty chunk preserves since, more false | `test_empty_page_preserves_since` |
| O9: 600 mixed events, residue at 500 and redaction-expanded oversize at 501 | `test_o9_mixed_room_residue_and_oversize_at_boundary` |
| O10: first 500 of 550 events dropped; replay progresses | `test_o10_first_page_all_dropped_still_advances` |
| O11: send raises on tenth event; no room_synced, return zero, retry recovers all events | `test_o11_send_exception_tenth_event_no_synced_retry_recovers` |

### Numbered behavior rules and verification gates

| Spec behavior rule | Coverage / gate |
|---|---|
| 1 | `test_silent_hostile_public_calls`; existing `test_privacy` import and side-stream checks; malformed-input tests in existing suites |
| 2 | `test_o1_all_positions_real_redactor_live_and_replay`, `test_o1_each_operation_kind_and_json_scalars`, `test_o5_noncolliding_keys_are_replaced` |
| 3 | O5a/O5b tests and legacy-null positive control |
| 4 | O1/O2/O3 tests; strings in dictionaries and lists |
| 5 | scalar positive control, invalid value/key rejection, collision and key-renaming tests |
| 6 | shallow positive control, excessive-depth rejection, pre-copy recursion failure; traversal algorithm is an implementation constraint, not pinned by source-code matching |
| 7 | O1 top-level text, plan title/steps, step outcome/took, and evidence path |
| 8 | shared `RelayHarness.assert_drop` exercises live/replay accounting and infers cursor advance through subsequent store-read arguments and delivered events |
| 9 | O6 golden legacy frames/stats and private operation floor; existing room-post ack/nack/rate/schema regression suites |
| 10 | O7–O11, empty page, and sync branch of `assert_drop` |
| 11 | real-secret O1 assertions on sanitizer and both emitted frame routes; key/value fault injections |

### Resolved ambiguities and fixture boundaries

- Both mandated test files share one directory, so their separate maps live in this existing directory-level `ORACLE.md`; its legacy content is retained.
- No stub files are allowed. Preserve the existing implementation and report behavioral reds. Do not force stub exceptions, alter production exports, or assert NotImplementedError as a desired implementation behavior.
- Store acceptance of `op` is U56-owned and not present in this workspace. Mock only `bridge.room.store.read` with its existing `(events, malformed_count)` return shape, honoring `lamport > since`. Deliberately reversed input tests ascending replay without relying on disk-order behavior. Do not mock `_read_sorted`, `sanitize_event`, `_frame_oversize`, `_try_send`, or relay counters.
- No test writes files, creates a home directory, calls a real clock, or opens ports. The explicit home string is a non-created workspace-local placeholder. The actual redactor is exercised for planted credentials; deterministic redactor fakes isolate residue/failure/expansion contracts.
- Root-versus-child depth counting is unspecified. Test clearly valid shallow nesting and clearly invalid 40-container nesting rather than inventing a boundary convention. A bounded 1500-list fixture exercises failure during deepcopy before traversal.
- Serialization exceptions may be detected during sanitization or frame sizing. Assert no event reaches send and exactly one existing drop counter advances, without imposing a new error code or choosing a detection stage.
- Relay semantic validation of kind-specific schemas remains outside scope. Include optional op_id absence and all canonical kinds, but do not require U55/U56 reducer validation here.
- U55/U56/U60/U62 supplied specifications are not declared absent. Implementation/verification receipts for those units: AUSENTE — no inventar. No additional files outside U58's assigned surface are required.

### Verification receipt

| Discovery pattern | Measured result |
|---|---|
| Default `test*.py` (existing suites) | `Ran 79 tests in 0.352s` [MEASURED]; `OK` |
| `u58_test_*.py` (new oracle) | `Ran 38 tests in 0.058s` [MEASURED]; `FAILED (failures=43)` |
| `*test*.py` (combined) | `Ran 117 tests in 0.441s` [MEASURED]; `FAILED (failures=43)` |

New-test method outcomes: 24 red, 14 green [MEASURED]. The 43 failure entries [MEASURED] include individual failing subtests; they are not distinct test methods. Zero errors and zero skips [MEASURED]. All reds are assertions exposing omitted operation redaction/validation; there are no U58 stubs to raise a stub exception. Paging without drops, legacy invariance, copy-failure containment and send-failure containment already pass.

`bridge/wall/room_relay.py` SHA-256 before and after test creation: `8733a4f4dbc329171f9390ec9fecd9693e3ad325774cdfa9b6f2973aa33a2efd` [MEASURED]. No production file was edited. This isolated workspace has no Git metadata; `git status` cannot provide a change receipt. Only the explicitly authorized test modules were created and this pre-existing `ORACLE.md` was appended.
