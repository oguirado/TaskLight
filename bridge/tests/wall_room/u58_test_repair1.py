"""U58 repair-1 regression: second-pass redactor validation (REVIEW HOLD item 1).

Fails against the pre-fix _redact_str, which (a) never type-checked the second
redact() result and (b) used truthiness (`if residue_count`) instead of an
equality check against zero, so falsey invalid counts (None, "") passed.
"""
import unittest
from unittest import mock

from bridge.wall import room_relay as relay
from . import support as S

HOME = str(S.REPO / ".unit" / "u58-in-memory-home")  # Never created or accessed.


def op_event(lamport=1, **fields):
    # A-R52LG: Supply the required task.add fields for checked reads.
    payload = {"kind": "task.add", "title": "clean", "op_id": "repair_0001",
               "type": "unit", "phase": "build"}
    return S.event(lamport, act="op", op=payload, **fields)


def bad_second_result(text, _disable=frozenset()):
    """Second redact() call returns a non-str; count stays 0."""
    if text == "trigger":
        return "masked", 1, []
    if text == "masked":
        return 42, 0, []
    return text, 0, []


def bad_residue_none_all(text, _disable=frozenset()):
    """Every call reports a None residue count (never equals zero)."""
    return text, None, []


def bad_residue_none_trigger(text, _disable=frozenset()):
    """Only 'trigger' reports a None residue count; everything else is clean."""
    if text == "trigger":
        return text, None, []
    return text, 0, []


def bad_residue_empty_trigger(text, _disable=frozenset()):
    """Only 'trigger' reports an '' residue count; everything else is clean."""
    if text == "trigger":
        return text, "", []
    return text, 0, []


class RepairHarness(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.reads = []

        def read(room, since=0, *, home=None):
            self.reads.append((room, since))
            return [e for e in reversed(self.events)
                    if e["room"] == room and e["lamport"] > since], 0

        # A-R52LG: Prime, live poll and replay now consume the checked reader.
        patch = mock.patch.object(relay.store, "read_checked", side_effect=read)
        patch.start()
        self.addCleanup(patch.stop)
        self.send = S.Frames()
        self.rcfg = relay.load_room_config(S.rcfg_dict(rooms=(("demo", "standard"),)))
        self.assertIsNotNone(self.rcfg)
        self.r = relay.RoomRelay(self.rcfg, self.send, home=HOME, clock=S.Clock())
        self.r.prime()

    def sync(self, since=0):
        return self.r.handle({"t": "room_sync", "v": 1, "rid": "r1", "since": {"demo": since}})

    def assert_drop_both_routes(self, event, redactor):
        """Live + replay: 0 frames, dropped_residue==1, cursor advances."""
        for mode in ("poll", "sync"):
            with self.subTest(mode=mode), S.patched_redact(redactor):
                self.events[:] = [event]
                self.send.clear()
                self.r = relay.RoomRelay(self.rcfg, self.send, home=HOME, clock=S.Clock())
                result = self.r.poll() if mode == "poll" else self.sync()
                self.assertEqual(result, 0)
                self.assertEqual(self.send.of("room_event"), [])
                self.assertEqual(self.r.stats()["dropped_residue"], 1)
                self.assertEqual(self.r.stats()["events_sent"], 0)
                if mode == "sync":
                    self.assertEqual(self.send.of("room_synced"), [
                        {"t": "room_synced", "v": 1, "rid": "r1", "room": "demo",
                         "upto": event["lamport"], "more": False}])
                # Poisoned event must not stall progress: a clean successor
                # in the same room is still delivered on the same route.
                self.events.append(op_event(event["lamport"] + 1))
                self.send.clear()
                if mode == "sync":
                    self.assertEqual(self.sync(event["lamport"]), 0)
                    self.assertEqual(self.r.stats()["dropped_residue"], 1)
                else:
                    self.assertEqual(self.r.poll(), 1)
                    self.assertEqual(self.reads[-1], ("demo", event["lamport"]))
                    self.assertEqual(self.r.stats()["dropped_residue"], 1)
                self.assertEqual([f["event"]["lamport"] for f in self.send.of("room_event")],
                                 [event["lamport"] + 1])


class SecondPassValidation(RepairHarness):
    def test_sanitize_nonstring_second_result(self):
        event = op_event()
        event["op"]["title"] = "trigger"
        with S.patched_redact(bad_second_result):
            self.assertIsNone(relay.sanitize_event(event))

    def test_sanitize_none_residue_count_all(self):
        event = op_event()
        event["op"]["title"] = "clean"
        with S.patched_redact(bad_residue_none_all):
            self.assertIsNone(relay.sanitize_event(event))

    def test_sanitize_none_residue_trigger(self):
        event = op_event()
        event["op"]["title"] = "trigger"
        with S.patched_redact(bad_residue_none_trigger):
            self.assertIsNone(relay.sanitize_event(event))

    def test_sanitize_empty_residue_trigger(self):
        event = op_event()
        event["op"]["title"] = "trigger"
        with S.patched_redact(bad_residue_empty_trigger):
            self.assertIsNone(relay.sanitize_event(event))

    def test_sanitize_nonstring_second_result_dict_key(self):
        event = op_event()
        event["op"]["brief"] = {"trigger": "clean"}
        with S.patched_redact(bad_second_result):
            self.assertIsNone(relay.sanitize_event(event))

    def test_live_and_sync_nonstring_second_result(self):
        event = op_event()
        event["op"]["title"] = "trigger"
        self.assert_drop_both_routes(event, bad_second_result)

    def test_live_and_sync_none_residue(self):
        event = op_event()
        event["op"]["title"] = "trigger"
        self.assert_drop_both_routes(event, bad_residue_none_trigger)

    def test_live_and_sync_empty_residue(self):
        event = op_event()
        event["op"]["title"] = "trigger"
        self.assert_drop_both_routes(event, bad_residue_empty_trigger)


if __name__ == "__main__":
    unittest.main()
