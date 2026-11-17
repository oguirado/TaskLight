"""M3-M5: public waiter behavior, stateless cursors and transport redaction."""
import copy
import hashlib
from unittest import mock

from bridge.room import app, mcp, store
from .support import RESULT, RoomCase


class WaitOracle(RoomCase):
    def test_m3_tool_discovery_advertises_the_spec_arguments(self):
        tool = self.require_waiter()
        schema = tool["inputSchema"]
        self.assertEqual(schema["required"], ["room"])
        self.assertTrue({"room", "agents", "parent", "states", "since_lamport", "timeout_s"} <= set(schema["properties"]))

    def test_m3_returns_all_existing_terminals_in_lamport_order(self):
        self.require_waiter()
        self.life(agent="first", state="finished")
        self.life(agent="other", state="alive")
        self.life(agent="second", state="failed")
        self.life(agent="third", state="finished")
        expected = [event for event in self.events() if event["op"]["state"] in ("finished", "failed")]
        before = self.raw()
        data = self.direct_wait()
        self.assert_wait_rows(data, expected)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.clock.now, 0, "existing matches must return immediately")

    def test_m3_never_silently_limits_a_batch_to_the_first_event(self):
        self.require_waiter()
        for i in range(105):
            self.life(agent=f"lane-{i}", state="finished")
        data = self.direct_wait(timeout_s=1)
        self.assert_wait_rows(data, self.terminals())
        self.assertEqual(len(data["events"]), 105)

    def test_m3_since_cursor_is_strictly_exclusive(self):
        self.require_waiter()
        self.life(agent="old", state="finished")
        boundary = self.events()[-1]["lamport"]
        self.life(agent="new", state="failed")
        self.assert_wait_rows(self.direct_wait(since_lamport=boundary), self.terminals()[1:])

    def test_m3_agents_filter_is_an_exact_allowlist(self):
        self.require_waiter()
        for agent in ("worker", "worker-extra", "other"):
            self.life(agent=agent, state="finished")
        self.assert_wait_rows(self.direct_wait(agents=["worker", "other"]), [self.terminals()[0], self.terminals()[2]])

    def test_m3_parent_selects_direct_children_not_grandchildren(self):
        self.require_waiter()
        self.life(agent="child", state="finished", parent_agent="leader", parent_run_id="lead-run")
        self.life(agent="grandchild", state="failed", parent_agent="child", parent_run_id="r1")
        self.life(agent="root", state="finished")
        self.assert_wait_rows(self.direct_wait(parent="leader"), self.terminals()[:1])

    def test_m3_terminal_inherits_parent_from_its_deployment(self):
        self.require_waiter()
        self.life(parent_agent="leader", parent_run_id="p1")
        self.life(state="finished")
        self.assert_wait_rows(self.direct_wait(parent="leader"), self.terminals())

    def test_m3_agents_parent_and_states_filters_intersect(self):
        self.require_waiter()
        self.life(agent="keep", state="failed", parent_agent="leader", parent_run_id="p1")
        self.life(agent="keep-other-parent", state="failed", parent_agent="elsewhere", parent_run_id="p1")
        self.life(agent="drop-state", state="finished", parent_agent="leader", parent_run_id="p1")
        self.life(agent="drop-agent", state="failed", parent_agent="leader", parent_run_id="p1")
        data = self.direct_wait(agents=["keep", "keep-other-parent", "drop-state"], parent="leader", states=["failed"])
        self.assert_wait_rows(data, self.terminals()[:1])

    def test_m3_explicit_states_can_select_nonterminal_lifecycle(self):
        self.require_waiter()
        self.life(agent="ready", state="deployed")
        self.life(agent="live", state="alive")
        self.life(agent="ended", state="finished")
        self.assert_wait_rows(self.direct_wait(states=["deployed", "alive"]),
                              [event for event in self.events() if event["op"]["state"] in ("deployed", "alive")])

    def test_m3_all_runs_of_the_same_agent_remain_waitable(self):
        self.require_waiter()
        self.life(state="finished", run="r1")
        self.life(run="r2")
        self.life(state="failed", run="r2")
        self.assert_wait_rows(self.direct_wait(agents=["worker"]), self.terminals())

    def test_m3_other_acts_do_not_count_as_lifecycle_completions(self):
        self.require_waiter()
        # A-C6o: "status" is not a room act; "verdict" is a valid non-lifecycle act carrying the same text.
        store.post("demo", "speaker", "verdict", "finished", to="worker")
        self.life(state="finished")
        self.assert_wait_rows(self.direct_wait(), self.terminals())

    def test_m3_room_filter_never_returns_another_rooms_completion(self):
        self.require_waiter()
        self.life(agent="other-room", room="elsewhere", state="finished")
        self.life(state="finished")
        self.assert_wait_rows(self.direct_wait(), self.terminals())

    def test_m3_result_and_parent_are_returned_with_the_event(self):
        self.require_waiter()
        self.life(state="finished", parent_agent="leader", parent_run_id="p1", result=RESULT)
        self.assert_wait_rows(self.direct_wait(), self.terminals())

    def test_m3_wait_blocks_until_a_later_matching_event(self):
        self.require_waiter()
        self.life()
        since = self.events()[-1]["lamport"]
        self.clock.later(0.25, lambda: self.life(state="finished"))
        data = self.direct_wait(since_lamport=since, timeout_s=2)
        self.assertGreaterEqual(self.clock.now, 0.25, "wait cannot return before a match exists")
        self.assertLess(self.clock.now, 2, "wait must wake on the match")
        self.assert_wait_rows(data, self.terminals())

    def test_m3_nonmatching_event_does_not_end_the_wait(self):
        self.require_waiter()
        self.life()
        self.clock.later(0.25, lambda: self.life(agent="unrelated", state="failed"))
        self.clock.later(0.5, lambda: self.life(state="finished"))
        data = self.direct_wait(agents=["worker"], since_lamport=1, timeout_s=2)
        self.assertGreaterEqual(self.clock.now, 0.5)
        self.assertLess(self.clock.now, 2)
        self.assert_wait_rows(data, [event for event in self.terminals() if event["agent"] == "worker"])

    def check_timeout(self, options, duration):
        self.require_waiter()
        self.life()
        before = self.raw()
        data = self.direct_wait(since_lamport=1, **options)
        self.assertEqual(data["events"], [])
        self.assertIs(data.get("timed_out"), True)
        self.assertEqual(data["cursor"], 1)
        self.assertAlmostEqual(self.clock.now, duration, places=5, msg="M3 timeout must use the requested virtual deadline")
        self.assertEqual(self.raw(), before)

    def test_m3_default_timeout_is_sixty_virtual_seconds(self):
        self.check_timeout({}, 60)

    def test_m3_minimum_timeout_is_one_virtual_second(self):
        self.check_timeout({"timeout_s": 1}, 1)

    def test_m3_maximum_timeout_is_six_hundred_virtual_seconds(self):
        self.check_timeout({"timeout_s": 600}, 600)

    def test_m3_empty_room_timeout_has_an_empty_stateless_cursor(self):
        self.require_waiter()
        before = self.raw()
        data = self.direct_wait(timeout_s=1)
        self.assertEqual(data["events"], [])
        self.assertEqual(data["cursor"], 0)
        self.assertIs(data.get("timed_out"), True)
        self.assertEqual(self.raw(), before)

    def test_m4_same_cursor_replays_matches_without_consuming_them(self):
        self.require_waiter()
        self.life(state="finished")
        self.life(agent="second", state="failed")
        before = self.raw()
        first = self.direct_wait(since_lamport=0)
        second = self.direct_wait(since_lamport=0)
        self.assert_wait_rows(first, self.terminals())
        self.assertEqual(second, first, "M4 waiting must never consume lifecycle events")
        self.assertEqual(self.raw(), before)

    def test_m4_append_between_calls_is_delivered_using_the_previous_cursor(self):
        self.require_waiter()
        self.life(state="finished")
        first = self.direct_wait(since_lamport=0)
        self.assert_wait_rows(first, self.terminals())
        self.life(agent="next", state="failed")
        self.life(agent="third", state="finished")
        second = self.direct_wait(since_lamport=first["cursor"])
        self.assert_wait_rows(second, self.terminals()[1:])
        self.assertEqual(self.direct_wait(since_lamport=first["cursor"]), second)

    def test_m4_independent_parent_filters_do_not_consume_each_others_events(self):
        self.require_waiter()
        self.life(agent="left", state="finished", parent_agent="parent-a", parent_run_id="p1")
        self.life(agent="right", state="failed", parent_agent="parent-b", parent_run_id="p2")
        self.assert_wait_rows(self.direct_wait(parent="parent-a", since_lamport=0), self.terminals()[:1])
        self.assert_wait_rows(self.direct_wait(parent="parent-b", since_lamport=0), self.terminals()[1:])

    def test_m5_mcp_and_cli_return_identical_wait_data(self):
        self.require_waiter()
        self.life(state="finished", result=RESULT)
        args = {"room": "demo", "since_lamport": 0, "timeout_s": 1}
        response, data = self.mcp_call("wait_agents", args)
        code, cli_data, _ = self.cli_call("wait_agents", args)
        self.assertFalse(response.get("isError", False))
        self.assertEqual(code, 0)
        self.assertEqual(cli_data, data)
        self.assert_wait_rows(data, self.terminals())

    def test_m5_shared_sanitizer_redacts_summary_but_preserves_result_pointers(self):
        self.require_waiter()
        digest = hashlib.sha256(b"c6 public synthetic pointer").hexdigest()
        result = dict(RESULT, summary="password=" + "hunter2-SYNTHETIC",
                      receipt="artifacts/" + digest + ".json",
                      evidence=[{"path": "artifacts/" + digest + ".txt", "sha256": digest}])
        self.life(state="finished", result=result)
        before = self.raw()
        args = {"room": "demo", "since_lamport": 0, "timeout_s": 1}
        with mock.patch.object(mcp, "sanitize_output", wraps=mcp.sanitize_output) as shared:
            response, data = self.mcp_call("wait_agents", args)
        self.assertGreater(shared.call_count, 0, "M5 MCP must use the shared sanitizer")
        self.assertFalse(response.get("isError", False))
        code, cli_data, _ = self.cli_call("wait_agents", args)
        self.assertEqual(code, 0)
        self.assertEqual(data, cli_data)
        actual = data["events"][0]["result"]
        self.assertEqual(actual["summary"], "password=[REDACTED:KEY_ASSIGN]")
        self.assertEqual(actual["receipt"], result["receipt"])
        self.assertEqual(actual["evidence"], result["evidence"])
        self.assertEqual(self.raw(), before, "M5 reads cannot redact stored result bytes")

    def test_m5_legacy_wait_data_is_identical_on_mcp_and_cli(self):
        self.require_waiter()
        self.life(state="failed")
        args = {"room": "demo", "timeout_s": 1}
        response, data = self.mcp_call("wait_agents", args)
        code, cli_data, _ = self.cli_call("wait_agents", args)
        self.assertFalse(response.get("isError", False))
        self.assertEqual(code, 0)
        self.assertEqual(cli_data, data)
        self.assert_wait_rows(data, self.terminals())


