import os, unittest
from bridge.room import store
from . import support as S


class PrimePoll(S.Base):
    def post(self, room, text, agent="agent-a", act="question", **kw):
        return store.post(room, agent, act, text, home=self.home, **kw)

    def test_prime_then_only_new_events(self):
        r = self.relay()
        self.post("demo", "old1")
        self.post("demo", "old2")
        self.assertIsNone(r.prime())
        self.assertEqual(r.poll(), 0)
        self.assertEqual(self.send.frames, [])
        e = self.post("demo", "fresh")
        self.assertEqual(r.poll(), 1)
        f = self.send.frames[0]
        self.assertEqual(set(f), {"t", "v", "room", "floor", "event"})
        self.assertEqual((f["t"], f["v"], f["room"], f["floor"]), ("room_event", 1, "demo", "ONLY_ON_DEVICE"))
        self.assertEqual(f["event"], e)
        self.assertEqual(r.poll(), 0, "no duplicates on the next poll")
        self.assertEqual(len(self.send.frames), 1)

    def test_order_ascending_and_count(self):
        r = self.relay()
        r.prime()
        for i in range(5):
            self.post("demo", "m%d" % i)
        self.assertEqual(r.poll(), 5)
        lams = [f["event"]["lamport"] for f in self.send.frames]
        self.assertEqual(lams, sorted(lams))
        self.assertEqual(len(set(lams)), 5)

    def test_cursor_per_room_and_floor_per_tier(self):
        r = self.relay(rooms=(("alpha", "private"), ("beta", "standard")))
        r.prime()
        self.post("alpha", "a1")
        self.assertEqual(r.poll(), 1)
        self.post("beta", "b1")
        self.post("beta", "b2")
        self.assertEqual(r.poll(), 2)
        self.assertEqual(r.poll(), 0)
        got = [(f["room"], f["floor"], f["event"]["text"]) for f in self.send.frames]
        self.assertEqual(got, [("alpha", "ONLY_ON_DEVICE", "a1"), ("beta", "PREFER_ON_DEVICE", "b1"),
                               ("beta", "PREFER_ON_DEVICE", "b2")])

    def test_prime_is_per_room_max_lamport(self):
        r = self.relay(rooms=(("alpha", "private"), ("beta", "private")))
        for _ in range(3):
            self.post("alpha", "x")
        r.prime()
        self.post("beta", "first-in-beta")  # beta lamport (2) is below alpha's max (4): still new
        self.assertEqual(r.poll(), 1)
        self.assertEqual(self.send.frames[0]["room"], "beta")

    def test_room_not_in_allow_list_ignored(self):
        r = self.relay()
        self.make_room("other")
        r.prime()
        self.post("other", "invisible")
        self.assertEqual(r.poll(), 0)

    def test_room_created_after_prime(self):
        r = self.relay(create=False)
        r.prime()
        self.assertEqual(r.poll(), 0)
        self.make_room("demo")
        self.assertEqual(r.poll(), 1)
        self.assertFalse(os.path.exists(os.path.join(self.home, "rooms", "other")))

    def test_poll_never_creates_directories(self):
        r = self.relay(create=False)
        r.prime()
        r.poll()
        self.assertEqual(os.listdir(self.home), [])

    def test_malformed_lines_skipped_not_fatal(self):
        r = self.relay()
        r.prime()
        S.write_raw(self.home, "demo", [], raw_lines=[b"{not json\n", b"\xff\xfe\n", b"[1,2]\n",
                                                          b'{"id":"x"}\n'])
        self.assertEqual(r.poll(), 0)
        e = self.post("demo", "after garbage")
        self.assertEqual(r.poll(), 1)
        self.assertEqual(self.send.frames[-1]["event"]["id"], e["id"])

    def test_events_file_is_a_directory_never_raises(self):
        r = self.relay(create=False)
        d = os.path.join(self.home, "rooms", "demo", "events.jsonl")
        os.makedirs(d)
        self.assertIsNone(r.prime())
        self.assertEqual(r.poll(), 0)

    def test_unreadable_room_dir_never_raises(self):
        r = self.relay(create=False)
        os.makedirs(os.path.join(self.home, "rooms"))
        open(os.path.join(self.home, "rooms", "demo"), "w").close()  # a file, not a dir
        r.prime()
        self.assertEqual(r.poll(), 0)

    def test_send_failure_never_raises(self):
        r = self.relay()
        r.prime()
        self.post("demo", "x")
        self.send.fail = True
        try:
            r.poll()
        except Exception as e:  # noqa: BLE001
            self.fail("poll raised %r" % (e,))

    def test_residue_event_dropped_counted_cursor_advances(self):
        r = self.relay()
        r.prime()
        self.post("demo", "will be residue")
        with S.patched_redact(S.residue_redact):
            self.assertEqual(r.poll(), 0)
        self.assertEqual(self.send.frames, [])
        self.assertEqual(r.stats()["dropped_residue"], 1)
        self.assertEqual(r.poll(), 0, "dropped event is not retried")
        self.assertEqual(r.stats()["dropped_residue"], 1)

    def test_frame_over_cap_dropped_and_counted(self):
        r = self.relay()
        r.prime()
        big = S.event(2, act="question", text="big",
                      evidence=[{"path": "/tmp/" + "a" * 10000, "sha256": "0" * 64} for _ in range(8)])
        S.write_raw(self.home, "demo", [big])
        self.assertEqual(r.poll(), 0)
        self.assertEqual(self.send.frames, [])
        self.assertEqual(r.stats()["dropped_oversize"], 1)
        self.post("demo", "normal after")
        self.assertEqual(r.poll(), 1)
        self.assertEqual(r.stats()["dropped_oversize"], 1)
        self.assertEqual(r.stats()["events_sent"], 1)

    def test_frame_just_under_cap_is_sent(self):
        import json
        r = self.relay()
        r.prime()
        base = S.event(2, act="question", text="x", evidence=[{"path": "/", "sha256": "0" * 64}])
        frame = {"t": "room_event", "v": 1, "room": "demo", "floor": "ONLY_ON_DEVICE", "event": base}
        # size the single path so the compact frame is at most FRAME_MAX
        slack = 65536 - len(json.dumps(frame, separators=(",", ":"), ensure_ascii=False).encode())
        base["evidence"][0]["path"] = "/" + "a" * (slack - 100)
        S.write_raw(self.home, "demo", [base])
        self.assertEqual(r.poll(), 1)
        self.assertLessEqual(len(json.dumps(self.send.frames[0], separators=(",", ":"),
                                            ensure_ascii=False).encode()), 65536)
