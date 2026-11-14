import importlib, json, os, pathlib, shutil, subprocess, sys, time, unittest
from . import support as S

O = importlib.import_module("bridge.wall.observers")
E = importlib.import_module("bridge.wall.emit")


class Rec:
    def __init__(self):
        self.calls = []

    def __call__(self, project, kind, text, source="agent", **kw):
        self.calls.append({"project": project, "kind": kind, "text": text, "source": source})
        return {"ok": True, "rc": 0, "seq": len(self.calls), "sha256": "0" * 64}

    def take(self):
        c, self.calls = self.calls, []
        return c


class FakeCtx:
    def __init__(self):
        self.calls = []

    def tail(self, path, n):
        self.calls.append(("tail", path, n)); return {"lines": []}

    def state(self, target):
        self.calls.append(("state", target)); return {}

    def page(self, path, frm):
        self.calls.append(("page", path, frm)); return {"lines": ["via ctx"], "next": None}


def git(cwd, *a):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *a], cwd=cwd, check=True,
                          capture_output=True, text=True, env=S.clean_env()).stdout.strip()


class Constants(unittest.TestCase):
    def test_poll_ms(self):
        self.assertEqual(O.POLL_MS, 2000)


class Files(S.Base):
    def test_change_only_and_baseline(self):
        root = self.tmp / "proj"; root.mkdir()
        f = root / "notes.txt"; f.write_text("hello\n"); os.utime(f, (1000, 1000))
        rec = Rec(); ob = O.FilesObserver("api", [str(root)], emit_fn=rec)
        ob.poll(); ob.poll()
        self.assertEqual(rec.take(), [])                         # unchanged state emits nothing
        f.write_text("hello again\n"); os.utime(f, (2000, 2000))
        ob.poll()
        ev = rec.take()
        self.assertEqual(len(ev), 1)
        self.assertEqual((ev[0]["source"], ev[0]["kind"], ev[0]["project"]), ("local", "file_changed", "api"))
        self.assertIn("notes.txt", ev[0]["text"])
        ob.poll(); self.assertEqual(rec.take(), [])
        (root / "sub").mkdir(); g = root / "sub" / "new.py"; g.write_text("x"); os.utime(g, (3000, 3000))
        ob.poll()
        ev = rec.take()
        self.assertEqual(len(ev), 1)
        self.assertIn("new.py", ev[0]["text"])

    def test_uses_ctxport_page(self):
        root = self.tmp / "proj"; root.mkdir()
        f = root / "a.txt"; f.write_text("1"); os.utime(f, (1000, 1000))
        ctx = FakeCtx(); rec = Rec()
        ob = O.FilesObserver("api", [str(root)], ctx=ctx, emit_fn=rec)
        ob.poll(); f.write_text("2"); os.utime(f, (2000, 2000)); ob.poll()
        self.assertTrue(any(c[0] == "page" and c[1].endswith("a.txt") for c in ctx.calls), ctx.calls)

    def test_planted_secret_in_file_never_reaches_spool(self):
        root = self.tmp / "proj"; root.mkdir()
        cfg = self.cfg()
        f = root / "env.txt"; f.write_text("ok\n"); os.utime(f, (1000, 1000))
        emit_fn = lambda p, k, t, source="agent", **kw: E.emit(p, k, t, source, config=cfg, _clock=S.CLOCK)
        ob = O.FilesObserver("api", [str(root)], emit_fn=emit_fn)
        ob.poll()
        secret = "hunter2hunter2"
        f.write_text("MY_SECRET" + "=" + secret + "\ncontact " + "dev" + "@" + "example.com\n"); os.utime(f, (2000, 2000))
        ob.poll()
        raw = b"".join(p.read_bytes() for p in S.spool_dir(cfg).iterdir())
        self.assertIn(b"file_changed", raw)
        self.assertNotIn(secret.encode(), raw)
        self.assertNotIn(("dev" + "@" + "example.com").encode(), raw)


@unittest.skipUnless(shutil.which("git"), "git not installed")
class Git(S.Base):
    def test_w14_git_observer_idempotent(self):
        repo = self.tmp / "repo"; repo.mkdir()
        remote = self.tmp / "remote.git"
        git(self.tmp, "init", "--bare", "-b", "main", str(remote))
        git(repo, "init", "-b", "main")
        (repo / "a").write_text("1"); git(repo, "add", "."); git(repo, "commit", "-m", "init")
        git(repo, "remote", "add", "origin", str(remote)); git(repo, "push", "-u", "origin", "main")
        rec = Rec(); ob = O.GitObserver("api", [str(repo)], emit_fn=rec)
        ob.poll(); ob.poll()
        self.assertEqual(rec.take(), [])
        (repo / "a").write_text("2"); git(repo, "commit", "-am", "second")
        head = git(repo, "rev-parse", "HEAD")
        ob.poll()
        ev = rec.take()
        self.assertEqual(len(ev), 1, ev)
        self.assertEqual((ev[0]["source"], ev[0]["kind"]), ("git", "commit"))
        self.assertIn("main", ev[0]["text"]); self.assertIn(head[:7], ev[0]["text"])
        ob.poll(); self.assertEqual(rec.take(), [])
        git(repo, "push")
        ob.poll()
        ev = rec.take()
        self.assertEqual([(e["source"], e["kind"]) for e in ev], [("git", "push")])
        ob.poll(); self.assertEqual(rec.take(), [])

    def test_non_repo_root_is_silent(self):
        d = self.tmp / "plain"; d.mkdir()
        rec = Rec(); ob = O.GitObserver("api", [str(d)], emit_fn=rec)
        ob.poll(); ob.poll()
        self.assertEqual(rec.take(), [])


