"""Repair loop 1 regression tests (Sol HOLD F1-F7). Concrete failing inputs only.
Fake secrets are built at runtime by concatenation (support.planted)."""
import importlib, json, os, pathlib, subprocess, sys, time, tracemalloc, unittest
from unittest import mock
from . import support as S

E = importlib.import_module("bridge.wall.emit")
O = importlib.import_module("bridge.wall.observers")


def spool_bytes(cfg, project):
    p = S.spool_dir(cfg) / (project + ".jsonl")
    return p.read_bytes() if p.exists() else b""


class F1Seq(S.Base):
    def test_result_seq_is_the_envelope_source_seq(self):
        cfg = self.cfg()
        r1 = E.emit("api", "output", "a", config=cfg, _clock=S.CLOCK)
        r2 = E.emit("api", "waiting_input", "b", config=cfg, _clock=S.CLOCK)
        r3 = E.emit("api", "output", "c", config=cfg, _clock=S.CLOCK)
        seqs = [json.loads(l)["sourceSeq"] for l in S.spool_lines(cfg, "api")]
        self.assertEqual(seqs, [1, 2, 3])
        self.assertEqual([r1["seq"], r2["seq"], r3["seq"]], seqs)

    def test_flush_failure_leaves_no_partial_line_and_no_seq_gap(self):
        cfg = self.cfg()
        real = os.fsync
        state = {"n": 0}

        def flaky(fd):
            try:
                tgt = os.readlink("/proc/self/fd/%d" % fd)
            except OSError:
                tgt = ""
            if tgt.endswith("api.jsonl") and state["n"] == 0:
                state["n"] += 1
                raise OSError(5, "injected")
            return real(fd)
        with mock.patch.object(os, "fsync", flaky):
            r = E.emit("api", "output", "will fail", config=cfg, _clock=S.CLOCK)
        self.assertEqual(state["n"], 1, "spool fsync not reached")
        self.assertEqual((r["ok"], r["rc"]), (False, 1))
        self.assertEqual(spool_bytes(cfg, "api"), b"")
        r2 = E.emit("api", "output", "after", config=cfg, _clock=S.CLOCK)
        self.assertEqual((r2["rc"], r2["seq"]), (0, 1))
        self.assertEqual(len(S.spool_lines(cfg, "api")), 1)


class F2SeqOverflow(S.Base):
    def test_seq_past_max_safe_int_rejected_nothing_written(self):
        cfg = self.cfg()
        sp = S.spool_dir(cfg)
        (sp / "seq.json").write_text('{"api":{"agent":9007199254740991}}')
        before = S.tree_bytes(sp)
        r = E.emit("api", "output", "x", config=cfg, _clock=S.CLOCK)
        self.assertEqual((r["ok"], r["rc"]), (False, 2))
        self.assertEqual(S.tree_bytes(sp), before)


class F3Rate(S.Base):
    def test_rate_limit_is_shared_across_processes(self):
        cfg = self.cfg()
        code = ("import sys, time, json; sys.path.insert(0, %r); "
                "from bridge.wall.emit import emit; "
                "t0 = float(sys.argv[2]); "
                "time.sleep(max(0, t0 - time.time())); ts = []\n"
                "for i in range(25):\n"
                "    r = emit('api', 'output', 'x', config=sys.argv[1]); assert r['rc'] == 0, r\n"
                "    ts.append(time.time())\n"
                "print(json.dumps(ts))" % str(S.REPO))
        t0 = time.time() + 1.5
        procs = [subprocess.Popen([sys.executable, "-I", "-c", code, cfg, repr(t0)],
                                  stdout=subprocess.PIPE, env=S.clean_env()) for _ in range(3)]
        ts = []
        for p in procs:
            out, _ = p.communicate(timeout=120)
            self.assertEqual(p.returncode, 0)
            ts += json.loads(out)
        ts.sort()
        self.assertEqual(len(ts), 75)
        worst = max(sum(1 for u in ts if t <= u < t + 1.0) for t in ts)
        self.assertLessEqual(worst, 26, "project allowance is 20/s across all processes")


class F4Host(S.Base):
    def _run(self, lines, settle=1.5):
        cfg = self.cfg()
        with open(S.spool_dir(cfg) / "api.jsonl", "wb") as fh:
            for l in lines:
                fh.write(l.encode() + b"\n")
        h = S.start_host(self, cfg)
        frames = []
        try:
            while True:
                frames.append(h.read_frame(settle))
        except (S.HostTimeout, S.HostEOF):
            pass
        return h, frames

    @staticmethod
    def env(**kw):
        return E.canonical_json(dict({"source": "agent", "projectId": "api", "sourceSeq": 1,
                                      "ts": S.TS, "kind": "output", "text": "ok"}, **kw))

    def test_unhashable_source_does_not_crash_host(self):
        good = self.env(sourceSeq=3, text="good-line")
        h, frames = self._run([self.env(source=[]), self.env(source={"a": 1}, sourceSeq=2), good])
        self.assertIsNone(h.p.poll(), "host crashed on malformed spool line")
        self.assertEqual([f["t"] for f in frames], ["hello", "event"])
        self.assertEqual(frames[1]["payload"]["text"], "good-line")

    def test_unredacted_secret_in_spool_line_not_forwarded(self):
        secret_text, secret, _ = S.planted()["KEY_ASSIGN"]
        h, frames = self._run([self.env(text=secret_text), self.env(sourceSeq=2, text="after")])
        self.assertIsNone(h.p.poll())
        self.assertNotIn(secret.encode(), json.dumps(frames).encode() + h.stderr_text())
        self.assertIn("after", [f["payload"]["text"] for f in frames if f["t"] == "event"])

    def test_export_rejects_malformed_spool_cleanly(self):
        cfg = self.cfg()
        sp = self.tmp / "bad.jsonl"
        sp.write_text(self.env(source=[]) + "\n")
        p = S.run_wall(["export", "--config", cfg, "--spool", str(sp), "--out", str(self.tmp / "fx")])
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertNotIn(b"Traceback", p.stderr)
        self.assertFalse((self.tmp / "fx" / "manifest.json").exists())


