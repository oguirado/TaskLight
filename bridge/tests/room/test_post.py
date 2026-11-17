"""Storage, event shape, validation codes, evidence, permissions, cap, Lamport."""
import hashlib, json, os, re, stat, unittest

from bridge.room import store
from bridge.room.store import RoomError
from .support import (RoomCase, BASE_TS, canon, events_path, room_dir, seed, mk_event,
                      popen_py, file_events, clean_env)


class Shape(RoomCase):
    def test_event_shape_and_canonical_line(self):
        ev = self.post(text="hello ñ→日本")
        self.assertEqual(set(ev), {"id", "lamport", "ts", "room", "agent", "act", "text"})
        self.assertRegex(ev["id"], r"^e-[0-9a-f]{16}$")
        self.assertEqual((ev["lamport"], ev["ts"], ev["room"], ev["agent"], ev["act"]),
                         (1, BASE_TS, "r1", "a1", "heartbeat"))
        raw = events_path(self.home, "r1").read_bytes()
        self.assertTrue(raw.endswith(b"\n"))
        self.assertEqual(raw.count(b"\n"), 1)
        line = raw[:-1].decode("utf-8")
        self.assertEqual(line, canon(json.loads(line)))          # sorted keys, no spaces
        self.assertIn("ñ→日本", line)                             # UTF-8, not \u escapes
        self.assertNotIn("\\u", line)
        self.assertEqual(json.loads(line), ev)

    def test_ids_random_and_unique(self):
        ids = {self.post()["id"] for _ in range(30)}
        self.assertEqual(len(ids), 30)

    def test_lamport_sequence_and_ts_from_clock(self):
        evs = [self.post() for _ in range(5)]
        self.assertEqual([e["lamport"] for e in evs], [1, 2, 3, 4, 5])
        self.assertEqual([e["ts"] for e in evs], [BASE_TS + i for i in range(5)])

    def test_lamport_is_previous_max_plus_one_not_count(self):
        seed(self.home, "r1", [mk_event(7), mk_event(3)], raw_lines=["garbage"])
        self.assertEqual(self.post()["lamport"], 8)

    def test_default_clock_is_epoch_ms(self):
        import time
        ev = self.post(clock=None)
        self.assertIsInstance(ev["ts"], int)
        self.assertLess(abs(ev["ts"] - int(time.time() * 1000)), 5000)

    def test_home_from_env(self):
        old = os.environ.get("CW_HOME")
        os.environ["CW_HOME"] = str(self.home)
        try:
            store.post("r1", "a1", "open", "go", clock=self.clock)
        finally:
            if old is None:
                os.environ.pop("CW_HOME")
            else:
                os.environ["CW_HOME"] = old
        self.assertTrue(events_path(self.home, "r1").exists())

    def test_optional_fields_only_when_given(self):
        q = self.post(act="question", text="why?")
        ev = self.post(act="answer", text="because", re=q["id"], to="a2")
        self.assertEqual(ev["re"], q["id"])
        self.assertEqual(ev["to"], "a2")
        self.assertNotIn("evidence", ev)

    def test_all_acts_accepted(self):
        ids = {}
        for act in ("open", "question", "handoff", "heartbeat", "verdict", "close"):
            ids[act] = self.post(act=act)["id"]
        self.post(act="answer", re=ids["question"])
        self.post(act="ack", re=ids["handoff"])
        self.post(act="plan", plan={"title": "t", "steps": [{"text": "s"}]})
        self.post(act="step", step={"index": 0, "state": "done"})
        self.assertEqual(len(file_events(self.home, "r1")), 10)

    def test_text_boundary_4096_bytes(self):
        self.post(text="a" * 4096)
        self.post(text="é" * 2048)                                # 4096 bytes, 2048 chars
        with self.assertRaises(RoomError) as c:
            self.post(text="a" * 4097)
        self.assertEqual(c.exception.code, "text_too_long")
        with self.assertRaises(RoomError) as c:
            self.post(text="é" * 2049)                            # 4098 bytes but only 2049 chars
        self.assertEqual(c.exception.code, "text_too_long")


