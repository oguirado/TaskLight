import importlib, json, time, unittest
from . import support as S

E = importlib.import_module("bridge.wall.emit")


class Construct(S.Base):
    def test_valid_rooms_builds_one_relay_with_rcfg_and_send(self):
        fake = self.patch_room(S.make_fake())
        h = self.start()
        self.hello(h)
        h.wait_frames(lambda f: f.get("t") == "room_hello")
        self.assertEqual(len(fake.instances), 1)
        r = fake.instances[0]
        self.assertEqual(r.rcfg, S.RCFG)
        self.assertTrue(callable(r.send))
        self.assertTrue(fake.load_seen and "rooms" in fake.load_seen[0])
        self.assertEqual(fake.load_seen[0]["rooms"], S.ROOMS_SECTION)
        self.assertEqual(self.bye_rc(h), 0)

    def test_hello_then_room_hello_exact_shape(self):
        self.patch_room(S.make_fake())
        h = self.start()
        fr = h.wait_frames(lambda f: f.get("t") == "room_hello")
        self.assertTrue(fr, "no room_hello")
        names = [f["t"] for f in h.frames()]
        self.assertEqual(names[0], "hello")
        self.assertLess(names.index("hello"), names.index("room_hello"))
        self.assertEqual(fr[0], {"t": "room_hello", "v": 1, "rooms": S.RCFG["rooms"], "agent": "wall-user"})
        self.assertEqual(names.count("room_hello"), 1)
        self.assertEqual(h.frames()[0]["projects"], ["api", "vault"])  # hello unchanged
        self.assertEqual(self.bye_rc(h), 0)

    def test_room_hello_carries_orchestrator_only_when_set(self):
        rc = dict(S.RCFG, orchestrator="lead-1")
        self.patch_room(S.make_fake(), rcfg=rc)
        h = self.start()
        fr = h.wait_frames(lambda f: f.get("t") == "room_hello")
        self.assertTrue(fr)
        self.assertEqual(fr[0], {"t": "room_hello", "v": 1, "rooms": rc["rooms"], "agent": "wall-user",
                                 "orchestrator": "lead-1"})
        self.assertEqual(self.bye_rc(h), 0)

    def test_prime_called_exactly_once_before_any_poll(self):
        fake = self.patch_room(S.make_fake())
        h = self.start()
        h.wait_frames(lambda f: f.get("t") == "room_hello")
        time.sleep(0.4)
        r = fake.instances[0]
        self.assertEqual(r.primes, 1)
        self.assertEqual(r.order[0], "prime")
        self.assertEqual(self.bye_rc(h), 0)

    def test_every_spawn_sends_room_hello(self):
        self.patch_room(S.make_fake())
        for _ in range(2):
            h = self.start()
            self.assertTrue(h.wait_frames(lambda f: f.get("t") == "room_hello"))
            self.assertEqual(self.bye_rc(h), 0)

    def test_relay_send_is_framed_on_stdout(self):
        sent = {"t": "room_event", "v": 1, "room": "demo", "floor": "ONLY_ON_DEVICE",
                "event": {"id": "e-1", "lamport": 1}}
        done = []

        def poll(self_):
            if not done:
                done.append(1)
                self_.send(sent)
            return 1
        self.patch_room(S.make_fake(poll=poll))
        h = self.start()
        self.assertEqual(h.wait_frames(lambda f: f.get("t") == "room_event"), [sent])
        self.assertEqual(self.bye_rc(h), 0)

    def test_oversize_relay_frame_dropped_host_survives(self):
        big = {"t": "room_event", "v": 1, "room": "demo", "floor": "ONLY_ON_DEVICE", "event": {"x": "a" * 70000}}
        ok = {"t": "room_synced", "v": 1, "rid": "r1", "room": "demo", "upto": 0, "more": False}
        n = []

        def poll(self_):
            if not n:
                n.append(1)
                self_.send(big)
                self_.send(ok)
            return 0
        self.patch_room(S.make_fake(poll=poll))
        h = self.start()
        self.assertEqual(h.wait_frames(lambda f: f.get("t") == "room_synced"), [ok])
        self.assertFalse([f for f in h.frames() if f.get("t") == "room_event"])
        self.assertEqual(self.bye_rc(h), 0)

    def test_spool_events_still_flow_with_relay(self):
        cfg = self.cfg()
        self.patch_room(S.make_fake())
        h = self.start(cfg)
        self.hello(h)
        r = E.emit("api", "output", "x", "agent", config=cfg, _clock=S.W.CLOCK)
        self.assertEqual(r["rc"], 0)
        ev = h.wait_frames(lambda f: f.get("t") == "event")
        self.assertTrue(ev)
        self.assertEqual(set(ev[0]), {"t", "v", "projectId", "payload", "floor", "spoolOffset"})
        self.assertEqual(self.bye_rc(h), 0)


