# ORACLE U29 (`bridge/ctx`, verbs page/find/census/tail/state/check)

Run: `cd repo && python3 -I -m unittest discover -s bridge/tests/ctx -t . -v` (stdlib `unittest`, no pytest).
Clean-room: derived only from `specs/SPEC_U29.md` (+ U28 spec/golden vectors for envelope parity).

## Case map (SPEC_U29 §5)
| Case | File | Negative control inside |
|---|---|---|
| P1 P2 P3 (+ walk, multibyte, lossy, empty) | test_page.py | page never > 60 lines / 4096 B, walked over whole files; no UTF-8 split (2/3/4-byte) |
| P4 P5 P6 | test_find.py | `absent` only when `complete`; rc 124 (injected `monotonic`), oversize, unreadable => no `absent`; file == FIND_FILE_MAX is read; NUL at byte 8191 vs 8192 |
| P7 | test_census.py | symlink file/dir and `.git` not counted; top-10 ties by path; entries cap (creates ~100k empty files, ~2 s) |
| P8 | test_tail.py | n=0/201 -> 2; 100 B x 200 -> cut, <= 4096 B; whole-file sha/byte_count |
| P9 P10 | test_state.py | git tests skip with reason if `git` absent; git-missing -> 124 via empty PATH; pid 43 -> 7 |
| P11 | test_check.py | extra key, missing key, `rc:true`, `0.0`, NaN/Infinity, dup key, ok/rc mismatch, bad rc, tampered data (STALE_SHA) |
| P12 | test_cli.py, test_envelope.py | CLI run twice byte-identical, one canonical line, exit == rc; golden vectors `fixtures/ctx/v1/*.out.jsonl` re-canonicalise byte-for-byte |
| P13 | test_confinement.py | `..`, absolute, in-root symlink (file and dir); `ReadSpy` on open/os.open/scandir/listdir records 0 hits; "TOPSECRET" never in output |
| P14 | test_static.py + scan_imports.py | scanner exits non-zero on `fixtures/bad_mod.py`, and on 14 planted snippets; subprocess only in state.py |

## Stub (`bridge/ctx/**`)
Exact API, wrong behaviour (accept-all: rc 0, whole file, `absent` = all terms, unsorted canonical, no confinement,
check always valid). Positive controls (limits, determinism, scanner, empty census...) pass on it by design.
A throw-away correct reference (outside the repo) passed all 120 tests; the stub fails 88 + errors 8.

## Decisions where the spec is silent or conflicts [ASSUMED] — writer (EW) must confirm with OP
1. **Envelope has 6 keys incl. `"schema":"ctx.resp/v1"`** (U28 `CtxResp` and `fixtures/ctx/v1` carry it; U29 §2 lists only 5). Tests assert the 6-key form.
2. **`check` sha mismatch = rc 2 + `STALE_SHA`** (U29 B19). U28 B17 says rc 4 for the same; tests follow U29.
3. `check` error codes asserted exactly only for: UNKNOWN_FIELD, MISSING_FIELD, BAD_NUMBER (float/NaN/Inf), BOOL_AS_INT, STALE_SHA. All other failures: rc 2, `valid:false`, non-empty errors sorted by (path, code), entries `{code,path}`. Path may be nested (`data.x`); only the last segment is compared for UNKNOWN_FIELD.
4. `check` accepts rc 6/124 envelopes; per-verb data shapes as listed in §2; `absent` optional in find.
5. `runtime_s` formula is AUSENTE: tests use `runtime_s = now_s - starttime_ticks // CLK_TCK` with `now_s` = seconds since boot (field 22 of `proc_root/<pid>/stat`, comm parsed after the LAST `)`), clamped >= 0 is not tested.
6. `find` `monotonic` returns seconds (float); first call is the start, later calls are checked against `deadline_ms`. Hit `path` is root-relative or absolute (tests use basename only). Terms matched as casefolded substrings.
7. `tail`/`page` `lines` have no trailing `\n`; a cut single line is allowed (`cut`/`line_cut` true, size counted with `\n`, within 4 B of 4096).
8. `canonical` raises ValueError/TypeError on float/NaN; `respond` with such data -> rc 2, `data == {"error": <ClassName>}`.
9. Modules must use relative imports; the package is importable as `bridge.ctx` (tests `from bridge.ctx.<mod> import ...`; the function `page` etc. may shadow the submodule in `__init__`).
10. CLI flags [ASSUMED] (spec says only `--flag value`): `page --path --from-line [--expect-sha256]`, `find --term T (repeat) --root --k [--deadline-ms]`, `census --dir`, `tail --path --n`, `state --target [--proc-root --now-s]`, `check --obj-json`, plus repeatable `--allow-root DIR` for `Roots`. Tests start it with `python3 -I -c "sys.path.insert(0, repo); runpy.run_module('bridge.ctx', run_name='__main__')"` because `-I` ignores PYTHONPATH and cwd. Usage error => exit 2.
11. `bridge/tests/ctx/__init__.py` exists so `-s bridge/tests/ctx -t .` can import; `bridge/` and `bridge/tests/` are namespace packages (no `__init__.py` needed).

