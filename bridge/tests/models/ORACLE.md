# U48 oracle (bridge/models + native host model relay)

Run (from `repo/`; stdlib only, loopback fakes only, tmp `CW_HOME`/`HOME`, ~75 s against the stub because red host tests wait on missing frames):

    python3 -I -c "import sys,unittest;sys.path.insert(0,'.');unittest.main(module=None,argv=['x','discover','-s','bridge/tests/models','-t','.'])"

Against the stub: 158 tests, 12 pass (all controls below), 146 fail or error [MEASURED 2026-11-14]. Wall static test and `wall`, `wall_host_room`, `wall_room`, `room` suites stay green (109/40/79/130 [MEASURED]); `bridge/wall/**` has no network import.

## Stub (`bridge/models/`, raises `NotImplementedError("U48 stub")`)
`__init__` (frozen constants: frame names, 16 nack codes, limits, id/rid regex), `store.py`, `transport.py` (only module allowed `socket/ssl/http.client`), `cli.py`, `__main__.py`. `bridge/wall/model_relay.py` is NOT stubbed (surface forbids editing `bridge/wall/*`): tests importing it fail with ModuleNotFoundError.

## Case map
| Spec / acceptance | Tests |
|---|---|
| 1 gate (no `models` key, invalid values) | test_host.Gate (GREEN controls), test_relay.Config.test_load_model_config |
| 2, 3 frame order, exact keys, no leaks | test_host.Hello, test_relay.Hello |
| 4 loopback pin, mixed, localhost, remote http | test_transport.Loopback, test_transport.Wire.test_pinned_* |
| 5 redirect, second server 0 requests | test_transport.Redirect, test_relay.Ladder |
| 6 remote http / allow_private at add and load | test_cli.test_add_remote_rules, test_store.Validation, test_transport.Loopback |
| 7 0600/0700/symlink/fifo refusal | test_store.Refusal, test_cli.test_cli_refuses_*, test_host.Hello |
| 8 canary (frames, stderr, argv sampler) | test_host.Canary, test_relay.Privacy |
| 9 set-key stdin, `--key` rc 2 | test_cli |
| 10 frame cap, 48 KiB body (exact boundary) | test_relay.Caps, test_host.Dispatch |
| 11 cancel, spool events during flight | test_relay.Flight, test_host.Dispatch |
| 12 busy | test_relay.Flight, test_host.Dispatch |
| 13 timeouts, ladder, rung_unsupported | test_relay.Timeouts/Ladder, test_transport.Timing |
| 14 policy | test_relay.Policy, test_host.Dispatch |
| 15 structural rc 2 | test_relay.Structural, test_host.Fatal |
| 16 bye / EOF in flight | test_host.Dispatch |
| 17 existing suites, netscan | test_static, wall suites |
| native_host changes (`_send_lock`, `_handle_frame(..., model_relay)`, `_build_model_relay`, `_model_poll`, close on every exit) | test_native_host_units |

GREEN controls (pass on the stub): Gate (4), `_handle_frame` old positional call, `test_no_relay_no_model_hello`, 6 test_static checks (wall netscan, only transport imports net modules, frozen constants and signatures, no secret literals).

## Judgement calls (spec AUSENTE; the implementer must match or amend the oracle)
- Host under test: `python3 -I -c` with REPO on `sys.path`, `native_host.main(argv)` (package `bridge.wall`, so absolute `bridge.models` imports work). CLI: `runpy.run_module('bridge.models', run_name='__main__')`. `bridge/models/__main__.py` + `cli.main(argv)` (spec says `python3 -m bridge.models`, so no `cli/` package).
- Env: `HOME` and `CW_HOME` both point at tmp dirs; store fixtures are written as raw files, never via `bridge.models.store`.
- `store.load(home) -> {"endpoints","keys","refused"}`; `save_endpoints(home, list)`, `set_key(home,id,key|None)` (None clears), `remove(home,id)`; invalid input `ValueError`, unknown id `KeyError`; `validate_endpoint(e)`; unknown endpoint keys refused; `enabled` defaults True on `add`.
- Transport: `TransportError(code, status=None)`; `probe(E,key,timeout_s,*,resolver=None) -> None`; `generate(E,key,body_dict,deadline,cancel,*,resolver=None) -> str`; `deadline` = absolute `time.monotonic()` seconds; `cancel` has `is_set()`; cancel raises code `cancelled`; `check_loopback(host,port,*,resolver=None)` is the only loopback helper (CLI `add` uses it, so CLI never imports `socket`). `resolver` has `getaddrinfo` signature and is called exactly once per request (pinned). The injected resolver is only reachable at transport level; host-level loopback is covered with `localhost`.
- Relay: `ModelRelay(mcfg, send, *, home, clock, transport, timeouts)`; `timeouts` keys `probe_ms`, `local_generate_ms`, `remote_generate_ms`; `transport` object has `probe`/`generate` methods; `handle` returns `0` for every valid model frame (including ones answered by nack), `2` structural, `None` for non-model types; busy/unknown/policy nacks may be sent from `handle` or `poll` (tests pump `poll`); results only from `poll()` on the caller thread; worker threads are daemon; stats key `store_refused`.
- Probe state mapping beyond the spec: success `available`; disabled `blocked`; remote without key `needs_setup`; refused connect, timeout `offline`; auth, redirect, bad reply: only "not available" is asserted. Probe redirect does not nack.
- Unknown `model_*` type (e.g. `model_bogus`) and wrong-direction frames: `None` or `2` from the relay, fatal rc 2 at host level.
- Request body contains `model` (from endpoint), `messages`, `max_tokens`, `stream:false`; body cap is measured on the bytes the fake receives (calibrated, so the serializer is free); `model_result` cap counts UTF-8 bytes of the frame as `native_host._send` serializes (`separators=(",",":")`, `ensure_ascii=False`).
- Local `tier: shared` is allowed (spec only bars remote for shared).
- `list` prints JSON (list or `{"endpoints": [...]}`); `probe` prints `{id,state,rung}`; CLI refusal stderr names `endpoints.json`; empty `CW_HOME` falls back to `$HOME/.context-wall`.
- `model_relay.py` imports: `bridge.models.*` absolute plus `threading queue json re time os sys typing collections` (spec lists only the first five; `os` is needed for `CW_HOME`).

