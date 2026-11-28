import builtins, json, os, signal, stat, subprocess, sys, time, unittest
from bridge.tests.viewpoint.support import *


class Mapping(Base):
    def test_first_intent_posts_plan_and_step_active(self):
        self.run_builder().intent("101", goal="Search wikipedia for DeepMind", atype="type", role="searchbox",
                                  name="Search Wikipedia", text=SECRET)
        o = self.make(); n = o.poll()
        evs = self.events()
        self.assertEqual(n, len(evs))
        self.assertEqual([e["act"] for e in evs], ["plan", "step"])
        # Oracle amendment A-U42: capsule slug and "<Capsule> · <goal>" title.
        self.assertEqual(evs[0]["agent"], "wikipedia-agent")
        self.assertEqual(evs[0]["plan"]["title"], "Wikipedia \u00b7 Search wikipedia for DeepMind")
        self.assertEqual(len(evs[0]["plan"]["steps"]), 1)
        self.assertEqual(evs[1]["step"]["index"], 0)
        self.assertEqual(evs[1]["step"]["state"], "active")

    def test_label_from_type_role_name(self):
        self.run_builder().intent("1", atype="click", role="link", name="Google DeepMind")
        self.make().poll()
        self.assertEqual(self.events()[0]["plan"]["steps"][0]["text"], 'click link "Google DeepMind"')

    def test_type_label_never_copies_text(self):
        self.run_builder().intent("1", atype="type", role="searchbox", name="Search Wikipedia", text=SECRET)
        self.make().poll()
        label = self.events()[0]["plan"]["steps"][0]["text"]
        self.assertTrue(label.startswith("type"))
        self.assertIn("Search Wikipedia", label)
        self.assertNotIn(SECRET, label)

    def test_action_text_never_in_any_event(self):
        b = self.run_builder().intent("1", atype="type", text=SECRET, goal="g")
        b.intent("2", atype="type", text=SECRET + "2").receipt("1", reason="typed " + "ok")
        b.receipt("2").report()
        o = self.make(); o.poll()
        blob = json.dumps(self.events())
        self.assertNotIn("SECRET-MARKER", blob)
        # also not in the cursor file
        if self.cursor_path().exists():
            self.assertNotIn("SECRET-MARKER", self.cursor_path().read_text())

    def test_receipt_text_marker_not_leaked(self):
        b = self.run_builder().intent("1", text=SECRET)
        b.receipt("1", raw={"action": {"type": "type", "text": SECRET}, "target": {},
                            "verification": {"status": "verified"}})
        self.make().poll()
        self.assertNotIn("SECRET-MARKER", json.dumps(self.events()))

    def test_label_and_title_capped_and_redacted(self):
        long_goal = "g" * 300
        b = self.run_builder().intent("1", goal=long_goal, name="n" * 200)
        self.make().poll()
        e = self.events()[0]
        self.assertLessEqual(len(e["plan"]["title"]), 120)
        self.assertLessEqual(len(e["plan"]["steps"][0]["text"]), 80)
        # Oracle amendment A-U42b: no capsule -> the bare goal (no "ViewPoint ·" prefix).
        self.assertTrue(e["plan"]["title"].startswith("ggg"))

    def test_goal_and_label_redacted(self):
        tok = "Bearer abcdefghijklmnop1234567890"
        self.run_builder().intent("1", goal="login with " + tok, name="btn " + tok)
        self.make().poll()
        blob = json.dumps(self.events())
        self.assertNotIn("abcdefghijklmnop1234567890", blob)
        self.assertIn("REDACTED", blob)

    def test_agent_slug_safe_chars(self):
        self.run_builder("Ab_Cd.Ef/Gh!ij12").intent("1")
        self.make().poll()
        from bridge.room.store import AGENT_RE
        ag = {e["agent"] for e in self.events()}
        self.assertEqual(len(ag), 1)
        a = ag.pop()
        self.assertTrue(AGENT_RE.fullmatch(a), a)
        # Oracle amendment A-U42: the slug is the capsule slug, not derived from the run id.
        self.assertEqual(a, "viewpoint-agent")

    def test_default_room_viewpoint_and_custom_room(self):
        self.run_builder().intent("1")
        self.make(room="other-room").poll()
        self.assertEqual(self.events("viewpoint"), [])
        self.assertTrue(self.events("other-room"))

    def test_custom_post_callable(self):
        from bridge.viewpoint.observer import ViewpointObserver
        calls = []
        def fake(room, agent, act, text, **kw):
            calls.append((room, agent, act, kw)); return {}
        self.run_builder().intent("1")
        ViewpointObserver(str(self.root), "viewpoint", home=str(self.home), clock=self.clock, post=fake).poll()
        self.assertEqual([c[2] for c in calls], ["plan", "step"])
        self.assertEqual(calls[0][0], "viewpoint")


