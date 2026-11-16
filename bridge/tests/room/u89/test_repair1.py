"""Regressions for room membership and negative journal heads."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from bridge.room import store
from bridge.room.ext.events import handler


class RepairRegression(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.path = self.home / "rooms" / "demo" / "events.jsonl"
        self.path.parent.mkdir(parents=True)
        environment = mock.patch.dict(os.environ, {"CW_HOME": str(self.home)})
        environment.start()
        self.addCleanup(environment.stop)

    def seed(self, *events):
        raw = b"".join((json.dumps(event) + "\n").encode() for event in events)
        self.path.write_bytes(raw)
        parsed, malformed = store._parse_events_bytes(raw)
        self.assertEqual(parsed, list(events))
        self.assertEqual(malformed, 0)
        return raw

    @staticmethod
    def event(room="elsewhere", lamport=1):
        return {"id": "e-0000000000000001", "room": room,
                "agent": "worker-a", "act": "heartbeat", "text": "literal",
                "ts": 1700000000001, "lamport": lamport}

    def request(self, **changes):
        return handler({"room": "demo", "agent": "reader",
                        "after_lamport": 0, **changes})

    def test_foreign_room_record_is_excluded_from_events_and_head(self):
        raw = self.seed(self.event())
        self.assertEqual(self.request(), {
            "events": [], "next_after": 0, "head": 0,
            "has_more": False, "resync": False})
        self.assertEqual(self.path.read_bytes(), raw)

    def test_negative_only_head_resynchronizes_immediately(self):
        raw = self.seed(self.event(room="demo", lamport=-1))
        for wait_ms in (0, 30000):
            with self.subTest(wait_ms=wait_ms), mock.patch(
                    "bridge.room.ext.events.time.sleep",
                    side_effect=AssertionError("resync must not sleep")):
                self.assertEqual(self.request(wait_ms=wait_ms), {
                    "events": [], "next_after": -1, "head": -1,
                    "has_more": False, "resync": True})
        self.assertEqual(self.path.read_bytes(), raw)

    def test_foreign_record_cannot_hide_negative_room_head(self):
        self.seed(self.event(), self.event(room="demo", lamport=-1))
        self.assertEqual(self.request(), {
            "events": [], "next_after": -1, "head": -1,
            "has_more": False, "resync": True})

    def test_foreign_record_cannot_affect_room_pagination(self):
        own = self.event(room="demo", lamport=1)
        self.seed(own, self.event(lamport=2))
        self.assertEqual(self.request(limit=1), {
            "events": [own], "next_after": 1, "head": 1,
            "has_more": False, "resync": False})

    def test_negative_head_is_maximum_in_any_file_order(self):
        for lamports in ((-1, -2), (-2, -1)):
            with self.subTest(lamports=lamports):
                self.seed(*(self.event(room="demo", lamport=value)
                            for value in lamports))
                self.assertEqual(self.request(), {
                    "events": [], "next_after": -1, "head": -1,
                    "has_more": False, "resync": True})

    def test_empty_room_keeps_zero_head(self):
        self.seed()
        self.assertEqual(self.request(), {
            "events": [], "next_after": 0, "head": 0,
            "has_more": False, "resync": False})


if __name__ == "__main__":
    unittest.main()