## Spec ambiguities (not asserted)
Whether a new request right after `cancelled` is `busy` until the worker unwinds; remote private/shared with no key (`policy` vs `needs_setup`); `probe` timeout `state`; what `rung` a health frame reports after a successful rung-1 generate; tmp-file naming in the store; DNS failure at CLI `add` (asserted via literal non-loopback IP only); `reply_too_large` precedence vs `bad_reply` for bodies between 64 KiB frame cap and 1 MiB reply cap (asserted: content pushing the frame over 65,536 gives `reply_too_large`; a >1 MiB HTTP body gives `bad_reply`).
- A-U48a (14 Nov, orchestrator): 5 oracle defects fixed after author report, intent unchanged: test_cli/test_host fakehome path is <CW_HOME>/fakehome as built by support.env_for (self.home, not self.tmp); test_host spool test calls bridge.wall.emit module (package re-exports the function); test_host Canary waits e500 before sending probe pp (busy nack is spec-required); test_relay cap test clears earlier frames (reused rid). Originals in relay/backups/u48_oracle_pre_amend/.
- A-U48r1 (14 Nov, repair loop 1, Sol HOLD findings 1-3): new `test_repair1.py`, 11 tests, red against the pre-repair code: 11 fail/error, 0 pass [MEASURED 2026-11-14] (the depth-2000 subtests are controls: CPython 3.12.3 parses depth 2000 and validation refuses it; depth 20000, 40 KB < 64 KiB cap, raises RecursionError). Cases: RelayWatchdog (never-settling injected generate/probe -> one terminal frame within 0.3 s budget + slack, next request served, late outcome discarded; abandoned workers capped at 2 -> `busy`; non-finite/non-positive/non-number/bool timeouts -> ValueError at construction), TransportBudget (trickling body, never-finished header line for generate and probe, never-returning resolver -> `timeout` within budget + 0.6 s), NestedStore (`load` refused for nested endpoints.json/keys.json; CLI `list` rc 2, no Traceback, no file content, stderr names endpoints.json). Judgement call: a probe timeout stays `model_health` state `offline` (spec: probe failures map to health; only unknown_endpoint/busy nack), not a `timeout` nack.
- A-U48r2 (14 Nov, repair loop 2, Sol HOLD findings 1-2): new `test_repair2.py`, 7 tests (8 incl. 2 subtests), red against the loop-1 code: 5 tests fail/error (4 F + 1 E; validate subtests label and model both F), 2 green controls pass (escaped-oversize drop, plain UTF-8 frame) [MEASURED 2026-11-14]; after repair 7/7 pass, models suite 176 OK. Cases: ResolverBound (20 alternating generate/probe calls with a never-returning resolver, 0.1 s budget -> each `timeout` within budget + 0.6 s, live `model-transport-resolve` threads <= 2 throughout; after release slots free and a loopback probe is served), SurrogateStore (`validate_endpoint` rejects lone surrogates in label/model; `load` never serves the bad endpoint; host sends `hello` then a `model_hello` without it and logs no unencodable drop), SendFallback (direct `_send` of a lone-surrogate frame is delivered as escaped ASCII JSON with a correct length prefix; size cap applies to the escaped bytes). Judgement calls: (a) helper slots full -> `timeout` (not `busy`), fail-fast, no thread spawned, so probe -> health `offline` and generate -> nack `timeout` mappings are unchanged; bound `transport._MAX_RESOLVERS = 2`. (b) a surrogate endpoint refuses the WHOLE store (existing contract "any defect refuses the whole store"; `load` returns `refused: true`), so model_hello carries `endpoints: []` rather than serving the other endpoints; per-endpoint refusal would change the store contract and is left to the spec owner. Debt not fixed: concurrent CLI store mutations can lose updates.