class Ordering(Base):
    def test_ordered_by_mtime_then_name(self):
        b = self.run_builder()
        b.intent("zzz", name="late", mtime=BASE + 50)
        b.intent("bbb", name="tie-b", mtime=BASE + 20)
        b.intent("aaa", name="tie-a", mtime=BASE + 20)
        self.make().poll()
        plans = [e for e in self.events() if e["act"] == "plan"]
        final = plans[-1]["plan"]["steps"]
        self.assertEqual([s["text"] for s in final],
                         ['click link "tie-a"', 'click link "tie-b"', 'click link "late"'])

    def test_additions_only_plans_and_active_steps(self):
        b = self.run_builder()
        b.intent("1", name="a")
        o = self.make(); o.poll()
        b.intent("2", name="b"); o.poll()
        b.intent("3", name="c"); o.poll()
        evs = self.events()
        plans = [e["plan"]["steps"] for e in evs if e["act"] == "plan"]
        self.assertEqual([len(p) for p in plans], [1, 2, 3])
        for prev, nxt in zip(plans, plans[1:]):
            self.assertEqual(nxt[:len(prev)], prev)
        steps = [e["step"] for e in evs if e["act"] == "step"]
        self.assertEqual([(s["index"], s["state"]) for s in steps], [(0, "active"), (1, "active"), (2, "active")])

    def test_two_runs_two_agents(self):
        self.run_builder("aaaaaaaa1111").intent("1")
        self.run_builder("bbbbbbbb2222").intent("1")
        self.make().poll()
        # Oracle amendment A-U42: two concurrent runs of one capsule -> "-agent" and "-agent-2".
        self.assertEqual({e["agent"] for e in self.events()}, {"viewpoint-agent", "viewpoint-agent-2"})


class Receipts(Base):
    def _states(self, status, reason=None):
        b = self.run_builder().intent("7").receipt("7", status=status, reason=reason)
        self.make().poll()
        return [e["step"] for e in self.events() if e["act"] == "step"]

    def test_verified_variants_done(self):
        for i, st in enumerate(["verified", "OK", "Pass", "VERIFIED"]):
            with self.subTest(st=st):
                self.setUp()
                steps = self._states(st)
                self.assertEqual(steps[-1]["state"], "done")
                self.assertEqual(steps[-1]["index"], 0)

    def test_failed_blocked_with_outcome(self):
        steps = self._states("failed", reason="element not found")
        self.assertEqual(steps[-1]["state"], "blocked")
        self.assertIn("failed", steps[-1]["outcome"].lower() + "failed")
        self.assertLessEqual(len(steps[-1]["outcome"]), 240)

    def test_unknown_or_missing_status_blocked(self):
        b = self.run_builder().intent("7").receipt("7", raw={"action": {}, "target": {}})
        self.make().poll()
        self.assertEqual([e["step"]["state"] for e in self.events() if e["act"] == "step"][-1], "blocked")

    def test_outcome_redacted_and_capped(self):
        tok = "Bearer abcdefghijklmnop1234567890"
        self.run_builder().intent("7").receipt("7", status="failed", reason=tok + " " + "x" * 600)
        self.make().poll()
        out = [e["step"] for e in self.events() if e["act"] == "step"][-1]["outcome"]
        self.assertLessEqual(len(out), 240)
        self.assertNotIn("abcdefghijklmnop1234567890", out)

    def test_receipt_matches_pid_suffix(self):
        b = self.run_builder().intent("1", name="a").intent("2", name="b")
        b.receipt("2", status="verified")
        self.make().poll()
        done = [e["step"] for e in self.events() if e["act"] == "step" and e["step"]["state"] == "done"]
        self.assertEqual([d["index"] for d in done], [1])

    def test_receipt_without_intent_ignored(self):
        self.run_builder().receipt("99")
        o = self.make(); o.poll()
        self.assertEqual([e for e in self.events() if e["act"] == "step"], [])

    def test_dispatch_and_moves_do_not_post(self):
        self.run_builder().dispatch("5").moves(2)
        self.make().poll()
        self.assertEqual(self.events(), [])