class NoRooms(S.Base):
    def test_no_rooms_key_never_builds_relay(self):
        fake = self.patch_room(S.make_fake(), require=False)
        h = self.start(self.cfg(rooms=False))
        f = self.hello(h)
        self.assertEqual(set(f), {"t", "v", "projects"})
        time.sleep(0.4)
        self.assertEqual(fake.instances, [])
        self.assertEqual([x["t"] for x in h.frames()], ["hello"])
        self.assertEqual(self.bye_rc(h), 0)

    def test_invalid_rooms_section_behaves_as_absent(self):
        # judgement call (ORACLE.md): load_room_config -> None means no relay, host starts normally.
        fake = self.patch_room(S.make_fake(), load=lambda cfg: None)
        h = self.start()
        self.hello(h)
        time.sleep(0.4)
        self.assertEqual(fake.instances, [])
        self.assertEqual([x["t"] for x in h.frames()], ["hello"])
        self.assertEqual(self.bye_rc(h), 0)

    def test_no_rooms_room_frame_is_fatal_as_before(self):
        self.patch_room(S.make_fake(), require=False)
        h = self.start(self.cfg(rooms=False))
        self.hello(h)
        h.send({"t": "room_sync", "v": 1, "rid": "r1", "since": {}})
        self.assertEqual(h.wait(), 2)

    def test_control_without_any_patching_no_rooms(self):
        h = self.start(self.cfg(rooms=False))
        self.assertEqual(self.hello(h)["projects"], ["api", "vault"])
        h.send({"t": "ping", "v": 1})
        self.assertTrue(h.alive_for(0.4))
        self.assertEqual(self.bye_rc(h), 0)
        self.assertEqual([x["t"] for x in h.frames()], ["hello"])

    def test_control_load_config_tolerates_rooms_and_unknown_keys(self):
        cfg = self.cfg(zz_unknown={"a": 1})
        data = E.load_config(cfg)
        self.assertIsNotNone(data)
        self.assertEqual(data["rooms"], S.ROOMS_SECTION)
        self.assertEqual(data["zz_unknown"], {"a": 1})


class Resilience(S.Base):
    def test_constructor_raising_does_not_crash_host(self):
        self.patch_room(S.make_fake(ctor_raises=RuntimeError("boom")))
        h = self.start()
        self.hello(h)
        self.assertTrue(h.alive_for(0.4))
        self.assertEqual(self.bye_rc(h), 0)

    def test_prime_raising_does_not_crash_host(self):
        def prime(self_):
            raise OSError("disk")
        fake = self.patch_room(S.make_fake(prime=prime))
        h = self.start()
        self.hello(h)
        self.assertTrue(h.alive_for(0.5))
        self.assertEqual(self.bye_rc(h), 0)
        self.assertEqual(len(fake.instances), 1)

    def test_poll_raising_never_crashes_and_spool_still_flows(self):
        def poll(self_):
            raise ValueError("poll bug")
        cfg = self.cfg()
        fake = self.patch_room(S.make_fake(poll=poll))
        h = self.start(cfg)
        self.hello(h)
        self.assertTrue(h.alive_for(0.6))
        self.assertGreaterEqual(fake.instances[0].polls, 1)
        E.emit("api", "output", "x", "agent", config=cfg, _clock=S.W.CLOCK)
        self.assertTrue(h.wait_frames(lambda f: f.get("t") == "event"))
        self.assertEqual(self.bye_rc(h), 0)

    def test_handle_raising_never_crashes_and_later_frames_work(self):
        def handle(self_, frame):
            if frame.get("rid") == "boom":
                raise KeyError("bug")
            return 0
        fake = self.patch_room(S.make_fake(handle=handle))
        h = self.start()
        self.hello(h)
        h.send({"t": "room_post", "v": 1, "rid": "boom", "room": "demo", "act": "question", "text": "x"})
        h.send({"t": "room_sync", "v": 1, "rid": "ok", "since": {}})
        time.sleep(0.5)
        self.assertEqual([f["rid"] for f in fake.instances[0].handled], ["boom", "ok"])
        self.assertTrue(h.alive_for(0.2))
        self.assertEqual(self.bye_rc(h), 0)


if __name__ == "__main__":
    unittest.main()