## Repair loop 1 (review HOLD) — tests in `test_repair1.py`
ACCEPTED (BLOCKING, spec-supported):
- Item 1 git half: `.git` symlinked outside root -> rc 2 (B5 symlinks never followed). `test_dot_git_symlink_to_outside_rejected`.
- Item 2: symlink swapped in after `Roots.resolve` approves (page, tail; hostile `Roots` subclass). B5 "never followed, nothing read". `RaceTests`. find/census descendant races are not deterministically testable without fd-level spies: not covered.
- Item 3: `core.fsmonitor` hook must not run; index not rewritten (B4 purity "nothing writes files"). `GitSafetyTests`.
- Item 4: unreadable subdir (chmod 0, real fs) -> `complete:false`, `skipped>=1`, no `absent` (B11). Skipped if perms not enforced.
- Item 5: deadline re-checked after the last file (B12; injected clock); partial scan visits bytewise-first dir (B3). `FindRepairTests`.
- Item 6: tail of a 24 MB file peaks < 6 MiB under tracemalloc (B15 seek-from-end + streaming sha). `TailMemoryTests`.
- Item 7: usage errors (missing/non-int flags, unknown flag, duplicate singleton) -> exactly one canonical rc 2 envelope for the recognised verb, exit 2 (§2 "prints exactly one canonical line"). `CliUsageTests`.
REJECTED:
- Item 1 pid half: B17 reads `proc_root` as an explicit parameter (default `/proc`, outside any root); existing P10 tests use a proc_root outside `roots`. Confinement would contradict spec and passing tests.
- Item 7 unknown-verb envelope: `Verb` excludes unknown values; reviewer itself says AUSENTE. Only rc 2 is asserted (already tested).
- "Test gaming" / U28 parity / golden vectors: NON-BLOCKING known debt (no fixture-specific branch found).

## Repair loop 2 (review HOLD) — tests in `test_repair2.py`, threat model DISP_03
ACCEPTED (BLOCKING):
- Item 1 ancestor half: directory swapped for a symlink after `Roots.resolve` (page, tail; hostile `Roots`) must not read outside (B5). `AncestorRaceTests`.
- Item 2: FIFO without writer must not stall page/tail and must not return rc 0 (DISP_03 #4). `FifoStallTests` (3 s watchdog, releases the FIFO).
- Item 3: oversized last line keeps the newest text (front trim, `cut:true`, UTF-8 valid) (B15). `TailFrontTrimTests`.
- Item 4: lone surrogate in `data` must give `valid:false`, rc 2, never a skipped digest check (B19). `CheckDigestFailureTests`.
NON-BLOCKING (known debt, no test): `find` lstat/open race (not deterministically testable without fd spies); stale "STUB" labels in `bridge/ctx/__init__.py` and this file; U28 parity / golden vectors.

## Repair loop 3 (review HOLD) - tests in `test_repair3.py`, threat model DISP_03
ACCEPTED (BLOCKING): (1) `state` must not follow repo metadata outside roots: `.git` file with absolute/relative `gitdir:` outside (rc != 0, no outside head/branch); `core.worktree` and config `include` pointing outside must not change the answer (rc!=0 or dirty 0); (2) no clean/smudge filter (config and `info/attributes`), hook, or fsmonitor execution (planted marker file must not appear); (3) root-ancestor replacement races: ancestor of the allowed root swapped for a symlink after `Roots.resolve` (page, tail, state) and repo dir / root ancestor swapped between validation and git launch (patched `subprocess.run`, outside repo's HEAD/branch must never appear) (B5 "symlinks never followed, nothing read"); (4) `Roots(("/",)).resolve` accepts descendants.
Stances: the `core.worktree`/include/global-config checks accept either rejection or in-root answer; the git launch race test is coupled to `subprocess.run` (B4 mandates subprocess in `state.py`). Currently green by design: include/global-config/hook/fsmonitor scenarios already neutralised by existing flags.
NON-BLOCKING (no test): stale "STUB" text in `bridge/ctx/__init__.py`.

## XPLAT_PROC

`test_state_platforms.py` injects Windows and macOS and rejects a default procfs read. An unavailable procfs root returns `capability: procfs_unavailable`, while a missing PID under an available root retains the existing empty facts. Git config isolation must use the platform null device.