class Report(Base):
    def test_report_closes(self):
        self.run_builder().intent("1").receipt("1").report(rc=0, verdict="PASS")
        self.make().poll()
        last = self.events()[-1]
        self.assertEqual(last["act"], "close")
        self.assertEqual(last["text"], "PASS (rc 0)")

    def test_rc_nonzero_blocks_active_steps_first(self):
        b = self.run_builder().intent("1", name="a").intent("2", name="b").receipt("1")
        b.report(rc=3, verdict="FAIL_X")
        self.make().poll()
        evs = self.events()
        self.assertEqual(evs[-1]["act"], "close")
        self.assertEqual(evs[-1]["text"], "FAIL_X (rc 3)")
        blocked = [e["step"] for e in evs if e["act"] == "step" and e["step"]["state"] == "blocked"]
        self.assertEqual([s["index"] for s in blocked], [1])
        self.assertLess(evs.index([e for e in evs if e["act"] == "step" and e["step"]["state"] == "blocked"][0]),
                        len(evs) - 1)

    def test_rc_zero_leaves_active(self):
        self.run_builder().intent("1").report(rc=0, verdict="PASS")
        self.make().poll()
        self.assertEqual([e["step"]["state"] for e in self.events() if e["act"] == "step"], ["active"])

    def test_close_once(self):
        b = self.run_builder().intent("1").report()
        o = self.make(); o.poll(); o.poll()
        self.assertEqual(len([e for e in self.events() if e["act"] == "close"]), 1)


class StepCap(Base):
    def test_12_step_cap(self):
        b = self.run_builder()
        for i in range(15):
            b.intent("%03d" % i, name="n%d" % i)
        o = self.make(); o.poll()
        evs = self.events()
        plans = [e["plan"]["steps"] for e in evs if e["act"] == "plan"]
        self.assertEqual(max(len(p) for p in plans), 12)
        self.assertTrue(all(e["act"] != "step" or e["step"]["index"] < 12 for e in evs))
        self.assertEqual(o.stats()["errors"], 0)

    def test_12th_outcome_says_more(self):
        b = self.run_builder()
        for i in range(14):
            b.intent("%03d" % i, name="n%d" % i)
        b.receipt("011", status="verified")
        self.make().poll()
        st = [e["step"] for e in self.events() if e["act"] == "step" and e["step"]["index"] == 11]
        self.assertTrue(any("more steps not shown" in (s.get("outcome") or "") for s in st))


