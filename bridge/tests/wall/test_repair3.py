"""Repair loop 3 regression tests (Sol HOLD, DISP_03 BLOCKING items only).
Concrete failing inputs. Fake secrets are never needed here."""
import importlib, json, os, pathlib, shutil, subprocess, sys, threading, time, unittest
from unittest import mock
from . import support as S

E = importlib.import_module("bridge.wall.emit")
O = importlib.import_module("bridge.wall.observers")

FAIL = {"ok": False, "rc": 1, "code": "WRITE_FAILED"}


class Flaky:
    """emit_fn: fails (result or exception) while `mode` is set, then succeeds."""
    def __init__(self, mode="result"):
        self.mode = mode
        self.attempts = []
        self.sent = []

    def __call__(self, project, kind, text, source="agent", **kw):
        self.attempts.append((kind, text))
        if self.mode == "result":
            return dict(FAIL)
        if self.mode == "raise":
            raise RuntimeError("injected emitter failure")
        self.sent.append((kind, text, source))
        return {"ok": True, "rc": 0, "seq": len(self.sent), "sha256": "0" * 64}


def poll_tolerant(ob):
    try:
        return ob.poll()
    except Exception:
        return None


class ObserverCursorTests(S.Base):
    """Cursor/baseline state may only advance for events emit() accepted (B11/B12, DISP_03 data loss)."""

    def test_files_observer_retries_after_failed_emit(self):
        for mode in ("result", "raise"):
            with self.subTest(mode=mode):
                root = self.tmp / ("proj_" + mode); root.mkdir()
                f = root / "a.txt"; f.write_text("1\n"); os.utime(f, (1000, 1000))
                fl = Flaky("ok")
                ob = O.FilesObserver("api", [str(root)], emit_fn=fl)
                ob.poll()
                f.write_text("22\n"); os.utime(f, (2000, 2000))
                fl.mode = mode
                res = poll_tolerant(ob)
                if mode == "raise":
                    self.assertIsNotNone(res, "emitter exception escaped poll()")
                fl.mode = "ok"
                ob.poll()
                self.assertEqual(len(fl.sent), 1)
                self.assertIn("a.txt", fl.sent[0][1])
                ob.poll()
                self.assertEqual(len(fl.sent), 1)

    def test_files_observer_partial_failure_retries_only_unsent(self):
        root = self.tmp / "proj"; root.mkdir()
        for n in ("a.txt", "b.txt"):
            (root / n).write_text("1"); os.utime(root / n, (1000, 1000))
        calls = []

        def emit_fn(project, kind, text, source="agent", **kw):
            calls.append(text)
            if "a.txt" in text and not any("a.txt" in c for c in calls[:-1]):
                return {"ok": True, "rc": 0, "seq": 1, "sha256": "0" * 64}
            return dict(FAIL) if len(calls) < 3 else {"ok": True, "rc": 0, "seq": 2, "sha256": "0" * 64}
        ob = O.FilesObserver("api", [str(root)], emit_fn=emit_fn)
        ob.poll()
        for n in ("a.txt", "b.txt"):
            (root / n).write_text("22"); os.utime(root / n, (2000, 2000))
        ob.poll()
        ob.poll()
        ok_a = [c for c in calls if "a.txt" in c]
        ok_b = [c for c in calls if "b.txt" in c]
        self.assertEqual(len(ok_a), 1, "already-accepted event re-sent")
        self.assertGreaterEqual(len(ok_b), 2, "failed event never retried")

    @unittest.skipUnless(shutil.which("git"), "git not installed")
    def test_git_observer_retries_after_failed_emit(self):
        repo = self.tmp / "repo"; repo.mkdir()

        def g(*a):
            return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *a], cwd=repo,
                                  check=True, capture_output=True, text=True, env=S.clean_env()).stdout.strip()
        g("init", "-b", "main"); (repo / "a").write_text("1"); g("add", "."); g("commit", "-m", "one")
        for mode in ("result", "raise"):
            with self.subTest(mode=mode):
                fl = Flaky("ok")
                ob = O.GitObserver("api", [str(repo)], emit_fn=fl)
                ob.poll()
                (repo / "a").write_text("x" + mode); g("commit", "-am", mode)
                fl.mode = mode
                res = poll_tolerant(ob)
                if mode == "raise":
                    self.assertIsNotNone(res)
                fl.mode = "ok"
                ob.poll()
                self.assertEqual([k for k, _t, _s in fl.sent], ["commit"])
                ob.poll()
                self.assertEqual(len(fl.sent), 1)

    def test_log_observer_retries_after_failed_emit(self):
        for mode in ("result", "raise"):
            with self.subTest(mode=mode):
                log = self.tmp / ("ci_%s.log" % mode); log.write_text("start\n")
                fl = Flaky("ok")
                ob = O.LogObserver("api", [{"path": str(log), "passed": "ALL PASS", "failed": "FAILED!"}], emit_fn=fl)
                ob.poll()
                self.assertEqual([k for k, _t, _s in fl.sent], ["ci_started"])
                with open(log, "a") as fh:
                    fh.write("ALL PASS\n")
                fl.mode = mode
                res = poll_tolerant(ob)
                if mode == "raise":
                    self.assertIsNotNone(res)
                fl.mode = "ok"
                ob.poll()
                self.assertEqual([k for k, _t, _s in fl.sent], ["ci_started", "ci_passed"])
                ob.poll()
                self.assertEqual(len(fl.sent), 2)

    def test_log_observer_first_sight_failure_retries_ci_started(self):
        log = self.tmp / "ci.log"; log.write_text("start\n")
        fl = Flaky("result")
        ob = O.LogObserver("api", [{"path": str(log), "passed": "OK", "failed": "NO"}], emit_fn=fl)
        ob.poll()
        fl.mode = "ok"
        ob.poll()
        self.assertEqual([k for k, _t, _s in fl.sent], ["ci_started"])

    def test_transcript_observer_retries_without_ctx(self):
        for mode in ("result", "raise"):
            with self.subTest(mode=mode):
                t = self.tmp / ("t_%s.jsonl" % mode); t.write_text("first\n")
                fl = Flaky("ok")
                ob = O.TranscriptObserver("api", [str(t)], emit_fn=fl)
                ob.poll()
                with open(t, "a") as fh:
                    fh.write("second\nthird\n")
                fl.mode = mode
                res = poll_tolerant(ob)
                if mode == "raise":
                    self.assertIsNotNone(res)
                fl.mode = "ok"
                ob.poll()
                self.assertEqual([t_ for _k, t_, _s in fl.sent], ["second", "third"])
                ob.poll()
                self.assertEqual(len(fl.sent), 2)

    def test_transcript_observer_retries_with_ctx_window(self):
        t = self.tmp / "tc.jsonl"; t.write_text("first\n")

        class Ctx:
            def tail(self, path, n):
                raw = t.read_text().split("\n")[:-1]
                return {"lines": raw[-n:], "line_count": len(raw), "cut": False}
            def state(self, target): return {}
            def page(self, path, frm): return {"lines": [], "next": None}
        fl = Flaky("ok")
        ob = O.TranscriptObserver("api", [str(t)], ctx=Ctx(), emit_fn=fl)
        ob.poll()
        with open(t, "a") as fh:
            fh.write("second\n")
        fl.mode = "result"
        ob.poll()
        fl.mode = "ok"
        ob.poll()
        self.assertEqual([t_ for _k, t_, _s in fl.sent], ["second"])

    @unittest.skipUnless(sys.platform.startswith("linux"), "/proc only")
    def test_proc_observer_retries_started_and_exited(self):
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            for mode in ("result", "raise"):
                with self.subTest(mode=mode):
                    fl = Flaky(mode)
                    ob = O.ProcObserver("api", [p.pid], emit_fn=fl)
                    res = poll_tolerant(ob)
                    if mode == "raise":
                        self.assertIsNotNone(res)
                    fl.mode = "ok"
                    ob.poll()
                    self.assertEqual([k for k, _t, _s in fl.sent], ["proc_started"])
                    ob.poll()
                    self.assertEqual(len(fl.sent), 1)
        finally:
            p.kill(); p.wait()
        fl = Flaky("ok")
        q = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        ob = O.ProcObserver("api", [q.pid], emit_fn=fl)
        ob.poll()
        q.kill(); q.wait()
        fl.mode = "result"
        ob.poll()
        fl.mode = "ok"
        ob.poll()
        self.assertEqual([k for k, _t, _s in fl.sent], ["proc_started", "proc_exited"])