def bad_arguments(fields):
    def test(self):
        self.require_waiter()  # Unknown-tool bad_args must never masquerade as validation.
        args = dict(room="demo", **fields)
        before = self.raw()
        with self.assertRaises(store.RoomError) as caught:
            app.dispatch("wait_agents", args)
        self.assertEqual(caught.exception.code, "bad_args")
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.clock.now, 0, "invalid arguments must fail before blocking")
    return test


for _name, _fields in (
    ("unknown_key", {"unexpected": True}),
    ("agents_string", {"agents": "worker"}),
    ("agents_null", {"agents": None}),
    ("agents_nonstring", {"agents": [True]}),
    ("agents_hostile", {"agents": ["../escape"]}),
    ("parent_nonstring", {"parent": {"agent": "leader"}}),
    ("parent_hostile", {"parent": "../escape"}),
    ("states_string", {"states": "finished"}),
    ("states_null", {"states": None}),
    ("states_nonstring", {"states": [True]}),
    ("states_unknown", {"states": ["complete"]}),
    ("cursor_negative", {"since_lamport": -1}),
    ("cursor_boolean", {"since_lamport": True}),
    ("cursor_fractional", {"since_lamport": 0.5}),
    ("cursor_null", {"since_lamport": None}),
    ("cursor_string", {"since_lamport": "0"}),
    ("timeout_zero", {"timeout_s": 0}),
    ("timeout_negative", {"timeout_s": -1}),
    ("timeout_over_limit", {"timeout_s": 601}),
    ("timeout_boolean", {"timeout_s": True}),
    ("timeout_null", {"timeout_s": None}),
    ("timeout_string", {"timeout_s": "60"}),
    ("timeout_nan", {"timeout_s": float("nan")}),
    ("timeout_infinite", {"timeout_s": float("inf")}),
):
    setattr(WaitOracle, "test_m3_bad_args_" + _name, bad_arguments(_fields))