class Codes(RoomCase):
    def assertCode(self, code, **kw):
        with self.assertRaises(RoomError) as c:
            self.post(**kw)
        self.assertEqual(c.exception.code, code)
        return c.exception

    def test_refusal_writes_nothing(self):
        self.post()
        before = events_path(self.home, "r1").read_bytes()
        self.assertCode("bad_act", act="nope")
        self.assertCode("text_too_long", text="a" * 5000)
        self.assertEqual(events_path(self.home, "r1").read_bytes(), before)

    def test_bad_room(self):
        for r in ("", "Bad", "-x", "a b", "../x", "a/b", "a" * 49, "é"):
            self.assertCode("bad_room", room=r)
        self.assertFalse((self.home / "rooms").exists() and any((self.home / "rooms").iterdir()))
        self.post(room="a" * 48)
        self.post(room="0-z")

    def test_bad_agent(self):
        for a in ("", "Bad", ".x", "-x", "a b", "a" * 49, "a/b"):
            self.assertCode("bad_agent", agent=a)
        self.assertCode("bad_agent", to="BAD")
        self.post(agent="a" * 48)
        self.post(agent="x.y_z-1", to="b.c")

    def test_bad_act(self):
        for a in ("", "nope", "Open", "post", None):
            self.assertCode("bad_act", act=a)

    def test_error_is_roomerror_with_code_attr(self):
        e = self.assertCode("bad_act", act="zzz")
        self.assertIsInstance(e, Exception)
        self.assertEqual(e.code, "bad_act")

    def test_bad_re(self):
        q = self.post(act="question")
        h = self.post(act="handoff")
        o = self.post(room="r2", act="question")
        self.assertCode("bad_re", act="answer")                              # re required
        self.assertCode("bad_re", act="ack")
        self.assertCode("bad_re", act="answer", re="e-0000000000000000")     # unknown id
        self.assertCode("bad_re", act="answer", re=h["id"])                  # answer must hit question
        self.assertCode("bad_re", act="ack", re=q["id"])                     # ack must hit handoff
        self.assertCode("bad_re", act="answer", re=o["id"])                  # other room
        self.assertCode("bad_re", act="heartbeat", re="e-ffffffffffffffff")  # any act: re must exist
        self.post(act="answer", re=q["id"])
        self.post(act="ack", re=h["id"])
        self.post(act="verdict", re=q["id"])

    def test_bad_plan(self):
        ok = {"title": "T", "steps": [{"text": "s"}]}
        bads = [None, "x", [], {}, {"title": "T"}, {"title": "T", "steps": []},
                {"title": "T", "steps": [{"text": "s"}] * 13}, {"title": "x" * 121, "steps": [{"text": "s"}]},
                {"title": "T", "steps": [{"text": "x" * 81}]},
                {"title": "T", "steps": [{"text": "s", "accept": "x" * 161}]},
                {"title": "T", "steps": ["s"]}, {"title": "T", "steps": [{}]}, {"title": 5, "steps": [{"text": "s"}]}]
        for p in bads:
            self.assertCode("bad_plan", act="plan", plan=p)
        self.assertCode("bad_plan", act="heartbeat", plan=ok)               # plan only for act plan
        self.post(act="plan", plan={"title": "x" * 120, "steps": [{"text": "x" * 80, "accept": "y" * 160}] * 12})
        self.post(act="plan", plan={"title": "T", "steps": [{"text": "s"}]})

    def test_plan_stored_verbatim(self):
        p = {"title": "T", "steps": [{"text": "a", "accept": "b"}, {"text": "c"}]}
        ev = self.post(act="plan", plan=p)
        self.assertEqual(ev["plan"], p)
        self.assertEqual(file_events(self.home, "r1")[0]["plan"], p)

    def test_bad_step(self):
        for s in (None, "x", {}, {"index": 0}, {"state": "done"}, {"index": -1, "state": "done"},
                  {"index": "0", "state": "done"}, {"index": 0, "state": "finished"},
                  {"index": 0, "state": "done", "outcome": "x" * 241},
                  {"index": 0, "state": "done", "took": "x" * 33}):
            self.assertCode("bad_step", act="step", step=s)
        self.assertCode("bad_step", act="heartbeat", step={"index": 0, "state": "done"})
        for st in ("done", "active", "blocked", "pending"):
            ev = self.post(act="step", step={"index": 0, "state": st})
            self.assertEqual(ev["step"]["state"], st)
        ev = self.post(act="step", step={"index": 3, "state": "done", "outcome": "o" * 240, "took": "t" * 32})
        self.assertEqual(ev["step"], {"index": 3, "state": "done", "outcome": "o" * 240, "took": "t" * 32})


