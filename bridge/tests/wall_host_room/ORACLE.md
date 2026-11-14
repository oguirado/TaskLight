# U09 AMEND_W oracle: native host room hooks (bridge/wall/native_host.py)

Run: `cd repo && python3 -I -c "import sys,unittest;sys.path.insert(0,'.');unittest.main(module=None,argv=['x','discover','-s','bridge/tests/wall_host_room','-t','.'])"` (stdlib only, ~13 s green).
Scope: ONLY the host hooks. RoomRelay and load_room_config are faked (`support.make_fake`); the host runs in-process (`main()` in a thread, os.pipe stdin, capturing stdout). A throwaway reference patch of native_host (kept outside the repo) passes 38/40; the 2 red are the RoomObserver fix.

## Host contract pinned (judgement calls, spec AUSENTE)
- Host obtains `RoomRelay` and `load_room_config` from `bridge.wall.room_relay` (module-level names on `native_host` or lazy import; tests patch both modules).
- `load_room_config(cfg)` -> rcfg dict `{"rooms":[{room,floor}], "agent", "orchestrator": str|None, "home"}` (as in wall_room/ORACLE.md); `None` = no relay, host runs exactly as before (invalid section == absent).
- `RoomRelay(rcfg, send, **kw)`: rcfg is the dict returned by load_room_config; `send` is the host framing sender (oversize still dropped by the host).
- Start: `hello`, then `room_hello {t,v:1,rooms,agent[,orchestrator only if set]}` once per spawn; `prime()` once, before any `poll()`.
- Inbound: frames whose `t` is a str starting `room_` go to `relay.handle(frame)` BEFORE the strict `{t,v}` check. Return None -> fall through to strict check (so rc 2); 0 -> handled, host continues (not bye); 2 -> rc 2. Non-room frames are never passed to handle; extra keys still rc 2.
- Framing errors (bad JSON/UTF-8, non-dict, zero or > 65536 length) still rc 2 with relay active; room frames up to 65536 B are accepted.
- Loop: `poll()` called repeatedly while idle (>= 3 in 1.5 s), also between inbound frames. Not called without a relay.
- Relay exceptions (ctor, prime, poll, handle) never crash the host; spool events keep flowing.

## RoomObserver decision
Retire from the host path: no file in `bridge/wall/` may reference it (green control today). The module stays fixable: while `bridge.room.observer` exists, an `emit_fn` result `{"ok": False,...}` (or `{"rc": 1,...}` without ok) must NOT advance the cursor (retry); dict ok true and legacy bool results unchanged. If the module is deleted, those tests skip.

## Expected state now (stub host, no room_relay.py)
40 tests; green controls: no-rooms host behaviour, load_config tolerates `rooms`/unknown keys, room frame fatal without rooms, observer static checks, observer ok-true and bool controls, no-poll-without-rooms. Everything else red until U37a lands plus the host hooks and the observer fix.
