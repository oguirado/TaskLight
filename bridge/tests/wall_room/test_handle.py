import os, unittest
from bridge.room import store
from . import support as S


class NonRoomFrames(S.Base):
    def test_non_room_frames_none_and_silent(self):
        r = self.relay()
        for f in ({"t": "hello", "v": 1}, {"t": "event", "v": 1, "event": {}}, {"t": "ping", "v": 1},
                  {"t": "pong"}, {"v": 1}, {}, {"t": 5}, {"t": None}, [], None, "room_sync", 7):
            with self.subTest(frame=f):
                self.assertIsNone(r.handle(f))
        self.assertEqual(self.send.frames, [])
        self.assertEqual(r.stats()["structural"], 0)


class Sync(S.Base):
    def fill(self, room, n, start=1):
        evs = [S.event(i, room=room, text="e%d" % i) for i in range(start, start + n)]
        S.write_raw(self.home, room, evs)

    def sync(self, since, rid="s1", **kw):
        f = {"t": "room_sync", "v": 1, "rid": rid, "since": since}
        f.update(kw)
        return f

    def test_replay_then_synced_with_rid(self):
        r = self.relay(create=False)
        self.fill("demo", 3)
        self.assertEqual(r.handle(self.sync({"demo": 1})), 0)
        fr = self.send.frames
        self.assertEqual([f["t"] for f in fr], ["room_event", "room_event", "room_synced"])
        for f in fr[:2]:
            self.assertEqual(set(f), {"t", "v", "room", "floor", "event", "rid"})
            self.assertEqual((f["v"], f["room"], f["floor"], f["rid"]), (1, "demo", "ONLY_ON_DEVICE", "s1"))
        self.assertEqual([f["event"]["lamport"] for f in fr[:2]], [2, 3])
        self.assertEqual(fr[2], {"t": "room_synced", "v": 1, "rid": "s1", "room": "demo", "upto": 3,
                                 "more": False})

    def test_since_zero_all_and_empty_room(self):
        r = self.relay(create=False)
        self.fill("demo", 2)
        r.handle(self.sync({"demo": 0}))
        self.assertEqual(len(self.send.of("room_event")), 2)
        self.send.clear()
        r.handle(self.sync({"demo": 2}, rid="s2"))
        self.assertEqual([f["t"] for f in self.send.frames], ["room_synced"])
        self.assertEqual(self.send.frames[0]["upto"], 2)
        self.assertFalse(self.send.frames[0]["more"])
        self.assertEqual(self.send.frames[0]["rid"], "s2")

    def test_replay_max_and_more_flag(self):
        self.assertEqual(self.mod().ROOM_LIMITS["REPLAY_MAX"], 500)
        r = self.relay(create=False)
        self.fill("demo", 503)
        self.assertEqual(r.handle(self.sync({"demo": 0})), 0)
        self.assertEqual(len(self.send.of("room_event")), 500)
        syn = self.send.of("room_synced")
        self.assertEqual(len(syn), 1)
        self.assertEqual(self.send.frames[-1], syn[0], "room_synced comes last")
        self.assertTrue(syn[0]["more"])
        self.assertEqual(syn[0]["upto"], 500)
        self.send.clear()
        r.handle(self.sync({"demo": 500}, rid="s2"))
        self.assertEqual(len(self.send.of("room_event")), 3)
        self.assertEqual(self.send.of("room_synced")[0]["more"], False)
        self.assertEqual(self.send.of("room_synced")[0]["upto"], 503)

    def test_exactly_replay_max_is_not_more(self):
        r = self.relay(create=False)
        self.fill("demo", 500)
        r.handle(self.sync({"demo": 0}))
        self.assertEqual(len(self.send.of("room_event")), 500)
        self.assertFalse(self.send.of("room_synced")[0]["more"])

    def test_multi_room_floor_and_unlisted_rooms_skipped(self):
        r = self.relay(rooms=(("alpha", "private"), ("beta", "standard")), create=False)
        self.fill("alpha", 1)
        self.fill("beta", 1)
        self.fill("secret", 1)
        self.assertEqual(r.handle(self.sync({"alpha": 0, "beta": 0, "secret": 0, "ghost": 0})), 0)
        floors = {f["room"]: f["floor"] for f in self.send.of("room_event")}
        self.assertEqual(floors, {"alpha": "ONLY_ON_DEVICE", "beta": "PREFER_ON_DEVICE"})
        self.assertEqual(sorted(f["room"] for f in self.send.of("room_synced")), ["alpha", "beta"])

    def test_replay_does_not_move_live_cursor(self):
        r = self.relay(create=False)
        self.fill("demo", 2)
        r.prime()
        r.handle(self.sync({"demo": 0}))
        self.send.clear()
        self.assertEqual(r.poll(), 0)

    def test_replay_drops_residue(self):
        r = self.relay(create=False)
        self.fill("demo", 2)
        with S.patched_redact(S.residue_redact):
            self.assertEqual(r.handle(self.sync({"demo": 0})), 0)
        self.assertEqual(self.send.of("room_event"), [])
        self.assertEqual(self.send.of("room_synced")[0]["upto"], 2)
        self.assertEqual(r.stats()["dropped_residue"], 2)

    def test_missing_room_dir_synced_empty_and_not_created(self):
        r = self.relay(create=False)
        self.assertEqual(r.handle(self.sync({"demo": 0})), 0)
        self.assertEqual(os.listdir(self.home), [])
        for f in self.send.frames:
            self.assertNotEqual(f["t"], "room_event")

    def test_structural(self):
        r = self.relay()
        base = self.sync({"demo": 0})
        bad = [dict(base, v=2), dict(base, v="1"), {k: v for k, v in base.items() if k != "v"},
               {k: v for k, v in base.items() if k != "rid"}, dict(base, rid=""), dict(base, rid="a b"),
               dict(base, rid="x" * 65), dict(base, rid=5), {k: v for k, v in base.items() if k != "since"},
               dict(base, since=None), dict(base, since=[]), dict(base, since={"demo": "0"}),
               dict(base, since={"demo": -1}), dict(base, since={"demo": 1.5}), dict(base, since={"demo": True}),
               dict(base, since={"demo": None}), dict(base, extra=1)]
        for f in bad:
            with self.subTest(frame=f):
                self.assertEqual(r.handle(f), 2)
        self.assertEqual(self.send.of("room_synced"), [])
        self.assertEqual(r.stats()["structural"], len(bad))

    def test_rid_charset_accepted(self):
        r = self.relay()
        self.assertEqual(r.handle(self.sync({"demo": 0}, rid="Az09_-" + "x" * 58)), 0)
        self.assertEqual(self.send.of("room_synced")[0]["rid"], "Az09_-" + "x" * 58)


