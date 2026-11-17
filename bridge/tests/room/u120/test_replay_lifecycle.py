"""A3/A4/A8 with actual U110/U132 journals and executable negative controls."""
import copy
import json
import unittest
from unittest.mock import Mock, patch

from bridge.room import app, store
from .support import HARNESS, PIN_A, PinCase, request

REPLAY = dict(room="demo", agent="executor-b", to="coordinator", act="question",
              text="private-marker", op_id="u120-replay-01")
LIFECYCLE = dict(room="demo", agent="executor-b", state="deployed",
                 run_id="u120-run", op_id="u120-life-01")


class ReplayLifecycleOracle(PinCase):
    def test_unpinned_retry_still_deduplicates(self):
        first = self.dispatch("room_send", copy.deepcopy(REPLAY))
        before = self.journal()
        again = self.dispatch("room_send", copy.deepcopy(REPLAY))
        self.assertEqual(again, first)
        self.assertEqual(self.journal(), before)
        self.assertEqual(len(before[0].splitlines()), 1)

    def test_pinned_retry_refuses_before_receipt_lookup(self):
        first = self.dispatch("room_send", copy.deepcopy(REPLAY))
        handler = Mock(wraps=app.V2_DISPATCH["room_send"])
        with self.no_io_handler("room_send", handler):
            error = self.refusal("room_send", copy.deepcopy(REPLAY))
        handler.assert_not_called()
        self.assertNotIn(first["untrusted"]["id"], str(error))
        self.assertNotIn("private-marker", str(error))

    def test_matching_pinned_retry_still_deduplicates(self):
        args = dict(REPLAY, agent="executor-a")
        first = self.dispatch("room_send", args, PIN_A)
        before = self.journal()
        self.assertEqual(self.dispatch("room_send", args, PIN_A), first)
        self.assertEqual(self.journal(), before)

    def test_harness_real_lifecycle_deploy_without_plan_and_replay(self):
        self.assertIn("agent_lifecycle", app.tool_names(), "U132 integration prerequisite is absent")
        result = self.dispatch("agent_lifecycle", copy.deepcopy(LIFECYCLE), HARNESS)
        self.assertEqual(result, {"untrusted": {"ok": True, "lamport": 1}})
        before = self.journal()
        self.assertEqual(self.dispatch("agent_lifecycle", copy.deepcopy(LIFECYCLE), HARNESS), result)
        self.assertEqual(self.journal(), before)
        self.assertEqual(len(before[0].splitlines()), 1)
        event = json.loads(before[0])
        self.assertEqual(event["agent"], "executor-b")
        self.assertEqual(event["op"]["run_id"], "u120-run")
        self.assertNotIn("pin", event)
        self.assertNotIn("role", event)

    @unittest.skip("A-U120b: finish gate pending U141")
    def test_harness_premature_finished_keeps_u132_conformance(self):
        self.make_plan(assignee="executor-b")
        self.dispatch("agent_lifecycle", copy.deepcopy(LIFECYCLE), HARNESS)
        before = self.journal()
        args = dict(LIFECYCLE, state="finished", op_id="u120-life-finished")
        with self.assertRaises(store.RoomError) as caught:
            self.dispatch("agent_lifecycle", args, HARNESS)
        self.assertEqual(caught.exception.code, "not_conformant")
        self.assertEqual(self.journal(), before)

    def test_harness_preserves_lifecycle_validation(self):
        args = dict(LIFECYCLE, state="unknown")
        with self.assertRaises(store.RoomError) as baseline:
            self.dispatch("agent_lifecycle", args)
        before = self.journal()
        with self.assertRaises(store.RoomError) as pinned:
            self.dispatch("agent_lifecycle", args, HARNESS)
        self.assertEqual(pinned.exception.code, baseline.exception.code)
        self.assertEqual(self.journal(), before)

    def test_harness_preserves_alive_throttle_and_retired_run(self):
        self.dispatch("agent_lifecycle", copy.deepcopy(LIFECYCLE), HARNESS)
        alive = dict(LIFECYCLE, state="alive", op_id="u120-life-alive-1")
        receipt = self.dispatch("agent_lifecycle", alive, HARNESS)
        before = self.journal()
        self.assertEqual(self.dispatch("agent_lifecycle", dict(alive, op_id="u120-life-alive-2"), HARNESS), receipt)
        self.assertEqual(self.journal(), before, "trusted harness bypassed U132 alive throttling")
        current = self.dispatch("agent_lifecycle", dict(LIFECYCLE, run_id="u120-new-run", op_id="u120-new-life-01"), HARNESS)
        before = self.journal()
        with self.assertRaises(store.RoomError) as caught:
            self.dispatch("agent_lifecycle", dict(LIFECYCLE, op_id="u120-retired-01"), HARNESS)
        self.assertEqual(caught.exception.code, "not_conformant")
        self.assertEqual(self.journal(), before)
        self.assertEqual(self.dispatch("agent_lifecycle", dict(alive, op_id="u120-retired-alive"), HARNESS), current)
        self.assertEqual(self.journal(), before)

    def test_control_late_handler_guard_is_detected(self):
        args = dict(room="demo", agent="executor-b", text="working")
        handler = Mock(return_value={})
        def oracle():
            handler.reset_mock()
            self.refusal("post_status", args)
            handler.assert_not_called()
        with self.no_io_handler("post_status", handler):
            oracle()  # Establish nominal detection before mutating anything.
            original = app.dispatch
            def late(name, values, *, pin=None):
                app.LEGACY_DISPATCH[name](values)
                return original(name, values, pin=pin)
            with patch.object(app, "dispatch", late):
                with self.assertRaisesRegex(AssertionError, "called"):
                    oracle()
            self.assertEqual(handler.call_count, 1)

    def test_control_late_replay_guard_is_detected(self):
        self.dispatch("room_send", copy.deepcopy(REPLAY))
        self.refusal("room_send", copy.deepcopy(REPLAY))
        original = app.dispatch
        def late(name, values, *, pin=None):
            events, _ = store.read(values["room"])
            store._op_identity_index(events, values["agent"])
            return original(name, values, pin=pin)
        with patch.object(app, "dispatch", late):
            with self.assertRaisesRegex(AssertionError, "guard was late"):
                self.refusal("room_send", copy.deepcopy(REPLAY))

    def test_control_executor_lifecycle_privilege_is_detected(self):
        self.refusal("agent_lifecycle", copy.deepcopy(LIFECYCLE))
        original = app.dispatch
        def elevated(name, values, *, pin=None):
            return original(name, values, pin=HARNESS if name == "agent_lifecycle" else pin)
        with patch.object(app, "dispatch", elevated):
            with self.assertRaisesRegex(AssertionError, "guard was late|expected RoomError"):
                self.refusal("agent_lifecycle", copy.deepcopy(LIFECYCLE))


