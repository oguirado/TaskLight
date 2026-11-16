# U09 oracle (bridge/wall, bridge/install.py)

Run: `cd repo && python3 -I -m unittest discover -s bridge/tests/wall -t . -v` (unittest, stdlib only, no git).
Against the stub: 73 tests, 59 fail or error (74 failures counting subtests); the 14 that pass are negative controls (clean-tree scanner, observers emitting nothing, rejection-leaves-no-write checks).

## Case map
| Spec | Tests |
|---|---|
| W1 | test_emit.test_w1_emit_valid, test_all_kinds_and_seq_per_project_source, test_ts_default_is_epoch_ms |
| W2 | test_redact.test_w2_planted_secrets_never_reach_spool, test_each_class_redacted, idempotence, class order |
| W3 | test_redact.test_w3_residue_fail_closed, test_w3_residue_other_classes |
| W4/W5 (neg) | test_emit.test_w4_envelope_strict, test_w5_project_checks, test_control_char_boundaries, test_bad_ints_and_types |
| W6 | test_emit.test_w6_seq_persist_and_concurrent (2 procs x 50) |
| W7 | test_emit.test_w7_cap_marker, test_cap_never_splits_surrogate_pair |
| W8 | test_native_host.test_w8_* (LE prefix 70000/65537/0xFFFFFFFF/0, truncated body, BE prefix, bad JSON/UTF-8, shapes, valid-frame controls incl. exactly 65536) |
| W9 | test_native_host.test_w9_unlisted_origin, test_invalid_config_exits_2_silently |
| W10/W11 | test_native_host.test_w10_resync_snapshot_and_w11_floor, test_shared_tier_floor_is_prefer |
| W12 | test_static (AST scan `netscan.py`, planted-import controls, exit code) |
| W13 | test_install.* |
| W14 | test_observers.Git.test_w14_git_observer_idempotent (commit + push) |
| W15 | test_export (shape, canonical lines, redaction, tamper refusal) |
| B8/B10 | test_spool_append_only_and_fsync, test_failed_write_rc1_no_partial_line, test_rate_limit_waits_and_never_drops |

## API contract the tests assume (spec leaves these AUSENTE; implementer must match or raise it)
- Relative imports only inside `bridge/wall` (tests import it as `bridge.wall`, subprocesses as `wall` via `runpy` with bridge/ on sys.path, because `-I` drops cwd/PYTHONPATH). `emit.py` imports nothing from siblings and works alone (vendored test).
- `from bridge.wall import emit` is the function; the module is `importlib.import_module("bridge.wall.emit")`.
- `emit.py` exports `emit, redact, canonical_json, EVENT_TEXT_MAX=2000, RAW_ENVELOPE_MAX=16384, MAX_PROJECTS=12, RATE_PER_SEC=20`. `_clock()` returns epoch ms (int). `_disable` disables a class in the redactor only, never in the residue re-scan. `redact()` returns `(text, count, classes)` with classes unique, in RedactClass order. `canonical_json` = sorted keys, `(",",":")`, `ensure_ascii=False`.
- Result dict: ok -> exactly `ok, rc, seq, sha256`; failure -> `ok False, rc, code` with codes `BAD_KIND BAD_SOURCE BAD_PROJECT_ID BAD_INT CONTROL_CHAR WRONG_TYPE UNKNOWN_PROJECT REDACT_RESIDUE`. `emit` never raises. Rejections (rc 2/7/9) burn no seq and write nothing, including `seq.json`. Invalid config (missing, bad JSON, v!=1, bad extensionId, >12 projects) -> rc 7. Unwritable spool -> rc 1. Spool dir is created if absent only when creatable.
- fsync: every successful emit calls `os.fsync` (through the `os` module attribute) at least once [INFERRED from "fsync semantics"; spec B8 only mandates lock + no partial line].
- Rate limiter is keyed per (spoolDir, projectId) so tests on different temp dirs do not throttle each other.
- CLI: `python3 -I -m wall emit [--config C] [--source S] PROJECT KIND TEXT` (stdout = result JSON, exit = rc); `host [--config C] ORIGIN` (origin = last argv; config via `--config`); `export --config C --spool FILE --out DIR`.
- Host: sends `hello` (`projects` = all configured ids) first, then every valid spool line from offset 0, then live-tails. A line is forwarded only if it is <= RAW_ENVELOPE_MAX, valid JSON, exactly the six keys, kind in its source group, and `projectId` equals the spool file's project; otherwise it is skipped and the host keeps running. Frames: `{t:"event",v:1,projectId,payload,floor,spoolOffset(int>=0, increasing)}`. Every fatal condition of B13/B14 exits 2 with nothing after (origin/config failure: nothing at all on stdout). EOF at a frame boundary exits 0. Inbound frame of exactly 65536 bytes is valid. `native_host.MAX_FRAME == 65536`. Prefix is little-endian.
- Observers: `XObserver(project, targets, ctx=None, emit_fn=None)`, `.poll() -> list`; `emit_fn(project, kind, text, source=...)` defaults to `emit.emit`. Files/Git/Log/Transcript take lists (roots / roots / log dicts / paths); `ProcObserver(project, pids, emit_fn=None, platform=None)` with `.disabled_reason`. First poll is a silent baseline for files/git/transcripts; logs emit `ci_started` on first sight of an existing file; procs emit `proc_started` on first sight of a live pid (text has pid and "rss"). `build_observers(project_cfg, ctx=None, emit_fn=None)`; `POLL_MS == 2000`. With `ctx` given, Files must call `ctx.page(path, frm)`.
- Installer: `HOME`-relative `.../NativeMessagingHosts/com.contextwall.bridge.json`; flags `--apply`, `--remove`, `--extension-id ID` (32 chars a-p, default pinned `nnmhdaibaopekhjcpnekgdpeaaojclof`); `--apply --remove` and unknown flags -> rc 2. Manifest keys exactly `name, description, path, type, allowed_origins`; `path` is an absolute executable launcher containing `-I`, `wall`, `host`, written under HOME (or already in bridge/), never inside `bridge/wall`. Foreign/unparseable existing file: apply -> rc 2, untouched; remove leaves it untouched.

