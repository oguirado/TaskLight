"""Repair loop 1 regressions from the cross-family review of U37a (strategy/flights/U37a/REVIEW_1.md)."""
import math, unittest

from . import support as S


class FlakySend(S.Frames):
    def __init__(self, fail_on=1):
        super().__init__()
        self.calls, self.fail_on = 0, fail_on

    def __call__(self, frame):
        self.calls += 1
        if self.calls == self.fail_on:
            raise RuntimeError("send failed")
        return super().__call__(frame)


class R1ReplayNoLoss(S.Base):
    def test_failed_event_send_never_reported_as_synced_past_it(self):
        self.send = FlakySend(fail_on=1)
        r = self.relay(create=False)
        S.write_raw(self.home, "demo", [S.event(i, text="e%d" % i) for i in range(1, 4)])
        r.handle({"t": "room_sync", "v": 1, "rid": "s1", "since": {"demo": 0}})
        synced = self.send.of("room_synced")
        delivered = sorted(f["event"]["lamport"] for f in self.send.of("room_event"))
        # Either no room_synced, or its `upto` never passes an undelivered event.
        for s in synced:
            missing = [l for l in (1, 2, 3) if l not in delivered and l <= s["upto"]]
            self.assertEqual(missing, [], "room_synced upto must not skip an event whose send failed")
        # A retry from the same `since` recovers every event.
        self.send.clear()
        r.handle({"t": "room_sync", "v": 1, "rid": "s2", "since": {"demo": 0}})
        self.assertEqual(sorted(f["event"]["lamport"] for f in self.send.of("room_event")), [1, 2, 3])


class R2NonFiniteClock(S.Base):
    def test_nan_or_inf_clock_never_bypasses_rate_limit(self):
        for bad in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(clock=bad):
                self.send.clear()
                self.clock = lambda: bad  # noqa: E731
                r = self.relay(create=True)
                acks = 0
                for i in range(10):
                    r.handle({"t": "room_post", "v": 1, "rid": "p%d" % i, "room": "demo", "act": "question", "text": "q%d" % i})
                acks = len(self.send.of("room_ack"))
                self.assertLessEqual(acks, 2, "a broken clock must not allow more than POSTS_PER_SEC posts")


if __name__ == "__main__":
    unittest.main()