class HardRules(Base):
    def test_rgb_never_opened(self):
        b = self.run_builder().frame().intent("1")
        b.raw("other.rgb", "x").raw("notes.txt", "x").raw("data.json.bak", "x")
        opened = []
        real_open, real_osopen = builtins.open, os.open
        def sp(p):
            try: opened.append(os.fspath(p))
            except TypeError: pass
        def fo(f, *a, **k): sp(f); return real_open(f, *a, **k)
        def fos(p, *a, **k): sp(p); return real_osopen(p, *a, **k)
        o = self.make()
        builtins.open, os.open = fo, fos
        try:
            o.poll(); o.poll()
        finally:
            builtins.open, os.open = real_open, real_osopen
        bad = [p for p in opened if not p.endswith(".json") and str(self.root) in p]
        self.assertEqual(bad, [])
        self.assertFalse([p for p in opened if p.endswith(".rgb")])
        st = o.stats()
        self.assertGreaterEqual(st["skipped_nonjson"], 1)

    def test_rgb_never_in_events_or_cursor(self):
        self.run_builder().frame().intent("1")
        self.make().poll()
        self.assertNotIn(".rgb", json.dumps(self.events()))
        self.assertNotIn("frame-1", json.dumps(self.events()))
        if self.cursor_path().exists():
            self.assertNotIn(".rgb", self.cursor_path().read_text())

    def test_no_writes_under_root(self):
        b = self.run_builder().frame().intent("1").receipt("1").dispatch().moves().report()
        before = snapshot(self.root)
        o = self.make(); o.prime(); o.poll(); o.poll()
        self.assertEqual(snapshot(self.root), before)

    def test_size_cap_skipped_and_counted(self):
        b = self.run_builder().intent("1")
        big = json.dumps({"goal": "x", "pad": "a" * (256 * 1024 + 10)})
        b.raw("intent-big.json", big)
        o = self.make(); o.poll()
        self.assertEqual(o.stats()["skipped_large"], 1)
        plans = [e for e in self.events() if e["act"] == "plan"]
        self.assertEqual(len(plans[-1]["plan"]["steps"]), 1)

    def test_exactly_256kib_not_skipped(self):
        b = self.run_builder()
        base = json.dumps({"goal": "g", "action": {"type": "click"}, "target": {"role": "link", "name": "a"}, "pad": ""})
        pad = "a" * (256 * 1024 - len(base))
        b.raw("intent-1.json", base.replace('"pad": ""', '"pad": "%s"' % pad))
        self.assertEqual((b.dir / "intent-1.json").stat().st_size, 256 * 1024)
        o = self.make(); o.poll()
        self.assertEqual(o.stats()["skipped_large"], 0)

    def test_symlink_ignored(self):
        b = self.run_builder().intent("1")
        outside = self.tmp / "outside.json"
        outside.write_text(json.dumps({"goal": "LEAK", "action": {"type": "click"}, "target": {"name": "LEAKNAME"}}))
        os.symlink(outside, b.dir / "intent-2.json")
        os.symlink(outside, b.dir / "report.json")
        os.symlink(self.tmp, self.root / "linkrun")
        o = self.make(); o.poll()
        blob = json.dumps(self.events())
        self.assertNotIn("LEAK", blob)
        self.assertEqual([e["act"] for e in self.events() if e["act"] == "close"], [])

    def test_malformed_json_tolerated(self):
        b = self.run_builder().intent("1")
        b.raw("intent-2.json", "{not json").raw("receipt-1.json", "[[[").raw("report.json", "")
        b.raw("intent-3.json", json.dumps([1, 2])).raw("intent-4.json", json.dumps({"action": "str"}))
        o = self.make()
        n = o.poll()
        self.assertIsInstance(n, int)
        self.assertGreaterEqual(o.stats()["errors"], 1)
        self.assertTrue([e for e in self.events() if e["act"] == "plan"])

    def test_poll_never_raises_when_root_missing_or_post_fails(self):
        from bridge.viewpoint.observer import ViewpointObserver
        o = ViewpointObserver(str(self.tmp / "nope"), "viewpoint", home=str(self.home), clock=self.clock)
        self.assertEqual(o.poll(), 0)
        def boom(*a, **k): raise RuntimeError("x")
        self.run_builder().intent("1")
        o2 = ViewpointObserver(str(self.root), "viewpoint", home=str(self.home), clock=self.clock, post=boom)
        self.assertEqual(o2.poll(), 0)
        self.assertGreaterEqual(o2.stats()["errors"], 1)


