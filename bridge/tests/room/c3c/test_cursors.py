"""Exercise cursor boundaries through the registered room tools."""
from pathlib import Path
from unittest import mock

from bridge.tests.room.c3 import support as snapshot_support
from bridge.tests.room.c6 import support as waiter_support


HERE = Path(__file__).resolve().parent


class SnapshotCursorTests(snapshot_support.SnapshotCase):
    def setUp(self):
        self.enterContext(mock.patch.object(snapshot_support, "HERE", HERE))
        super().setUp()

    def seed_completions(self):
        self.plan()
        task = self.task(owner="worker", micros=2)
        first = self.op("micro.set", agent="worker", micro_id=task + ".M01", state="done")
        second = self.op("micro.set", agent="worker", micro_id=task + ".M02", state="done")
        self.projection()
        return first["lamport"], second["lamport"]

    def seed_budget_pressure(self):
        first, second = self.seed_completions()
        for index in range(4):
            self.event(agent="asker", act="question", text=f"Question {index}: " + "Please review. " * 30)
        return first, second

    def test_truncation_keeps_same_lamport_completions_together_for_next_poll(self):
        first, second = self.seed_budget_pressure()
        full, payload = self.snapshot(max_bytes=65536)
        self.assertEqual([row["lamport"] for row in full["completed_since"]],
                         [first, second, second])
        self.assertEqual(full["cursor"], full["head_lamport"])
        budget = len(snapshot_support.compact(payload).encode("utf-8")) - 1
        page, packed = self.snapshot(max_bytes=budget)
        self.assertFalse(page["complete"])
        self.assertEqual(page["cursor"], first)
        self.assertEqual(page["head_lamport"], full["head_lamport"])
        self.assertEqual(page["omitted"]["completed_since"], 2)
        self.assertEqual(page["completed_since"], full["completed_since"][:1])
        self.assertLessEqual(len(snapshot_support.compact(packed).encode("utf-8")), budget)

        next_page, _ = self.snapshot(since=page["cursor"], max_bytes=budget)
        self.assertEqual(page["completed_since"] + next_page["completed_since"],
                         full["completed_since"])

    def test_no_retained_completions_keeps_the_input_cursor(self):
        first, _ = self.seed_budget_pressure()
        for args, expected in (({}, 0), ({"since": first}, first)):
            with self.subTest(args=args):
                page, _ = self.snapshot(max_bytes=1024, **args)
                self.assertFalse(page["complete"])
                self.assertGreater(page["omitted"]["completed_since"], 0)
                self.assertEqual(page["completed_since"], [])
                self.assertEqual(page["cursor"], expected)

    def test_incomplete_capture_uses_last_completion_even_without_omissions(self):
        _, second = self.seed_completions()
        later = self.event(agent="observer", act="heartbeat")
        later["lamport"] += 1
        self.flush()

        page, _ = self.snapshot()
        self.assertFalse(page["complete"])
        self.assertFalse(any(page["omitted"].values()))
        self.assertEqual(page["head_lamport"], later["lamport"])
        self.assertEqual(page["cursor"], second)


class WaiterCursorTests(waiter_support.RoomCase):
    def setUp(self):
        self.enterContext(mock.patch.object(waiter_support, "HERE", HERE))
        super().setUp()

    def test_ahead_of_head_is_refused_without_waiting_on_both_transports(self):
        for head in (0, 2):
            with self.subTest(head=head):
                if head:
                    self.life(state="finished")
                    self.assertEqual(self.events()[-1]["lamport"], head)
                args = {"room": "demo", "since_lamport": head + 1, "timeout_s": 1}
                response, data = self.mcp_call("wait_agents", args)
                code, cli_data, _ = self.cli_call("wait_agents", args)
                self.assertTrue(response.get("isError"))
                self.assertNotEqual(code, 0)
                self.assertEqual(data, cli_data)
                self.assertEqual(data["code"], "bad_args")
                self.assertEqual(data["detail"], f"since_lamport is ahead of the room head ({head})")
                self.assertEqual(self.clock.calls, 0)

    def test_at_head_still_waits_for_a_new_result(self):
        self.life()
        head = self.events()[-1]["lamport"]
        self.clock.later(0.25, lambda: self.life(state="finished"))
        reply = self.direct_wait(since_lamport=head, timeout_s=1)

        self.assertGreater(self.clock.calls, 0)
        self.assert_wait_rows(reply, self.terminals())
        self.assertEqual(reply["cursor"], head + 1)