class FakeWindowCtx:
    """U29-shaped tail over a growing file: last n lines plus whole-file line_count."""
    def __init__(self, path):
        self.path = path

    def tail(self, path, n):
        raw = pathlib.Path(self.path).read_text().split("\n")
        if raw and raw[-1] == "":
            raw.pop()
        return {"lines": raw[-n:], "line_count": len(raw), "cut": False}

    def state(self, target):
        return {}

    def page(self, path, frm):
        return {"lines": [], "next": None}


class Rec:
    def __init__(self):
        self.calls = []

    def __call__(self, project, kind, text, source="agent", **kw):
        self.calls.append((kind, text, source))
        return {"ok": True, "rc": 0, "seq": len(self.calls), "sha256": "0" * 64}


class F5Transcript(S.Base):
    def test_full_sliding_window_still_emits_new_line(self):
        t = self.tmp / "t.jsonl"
        t.write_text("".join("line%04d\n" % i for i in range(1000)))   # > 200-line window
        rec = Rec()
        ob = O.TranscriptObserver("api", [str(t)], ctx=FakeWindowCtx(str(t)), emit_fn=rec)
        ob.poll()
        self.assertEqual(rec.calls, [])
        with open(t, "a") as fh:
            fh.write("brand-new-1\n")
        ob.poll()
        self.assertEqual([c[1] for c in rec.calls], ["brand-new-1"])
        with open(t, "a") as fh:
            fh.write("brand-new-2\nbrand-new-3\n")
        ob.poll()
        self.assertEqual([c[1] for c in rec.calls][1:], ["brand-new-2", "brand-new-3"])

    def test_fallback_bounded_on_huge_newline_free_record(self):
        t = self.tmp / "big.jsonl"
        t.write_text("")
        rec = Rec()
        ob = O.TranscriptObserver("api", [str(t)], emit_fn=rec)      # no ctx: plain bounded reads
        ob.poll()
        with open(t, "ab") as fh:
            fh.write(b"x" * (8 * 1024 * 1024))                       # one 8 MiB record, no newline
        tracemalloc.start()
        try:
            ob.poll()
            ob.poll()
            _c, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 2 * 1024 * 1024)
        self.assertTrue(all(len(c[1]) <= 2000 for c in rec.calls))


def cmd(args, home):
    return subprocess.run([sys.executable, "-I", str(S.INSTALL), *args], capture_output=True,
                          env=S.clean_env(HOME=str(home)), timeout=30)


class F6Install(S.Base):
    def setUp(self):
        super().setUp()
        self.home = self.tmp / "home"
        self.home.mkdir()

    def manifest(self):
        hits = list(self.home.rglob(S.HOST_NAME + ".json"))
        self.assertEqual(len(hits), 1)
        return hits[0]

    def test_generated_launcher_actually_runs_the_host(self):
        self.assertEqual(cmd(["--apply"], self.home).returncode, 0)
        launcher = json.loads(self.manifest().read_text())["path"]
        cfg = self.cfg()
        p = subprocess.run([launcher, "--config", cfg, S.ORIGIN], input=S.frame({"t": "bye", "v": 1}),
                           capture_output=True, env=S.clean_env(HOME=str(self.home)), timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        n = int.from_bytes(p.stdout[:4], "little")
        self.assertEqual(json.loads(p.stdout[4:4 + n])["t"], "hello")

    def test_remove_never_deletes_unrelated_file_named_in_manifest(self):
        self.assertEqual(cmd(["--apply"], self.home).returncode, 0)
        important = self.home / "important.txt"
        important.write_text("keep me")
        m = self.manifest()
        data = json.loads(m.read_text())
        data["path"] = str(important)
        m.write_text(json.dumps(data))
        cmd(["--remove"], self.home)
        self.assertTrue(important.exists(), "--remove deleted a file it never wrote")


class F7Config(S.Base):
    def mutated(self, **proj):
        cfg = self.cfg()
        d = json.loads(pathlib.Path(cfg).read_text())
        d["projects"][0].update(proj)
        pathlib.Path(cfg).write_text(json.dumps(d))
        return cfg

    def test_observe_rejects_malformed_project_fields_with_rc2(self):
        for bad in ({"roots": 1}, {"pids": ["x"]}, {"transcripts": 5}):
            cfg = self.mutated(**bad)
            p = S.run_wall(["observe", "--once", "--config", cfg])
            self.assertEqual(p.returncode, 2, (bad, p.stderr))
            self.assertNotIn(b"Traceback", p.stderr, bad)

    def test_emit_treats_malformed_project_fields_as_invalid_config(self):
        for bad in ({"roots": 1}, {"pids": ["x"]}):
            cfg = self.mutated(**bad)
            r = E.emit("api", "output", "x", config=cfg, _clock=S.CLOCK)
            self.assertEqual(r["rc"], 7, bad)


if __name__ == "__main__":
    unittest.main()
