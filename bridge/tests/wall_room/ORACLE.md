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