def replay_adapter(adapter):
    def test(self):
        first = self.dispatch("room_send", copy.deepcopy(REPLAY))
        before = self.journal()
        handler = Mock(wraps=app.V2_DISPATCH["room_send"])
        with self.no_io_handler("room_send", handler), self.observe() as observed:
            if adapter == "mcp":
                code, out, err, _ = self.mcp([request("room_send", copy.deepcopy(REPLAY))], PIN_A)
                result, payload = self.mcp_payload(out)
                self.assertIs(result["isError"], True)
                self.assertEqual(code, 0)
            else:
                code, out, err, _ = self.cli(["call", "room_send", "--json", json.dumps(REPLAY)], PIN_A)
                self.assertEqual(code, 3)
                payload = self.one_json(out)
        self.assertEqual(err, "")
        self.assertEqual(payload.get("code"), "bad_agent")
        self.assertNotIn("private-marker", out)
        self.assertNotIn(first["untrusted"]["id"], out)
        handler.assert_not_called()
        self.untouched(observed)
        self.assertEqual(self.journal(), before)
    return test


for _adapter in ("mcp", "cli"):
    setattr(ReplayLifecycleOracle, "test_replay_" + _adapter + "_refuses_without_disclosure", replay_adapter(_adapter))


def executor_lifecycle(target, state):
    def test(self):
        handler = Mock(return_value={"ok": True, "lamport": 1})
        args = dict(LIFECYCLE, agent=target, state=state, harness="harness")
        with self.no_io_handler("agent_lifecycle", handler):
            self.refusal("agent_lifecycle", args)
        handler.assert_not_called()
        self.assertFalse(self.home.exists())
    return test


for _target in ("executor-a", "executor-b"):
    for _state in ("deployed", "alive", "finished", "failed"):
        setattr(ReplayLifecycleOracle, "test_executor_lifecycle_" + _target.replace("-", "_") + "_" + _state,
                executor_lifecycle(_target, _state))


