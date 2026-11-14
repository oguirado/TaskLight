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

## Repair loop 1 (Sol review, 13 Nov)
`test_review1.py`: R1 Lamport from top-level field only + unknown plan step keys → `bad_plan`; R2 a complete fragment without trailing newline never yields duplicate or non-increasing Lamports; R3 non-finite or negative `timeout_s`/`poll_s` rejected without stalling (store, CLI rc 2); R4 non-string act/step state → `bad_act`/`bad_step` (no TypeError); R5 slugs use full match (no trailing newline); R6 concurrent hook runs: exactly one plan per session id, no malformed lines.

## Repair loop 2 (second review, HOLD)
`test_review2.py`, one TestCase per BLOCKING finding:
- F1 evidence symlinks: containment, credential basename and regular-file checks apply to the resolved target (target under room root, target `token.txt`/`secret.txt` incl. chained links, directory target, dangling link: `bad_evidence`). A valid symlink to a regular file is accepted; judgement call: the recorded `path` is `os.path.realpath(given)` and `sha256` is the target content hash.
- F2 append never truncates: a torn fragment (after events, or alone) survives a post byte-for-byte; the file grows by the new line plus at most 1 separator byte; `read` never returns the fragment; Lamport continues from complete events; a refused `room_full` append leaves the file byte-identical.
- F3 JSON-valid but invalid events (wrong types, missing fields, bad act, non-int lamport, non-str text, bad `re`/`to`) are skipped by `read`/`wait`/`inbox`/`status`, counted in `malformed` by `read`; `status` never raises (also via CLI). Open: whether their lamports feed the next Lamport (test only requires >= 4).
- F4 MCP: no `id` key means notification, no reply (known, unknown and `notifications/*` methods); unknown method with id (incl. `notifications/nope`): -32601; `id: null` is a request, reply carries `id: null`.
- F5 CLI argument errors (unknown verb, missing flags, bad int/float, unknown flag, extra positional): exit 2, stdout is exactly one JSON line `{"ok":false,"code":<str>}` (argparse text only on stderr).
- F6 hook helper under umask 022 and 0: every dir under CW_HOME is 0700, every file 0600, no stray `*.tmp` or unknown file in the room dir; checked after normal runs, refused-post runs (`CW_AGENT="BAD AGENT"`) and invalid-stdin runs.