## Not covered / blocked
- W15 digest parity with U08 `loadFixture`: `repo/src/ingest/{digest,replay,redact}.ts` are still oracle stubs (constant digest, no validation), so only shape, canonical lines and an INFERRED `eventId = sha256(canonical_json(event without eventId))` check are asserted. Add the TS parity run once U08 lands.
- Redaction patterns were taken from SPEC_U08 B6 (redact.ts is a stub). For `AppCheck debug token: "<uuid>"` either `APPCHECK_DEBUG` or `KEY_ASSIGN` is accepted (ordering ambiguity in the spec); the other classes are pinned.
- Chrome 1 MiB host->extension cap is unreachable by design (frames are capped at 65536); covered by the oversize-line test.

## Repair loop 1 (review HOLD) — tests in `test_repair1.py`
ACCEPTED (BLOCKING, spec-supported):
- F1: B9 `seq` = the envelope `sourceSeq` (per project+source, B8); spool write failure leaves no partial line and burns no seq (B8 "no partial line"). **Conflict:** existing `test_emit.test_all_kinds_and_seq_per_project_source` (line 60) asserts per-kind result seq `1` for every kind and contradicts B8/B9; it passes only on the buggy `@kind` counters. It must be relaxed (result seq == spool `sourceSeq`) when the fix lands; left untouched here.
- F2: `seq.json` at 2^53-1 -> rc 2, nothing written (B3 safe integers).
- F3: 20/s per project across 3 processes (B10; sliding 1 s window <= 26 incl. jitter slack).
- F4: unhashable `source` in a spool line must be skipped, not crash host (ORACLE: malformed lines not forwarded) and export returns rc 2 without traceback; a valid-shape spool line carrying an unredacted secret is not forwarded (unit oracle "planted secret leaves the bridge"; export already refuses the same input).
- F5: full 200-line tail window still yields new lines; fallback (no ctx) stays bounded on an 8 MiB newline-free record ("bounded reads", §4).
- F6: generated launcher must execute the host; `--remove` must not delete a manifest-named unrelated file (B17 "only a file it would have written").
- F7: non-list `roots`/`transcripts`, non-int `pids` -> observe rc 2 without traceback, emit rc 7 (§4 Invalid config).
REJECTED: none. NON-BLOCKING debt kept: U08 `loadFixture` digest parity (stub, see above).

## Amendment A1-U09 (orchestrator)
`test_all_kinds_and_seq_per_project_source` now expects seq per (project, source) incrementing across kinds (B8/B9), resolving the conflict noted in Repair loop 1 F1.

## Repair loop 3 (review HOLD) - tests in `test_repair3.py`, threat model DISP_03
ACCEPTED (BLOCKING): (1) B11/B12 + DISP_03 data loss: an observer's cursor/baseline (files mtime map, git HEAD/upstream, log tail state incl. `ci_started`, transcript offset/line_count, proc seen-set) advances only for events whose `emit()` returned `ok:true`; a failed event (`ok:false` result or raised exception) is retried on the next poll without a new change, never duplicated after success, and an emitter exception does not escape `poll()`; (2) B10: admission and append are one critical section: with a process paused after admission and its reservation expired, no 1 s window contains more than 20 actual spool appends (threads, processes, injected pause; slack 50 ms); excess still waits, nothing dropped; (3) B3/B7: host and export apply the same text validation: over `EVENT_TEXT_MAX` (2000 UTF-16 units, ASCII and astral), lone surrogates (`\ud800`, `\udc00`), escaped C0/DEL controls; host skips the line and survives, export returns rc 2 without traceback and writes nothing; text of exactly 2000 units is accepted.
Stances: the pause-injection test patches `emit._rate_wait` with `create=True`, so any implementation that merges admission and append passes; retry of failed events is unbounded in the test (bounded retention is the implementation's choice).
NOT COVERED here (not requested in this task): review item 4 (`tier`/`roots` required in config validation). NON-BLOCKING (no test): U08 `loadFixture` digest parity.