def invalid_harness_target(target, omitted=False):
    def test(self):
        args = copy.deepcopy(LIFECYCLE)
        if omitted:
            args.pop("agent")
        else:
            args["agent"] = copy.deepcopy(target)
        handler = Mock(return_value={})
        with self.no_io_handler("agent_lifecycle", handler):
            self.refusal("agent_lifecycle", args, HARNESS)
        handler.assert_not_called()
        self.assertFalse(self.home.exists())
    return test


for _label, _target in (("null", None), ("empty", ""), ("case", "Executor-b"), ("space", "executor-b "),
                        ("path", "../other"), ("bool", True), ("number", 7), ("object", {"agent": "executor-b"})):
    setattr(ReplayLifecycleOracle, "test_harness_invalid_target_" + _label, invalid_harness_target(_target))
ReplayLifecycleOracle.test_harness_missing_target = invalid_harness_target(None, omitted=True)


def legacy_gate(role, gate):
    def test(self):
        pin = dict(agent="executor-a", role=role)
        self.make_plan(assignee="executor-b" if gate == "ownership" else "executor-a", dependency=gate == "dependency")
        if gate == "ownership":
            args = dict(room="demo", agent="executor-a", task_id="T01")
            tool, expected = "task_claim", "claimed_by_other"
        elif gate == "dependency":
            self.dispatch("task_claim", dict(room="demo", agent="executor-a", task_id="T02"))
            args = dict(room="demo", agent="executor-a", id="T02.M01", state="active")
            tool, expected = "microtask_set", "not_conformant"
        else:
            claim = self.dispatch("task_claim", dict(room="demo", agent="executor-a", task_id="T01"))
            # Use a known stale token; it is never guessed as a successful fencing token.
            store.post("demo", "executor-a", "heartbeat", "advance")
            args = dict(room="demo", agent="executor-a", id="T01.M01", state="active", claim_lamport=1)
            # A-U120a: U120 M4/M6 preserve U109 stale-fence precedence.
            tool, expected = "microtask_set", "stale_rev"
        before = self.journal()
        with self.assertRaises(store.RoomError) as caught:
            self.dispatch(tool, args, pin)
        self.assertEqual(caught.exception.code, expected)
        if gate == "dependency":
            self.assertIn("T01", str(caught.exception), "fixture must exercise the prerequisite gate")
        self.assertEqual(self.journal(), before)
    return test


for _role in ("executor", "harness"):
    for _gate in ("ownership", "dependency", "fencing"):
        setattr(ReplayLifecycleOracle, "test_" + _role + "_preserves_u109_" + _gate, legacy_gate(_role, _gate))


def lifecycle_adapter(adapter, role, target):
    def test(self):
        pin = HARNESS if role == "harness" else PIN_A
        args = dict(LIFECYCLE, agent=target)
        before = self.journal()
        handler = Mock(wraps=app.V2_DISPATCH["agent_lifecycle"])
        with self.no_io_handler("agent_lifecycle", handler), self.observe() as observed:
            if adapter == "mcp":
                code, out, err, _ = self.mcp([request("agent_lifecycle", args)], pin)
                result, payload = self.mcp_payload(out)
                self.assertEqual(code, 0)
                self.assertIs(result["isError"], role == "executor")
            else:
                code, out, err, _ = self.cli(["call", "agent_lifecycle", "--json", json.dumps(args)], pin)
                self.assertEqual(code, 3 if role == "executor" else 0)
                payload = self.one_json(out)
        self.assertEqual(err, "")
        if role == "executor":
            self.assertEqual(payload.get("code"), "bad_agent")
            self.untouched(observed)
            handler.assert_not_called()
            self.assertEqual(self.journal(), before)
            self.assertFalse(self.home.exists())
        else:
            handler.assert_called_once()
            self.assertEqual(payload, {"untrusted": {"ok": True, "lamport": 1}})
            replay_before = self.journal()
            if adapter == "mcp":
                code, out, err, _ = self.mcp([request("agent_lifecycle", args)], pin)
                self.assertEqual(self.mcp_payload(out)[1], payload)
            else:
                code, out, err, _ = self.cli(["call", "agent_lifecycle", "--json", json.dumps(args)], pin)
                self.assertEqual(self.one_json(out), payload)
            self.assertEqual((code, err), (0, ""))
            self.assertEqual(self.journal(), replay_before)
    return test


for _adapter in ("mcp", "cli"):
    for _role, _targets in (("harness", ("executor-b",)), ("executor", ("executor-a", "executor-b"))):
        for _target in _targets:
            setattr(ReplayLifecycleOracle, "test_" + _adapter + "_lifecycle_" + _role + "_" + _target.replace("-", "_"),
                    lifecycle_adapter(_adapter, _role, _target))
