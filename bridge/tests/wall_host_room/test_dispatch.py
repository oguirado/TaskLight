import struct, time, unittest
from . import support as S

SYNC = {"t": "room_sync", "v": 1, "rid": "r1", "since": {"demo": 0}}
POST = {"t": "room_post", "v": 1, "rid": "r2", "room": "demo", "act": "question", "text": "hi"}


def handled_ok(self_, frame):
    return 0


class Dispatch(S.Base):
    def up(self, handle=handled_ok):
        fake = self.patch_room(S.make_fake(handle=handle))
        h = self.start()
        self.hello(h)
        return fake, h

    def test_room_frames_reach_handle_and_are_not_rejected(self):
        fake, h = self.up()
        h.send(SYNC)
        h.send(POST)
        time.sleep(0.5)
        self.assertEqual(fake.instances[0].handled, [SYNC, POST])
        self.assertTrue(h.alive_for(0.2))
        self.assertEqual(self.bye_rc(h), 0)

    def test_handled_zero_does_not_mean_bye(self):
        fake, h = self.up()
        h.send(SYNC)
        self.assertTrue(h.alive_for(0.6))
        h.send({"t": "ping", "v": 1})
        self.assertTrue(h.alive_for(0.2))
        self.assertEqual(self.bye_rc(h), 0)

    def test_handle_two_is_fatal_rc2(self):
        fake, h = self.up(handle=lambda s, f: 2)
        h.send(SYNC)
        self.assertEqual(h.wait(), 2)

    def test_handle_none_falls_through_to_strict_check(self):
        for frame in ({"t": "room_sync", "v": 1}, dict(SYNC)):
            with self.subTest(frame=frame):
                self.setUp()
                fake, h = self.up(handle=lambda s, f: None)
                h.send(frame)
                self.assertEqual(h.wait(), 2)
                self.assertEqual(len(fake.instances[0].handled), 1)

    def test_dispatch_is_before_strict_tv_check(self):
        # a frame with keys beyond {t,v} is only legal because handle claimed it
        fake, h = self.up()
        h.send(POST)
        time.sleep(0.4)
        self.assertEqual(len(fake.instances[0].handled), 1)
        self.assertTrue(h.alive_for(0.1))
        self.assertEqual(self.bye_rc(h), 0)

    def test_non_room_extra_keys_still_rc2_and_never_dispatched(self):
        cases = [{"t": "ping", "v": 1, "x": 1}, {"t": "bye", "v": 1, "x": 1}, {"t": "resync", "v": 1, "x": 1},
                 {"t": "hello", "v": 1}, {"t": "event", "v": 1, "payload": {}}, {"t": 5, "v": 1, "x": 1},
                 {"v": 1, "x": 1}, {"t": "roomy", "v": 1, "x": 1}]
        for frame in cases:
            with self.subTest(frame=frame):
                self.setUp()
                fake, h = self.up()  # greedy handle: returns 0 for anything it is given
                h.send(frame)
                self.assertEqual(h.wait(), 2)
                self.assertEqual(fake.instances[0].handled, [])

    def test_plain_frames_unchanged_with_relay(self):
        fake, h = self.up()
        h.send({"t": "ping", "v": 1})
        h.send({"t": "resync", "v": 1})
        self.assertTrue(h.alive_for(0.4))
        self.assertEqual(fake.instances[0].handled, [])
        self.assertEqual(self.bye_rc(h), 0)

    def test_bad_json_and_framing_still_rc2_with_relay(self):
        cases = {"not-json": struct.pack("<I", 3) + b"{{{", "array": struct.pack("<I", 2) + b"[]", "zero-len": struct.pack("<I", 0),
                 "too-big": struct.pack("<I", 65537), "bad-utf8": struct.pack("<I", 2) + b"\xff\xfe"}
        for name, raw in cases.items():
            with self.subTest(case=name):
                self.setUp()
                fake, h = self.up()
                h.send_raw(raw)
                self.assertEqual(h.wait(), 2)
                self.assertEqual(fake.instances[0].handled, [])

    def test_large_room_post_up_to_frame_max_is_dispatched(self):
        fake, h = self.up()
        big = dict(POST, text="a" * 60000)
        h.send(big)
        time.sleep(0.5)
        self.assertEqual(len(fake.instances[0].handled), 1)
        self.assertEqual(len(fake.instances[0].handled[0]["text"]), 60000)
        self.assertEqual(self.bye_rc(h), 0)

    def test_same_buffer_order_room_then_bye_then_fatal_not_reached(self):
        fake, h = self.up()
        h.send_raw(S.W.frame(SYNC) + S.W.frame({"t": "bye", "v": 1}) + struct.pack("<I", 0))
        self.assertEqual(h.wait(), 0)
        self.assertEqual(fake.instances[0].handled, [SYNC])

    def test_room_frame_then_fatal_in_same_buffer_exits_2(self):
        fake, h = self.up()
        h.send_raw(S.W.frame(SYNC) + S.W.frame({"t": "ping", "v": 1, "x": 1}))
        self.assertEqual(h.wait(), 2)
        self.assertEqual(fake.instances[0].handled, [SYNC])

    def test_handle_replies_use_host_stdout(self):
        reply = {"t": "room_synced", "v": 1, "rid": "r1", "room": "demo", "upto": 0, "more": False}

        def handle(self_, frame):
            self_.send(reply)
            return 0
        fake, h = self.up(handle=handle)
        h.send(SYNC)
        self.assertEqual(h.wait_frames(lambda f: f.get("t") == "room_synced"), [reply])
        self.assertEqual(self.bye_rc(h), 0)


if __name__ == "__main__":
    unittest.main()