class Post(S.Base):
    def test_ack_and_event_written(self):
        r = self.relay()
        self.assertEqual(r.handle(self.post_frame("hello agent", rid="p1")), 0)
        self.assertEqual(len(self.send.frames), 1)
        a = self.send.frames[0]
        evs = self.events_on_disk()
        w = evs[-1]
        self.assertEqual(a, {"t": "room_ack", "v": 1, "rid": "p1", "id": w["id"], "lamport": w["lamport"]})
        self.assertEqual((w["room"], w["agent"], w["act"], w["text"]), ("demo", "wall-user", "question",
                                                                          "hello agent"))
        self.assertNotIn("to", w)
        self.assertNotIn("re", w)
        self.assertEqual(r.stats()["posts_acked"], 1)

    def test_agent_comes_from_config(self):
        r = self.relay(agent="someone-else")
        r.handle(self.post_frame("x"))
        self.assertEqual(self.events_on_disk()[-1]["agent"], "someone-else")

    def test_page_cannot_choose_identity(self):
        r = self.relay()
        n = len(self.events_on_disk())
        for extra in ({"agent": "evil"}, {"from": "evil"}, {"id": "e-0000000000000000"}, {"lamport": 1}):
            with self.subTest(extra=extra):
                self.assertEqual(r.handle(self.post_frame("x", **extra)), 2)
        self.assertEqual(len(self.events_on_disk()), n)

    def test_to_and_re_passed_through(self):
        r = self.relay()
        q = store.post("demo", "agent-a", "question", "which?", home=self.home)
        self.assertEqual(r.handle(self.post_frame("to you", to="orch", re=q["id"])), 0)
        w = self.events_on_disk()[-1]
        self.assertEqual((w["to"], w["re"], w["agent"], w["act"]), ("orch", q["id"], "wall-user", "question"))
        self.assertEqual(self.send.frames[-1]["t"], "room_ack")

    def test_text_boundaries(self):
        r = self.relay()
        self.assertEqual(r.handle(self.post_frame("a" * 4096, rid="ok")), 0)
        self.assertEqual(self.send.frames[-1]["t"], "room_ack")
        self.assertEqual(r.handle(self.post_frame("a" * 4097, rid="long")), 0)
        self.assertEqual(self.send.frames[-1], {"t": "room_nack", "v": 1, "rid": "long", "code": "text_too_long"})
        # 1366 chars * 3 bytes = 4098 bytes: short in characters, long in UTF-8
        self.assertEqual(r.handle(self.post_frame("€" * 1366, rid="mb")), 0)
        self.assertEqual(self.send.frames[-1]["code"], "text_too_long")
        self.assertEqual(r.handle(self.post_frame("€" * 1365 + "a", rid="mb2")), 0)
        self.assertEqual(self.send.frames[-1]["t"], "room_ack")

    def test_empty_and_c0_refused_as_bad_args(self):
        r = self.relay()
        n = len(self.events_on_disk())
        for i, t in enumerate(("", "a\x00b", "bell\x07", "esc\x1b[0m", "\x01")):
            with self.subTest(text=t):
                self.assertEqual(r.handle(self.post_frame(t, rid="c%d" % i)), 0)
                self.assertEqual(self.send.frames[-1], {"t": "room_nack", "v": 1, "rid": "c%d" % i,
                                                        "code": "bad_args"})
        self.assertEqual(len(self.events_on_disk()), n)

    def test_unicode_text_accepted(self):
        r = self.relay()
        r.handle(self.post_frame("café \U0001f600 über"))
        self.assertEqual(self.events_on_disk()[-1]["text"], "café \U0001f600 über")

    def test_room_not_allowed_unknown_room(self):
        r = self.relay()
        self.make_room("other")
        n = len(self.events_on_disk("other"))
        for room in ("other", "nope", "../demo", "DEMO", "", "x" * 60):
            with self.subTest(room=room):
                self.assertEqual(r.handle(self.post_frame("x", rid="n1", room=room)), 0)
                self.assertEqual(self.send.frames[-1], {"t": "room_nack", "v": 1, "rid": "n1",
                                                        "code": "room_not_allowed"})
        self.assertEqual(len(self.events_on_disk("other")), n)

    def test_allowed_room_without_directory_not_created(self):
        r = self.relay(create=False)
        self.assertEqual(r.handle(self.post_frame("x", rid="n2")), 0)
        self.assertEqual(self.send.frames[-1], {"t": "room_nack", "v": 1, "rid": "n2", "code": "room_not_allowed"})
        self.assertEqual(os.listdir(self.home), [], "no rooms/ tree may be created from the page")

    def test_room_path_is_a_file_not_allowed(self):
        r = self.relay(create=False)
        os.makedirs(os.path.join(self.home, "rooms"))
        open(os.path.join(self.home, "rooms", "demo"), "w").close()
        self.assertEqual(r.handle(self.post_frame("x")), 0)
        self.assertEqual(self.send.frames[-1]["code"], "room_not_allowed")

    def test_u33_error_codes_forwarded(self):
        r = self.relay()
        n = len(self.events_on_disk())
        cases = [({"re": "e-ffffffffffffffff"}, "bad_re"), ({"to": "Bad Agent!"}, "bad_agent")]
        for extra, code in cases:
            with self.subTest(code=code):
                self.assertEqual(r.handle(self.post_frame("x", rid="u1", **extra)), 0)
                self.assertEqual(self.send.frames[-1], {"t": "room_nack", "v": 1, "rid": "u1", "code": code})
        self.assertEqual(len(self.events_on_disk()), n)

    def test_u33_room_error_raised_by_store_becomes_nack(self):
        r = self.relay()
        err = store.RoomError("room_full", "cap")
        mod = __import__("bridge.room.store", fromlist=["store"])
        from unittest import mock
        with mock.patch.object(mod, "post", side_effect=err):
            self.assertEqual(r.handle(self.post_frame("x", rid="f1")), 0)
        self.assertEqual(self.send.frames[-1], {"t": "room_nack", "v": 1, "rid": "f1", "code": "room_full"})

    def test_rate_limit_two_per_second(self):
        self.assertEqual(self.mod().ROOM_LIMITS["POSTS_PER_SEC"], 2)
        r = self.relay()
        n = len(self.events_on_disk())
        for i in range(2):
            self.assertEqual(r.handle(self.post_frame("m%d" % i, rid="a%d" % i)), 0)
            self.assertEqual(self.send.frames[-1]["t"], "room_ack")
        self.assertEqual(r.handle(self.post_frame("m3", rid="a3")), 0)
        self.assertEqual(self.send.frames[-1], {"t": "room_nack", "v": 1, "rid": "a3", "code": "rate_limited"})
        self.assertEqual(len(self.events_on_disk()), n + 2)
        self.clock.advance(2.0)
        self.assertEqual(r.handle(self.post_frame("m4", rid="a4")), 0)
        self.assertEqual(self.send.frames[-1]["t"], "room_ack")
        self.assertEqual(r.stats()["posts_acked"], 3)
        self.assertEqual(r.stats()["posts_refused"], 1)

    def test_rate_limit_is_global_not_per_room(self):
        r = self.relay(rooms=(("alpha", "private"), ("beta", "private")))
        r.handle(self.post_frame("1", rid="g1", room="alpha"))
        r.handle(self.post_frame("2", rid="g2", room="beta"))
        r.handle(self.post_frame("3", rid="g3", room="alpha"))
        self.assertEqual([f["t"] for f in self.send.frames], ["room_ack", "room_ack", "room_nack"])
        self.assertEqual(self.send.frames[-1]["code"], "rate_limited")

    def test_structural(self):
        r = self.relay()
        n = len(self.events_on_disk())
        base = self.post_frame("x")
        drop = lambda k: {a: b for a, b in base.items() if a != k}  # noqa: E731
        bad = [dict(base, v=2), dict(base, v="1"), drop("v"), drop("rid"), drop("room"), drop("text"), drop("act"),
               dict(base, rid=""), dict(base, rid="a b"), dict(base, rid=5), dict(base, room=5),
               dict(base, room=None), dict(base, text=5), dict(base, text=None), dict(base, text=["x"]),
               dict(base, to=5), dict(base, re=5), dict(base, act="answer"), dict(base, act="plan"),
               dict(base, act=None), dict(base, extra="x"), dict(base, evidence=[])]
        for f in bad:
            with self.subTest(frame=f):
                self.assertEqual(r.handle(f), 2)
        self.assertEqual(len(self.events_on_disk()), n)
        self.assertEqual(r.stats()["structural"], len(bad))
        self.assertEqual(self.send.of("room_ack"), [])

    def test_to_and_re_null_treated_as_absent_or_structural_never_crash(self):
        r = self.relay()
        rc = r.handle(self.post_frame("x", to=None))
        self.assertIn(rc, (0, 2))


class Stats(S.Base):
    def test_initial_and_counters(self):
        r = self.relay()
        st = r.stats()
        for k in ("events_sent", "dropped_residue", "dropped_oversize", "posts_acked", "posts_refused",
                  "structural"):
            self.assertEqual(st[k], 0, k)
        r.prime()
        store.post("demo", "agent-a", "question", "q", home=self.home)
        r.poll()
        r.handle(self.post_frame("x"))
        r.handle(self.post_frame("x", room="nope", rid="z"))
        r.handle({"t": "room_post"})
        st = r.stats()
        self.assertEqual((st["events_sent"], st["posts_acked"], st["posts_refused"], st["structural"]),
                         (1, 1, 1, 1))

    def test_stats_is_a_snapshot_of_ints_only(self):
        r = self.relay()
        st = r.stats()
        self.assertIsInstance(st, dict)
        for k, v in st.items():
            self.assertIsInstance(k, str)
            self.assertIsInstance(v, int, k)
        st["events_sent"] = 99
        self.assertEqual(r.stats()["events_sent"], 0)
