"""A gap after a contiguous cursor must create new stale-work attention."""
from pathlib import Path
from unittest import mock

from bridge.tests.room.c3 import support


class SinceGapTests(support.SnapshotCase):
    def setUp(self):
        self.enterContext(mock.patch.object(
            support, "HERE", Path(__file__).resolve().parent))
        super().setUp()

    def test_since_keeps_stale_attention_from_a_post_cursor_gap(self):
        self.life(agent="w1", harness="codex")
        # A real assignment needs an open plan before the task.add event.
        self.plan()
        task_id = self.task(owner="w1")
        self.projection()
        prefix, _ = self.snapshot()
        since = prefix["cursor"]
        self.assertEqual(since, 3)
        self.assertEqual(prefix["freshness"], "current")
        self.assertTrue(prefix["complete"])
        self.assertEqual(prefix["attention"], [])
        self.assertEqual(prefix["agents"]["rows"][0]["current"]["task_id"], task_id)

        later = self.event(agent="observer", act="heartbeat", text="After the gap")
        later["lamport"] += 1
        self.flush()
        self.assertEqual([event["lamport"] for event in self.events], [1, 2, 3, 5])
        self.projection()

        full, _ = self.snapshot()
        delta, _ = self.snapshot(since=since)
        self.assertEqual(delta["freshness"], "stale")
        self.assertFalse(delta["complete"])
        # A-C3c: A gap without completions preserves the caller's watermark.
        self.assertEqual(delta["head_lamport"], 5)
        self.assertEqual(delta["cursor"], since)
        self.assertEqual(delta["agents"], full["agents"])
        self.assertEqual(delta["agents"]["rows"][0]["state"], "unknown")
        stale = next(row for row in full["attention"] if row["id"] == "stale:w1")
        self.assertEqual(stale["task_id"], task_id)
        self.assertIn(stale, delta["attention"],
                      "A post-cursor gap must not suppress new stale-work attention")
