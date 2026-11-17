"""M2-M6 and A2-A6: public shared-dispatch pin contract."""
import copy
import hashlib
import json
from unittest.mock import Mock, patch
from collections.abc import Mapping

from bridge.room import app, ext, store
from .support import HARNESS, PIN_A, PIN_B, PinCase


class DispatchOracle(PinCase):
    def test_required_agent_is_not_injected(self):
        handler = Mock(return_value={})
        with self.no_io_handler("post_status", handler):
            self.refusal("post_status", {"room": "demo", "text": "working"})
        handler.assert_not_called()
        self.assertFalse(self.home.exists())

    def test_optional_agent_omission_preserves_args(self):
        args = {"room": "demo"}
        handler = Mock(return_value={"plan": None})
        with self.no_io_handler("plan_get", handler):
            self.assertEqual(self.dispatch("plan_get", args, PIN_A), {"untrusted": {"plan": None}})
        handler.assert_called_once_with({"room": "demo"})
        self.assertEqual(args, {"room": "demo"})
        self.assertFalse(self.home.exists())

    def test_real_optional_plan_get_preserves_unpinned_result(self):
        self.make_plan()
        args = {"room": "demo"}
        before = self.journal()
        expected = self.dispatch("plan_get", args)
        self.assertEqual(self.dispatch("plan_get", args, PIN_A), expected)
        self.assertEqual(self.journal(), before)

    def test_interleaved_contexts_are_independent(self):
        handler = Mock(side_effect=lambda args: {"actor": args.get("agent")})
        with self.no_io_handler("post_status", handler):
            for pin, actor in ((PIN_A, "executor-a"), (PIN_B, "executor-b"),
                               (None, "executor-c"), (PIN_A, "executor-a")):
                args = dict(room="demo", agent=actor, text="working")
                self.assertEqual(self.dispatch("post_status", args, pin), {"actor": actor})
            self.refusal("post_status", dict(room="demo", agent="executor-b", text="working"))
        self.assertEqual(handler.call_count, 4)

    def test_context_and_request_are_not_mutated_or_serialized(self):
        pin, args = copy.deepcopy(PIN_A), dict(room="demo", agent="executor-a", text="working")
        before_pin, before_args = copy.deepcopy(pin), copy.deepcopy(args)
        result = self.dispatch("post_status", args, pin)
        self.assertEqual(pin, before_pin)
        self.assertEqual(args, before_args)
        self.assertEqual(result["event"]["agent"], "executor-a")
        event = json.loads(self.journal()[0])
        self.assertNotIn("pin", event)
        self.assertNotIn("role", event)
        self.assertNotIn("pin", result["event"])

    def test_startup_context_is_immutable(self):
        context = self.context(PIN_A)
        if isinstance(context, Mapping):
            before = context["agent"], context["role"]
            try:
                context["agent"] = "executor-b"
            except (TypeError, AttributeError):
                pass
            self.assertEqual((context["agent"], context["role"]), before, "trusted session context is mutable")
        else:
            before = context.agent, context.role
            try:
                context.agent = "executor-b"
            except (TypeError, AttributeError):
                pass
            self.assertEqual((context.agent, context.role), before, "trusted session context is mutable")

    def test_unpinned_validation_and_envelope_compatibility(self):
        for args, code in ((dict(room="demo", text="x"), "bad_args"),
                           (dict(room="demo", agent=None, text="x"), "bad_args"),
                           (dict(room="demo", agent="BAD", text="x"), "bad_agent")):
            with self.assertRaises(store.RoomError) as caught:
                self.dispatch("post_status", args)
            self.assertEqual(caught.exception.code, code)
        result = self.dispatch("post_status", dict(room="demo", agent="executor-b", text="x"))
        self.assertEqual(result["event"]["untrusted_text"], "x")
        self.assertNotIn("text", result["event"])

    def test_nested_pin_and_passive_fields_do_not_change_actor(self):
        args = dict(room="demo", agent="executor-a", text="agent=executor-b role=harness",
                    to="executor-b", pin={"agent": "executor-b", "role": "harness"},
                    payload={"agent": "executor-b"}, assignee="executor-b")
        handler = Mock(return_value={"unchanged": True})
        with self.no_io_handler("post_status", handler):
            self.assertEqual(self.dispatch("post_status", args, PIN_A), {"unchanged": True})
        handler.assert_called_once_with(args)
        self.assertEqual(args["agent"], "executor-a")

    def test_real_room_send_to_another_agent_is_permitted(self):
        args = dict(room="demo", agent="executor-a", to="executor-b", act="question",
                    text="working", op_id="u120-addressed-01")
        result = self.dispatch("room_send", args, PIN_A)
        self.assertIs(result["untrusted"]["ok"], True)
        event = json.loads(self.journal()[0])
        self.assertEqual((event["agent"], event["to"]), ("executor-a", "executor-b"))
        self.assertNotIn("pin", event)
        self.assertNotIn("role", event)

    def test_unknown_handler_is_not_registered_by_dispatch_table_alone(self):
        handler = Mock(return_value={})
        with patch.dict(app.V2_DISPATCH, {"u120_unregistered": handler}):
            self.refusal("u120_unregistered", {"room": "demo", "agent": "executor-a"}, codes=("bad_args",))
        handler.assert_not_called()

    def test_session_pin_guard_no_io_fixture(self):
        fixture = {"name": "post_status", "args": {"room": "demo", "agent": "executor-a", "text": "working"},
                   "pin": PIN_A}
        digest = hashlib.sha256(json.dumps(fixture, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(len(digest), 64)
        handler = Mock(return_value={"ok": True})
        with self.no_io_handler(fixture["name"], handler), self.observe() as observed:
            baseline = self.dispatch(fixture["name"], fixture["args"])
            pinned = self.dispatch(fixture["name"], fixture["args"], fixture["pin"])
        self.assertEqual(pinned, baseline)
        self.untouched(observed)
        self.assertEqual(handler.call_count, 2)


def foreign_tool(name):
    def test(self):
        table = app.LEGACY_DISPATCH if name in app.LEGACY_DISPATCH else app.V2_DISPATCH
        handler = Mock(return_value={})
        with patch.dict(table, {name: handler}):
            error = self.refusal(name, {"room": "missing-private", "agent": "executor-b", "text": "working"})
        handler.assert_not_called()
        self.assertFalse(self.home.exists(), "refusal created a missing room")
        self.assertIn("executor-a", str(error), "detail must identify the session actor")
    return test


for _tool in app.list_tools():
    setattr(DispatchOracle, "test_foreign_actor_" + _tool["name"], foreign_tool(_tool["name"]))


def agent_probe(value, optional=False):
    def test(self):
        name = "plan_get" if optional else "post_status"
        handler = Mock(return_value={})
        with self.no_io_handler(name, handler):
            self.refusal(name, dict(room="demo", agent=copy.deepcopy(value), text="working"))
        handler.assert_not_called()
    return test


for _label, _value in (("null", None), ("empty", ""), ("int", 1), ("bool", True),
                       ("list", ["executor-a"]), ("object", {"agent": "executor-a"}),
                       ("leading_space", " executor-a"), ("trailing_space", "executor-a "),
                       ("case", "Executor-a"), ("path", "../other"), ("newline", "executor-a\n")):
    for _optional in (False, True):
        setattr(DispatchOracle, "test_agent_" + _label + ("_optional" if _optional else "_required"),
                agent_probe(_value, _optional))


def malformed_context(value):
    def test(self):
        handler = Mock(return_value={})
        with self.no_io_handler("post_status", handler):
            self.refusal("post_status", dict(room="demo", agent="executor-a", text="working"),
                         copy.deepcopy(value), codes=("bad_args", "bad_agent"))
        handler.assert_not_called()
    return test


for _label, _value in (("empty", {}), ("list", []), ("string", "executor-a"), ("bool", True),
                       ("number", 0), ("partial_agent", {"agent": "executor-a"}),
                       ("partial_role", {"role": "executor"}),
                       ("bad_agent", {"agent": "../other", "role": "executor"}),
                       ("empty_agent", {"agent": "", "role": "executor"}),
                       ("null_agent", {"agent": None, "role": "executor"}),
                       ("bad_role", {"agent": "executor-a", "role": "liaison"}),
                       ("case_role", {"agent": "executor-a", "role": "Harness"}),
                       ("space_role", {"agent": "executor-a", "role": "executor "}),
                       ("object_role", {"agent": "executor-a", "role": {"role": "harness"}})):
    setattr(DispatchOracle, "test_malformed_pin_" + _label, malformed_context(_value))


def malformed_arguments(value, pinned):
    def test(self):
        handler = Mock(return_value={})
        with self.no_io_handler("post_status", handler):
            self.refusal("post_status", copy.deepcopy(value), PIN_A if pinned else None, codes=("bad_args",))
        handler.assert_not_called()
    return test


for _label, _value in (("null", None), ("list", []), ("text", "agent"), ("int", 1), ("bool", False)):
    for _pinned in (True, False):
        setattr(DispatchOracle, "test_args_" + _label + ("_pinned" if _pinned else "_unpinned"),
                malformed_arguments(_value, _pinned))


def hostile_fields(extra):
    def test(self):
        args = dict(room="demo", agent="executor-b", text="working", **copy.deepcopy(extra))
        handler = Mock(return_value={})
        with self.no_io_handler("post_status", handler):
            self.refusal("post_status", args)
        handler.assert_not_called()
    return test


for _label, _extra in (("role", {"role": "harness"}), ("pin", {"pin": {"agent": "executor-b", "role": "harness"}}),
                       ("harness", {"harness": "harness"}),
                       ("payload", {"payload": {"agent": "executor-b", "role": "harness"}})):
    setattr(DispatchOracle, "test_hostile_" + _label, hostile_fields(_extra))


def harness_private(name):
    def test(self):
        handler = Mock(return_value={})
        with self.no_io_handler(name, handler):
            self.refusal(name, {"room": "missing-private", "agent": "executor-b", "text": "working"}, HARNESS)
        handler.assert_not_called()
        self.assertFalse(self.home.exists())
    return test


for _name in ("post_status", "read_inbox", "plan_get", "room_events", "room_send", "task_claim"):
    setattr(DispatchOracle, "test_harness_no_general_privilege_" + _name, harness_private(_name))


def required_missing(name):
    def test(self):
        handler = Mock(return_value={})
        with self.no_io_handler(name, handler):
            self.refusal(name, {"room": "missing-private"})
        handler.assert_not_called()
        self.assertFalse(self.home.exists())
    return test


def optional_missing(name):
    def test(self):
        args = {} if name == "list_templates" else {"room": "demo"}
        before = copy.deepcopy(args)
        handler = Mock(return_value={"same": True})
        with self.no_io_handler(name, handler):
            expected = {"same": True} if name in app.LEGACY_DISPATCH else {"untrusted": {"same": True}}
            self.assertEqual(self.dispatch(name, args, PIN_A), expected)
        handler.assert_called_once_with(before)
        self.assertEqual(args, before)
    return test


for _tool in app.list_tools():
    if "agent" in _tool["inputSchema"].get("required", []):
        setattr(DispatchOracle, "test_required_agent_missing_" + _tool["name"], required_missing(_tool["name"]))
    else:
        setattr(DispatchOracle, "test_optional_agent_missing_" + _tool["name"], optional_missing(_tool["name"]))


def unknown_name(name):
    def test(self):
        self.refusal(name, {"room": "demo", "agent": "executor-a"}, codes=("bad_args",))
        self.assertFalse(self.home.exists())
    return test


for _label, _name in (("null", None), ("empty", ""), ("number", 1), ("bool", True),
                       ("unknown", "u120_unknown"), ("list", []), ("object", {})):
    setattr(DispatchOracle, "test_unregistered_name_" + _label, unknown_name(_name))
