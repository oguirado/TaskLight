"""Non-operation records exercise the inventory observer's type guard."""
from pathlib import Path
from unittest import mock

from bridge.room.ext.inventory import derive_inventory
from bridge.tests.room.c6 import support


class NonOperationInventory(support.RoomCase):
    def setUp(self):
        with mock.patch.object(support, "HERE", Path(__file__).parent):
            super().setUp()

    def assert_preserved(self, value):
        self.life(state="finished", result={"verdict": "OK", "summary": "complete"})
        events = self.events()
        expected = derive_inventory("demo", events, 1800000000000)
        event = {"id": "say-event", "room": "demo", "agent": "speaker", "act": "say",
                 "text": "progress", "lamport": events[-1]["lamport"] + 1,
                 "ts": 1800000000000, "op": value}
        actual = derive_inventory("demo", events + [event], 1800000000000)
        self.assertEqual(actual, expected)
        self.assertEqual(actual["agents"][0]["agent"], "worker")
        self.assertEqual(actual["agents"][0]["last_result"]["verdict"], "OK")

    def test_say_with_null_op_preserves_inventory(self):
        self.assert_preserved(None)

    def test_say_with_list_or_string_op_preserves_inventory(self):
        for value in ([], "not-an-operation"):
            with self.subTest(value=value):
                self.assert_preserved(value)