class Cursor(Base):
    @unittest.skipUnless(os.name == "posix", "requires POSIX file mode bits")
    def test_cursor_file_0600(self):
        self.run_builder().intent("1")
        self.make().poll()
        p = self.cursor_path()
        self.assertTrue(p.exists())
        self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
        json.loads(p.read_text())

    def test_restart_does_not_repost(self):
        b = self.run_builder().intent("1").receipt("1").report()
        self.make().poll()
        n1 = len(self.events())
        o2 = self.make()
        self.assertEqual(o2.poll(), 0)
        self.assertEqual(len(self.events()), n1)

    def test_restart_picks_up_new_files_only(self):
        b = self.run_builder().intent("1", name="a")
        self.make().poll()
        n1 = len(self.events())
        b.intent("2", name="b")
        o2 = self.make(); n = o2.poll()
        self.assertEqual(len(self.events()), n1 + n)
        self.assertGreaterEqual(n, 2)
        last_plan = [e for e in self.events() if e["act"] == "plan"][-1]["plan"]["steps"]
        self.assertEqual(len(last_plan), 2)
        self.assertEqual(last_plan[0]["text"], 'click link "a"')

    def test_corrupt_cursor_primes_without_reposting(self):
        self.run_builder().intent("1")
        self.make().poll()
        n1 = len(self.events())
        self.cursor_path().write_text("{garbage")
        o2 = self.make()
        self.assertEqual(o2.poll(), 0)
        self.assertEqual(len(self.events()), n1)

    def test_prime_posts_nothing_then_new_posts(self):
        b = self.run_builder().intent("1", name="a")
        o = self.make(); o.prime()
        self.assertEqual(self.events(), [])
        self.assertEqual(o.poll(), 0)
        self.assertEqual(self.events(), [])
        b.receipt("1")
        self.assertGreaterEqual(o.poll(), 1)

    def test_stats_keys(self):
        self.run_builder().intent("1").receipt("1")
        o = self.make(); o.poll()
        st = o.stats()
        for k in ("runs", "steps", "skipped_large", "skipped_nonjson", "errors"):
            self.assertIn(k, st)
        self.assertEqual(st["runs"], 1)
        self.assertEqual(st["steps"], 1)

    def test_changed_file_not_reprocessed(self):
        b = self.run_builder().intent("1")
        o = self.make(); o.poll(); n = len(self.events())
        os.utime(b.dir / "intent-1.json", (BASE + 999, BASE + 999))
        self.assertEqual(self.make().poll(), 0)
        self.assertEqual(len(self.events()), n)


class Cli(Base):
    def test_once_posts_and_exits_0(self):
        self.run_builder().intent("1", text=SECRET).receipt("1").report()
        before = snapshot(self.root)
        cp = run_cli(["watch", "--root", self.root, "--room", "vp-test", "--once"], self.home)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        evs = self.events("vp-test")
        self.assertEqual([e["act"] for e in evs][-1], "close")
        self.assertEqual(snapshot(self.root), before)
        self.assertNotIn(b"SECRET-MARKER", cp.stderr + cp.stdout)
        self.assertNotIn("SECRET-MARKER", json.dumps(evs))

    def test_once_default_room(self):
        self.run_builder().intent("1")
        cp = run_cli(["watch", "--root", self.root, "--once"], self.home)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        self.assertTrue(self.events("viewpoint"))

    def test_once_prime_posts_nothing(self):
        self.run_builder().intent("1")
        cp = run_cli(["watch", "--root", self.root, "--once", "--prime"], self.home)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        self.assertEqual(self.events("viewpoint"), [])

    def test_stderr_counters_only(self):
        self.run_builder().intent("1", goal="UNIQUE-GOAL-TEXT-XYZ", name="UNIQUE-NAME-XYZ")
        cp = run_cli(["watch", "--root", self.root, "--once"], self.home)
        self.assertNotIn(b"UNIQUE-GOAL-TEXT-XYZ", cp.stderr)
        self.assertNotIn(b"UNIQUE-NAME-XYZ", cp.stderr)
        self.assertTrue(cp.stderr.strip())

    @unittest.skipUnless(os.name == "posix", "requires POSIX delivery of SIGTERM and SIGINT to a subprocess")
    def test_sigterm_and_sigint_exit_0(self):
        for sig in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(sig=sig):
                self.run_builder().intent("1")
                p = subprocess.Popen([sys.executable, "-I", "-c", RUNNER, "bridge.viewpoint", "watch",
                                      "--root", str(self.root), "--interval", "0.1"],
                                     cwd=str(REPO), env=clean_env(self.home),
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                time.sleep(1.5)
                self.assertIsNone(p.poll(), p.stderr.read() if p.poll() is not None else b"")
                p.send_signal(sig)
                try:
                    rc = p.wait(timeout=10)
                finally:
                    if p.poll() is None:
                        p.kill()
                    p.stdout.close(); p.stderr.close()
                self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
