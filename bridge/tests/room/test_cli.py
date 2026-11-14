"""CLI verbs, JSON output and exit codes 0/2/4/124."""
import json, time, unittest

from .support import RoomCase, run_cli, jout, find_events, file_events, events_path, mk_event, seed


class Cli(RoomCase):
    def cli(self, *args, **kw):
        return run_cli(args, self.home, **kw)

    def post(self, *extra, room="r1", agent="a1", act="heartbeat", text="x"):
        return self.cli("post", "--room", room, "--agent", agent, "--act", act, "--text", text, *extra)

    def test_post_ok(self):
        cp = self.post(text="héllo")
        self.assertEqual(cp.returncode, 0, cp.stderr)
        out = jout(cp)
        ev = out.get("event", out)
        self.assertEqual((ev["lamport"], ev["agent"], ev["text"]), (1, "a1", "héllo"))
        self.assertEqual(len(file_events(self.home, "r1")), 1)
        self.assertEqual(cp.stdout.decode().strip().count("\n"), 0)       # one object on one line

    def test_post_refused_exit_2_and_code(self):
        cp = self.post(act="nope")
        self.assertEqual(cp.returncode, 2)
        self.assertEqual(jout(cp), {"ok": False, "code": "bad_act"})
        self.assertEqual(jout(self.post(agent="BAD"))["code"], "bad_agent")
        self.assertEqual(jout(self.post(room="BAD"))["code"], "bad_room")
        self.assertEqual(jout(self.post(text="a" * 5000))["code"], "text_too_long")
        self.assertEqual(jout(self.post(act="answer", text="x"))["code"], "bad_re")

    def test_post_re_to_evidence(self):
        q = jout(self.post(act="question"))
        qid = q.get("event", q)["id"]
        f = self.make_file("e.txt", b"abc")
        cp = self.post("--re", qid, "--to", "a2", "--evidence", str(f), act="answer")
        self.assertEqual(cp.returncode, 0, cp.stdout)
        ev = file_events(self.home, "r1")[1]
        self.assertEqual((ev["re"], ev["to"]), (qid, "a2"))
        self.assertEqual(ev["evidence"][0]["path"], str(f))
        g = self.make_file("g.txt")
        cp = self.post("--evidence", str(f), "--evidence", str(g))
        self.assertEqual(len(file_events(self.home, "r1")[2]["evidence"]), 2)
        cp = self.post("--evidence", "relative.txt")
        self.assertEqual((cp.returncode, jout(cp)["code"]), (2, "bad_evidence"))

    def test_post_plan_file_and_step_json(self):
        pf = self.tmp / "plan.json"
        pf.write_text(json.dumps({"title": "T", "steps": [{"text": "a"}, {"text": "b", "accept": "c"}]}))
        cp = self.post("--plan-file", str(pf), act="plan")
        self.assertEqual(cp.returncode, 0, cp.stdout)
        cp = self.post("--step-json", json.dumps({"index": 1, "state": "done", "took": "2m"}), act="step")
        self.assertEqual(cp.returncode, 0, cp.stdout)
        evs = file_events(self.home, "r1")
        self.assertEqual(evs[0]["plan"]["title"], "T")
        self.assertEqual(evs[1]["step"], {"index": 1, "state": "done", "took": "2m"})
        cp = self.post("--step-json", json.dumps({"index": 1, "state": "weird"}), act="step")
        self.assertEqual((cp.returncode, jout(cp)["code"]), (2, "bad_step"))
        bad = self.tmp / "bad.json"
        bad.write_text("{nope")
        cp = self.post("--plan-file", str(bad), act="plan")
        self.assertEqual(cp.returncode, 2)
        self.assertEqual(jout(cp)["code"], "bad_plan")

    def test_read(self):
        for i in range(3):
            self.post(text="m%d" % i)
        cp = self.cli("read", "--room", "r1", "--json")
        self.assertEqual(cp.returncode, 0, cp.stderr)
        out = jout(cp)
        self.assertEqual([e["text"] for e in find_events(out)], ["m0", "m1", "m2"])
        self.assertEqual(out["malformed"], 0)
        out = jout(self.cli("read", "--room", "r1", "--since", "2", "--json"))
        self.assertEqual([e["text"] for e in find_events(out)], ["m2"])
        self.assertEqual(self.cli("read", "--room", "r1").returncode, 0)   # works without --json

    def test_read_counts_malformed(self):
        seed(self.home, "r1", [mk_event(1)], raw_lines=["junk"])
        out = jout(self.cli("read", "--room", "r1", "--json"))
        self.assertEqual((len(find_events(out)), out["malformed"]), (1, 1))

    def test_missing_room_exit_4(self):
        for verb in (["read"], ["status"], ["wait", "--timeout", "0.2"]):
            cp = self.cli(*verb, "--room", "nope")
            self.assertEqual(cp.returncode, 4, (verb, cp.stdout, cp.stderr))

    def test_status(self):
        q = jout(self.post(act="question"))
        cp = self.cli("status", "--room", "r1")
        self.assertEqual(cp.returncode, 0, cp.stderr)
        s = jout(cp)
        for k in ("open_questions", "handoffs_without_ack", "last_by_agent", "silent"):
            self.assertIn(k, s)
        self.assertEqual(len(s["open_questions"]), 1)

    def test_wait_match_and_timeout_124(self):
        self.post(agent="a1", act="question")
        cp = self.cli("wait", "--room", "r1", "--act", "question", "--timeout", "5")
        self.assertEqual(cp.returncode, 0, cp.stderr)
        out = jout(cp)
        self.assertEqual(out.get("event", out)["act"], "question")
        t = time.time()
        cp = self.cli("wait", "--room", "r1", "--since", "1", "--timeout", "0.5")
        self.assertEqual(cp.returncode, 124)
        self.assertLess(time.time() - t, 15)
        cp = self.cli("wait", "--room", "r1", "--exclude-agent", "a1", "--timeout", "0.3")
        self.assertEqual(cp.returncode, 124)
        cp = self.cli("wait", "--room", "r1", "--agent", "a1", "--to", "zz", "--timeout", "0.3")
        self.assertEqual(cp.returncode, 124)

    def test_wait_wakes_on_concurrent_post(self):
        import subprocess, sys
        from .support import RUNNER, REPO, clean_env
        self.post()
        w = subprocess.Popen([sys.executable, "-I", "-c", RUNNER, "bridge.room", "wait", "--room", "r1",
                              "--since", "1", "--act", "verdict", "--timeout", "20"],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(REPO),
                             env=clean_env(self.home))
        time.sleep(0.6)
        self.post(act="verdict", agent="a2")
        out, err = w.communicate(timeout=20)
        self.assertEqual(w.returncode, 0, err)
        ev = json.loads(out)
        self.assertEqual(ev.get("event", ev)["agent"], "a2")

    def test_stdout_only_json_on_refusal(self):
        cp = self.post(act="nope")
        json.loads(cp.stdout)                                  # whole stdout is one JSON document


if __name__ == "__main__":
    unittest.main()