class Monitor:
    """Samples a spool file and records the time of every appended line."""
    def __init__(self, path):
        self.path, self.stamps, self._stop = path, [], threading.Event()
        self.t = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        last = 0
        while not self._stop.is_set():
            try:
                n = pathlib.Path(self.path).read_bytes().count(b"\n")
            except OSError:
                n = 0
            now = time.perf_counter()
            if n > last:
                self.stamps += [now] * (n - last)
                last = n
            time.sleep(0.0005)

    def __enter__(self):
        self.t.start(); return self

    def __exit__(self, *a):
        time.sleep(0.05); self._stop.set(); self.t.join(5)


def worst_window(stamps, per=20, span=1.0):
    return min((stamps[i + per] - stamps[i] for i in range(len(stamps) - per)), default=span + 1)


class RateAtomicityTests(S.Base):
    SLACK = 0.05

    def test_pause_between_admission_and_append_cannot_exceed_rate(self):
        """Review defect 3: process A is paused right after rate admission; its reservation
        expires; B appends 20 events; A resumes. >20 actual appends must not land in 1 s."""
        cfg = self.cfg()
        spool = str(S.spool_dir(cfg) / "api.jsonl")
        orig = getattr(E, "_rate_wait", None)
        paused = threading.Event()
        results = {}

        def wrapper(*a, **k):
            r = orig(*a, **k) if orig else None
            if threading.current_thread().name == "A" and not paused.is_set():
                paused.set()
                time.sleep(1.3)
            return r

        def run(name, n, delay):
            time.sleep(delay)
            results[name] = [E.emit("api", "output", "%s%d" % (name, i), config=cfg)["rc"] for i in range(n)]

        with mock.patch.object(E, "_rate_wait", wrapper, create=True):
            with Monitor(spool) as mon:
                a = threading.Thread(target=run, args=("A", 1, 0), name="A")
                b = threading.Thread(target=run, args=("B", 20, 1.1), name="B")
                a.start(); b.start(); a.join(60); b.join(60)
        self.assertEqual(results.get("A"), [0])
        self.assertEqual(results.get("B"), [0] * 20)       # never dropped
        self.assertEqual(len(S.spool_lines(cfg, "api")), 21)
        self.assertGreaterEqual(worst_window(mon.stamps), 1.0 - self.SLACK,
                                "more than 20 spool appends within one second for one project")

    def test_concurrent_processes_actual_appends_within_rate(self):
        cfg = self.cfg()
        spool = str(S.spool_dir(cfg) / "api.jsonl")
        code = ("import sys, time; sys.path.insert(0, %r); from bridge.wall.emit import emit\n"
                "time.sleep(max(0, float(sys.argv[2]) - time.time()))\n"
                "for i in range(15):\n"
                "    r = emit('api', 'output', 'x', config=sys.argv[1]); assert r['rc'] == 0, r\n" % str(S.REPO))
        t0 = time.time() + 1.0
        with Monitor(spool) as mon:
            procs = [subprocess.Popen([sys.executable, "-I", "-c", code, cfg, repr(t0)], env=S.clean_env())
                     for _ in range(4)]
            for p in procs:
                self.assertEqual(p.wait(120), 0)
        self.assertEqual(len(S.spool_lines(cfg, "api")), 60)
        self.assertGreaterEqual(worst_window(mon.stamps), 1.0 - self.SLACK)

    def test_concurrent_threads_actual_appends_within_rate(self):
        cfg = self.cfg()
        spool = str(S.spool_dir(cfg) / "api.jsonl")
        rcs = []

        def run():
            for _ in range(12):
                rcs.append(E.emit("api", "output", "x", config=cfg)["rc"])
        with Monitor(spool) as mon:
            ts = [threading.Thread(target=run) for _ in range(5)]
            [t.start() for t in ts]; [t.join(120) for t in ts]
        self.assertEqual(rcs, [0] * 60)
        self.assertGreaterEqual(worst_window(mon.stamps), 1.0 - self.SLACK)


