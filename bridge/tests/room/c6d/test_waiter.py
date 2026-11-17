"""Effective dispositions and nonempty filters across public transports."""
from pathlib import Path
from unittest import mock

from bridge.room import app, store
from bridge.room.ext import waiter
from bridge.tests.room.c6 import support


class WaiterDebts(support.RoomCase):
    def setUp(self):
        with mock.patch.object(support, "HERE", Path(__file__).parent):
            super().setUp()

    def test_ignored_terminal_is_not_returned_but_accepted_terminal_is(self):
        self.life(agent="ignored", state="finished")
        self.life(agent="accepted", state="failed")
        fold = waiter.fold_plan

        def dispositions(events, *, _observe, **kwargs):
            def observe(event, projection, disposition):
                if event["agent"] == "ignored":
                    disposition = {"ignored": True}
                _observe(event, projection, disposition)
            return fold(events, _observe=observe, **kwargs)

        with mock.patch.object(waiter, "fold_plan", side_effect=dispositions):
            output = self.direct_wait()
        self.assertEqual([row["agent"] for row in output["events"]], ["accepted"])
        self.assertEqual(output["cursor"], self.events()[-1]["lamport"])

    def test_explicit_empty_filters_fail_before_waiting(self):
        self.require_waiter()
        for field in ("agents", "states"):
            with self.subTest(field=field):
                with self.assertRaises(store.RoomError) as caught:
                    app.dispatch("wait_agents", {"room": "demo", field: []})
                self.assertEqual(caught.exception.code, "bad_args")
                self.assertEqual(self.clock.now, 0)

    def test_mcp_rejects_empty_filters(self):
        self.require_waiter()
        for field in ("agents", "states"):
            with self.subTest(field=field):
                response, data = self.mcp_call("wait_agents", {"room": "demo", field: []})
                self.assertTrue(response.get("isError"))
                self.assertEqual(data["code"], "bad_args")
                self.assertEqual(self.clock.now, 0)

    def test_cli_rejects_empty_filters(self):
        self.require_waiter()
        for field in ("agents", "states"):
            with self.subTest(field=field):
                code, data, _ = self.cli_call("wait_agents", {"room": "demo", field: []})
                self.assertNotEqual(code, 0)
                self.assertEqual(data["code"], "bad_args")
                self.assertEqual(self.clock.now, 0)

    def test_filter_schemas_require_at_least_one_item(self):
        properties = self.require_waiter()["inputSchema"]["properties"]
        for field in ("agents", "states"):
            with self.subTest(field=field):
                self.assertEqual(properties[field].get("minItems"), 1)

    def test_unrelated_appends_preserve_wait_results_and_cursor(self):
        self.life()
        self.clock.later(0.2, lambda: store.post("demo", "speaker", "verdict", "progress"))
        self.clock.later(0.4, lambda: self.life(state="finished", result={"verdict": "OK"}))
        reply = self.direct_wait(since_lamport=1, timeout_s=1)
        self.assert_wait_rows(reply, self.terminals())
        self.assertEqual(reply, self.direct_wait(since_lamport=1))

    def test_full_journal_replay_cost_is_documented(self):
        guide = (Path(__file__).resolve().parents[4] / "docs/WAIT_AGENTS.md").read_text()
        self.assertIn("full journal", guide)
        self.assertIn("unrelated", guide)
