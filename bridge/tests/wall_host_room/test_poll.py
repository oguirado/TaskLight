import time, unittest
from . import support as S


class Poll(S.Base):
    def test_poll_called_periodically_while_idle(self):
        fake = self.patch_room(S.make_fake())
        h = self.start()
        self.hello(h)
        time.sleep(1.5)
        n = fake.instances[0].polls
        self.assertGreaterEqual(n, 3, "poll called %d times in 1.5 s idle (spec cadence 0.5 s)" % n)
        self.assertEqual(self.bye_rc(h), 0)

    def test_poll_keeps_running_between_inbound_frames(self):
        fake = self.patch_room(S.make_fake(handle=lambda s, f: 0))
        h = self.start()
        self.hello(h)
        time.sleep(0.3)
        a = fake.instances[0].polls
        for _ in range(5):
            h.send({"t": "room_sync", "v": 1, "rid": "r", "since": {}})
            h.send({"t": "ping", "v": 1})
            time.sleep(0.3)
        self.assertGreater(fake.instances[0].polls, a + 2)
        self.assertEqual(self.bye_rc(h), 0)

    def test_poll_sent_frames_appear_in_order(self):
        seq = []

        def poll(self_):
            if len(seq) < 3:
                seq.append(1)
                self_.send({"t": "room_event", "v": 1, "room": "demo", "floor": "ONLY_ON_DEVICE",
                            "event": {"id": "e-%d" % len(seq), "lamport": len(seq)}})
                return 1
            return 0
        self.patch_room(S.make_fake(poll=poll))
        h = self.start()
        time.sleep(1.0)
        ids = [f["event"]["id"] for f in h.frames() if f.get("t") == "room_event"]
        self.assertEqual(ids, ["e-1", "e-2", "e-3"])
        self.assertEqual(self.bye_rc(h), 0)

    def test_no_poll_without_rooms(self):
        fake = self.patch_room(S.make_fake(), require=False)
        h = self.start(self.cfg(rooms=False))
        self.hello(h)
        time.sleep(0.4)
        self.assertEqual(fake.instances, [])
        self.assertEqual(self.bye_rc(h), 0)

    def test_poll_not_called_after_exit(self):
        fake = self.patch_room(S.make_fake())
        h = self.start()
        self.hello(h)
        self.assertEqual(self.bye_rc(h), 0)
        n = fake.instances[0].polls
        time.sleep(0.4)
        self.assertEqual(fake.instances[0].polls, n)


if __name__ == "__main__":
    unittest.main()