def env_line(**over):
    d = {"source": "agent", "projectId": "api", "sourceSeq": 1, "ts": S.TS, "kind": "output", "text": "ok"}
    d.update(over)
    return json.dumps(d, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def good_line(seq=99, text="good-line"):
    return env_line(sourceSeq=seq, text=text)


# (label, text as a JSON string literal body) -- rejected by B3/B7 shared validation
BAD_TEXTS = [
    ("over_cap_ascii", "x" * 2001),
    ("over_cap_utf16_units", "\\ud83d\\ude00" * 1001),      # 1001 astral chars = 2002 code units
    ("lone_high_surrogate", "\\ud800"),
    ("lone_low_surrogate", "a\\udc00b"),
    ("c0_control_escaped", "a\\u0001b"),
    ("del_escaped", "a\\u007fb"),
]


class SpoolValidationTests(S.Base):
    def _line(self, body):
        return ('{"kind":"output","projectId":"api","source":"agent","sourceSeq":1,"text":"%s","ts":%d}'
                % (body, S.TS))

    def _host(self, lines):
        cfg = self.cfg()
        with open(S.spool_dir(cfg) / "api.jsonl", "wb") as fh:
            for l in lines:
                fh.write(l.encode("ascii") + b"\n")
        h = S.start_host(self, cfg)
        frames = []
        try:
            while True:
                frames.append(h.read_frame(1.5))
        except (S.HostTimeout, S.HostEOF):
            pass
        return h, frames

    def test_host_rejects_bad_text_and_survives(self):
        for label, body in BAD_TEXTS:
            with self.subTest(label=label):
                h, frames = self._host([self._line(body), good_line()])
                self.assertIsNone(h.p.poll(), "host crashed on %s" % label)
                evs = [f for f in frames if f["t"] == "event"]
                self.assertEqual([e["payload"]["text"] for e in evs], ["good-line"], label)
                self.assertNotIn(b"Traceback", h.stderr_text())
                h.stop()

    def test_host_accepts_text_exactly_at_cap(self):
        h, frames = self._host([self._line("x" * 2000)])
        evs = [f for f in frames if f["t"] == "event"]
        self.assertEqual(len(evs), 1)
        self.assertEqual(len(evs[0]["payload"]["text"]), 2000)
        h.stop()

    def test_export_rejects_bad_text_cleanly(self):
        for label, body in BAD_TEXTS:
            with self.subTest(label=label):
                cfg = self.cfg()
                sp = self.tmp / ("bad_%s.jsonl" % label)
                sp.write_bytes(self._line(body).encode("ascii") + b"\n")
                out = self.tmp / ("fx_" + label)
                p = S.run_wall(["export", "--config", cfg, "--spool", str(sp), "--out", str(out)])
                self.assertEqual(p.returncode, 2, (label, p.stderr))
                self.assertNotIn(b"Traceback", p.stderr, label)
                self.assertFalse((out / "manifest.json").exists(), label)

    def test_export_accepts_text_exactly_at_cap(self):
        cfg = self.cfg()
        sp = self.tmp / "ok.jsonl"
        sp.write_bytes(self._line("x" * 2000).encode("ascii") + b"\n")
        p = S.run_wall(["export", "--config", cfg, "--spool", str(sp), "--out", str(self.tmp / "fx")])
        self.assertEqual(p.returncode, 0, p.stderr)


if __name__ == "__main__":
    unittest.main()