class Logs(S.Base):
    def test_started_then_passed_then_quiet(self):
        log = self.tmp / "ci.log"; log.write_text("")
        rec = Rec()
        ob = O.LogObserver("api", [{"path": str(log), "passed": "PASS (all)", "failed": "FAIL!"}], emit_fn=rec)
        ob.poll(); ob.poll()
        ev = rec.take()
        self.assertEqual([(e["source"], e["kind"]) for e in ev], [("ci", "ci_started")])   # first sight only
        with open(log, "a") as fh: fh.write("building\n")
        ob.poll(); self.assertEqual(rec.take(), [])
        with open(log, "a") as fh: fh.write("suite PASS (all)\n")
        ob.poll()
        self.assertEqual([(e["source"], e["kind"]) for e in rec.take()], [("ci", "ci_passed")])
        ob.poll(); self.assertEqual(rec.take(), [])

    def test_failed_marker_literal_not_regex(self):
        log = self.tmp / "ci.log"; log.write_text("start\n")
        rec = Rec()
        ob = O.LogObserver("api", [{"path": str(log), "passed": "OK", "failed": "FAIL (1)"}], emit_fn=rec)
        ob.poll(); rec.take()
        with open(log, "a") as fh: fh.write("FAIL 1\n")        # regex-ish near-miss must not match
        ob.poll(); self.assertEqual(rec.take(), [])
        with open(log, "a") as fh: fh.write("FAIL (1)\n")
        ob.poll(); self.assertEqual([e["kind"] for e in rec.take()], ["ci_failed"])

    def test_missing_log_is_silent(self):
        rec = Rec()
        ob = O.LogObserver("api", [{"path": str(self.tmp / "none.log"), "passed": "a", "failed": "b"}], emit_fn=rec)
        ob.poll(); self.assertEqual(rec.take(), [])


class Transcripts(S.Base):
    def test_agent_kinds_and_output_fallback(self):
        t = self.tmp / "t.jsonl"; t.write_text("")
        rec = Rec(); ob = O.TranscriptObserver("api", [str(t)], emit_fn=rec)
        ob.poll(); self.assertEqual(rec.take(), [])
        with open(t, "a") as fh:
            fh.write(json.dumps({"kind": "waiting_input", "text": "Approve?"}) + "\n")
            fh.write(json.dumps({"kind": "error", "text": "boom"}) + "\n")
            fh.write(json.dumps({"kind": "weird", "text": "xyz"}) + "\n")
            fh.write("plain not json line\n")
            fh.write(json.dumps({"text": "hello"}) + "\n")
        ob.poll()
        ev = rec.take()
        self.assertEqual([e["kind"] for e in ev], ["waiting_input", "error", "output", "output", "output"])
        self.assertTrue(all(e["source"] == "agent" and e["project"] == "api" for e in ev))
        self.assertEqual(ev[0]["text"], "Approve?"); self.assertEqual(ev[1]["text"], "boom")
        self.assertIn("plain not json line", ev[3]["text"]); self.assertIn("hello", ev[4]["text"])
        ob.poll(); self.assertEqual(rec.take(), [])


class Procs(S.Base):
    @unittest.skipUnless(sys.platform.startswith("linux"), "linux /proc only")
    def test_started_then_exited(self):
        p = subprocess.Popen(["sleep", "30"])
        self.addCleanup(lambda: (p.kill(), p.wait()))
        rec = Rec(); ob = O.ProcObserver("api", [p.pid], emit_fn=rec)
        ob.poll()
        ev = rec.take()
        self.assertEqual([(e["source"], e["kind"]) for e in ev], [("local", "proc_started")])
        self.assertIn(str(p.pid), ev[0]["text"]); self.assertIn("rss", ev[0]["text"].lower())
        ob.poll(); self.assertEqual(rec.take(), [])
        p.kill(); p.wait()
        ob.poll()
        ev = rec.take()
        self.assertEqual([(e["source"], e["kind"]) for e in ev], [("local", "proc_exited")])
        self.assertIn(str(p.pid), ev[0]["text"])
        ob.poll(); self.assertEqual(rec.take(), [])

    def test_disabled_off_linux_reports_why(self):
        rec = Rec(); ob = O.ProcObserver("api", [os.getpid()], emit_fn=rec, platform="darwin")
        self.assertEqual(ob.poll(), [])
        self.assertEqual(rec.take(), [])
        self.assertTrue(isinstance(ob.disabled_reason, str) and ob.disabled_reason)


class Build(S.Base):
    def test_build_observers_from_project_config(self):
        d = self.tmp / "r"; d.mkdir()
        pc = {"projectId": "api", "tier": "standard", "roots": [str(d)],
              "logs": [{"path": str(d / "l.log"), "passed": "ok", "failed": "bad"}],
              "transcripts": [str(d / "t.jsonl")], "pids": [os.getpid()]}
        obs = O.build_observers(pc, emit_fn=Rec())
        names = {type(o).__name__ for o in obs}
        self.assertEqual(names, {"FilesObserver", "GitObserver", "LogObserver", "TranscriptObserver", "ProcObserver"})
        bare = O.build_observers({"projectId": "api", "tier": "standard", "roots": [str(d)]}, emit_fn=Rec())
        self.assertEqual({type(o).__name__ for o in bare}, {"FilesObserver", "GitObserver"})

    def test_observers_have_no_direct_spool_writes(self):
        src = (S.BRIDGE / "wall" / "observers.py").read_text()
        self.assertNotIn(".jsonl", src)
        self.assertNotIn("seq.json", src)


if __name__ == "__main__":
    unittest.main()
