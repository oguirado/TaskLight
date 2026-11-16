"""Public transport assertions, including negative controls, without disk journals."""
import copy
import json
import unittest
from unittest.mock import patch

from bridge.wall import room_relay as module
from bridge.plan.fold import fold_plan
from .relay_fixture import (CURRENT_HASH, HISTORICAL_HASH, RelayFixture, fixture,
                            triplet)


class RelayOracle(unittest.TestCase):
    def assert_gap(self, mode, reason):
        rig = RelayFixture(triplet(reason), reason=reason)
        frames = rig.run(mode)
        gap = {"t": "room_gap", "v": 1, "room": "demo", "from_lamport": 8,
               "to_lamport": 8, "reason": reason}
        if mode == "replay":
            gap["rid"] = "replay-1"
        self.assertEqual([f for f in frames if f["t"] == "room_gap"], [gap])
        self.assertEqual([f["t"] for f in frames][:3],
                         ["room_event", "room_gap", "room_event"])
        self.assertEqual([f["event"]["lamport"] for f in frames if f["t"] == "room_event"], [7, 9])
        if mode == "replay":
            self.assertEqual(frames[-1], {"t": "room_synced", "v": 1,
                "rid": "replay-1", "room": "demo", "upto": 9, "more": False})
        return rig

    def test_A3_live_sanitize_gap_precedes_later_event(self):
        self.assert_gap("live", "sanitize_failed")

    def test_A3_replay_sanitize_gap_precedes_later_event_and_terminal(self):
        self.assert_gap("replay", "sanitize_failed")

    def test_A3_live_oversize_gap_precedes_later_event(self):
        self.assert_gap("live", "oversize")

    def test_A3_replay_oversize_gap_precedes_later_event_and_terminal(self):
        self.assert_gap("replay", "oversize")

    def assert_send_failure(self, mode, kind, reason="sanitize_failed"):
        rig = RelayFixture(triplet(reason), reason=reason,
            send_failure=lambda f: f["t"] == kind and
            (kind == "room_gap" or f["event"]["lamport"] == 8))
        rig.run(mode)
        self.assertTrue(any(f["t"] == kind and
            (kind == "room_gap" or f["event"]["lamport"] == 8) for f in rig.attempted),
            "the failed interval must actually be attempted")
        self.assertFalse(any(f["t"] == "room_event" and f["event"]["lamport"] > 7 for f in rig.sent))
        self.assertFalse(any(f["t"] == "room_synced" and f["upto"] > 7 for f in rig.sent))
        rig.sent.clear()
        rig.send_failure = None
        rig.run(mode, since=7, rid="replay-2")
        if mode == "live":
            self.assertEqual(rig.reads[-1], ("demo", 7))
        if kind == "room_gap":
            self.assertEqual(rig.sent[0]["t"], "room_gap")
            self.assertEqual(rig.sent[0]["from_lamport"], 8)
        else:
            self.assertEqual(rig.sent[0]["event"]["lamport"], 8)
        self.assertTrue(any(f["t"] == "room_event" and f["event"]["lamport"] == 9 for f in rig.sent))

    def test_A4_live_failed_gap_stops_and_retries(self):
        self.assert_send_failure("live", "room_gap")

    def test_A4_replay_failed_gap_stops_and_retries(self):
        self.assert_send_failure("replay", "room_gap")

    def test_A4_live_failed_oversize_gap_stops_and_retries(self):
        self.assert_send_failure("live", "room_gap", "oversize")

    def test_A4_replay_failed_oversize_gap_stops_and_retries(self):
        self.assert_send_failure("replay", "room_gap", "oversize")

    def test_A4_live_failed_event_stops_and_retries(self):
        self.assert_send_failure("live", "room_event", None)

    def test_A4_replay_failed_event_stops_and_retries(self):
        self.assert_send_failure("replay", "room_event", None)

    def test_A3_numeric_discontinuity_does_not_invent_loss(self):
        rig = RelayFixture([e for e in triplet() if e["lamport"] != 8])
        frames = rig.run("replay")
        self.assertEqual([f["t"] for f in frames], ["room_event", "room_event", "room_synced"])
        self.assertEqual(frames[-1]["upto"], 9)

    def test_A3_replay_pagination_signals_gap_before_watermark(self):
        rig = RelayFixture(triplet("sanitize_failed"), reason="sanitize_failed")
        with patch.dict(module.ROOM_LIMITS, {"REPLAY_MAX": 2}):
            rig.run("replay")
            self.assertEqual([f["t"] for f in rig.sent], ["room_event", "room_gap", "room_synced"])
            self.assertEqual(rig.sent[-1]["upto"], 8)
            self.assertTrue(rig.sent[-1]["more"])
            rig.sent.clear()
            rig.run("replay", since=8, rid="page-2")
            self.assertEqual(rig.sent[0]["event"]["lamport"], 9)
            self.assertFalse(rig.sent[-1]["more"])

    def test_A3_sparse_failures_never_coalesce_over_accepted_events(self):
        events = triplet()
        events.extend([dict(copy.deepcopy(events[1]), lamport=10, id="e-000000000000000a"),
                       dict(copy.deepcopy(events[2]), lamport=11, id="e-000000000000000b")])
        rig = RelayFixture(events)
        real = module.sanitize_event
        with patch.object(module.store, "read", side_effect=rig.read), patch.object(
                module, "sanitize_event", side_effect=lambda e: None if e["lamport"] in (8, 10) else real(e)):
            rig.relay.poll()
        gaps = [f for f in rig.sent if f["t"] == "room_gap"]
        covered = {n for f in gaps for n in range(f["from_lamport"], f["to_lamport"] + 1)}
        self.assertEqual(covered, {8, 10})
        self.assertEqual([f["event"]["lamport"] for f in rig.sent if f["t"] == "room_event"], [7, 9, 11])

    def test_A2_clean_fixture_folds_to_done_half_progress_and_memory(self):
        data = fixture()
        rig = RelayFixture(data["events"])
        frames = rig.run("replay")
        events = [f["event"] for f in frames if f["t"] == "room_event"]
        self.assertEqual(events, data["events"])
        projection = fold_plan(events, templates={data["template"]["id"]: data["template"]})
        self.assertEqual(projection["tasks"][0]["state"], "done")
        self.assertEqual(projection["rollup"]["progress_pct"], 50)
        self.assertEqual(set(projection["memory"]), {"goal", "decisions"})
        self.assertEqual(projection["rejected"], [])
        self.assertEqual(events[-1]["op"]["evidence"][0]["sha256"], CURRENT_HASH)

    def test_A2_historical_hash_is_a_separate_synthetic_receipt(self):
        data = fixture()
        self.assertNotIn(HISTORICAL_HASH, json.dumps(data["events"]))
        data["events"][-1]["op"]["evidence"][0]["sha256"] = HISTORICAL_HASH
        frames = RelayFixture(data["events"]).run("replay")
        self.assertEqual(frames[-2]["event"]["op"]["evidence"][0]["sha256"], HISTORICAL_HASH)

    def test_A2_structural_hash_exemption_does_not_exempt_ordinary_strings(self):
        ev = copy.deepcopy(fixture()["events"][-1])
        ev["op"]["outcome"] = "contact " + "oracle" + "@" + "example.test"
        clean = module.sanitize_event(ev)
        self.assertIsNotNone(clean)
        self.assertNotIn("oracle" + "@" + "example.test", clean["op"]["outcome"])
        self.assertEqual(clean["op"]["evidence"][0]["sha256"], CURRENT_HASH)

    def test_A8_gap_suppression_negative_control_is_detected(self):
        rig = self.assert_gap("live", "sanitize_failed")
        broken = [f for f in rig.sent if f["t"] != "room_gap"]
        with self.assertRaises(AssertionError):
            self.assertIn("room_gap", [f["t"] for f in broken])


if __name__ == "__main__":
    unittest.main()