class Evidence(RoomCase):
    def test_hash_and_shape(self):
        p = self.make_file("a.txt", b"abc")
        ev = self.post(evidence=[str(p)])
        self.assertEqual(ev["evidence"], [{"path": str(p), "sha256": hashlib.sha256(b"abc").hexdigest()}])
        self.assertEqual(file_events(self.home, "r1")[0]["evidence"], ev["evidence"])

    def test_eight_ok_nine_refused(self):
        ps = [str(self.make_file("f%d.txt" % i, b"%d" % i)) for i in range(9)]
        ev = self.post(evidence=ps[:8])
        self.assertEqual(len(ev["evidence"]), 8)
        with self.assertRaises(RoomError) as c:
            self.post(evidence=ps)
        self.assertEqual(c.exception.code, "bad_evidence")

    def refuse(self, path):
        n = len(file_events(self.home, "r1"))
        with self.assertRaises(RoomError) as c:
            self.post(evidence=[str(path)])
        self.assertEqual(c.exception.code, "bad_evidence", str(path))
        self.assertEqual(len(file_events(self.home, "r1")), n)

    def test_missing_relative_directory(self):
        self.post()
        self.refuse(self.tmp / "nope.txt")
        self.refuse("rel/path.txt")
        self.refuse("note.txt")
        self.refuse(self.tmp)                                   # directory, not regular file

    def test_under_room_root(self):
        self.post()
        self.refuse(events_path(self.home, "r1"))
        inside = room_dir(self.home, "r1") / "extra.txt"
        inside.write_text("x")
        self.refuse(inside)

    def test_credential_like_basenames(self):
        self.post()
        for name in ("token.txt", "my_secret.md", "credentials.json", "Password.txt", ".env",
                     ".env.local", "id_rsa", "auth.json", "API_TOKEN", "SECRET"):
            self.refuse(self.make_file(name))

    def test_credential_check_is_basename_only(self):
        p = self.make_file("ok.txt", b"1", sub="token-dir")
        self.assertEqual(len(self.post(evidence=[str(p)])["evidence"]), 1)

    def test_one_bad_item_refuses_whole_post(self):
        good = self.make_file("g.txt")
        self.post()
        with self.assertRaises(RoomError):
            self.post(evidence=[str(good), str(self.tmp / "missing")])
        self.assertEqual(len(file_events(self.home, "r1")), 1)


class Perms(RoomCase):
    def test_modes(self):
        old = os.umask(0)
        try:
            self.post()
        finally:
            os.umask(old)
        mode = lambda p: stat.S_IMODE(os.stat(p).st_mode)
        self.assertEqual(mode(self.home / "rooms"), 0o700)
        self.assertEqual(mode(room_dir(self.home, "r1")), 0o700)
        self.assertEqual(mode(events_path(self.home, "r1")), 0o600)
        self.assertEqual(mode(room_dir(self.home, "r1") / "events.lock"), 0o600)

    def test_modes_with_permissive_umask_on_second_post(self):
        self.post()
        self.post()
        self.assertEqual(stat.S_IMODE(os.stat(events_path(self.home, "r1")).st_mode), 0o600)


class Cap(RoomCase):
    CAP = 8 * 1024 * 1024

    def fill(self, target):
        """Valid events written directly until the file reaches >= target bytes."""
        lam, size = 0, 0
        path = events_path(self.home, "r1")
        room_dir(self.home, "r1").mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            while size < target:
                lam += 1
                line = (canon(mk_event(lam, text="z" * 4000)) + "\n").encode()
                f.write(line)
                size += len(line)
        return lam

    def test_room_full_refuses_and_never_truncates(self):
        lam = self.fill(self.CAP)
        path = events_path(self.home, "r1")
        before = path.read_bytes()
        with self.assertRaises(RoomError) as c:
            self.post(text="one more")
        self.assertEqual(c.exception.code, "room_full")
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(lam, len(before.splitlines()))

    def test_below_cap_still_accepts(self):
        # A-U121c: heartbeats fit below their ceiling with semantic capacity reserved, M4.
        self.fill(self.CAP - store.SEMANTIC_RESERVE_BYTES - 64 * 1024)
        ev = self.post(text="fits")
        self.assertGreater(ev["lamport"], 1)

    def test_posts_until_full_via_large_text(self):
        # 4 KiB texts through the real API: must hit room_full before 8 MiB + one event.
        txt = "y" * 4096
        n = 0
        with self.assertRaises(RoomError) as c:
            for _ in range(2200):
                self.post(text=txt)
                n += 1
        self.assertEqual(c.exception.code, "room_full")
        self.assertLessEqual(events_path(self.home, "r1").stat().st_size, self.CAP)
        # A-U121c: beat traffic stops before consuming the semantic reserve, M4.
        ceiling = self.CAP - store.SEMANTIC_RESERVE_BYTES
        size = events_path(self.home, "r1").stat().st_size
        self.assertLessEqual(size, ceiling)
        self.assertGreater(n, 1800)
        self.assertLess(ceiling - size, 8192)


class Concurrency(RoomCase):
    def test_lamport_unique_and_monotonic_8_procs(self):
        code = ("from bridge.room import store; a = sys.argv[1]; h = sys.argv[2]\n"
                "for i in range(12):\n store.post('race', a, 'heartbeat', 'n%d' % i, home=h)")
        procs = [popen_py(code, "agent-%d" % i, self.home, home=self.home) for i in range(8)]
        for p in procs:
            out, err = p.communicate(timeout=60)
            self.assertEqual(p.returncode, 0, err.decode())
        evs = file_events(self.home, "race")
        self.assertEqual(len(evs), 96)
        lams = [e["lamport"] for e in evs]
        self.assertEqual(lams, list(range(1, 97)))               # file order == lamport order, no gaps
        self.assertEqual(len({e["id"] for e in evs}), 96)
        raw = events_path(self.home, "race").read_bytes()
        self.assertEqual(raw.count(b"\n"), 96)                   # no interleaved/torn lines


if __name__ == "__main__":
    unittest.main()
