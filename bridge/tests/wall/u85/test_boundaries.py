"""Failure boundaries exercise the actual relay with deterministic dependencies."""
import io
import json
import struct
import unittest
from unittest.mock import patch

from bridge.wall import room_relay as module
from .relay_fixture import CURRENT_HASH, RelayFixture, event, fixture, triplet


class RelayBoundaryOracle(unittest.TestCase):
    def assert_sanitizer_exception_gap(self, mode):
        rig = RelayFixture(triplet())
        real = module.sanitize_event
        sentinel = "synthetic sanitizer exception detail"

        def sanitize(ev):
            if ev["lamport"] == 8:
                raise ValueError(sentinel)
            return real(ev)

        with patch.object(module.store, "read", side_effect=rig.read), patch.object(
                module, "sanitize_event", side_effect=sanitize):
            if mode == "live":
                rig.relay.poll()
            else:
                rig.relay.handle({"t": "room_sync", "v": 1, "rid": "exception-1",
                                  "since": {"demo": 6}})
        gaps = [f for f in rig.sent if f["t"] == "room_gap"]
        expected = dict(t="room_gap", v=1, room="demo", from_lamport=8,
                        to_lamport=8, reason="sanitize_failed")
        if mode == "replay":
            expected["rid"] = "exception-1"
        self.assertEqual(gaps, [expected])
        self.assertEqual([f["t"] for f in rig.sent[:3]],
                         ["room_event", "room_gap", "room_event"])
        self.assertNotIn(sentinel, repr(rig.sent))

    def test_M3_live_sanitizer_exception_emits_content_free_gap(self):
        self.assert_sanitizer_exception_gap("live")

    def test_M3_replay_sanitizer_exception_emits_content_free_gap(self):
        self.assert_sanitizer_exception_gap("replay")

    def assert_later_event_send_failure(self, mode):
        rig = RelayFixture(triplet(), reason="sanitize_failed",
                           send_failure=lambda f: f["t"] == "room_event"
                           and f["event"]["lamport"] == 9)
        rig.run(mode, since=6)
        self.assertEqual([f["t"] for f in rig.sent], ["room_event", "room_gap"])
        self.assertTrue(any(f["t"] == "room_event" and f["event"]["lamport"] == 9
                            for f in rig.attempted))
        self.assertFalse(any(f["t"] == "room_synced" and f["upto"] >= 9
                             for f in rig.sent))
        rig.sent.clear()
        rig.send_failure = None
        rig.run(mode, since=8, rid="retry-later")
        self.assertEqual(rig.reads[-1], ("demo", 8))
        self.assertEqual(rig.sent[0]["t"], "room_event")
        self.assertEqual(rig.sent[0]["event"]["lamport"], 9)
        if mode == "replay":
            self.assertEqual(rig.sent[-1], dict(t="room_synced", v=1,
                rid="retry-later", room="demo", upto=9, more=False))

    def test_M4_live_failure_after_signalled_gap_retries_failed_event(self):
        self.assert_later_event_send_failure("live")

    def test_M4_replay_failure_after_signalled_gap_retries_failed_event(self):
        self.assert_later_event_send_failure("replay")

    def assert_adjacent_intervals(self, mode):
        events = [event(n) for n in (7, 8, 9, 10)]
        rig = RelayFixture(events)
        real = module.sanitize_event

        def sanitize(ev):
            return None if ev["lamport"] in (8, 9) else real(ev)

        with patch.object(module.store, "read", side_effect=rig.read), patch.object(
                module, "sanitize_event", side_effect=sanitize):
            if mode == "live":
                rig.relay.poll()
            else:
                rig.relay.handle({"t": "room_sync", "v": 1, "rid": "adjacent",
                                  "since": {"demo": 6}})
        gaps = [f for f in rig.sent if f["t"] == "room_gap"]
        expected = dict(t="room_gap", v=1, room="demo", from_lamport=8,
                        to_lamport=9, reason="sanitize_failed")
        if mode == "replay":
            expected["rid"] = "adjacent"
        self.assertEqual(gaps, [expected], "Amendment B requires maximal same-reason runs")
        covered = set()
        for gap in gaps:
            self.assertIs(type(gap["from_lamport"]), int)
            self.assertIs(type(gap["to_lamport"]), int)
            self.assertLessEqual(8, gap["from_lamport"])
            self.assertLessEqual(gap["from_lamport"], gap["to_lamport"])
            self.assertLessEqual(gap["to_lamport"], 9)
            covered.update(range(gap["from_lamport"], gap["to_lamport"] + 1))
            expected_keys = {"t", "v", "room", "from_lamport", "to_lamport", "reason"}
            if mode == "replay":
                expected_keys.add("rid")
                self.assertEqual(gap["rid"], "adjacent")
            self.assertEqual(set(gap), expected_keys)
            self.assertEqual(gap["reason"], "sanitize_failed")
        self.assertEqual(covered, {8, 9})
        later = next(i for i, f in enumerate(rig.sent)
                     if f["t"] == "room_event" and f["event"]["lamport"] == 10)
        self.assertTrue(all(i < later for i, f in enumerate(rig.sent)
                            if f["t"] == "room_gap"))
        self.assertEqual([f["event"]["lamport"] for f in rig.sent
                          if f["t"] == "room_event"], [7, 10])

    def test_M3_live_adjacent_exclusions_emit_one_maximal_same_reason_gap(self):
        self.assert_adjacent_intervals("live")

    def test_M3_replay_adjacent_exclusions_emit_one_maximal_same_reason_gap(self):
        self.assert_adjacent_intervals("replay")


    def assert_no_gap_payload(self, mode, reason):
        events = triplet(reason)
        excluded = fixture()["events"][-1]
        if reason == "oversize":
            excluded["text"] = events[1]["text"]
        else:
            excluded["text"] = "excluded event text"
        excluded["op"]["outcome"] = "excluded operation outcome"
        excluded["op"]["evidence"][0]["path"] = "tests/unit/u85/excluded-evidence.md"
        events[1] = excluded
        frames = RelayFixture(events, reason=reason).run(mode, since=6)
        expected = dict(t="room_gap", v=1, room="demo", from_lamport=8,
                        to_lamport=8, reason=reason)
        if mode == "replay":
            expected["rid"] = "replay-1"
        gaps = [f for f in frames if f["t"] == "room_gap"]
        self.assertEqual(gaps, [expected])
        encoded = json.dumps(gaps)
        for forbidden in ("excluded event text", "excluded operation outcome",
                          "excluded-evidence.md", CURRENT_HASH, '"op"',
                          '"text"', '"evidence"', '"exception"'):
            self.assertNotIn(forbidden, encoded)

    def test_M3_live_sanitize_gap_has_no_event_op_or_evidence_payload(self):
        self.assert_no_gap_payload("live", "sanitize_failed")

    def test_M3_replay_sanitize_gap_has_no_event_op_or_evidence_payload(self):
        self.assert_no_gap_payload("replay", "sanitize_failed")

    def test_M3_live_oversize_gap_has_no_event_op_or_evidence_payload(self):
        self.assert_no_gap_payload("live", "oversize")

    def test_M3_replay_oversize_gap_has_no_event_op_or_evidence_payload(self):
        self.assert_no_gap_payload("replay", "oversize")

    def assert_reason_boundary(self, mode):
        events = [event(n) for n in (7, 8, 9, 10)]
        events[2]["text"] = "ordinary words " * 6000
        frames = RelayFixture(events, reason="sanitize_failed").run(mode, since=6)
        expected = [dict(t="room_gap", v=1, room="demo", from_lamport=n,
                         to_lamport=n, reason=reason) for n, reason in
                    ((8, "sanitize_failed"), (9, "oversize"))]
        if mode == "replay":
            for gap in expected:
                gap["rid"] = "replay-1"
        self.assertEqual([f for f in frames if f["t"] == "room_gap"], expected)
        self.assertEqual([f["t"] for f in frames[:4]],
                         ["room_event", "room_gap", "room_gap", "room_event"])

    def test_M3_live_adjacent_different_reasons_remain_separate(self):
        self.assert_reason_boundary("live")

    def test_M3_replay_adjacent_different_reasons_remain_separate(self):
        self.assert_reason_boundary("replay")

    def test_M8_native_host_send_preserves_live_and_replay_gap_fields(self):
        # _send is the actual outbound boundary supplied to RoomRelay. No daemon,
        # spool, journal, pipe, or network is opened by this in-memory check.
        from bridge.wall import native_host
        for replay in (False, True):
            with self.subTest(replay=replay):
                stream = io.BytesIO()
                host = native_host._Host({"spoolDir": ".", "projects": []},
                                         stream, io.StringIO())
                frame = dict(t="room_gap", v=1, room="demo", from_lamport=8,
                             to_lamport=8, reason="sanitize_failed")
                if replay:
                    frame["rid"] = "native-gap"
                self.assertTrue(host._send(frame))
                wire = stream.getvalue()
                size = struct.unpack("<I", wire[:4])[0]
                self.assertEqual(size, len(wire[4:]))
                self.assertEqual(json.loads(wire[4:]), frame)

    def test_M8_hash_exemptions_are_structural_not_key_based(self):
        opened = fixture()["events"][0]
        self.assertEqual(module.sanitize_event(opened)["op"]["template_hash"],
                         opened["op"]["template_hash"])
        completed = fixture()["events"][-1]
        completed["text"] = CURRENT_HASH
        completed["op"]["outcome"] = CURRENT_HASH
        completed["op"]["extra"] = {"sha256": CURRENT_HASH}
        completed["op"]["evidence"][0]["label"] = CURRENT_HASH
        clean = module.sanitize_event(completed)
        self.assertIsNotNone(clean)
        self.assertEqual(clean["op"]["evidence"][0]["sha256"], CURRENT_HASH)
        self.assertNotIn(CURRENT_HASH, clean["text"])
        self.assertNotIn(CURRENT_HASH, clean["op"]["outcome"])
        self.assertNotIn(CURRENT_HASH, clean["op"]["extra"]["sha256"])
        self.assertNotIn(CURRENT_HASH, clean["op"]["evidence"][0]["label"])


if __name__ == "__main__":
    unittest.main()
