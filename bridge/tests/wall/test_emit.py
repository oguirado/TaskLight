import contextlib, hashlib, importlib, io, json, os, pathlib, re, sys, time, unittest
from unittest import mock
from . import support as S

E = importlib.import_module("bridge.wall.emit")  # module (the package attr `emit` is the function)

KINDS = {"agent": ["output", "waiting_input", "error", "exit"],
         "ci": ["ci_started", "ci_passed", "ci_failed"],
         "git": ["commit", "push"],
         "local": ["file_changed", "proc_started", "proc_exited"]}


def em(cfg, project, kind, text, source="agent", **kw):
    kw.setdefault("_clock", S.CLOCK)
    return E.emit(project, kind, text, source, config=cfg, **kw)


class Emit(S.Base):
    def test_constants(self):
        self.assertEqual((E.EVENT_TEXT_MAX, E.RAW_ENVELOPE_MAX, E.MAX_PROJECTS, E.RATE_PER_SEC),
                         (2000, 16384, 12, 20))

    def test_canonical_json_parity(self):
        self.assertEqual(E.canonical_json({"b": 1, "a": "é\U0001F600\n\x1f"}),
                         '{"a":"é\U0001F600\\n\\u001f","b":1}')
        self.assertEqual(E.canonical_json({"z": {"y": 2, "x": [1, {"d": 0, "c": 9}]}}),
                         '{"z":{"x":[1,{"c":9,"d":0}],"y":2}}')

    # W1
    def test_w1_emit_valid(self):
        cfg = self.cfg()
        r1 = em(cfg, "api", "waiting_input", "Approve migration?")
        r2 = em(cfg, "api", "waiting_input", "Approve migration?")
        self.assertEqual((r1["ok"], r1["rc"], r1["seq"]), (True, 0, 1))
        self.assertEqual((r2["ok"], r2["rc"], r2["seq"]), (True, 0, 2))
        self.assertEqual(set(r1), {"ok", "rc", "seq", "sha256"})
        lines = S.spool_lines(cfg, "api")
        self.assertEqual(len(lines), 2)
        for i, (line, r) in enumerate(zip(lines, (r1, r2)), 1):
            exp = E.canonical_json({"source": "agent", "projectId": "api", "sourceSeq": i, "ts": S.TS,
                                    "kind": "waiting_input", "text": "Approve migration?"})
            self.assertEqual(line.decode(), exp)
            self.assertEqual(r["sha256"], hashlib.sha256(line).hexdigest())
        self.assertEqual(set(json.loads(lines[0])), S.SIX_KEYS)
        self.assertFalse((S.spool_dir(cfg) / "vault.jsonl").exists())
        json.loads((S.spool_dir(cfg) / "seq.json").read_text())

    def test_ts_default_is_epoch_ms(self):
        cfg = self.cfg()
        r = E.emit("api", "output", "x", config=cfg)
        ts = json.loads(S.spool_lines(cfg, "api")[0])["ts"]
        self.assertTrue(r["ok"])
        self.assertLess(abs(ts - time.time() * 1000), 60000)

    def test_all_kinds_and_seq_per_project_source(self):
        cfg = self.cfg()
        # Amendment A1-U09 (orchestrator): seq is per (project, source) per B8/B9, so it increments across kinds.
        expected = {}
        for src, kinds in KINDS.items():
            for k in kinds:
                r = em(cfg, "api", k, "t " + k, src)
                expected[src] = expected.get(src, 0) + 1
                self.assertEqual((r["rc"], r["seq"]), (0, expected[src]), (src, k))
        r = em(cfg, "api", "output", "again")
        self.assertEqual(r["seq"], expected.get("agent", 0) + 1)

    # W4 (neg)
    def test_w4_envelope_strict(self):
        cfg = self.cfg()
        before = S.tree_bytes(S.spool_dir(cfg))
        r = em(cfg, "api", "commit", "x", "agent")
        self.assertEqual((r["ok"], r["rc"]), (False, 2))
        self.assertEqual(r.get("code"), "BAD_KIND")
        self.assertEqual(em(cfg, "api", "output", "x", "bogus")["code"], "BAD_SOURCE")
        self.assertEqual(em(cfg, "api", "output", "x", "local")["rc"], 2)   # agent kind on local
        self.assertEqual(em(cfg, "api", "nope", "x", "agent")["rc"], 2)
        self.assertEqual(S.tree_bytes(S.spool_dir(cfg)), before)
        ok = em(cfg, "api", "file_changed", "src/a.py", "local")
        self.assertEqual((ok["rc"], ok["seq"]), (0, 1))  # rejections burn no seq
        self.assertEqual(set(json.loads(S.spool_lines(cfg, "api")[0])), S.SIX_KEYS)

    # W5 (neg)
    def test_w5_project_checks(self):
        cfg = self.cfg()
        before = S.tree_bytes(S.spool_dir(cfg))
        r = em(cfg, "p9", "output", "x")
        self.assertEqual((r["rc"], r.get("code")), (7, "UNKNOWN_PROJECT"))
        self.assertEqual(em(cfg, "P 1", "output", "x")["rc"], 2)
        self.assertEqual(em(cfg, "P 1", "output", "x")["code"], "BAD_PROJECT_ID")
        r = em(cfg, "api", "output", "done\u0007")
        self.assertEqual((r["rc"], r.get("code")), (2, "CONTROL_CHAR"))
        self.assertEqual(em(cfg, "a" * 33, "output", "x")["code"], "BAD_PROJECT_ID")
        self.assertEqual(em(cfg, "a" * 32, "output", "x")["rc"], 7)   # well-formed but unknown
        self.assertEqual(em(cfg, "-api", "output", "x")["rc"], 2)
        self.assertEqual(S.tree_bytes(S.spool_dir(cfg)), before)
        self.assertEqual(em(cfg, "p9", "output", "x")["rc"], 7)
        self.assertFalse((S.spool_dir(cfg) / "p9.jsonl").exists())     # B4: no capsule auto-created

    def test_control_char_boundaries(self):
        cfg = self.cfg()
        for bad in ("a\rb", "a\x00b", "a\x1bb", "a\x7fb", "\x08"):
            self.assertEqual(em(cfg, "api", "output", bad)["rc"], 2, repr(bad))
        r = em(cfg, "api", "output", "line1\nline2\tcol")
        self.assertEqual(r["rc"], 0)
        self.assertEqual(json.loads(S.spool_lines(cfg, "api")[0])["text"], "line1\nline2\tcol")

    def test_bad_ints_and_types(self):
        cfg = self.cfg()
        for clock in (lambda: -1, lambda: 1.5, lambda: 2 ** 53):
            r = em(cfg, "api", "output", "x", _clock=clock)
            self.assertEqual((r["rc"], r.get("code")), (2, "BAD_INT"))
        self.assertEqual(em(cfg, "api", "output", "x", _clock=lambda: 2 ** 53 - 1)["rc"], 0)
        for args in ((None, "output", "x"), ("api", None, "x"), ("api", "output", 123), ("api", "output", None)):
            r = E.emit(*args, config=cfg)               # never raises
            self.assertEqual((r["ok"], r["rc"]), (False, 2), args)

    def test_invalid_config_gives_rc7(self):
        for content in (None, "{not json", json.dumps({"v": 2}), json.dumps({"v": 1, "extensionId": "x", "spoolDir": "/tmp", "projects": []})):
            p = self.tmp / "c.json"
            if content is None:
                p.unlink(missing_ok=True)
            else:
                p.write_text(content)
            r = E.emit("api", "output", "x", config=str(p))
            self.assertEqual((r["ok"], r["rc"]), (False, 7), content)

    def test_too_many_projects_is_invalid(self):
        cfg = self.cfg(projects=[("p%d" % i, "standard") for i in range(13)])
        self.assertEqual(E.emit("p1", "output", "x", config=cfg)["rc"], 7)
        cfg = self.cfg(projects=[("p%d" % i, "standard") for i in range(12)])
        self.assertEqual(E.emit("p1", "output", "x", config=cfg, _clock=S.CLOCK)["rc"], 0)

    # W7
    def test_w7_cap_marker(self):
        cfg = self.cfg()
        text = "a" * 1985 + " " + "dev" + "@" + "example.com" + " " + "b" * 520
        r = em(cfg, "api", "output", text)
        self.assertEqual(r["rc"], 0)
        out = json.loads(S.spool_lines(cfg, "api")[0])["text"]
        self.assertLessEqual(len(out.encode("utf-16-le")) // 2, 2000)
        self.assertTrue(out.endswith("…"))
        self.assertNotIn("[REDACTED", re.sub(r"\[REDACTED:[A-Z_]+\]", "", out))  # no partial marker

    def test_cap_never_splits_surrogate_pair(self):
        cfg = self.cfg()
        text = "ab " * 666 + "\U0001F600" + " tail" * 200
        em(cfg, "api", "output", text)
        out = json.loads(S.spool_lines(cfg, "api")[0])["text"]
        self.assertLessEqual(len(out.encode("utf-16-le")) // 2, 2000)
        self.assertTrue(out.endswith("…"))
        self.assertNotIn("\U0001F600", out)
        out.encode("utf-8")  # strict: no lone surrogate

    def test_short_text_untouched_and_huge_text_capped(self):
        cfg = self.cfg()
        em(cfg, "api", "output", "x" * 0 + "ok text")
        em(cfg, "api", "output", "ab " * 40000)
        a, b_ = [json.loads(l) for l in S.spool_lines(cfg, "api")]
        self.assertEqual(a["text"], "ok text")
        self.assertLessEqual(len(b_["text"]), 2000)
        self.assertLessEqual(len(S.spool_lines(cfg, "api")[1]), E.RAW_ENVELOPE_MAX)

    # B8: append-only, fsync, rc 1
    def test_spool_append_only_and_fsync(self):
        cfg = self.cfg()
        calls = []
        real = os.fsync
        with mock.patch("os.fsync", side_effect=lambda fd: (calls.append(fd), real(fd))[1]):
            em(cfg, "api", "output", "one")
            n1 = len(calls)
            snap1 = (S.spool_dir(cfg) / "api.jsonl").read_bytes()
            em(cfg, "api", "output", "two")
        snap2 = (S.spool_dir(cfg) / "api.jsonl").read_bytes()
        self.assertGreaterEqual(n1, 1, "each successful emit must fsync the spool [INFERRED, see ORACLE.md]")
        self.assertGreater(len(calls), n1)
        self.assertTrue(snap2.startswith(snap1) and len(snap2) > len(snap1))
        self.assertTrue(snap2.endswith(b"\n"))

    def test_failed_write_rc1_no_partial_line(self):
        cfg = self.cfg()
        c = json.loads(pathlib.Path(cfg).read_text())
        blocker = self.tmp / "afile"
        blocker.write_text("x")
        c["spoolDir"] = str(blocker / "sub")      # cannot be created: parent is a regular file
        pathlib.Path(cfg).write_text(json.dumps(c))
        r = em(cfg, "api", "output", "x")
        self.assertEqual((r["ok"], r["rc"]), (False, 1))
        self.assertEqual(blocker.read_text(), "x")

    # B10
    def test_rate_limit_waits_and_never_drops(self):
        cfg = self.cfg()
        t0 = time.monotonic()
        rs = [em(cfg, "api", "output", "n%d" % i) for i in range(26)]
        dt = time.monotonic() - t0
        self.assertTrue(all(r["rc"] == 0 for r in rs))
        self.assertEqual([r["seq"] for r in rs], list(range(1, 27)))
        self.assertEqual(len(S.spool_lines(cfg, "api")), 26)
        self.assertGreaterEqual(dt, 0.25, "26 emits at 20/s must wait")
        self.assertLess(dt, 15)

    # W6
    def test_w6_seq_persist_and_concurrent(self):
        cfg = self.cfg()
        for _ in range(3):
            em(cfg, "api", "output", "x")
        code = ("from bridge.wall.emit import emit; import json,sys; "
                "r=emit('api','output','from new interpreter',config=sys.argv[1]); print(json.dumps(r))")
        p = S.run_py(code, cfg)
        self.assertEqual(json.loads(p.stdout)["seq"], 4, p.stderr)
        (self.tmp / "c2").mkdir()
        cfg2 = S.make_config(self.tmp / "c2")
        loop = ("from bridge.wall.emit import emit; import sys; "
                "bad=[i for i in range(50) if emit('api','output','w'+sys.argv[2]+'-'+str(i),config=sys.argv[1])['rc']!=0]; "
                "sys.exit(len(bad))")
        procs = [__import__("subprocess").Popen([sys.executable, "-I", "-c", "import sys; sys.path.insert(0, %r); " % str(S.REPO) + loop, cfg2, str(k)],
                                                 env=S.clean_env()) for k in range(2)]
        self.assertEqual([p.wait(120) for p in procs], [0, 0])
        lines = S.spool_lines(cfg2, "api")
        self.assertEqual(len(lines), 100)
        seqs = [json.loads(l)["sourceSeq"] for l in lines]       # json.loads on each: no torn lines
        self.assertEqual(len(set(seqs)), 100)
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(seqs, list(range(1, 101)))

    def test_single_file_emit_is_self_contained(self):
        src = (S.BRIDGE / "wall" / "emit.py").read_text()
        import ast
        for n in ast.walk(ast.parse(src)):
            if isinstance(n, ast.ImportFrom):
                self.assertEqual(n.level, 0, "emit.py must not use relative imports")
                self.assertNotIn((n.module or "").split(".")[0], ("wall", "bridge"))
            if isinstance(n, ast.Import):
                for a in n.names:
                    self.assertNotIn(a.name.split(".")[0], ("wall", "bridge"))
        vend = self.tmp / "vend"
        vend.mkdir()
        (vend / "emit.py").write_text(src)
        cfg = self.cfg()
        code = ("import sys; sys.path.insert(0, %r); import emit, json; "
                "print(json.dumps(emit.emit('api','output','vendored',config=%r)))" % (str(vend), cfg))
        p = __import__("subprocess").run([sys.executable, "-I", "-c", code], capture_output=True, env=S.clean_env())
        self.assertEqual(json.loads(p.stdout)["rc"], 0, p.stderr)

    def test_package_reexports_emit_and_works_without_host(self):
        pkg = importlib.import_module("bridge.wall")
        self.assertTrue(callable(pkg.emit))
        self.assertIs(pkg.emit, E.emit)
        cfg = self.cfg()
        r = pkg.emit("api", "output", "no host running", config=cfg)   # falls back to spool, no host process
        self.assertEqual(r["rc"], 0)
        self.assertEqual(len(S.spool_lines(cfg, "api")), 1)

    # CLI
    def test_cli_emit(self):
        cfg = self.cfg()
        p = S.run_wall(["emit", "--config", cfg, "api", "output", "hello cli"])
        self.assertEqual(p.returncode, 0, p.stderr)
        r = json.loads(p.stdout)
        self.assertEqual((r["ok"], r["rc"], r["seq"]), (True, 0, 1))
        self.assertEqual(r["sha256"], hashlib.sha256(S.spool_lines(cfg, "api")[0]).hexdigest())
        p = S.run_wall(["emit", "--config", cfg, "p9", "output", "x"])
        self.assertEqual(p.returncode, 7)
        self.assertEqual(json.loads(p.stdout)["rc"], 7)
        p = S.run_wall(["emit", "--config", cfg, "--source", "git", "api", "output", "x"])
        self.assertEqual(p.returncode, 2)

    def test_cli_planted_secret_never_printed(self):
        cfg = self.cfg()
        for cls, (text, secret, _) in S.planted().items():
            p = S.run_wall(["emit", "--config", cfg, "api", "output", text])
            self.assertNotIn(secret.encode(), p.stdout + p.stderr, cls)


if __name__ == "__main__":
    unittest.main()
