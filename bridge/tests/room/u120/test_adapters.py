"""Startup stop rules, adapter error mapping, and session isolation."""
import copy
import json
import os
from unittest.mock import Mock, patch

from bridge.room import app, store
from .support import HARNESS, PIN_A, PIN_B, Input, PinCase, request


class AdapterOracle(PinCase):
    def test_neither_variable_cli_legacy_post(self):
        code, out, err, _ = self.cli(["post", "--room", "demo", "--agent", "executor-b",
                                     "--act", "heartbeat", "--text", "working"])
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertTrue(self.one_json(out)["ok"])

    def test_neither_variable_mcp_tools_resources_prompts(self):
        methods = ("initialize", "tools/list", "resources/list", "resources/templates/list", "prompts/list")
        requests = [{"jsonrpc": "2.0", "id": i, "method": method, "params": {}}
                    for i, method in enumerate(methods, 1)]
        code, out, err, _ = self.mcp(requests)
        self.assertEqual((code, err), (0, ""))
        frames = [json.loads(line) for line in out.splitlines()]
        self.assertEqual(len(frames), len(methods))
        self.assertTrue(all("result" in frame and "error" not in frame for frame in frames))
        self.assertEqual(frames[1]["result"]["tools"], app.list_tools())

    def test_mcp_initialize_and_meta_cannot_override_session(self):
        override = {"agent": "executor-b", "role": "harness", "pin": {"agent": "executor-b", "role": "harness"}}
        messages = [{"jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": dict(clientInfo={"name": "test", "version": "1"}, _meta=override, **override)},
                    request("post_status", dict(room="demo", agent="executor-b", text="working"), 2, _meta=override)]
        handler = Mock(return_value={})
        with self.no_io_handler("post_status", handler), self.observe() as observed:
            code, out, err, _ = self.mcp(messages, PIN_A)
        handler.assert_not_called()
        self.untouched(observed)
        self.assertEqual((code, err), (0, ""))
        frames = [json.loads(line) for line in out.splitlines()]
        self.assertEqual(len(frames), 2)
        self.assertIn("result", frames[0])
        tool = frames[1]["result"]
        self.assertIs(tool["isError"], True)
        self.assertEqual(json.loads(tool["content"][0]["text"])["code"], "bad_agent")

    def test_mcp_pin_is_captured_before_first_input_and_requires_restart(self):
        messages = [request("post_status", dict(room="demo", agent=agent, text="working"), i)
                    for i, agent in enumerate(("executor-a", "executor-b", "executor-a"), 1)]
        def change_environment():
            os.environ["CW_PIN_AGENT"] = "executor-b"
            os.environ["CW_PIN_ROLE"] = "harness"
        stream = Input(messages, after_first=change_environment)
        handler = Mock(return_value={"accepted": True})
        with self.no_io_handler("post_status", handler):
            code, out, err, _ = self.mcp(pin=PIN_A, inp=stream)
        self.assertEqual((code, err), (0, ""))
        results = [json.loads(line)["result"] for line in out.splitlines()]
        self.assertEqual([r["isError"] for r in results], [False, True, False])
        self.assertEqual(json.loads(results[1]["content"][0]["text"])["code"], "bad_agent")
        self.assertEqual(handler.call_count, 2)
        code, out, err, _ = self.mcp([messages[1]], PIN_B)
        self.assertEqual((code, err), (0, ""))
        self.assertIs(self.mcp_payload(out)[0]["isError"], False)

    def test_sessions_do_not_leak_context(self):
        handler = Mock(return_value={"ok": True})
        with self.no_io_handler("post_status", handler):
            for adapter in ("cli", "mcp"):
                for pin, actor in ((PIN_A, "executor-a"), (PIN_B, "executor-b"),
                                   (None, "executor-c"), (PIN_A, "executor-a")):
                    args = dict(room="demo", agent=actor, text="working")
                    if adapter == "cli":
                        code, out, err, _ = self.cli(["call", "post_status", "--json", json.dumps(args)], pin)
                        self.assertEqual(self.one_json(out), {"ok": True})
                    else:
                        code, out, err, _ = self.mcp([request("post_status", args)], pin)
                        self.assertIs(self.mcp_payload(out)[0]["isError"], False)
                    self.assertEqual((code, err), (0, ""))
        self.assertEqual(handler.call_count, 8)

    def test_cli_unpinned_tools_still_available(self):
        code, out, err, _ = self.cli(["tools"])
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(self.one_json(out)["tools"], app.list_tools())


def invalid_startup(adapter, config, expected):
    def test(self):
        before = self.journal()
        with self.observe() as observed:
            if adapter == "cli":
                code, out, err, inp = self.cli(["read", "--room", "missing-private"], config=config)
                refusal_text = out
            else:
                code, out, err, inp = self.mcp([{"jsonrpc": "2.0", "id": 1, "method": "ping"}], config=config)
                refusal_text = err
        self.assertEqual(code, 2, "M1 invalid startup configuration was not refused")
        if adapter == "mcp":
            self.assertEqual(out, "", "invalid startup emitted protocol stdout")
        payload = self.one_json(refusal_text)
        self.assertEqual(set(payload), {"ok", "code", "detail"})
        self.assertIs(payload["ok"], False)
        self.assertEqual(payload["code"], expected)
        self.assertIsInstance(payload["detail"], str)
        self.assertTrue(payload["detail"])
        self.assertEqual(inp.reads, 0, "invalid configuration consumed input")
        self.assertEqual(inp.home_reads, [], "invalid startup accessed CW_HOME")
        self.untouched(observed)
        self.assertEqual(self.journal(), before)
        self.assertFalse(self.home.exists())
    return test


CONFIGS = (
    ("role_only", {"CW_PIN_ROLE": "executor"}, "bad_args"),
    ("agent_only", {"CW_PIN_AGENT": "executor-a"}, "bad_args"),
    ("empty_both", {"CW_PIN_AGENT": "", "CW_PIN_ROLE": ""}, "bad_args"),
    ("empty_agent", {"CW_PIN_AGENT": "", "CW_PIN_ROLE": "executor"}, "bad_args"),
    ("empty_role", {"CW_PIN_AGENT": "executor-a", "CW_PIN_ROLE": ""}, "bad_args"),
    ("liaison", {"CW_PIN_AGENT": "executor-a", "CW_PIN_ROLE": "liaison"}, "bad_args"),
    ("bad_agent", {"CW_PIN_AGENT": "../other", "CW_PIN_ROLE": "executor"}, "bad_agent"),
    ("agent_leading_space", {"CW_PIN_AGENT": " executor-a", "CW_PIN_ROLE": "executor"}, "bad_agent"),
    ("agent_trailing_space", {"CW_PIN_AGENT": "executor-a ", "CW_PIN_ROLE": "executor"}, "bad_agent"),
    ("agent_case", {"CW_PIN_AGENT": "Executor-a", "CW_PIN_ROLE": "executor"}, "bad_agent"),
    ("agent_newline", {"CW_PIN_AGENT": "executor-a\n", "CW_PIN_ROLE": "executor"}, "bad_agent"),
    ("role_space", {"CW_PIN_AGENT": "executor-a", "CW_PIN_ROLE": " executor"}, "bad_args"),
    ("role_case", {"CW_PIN_AGENT": "executor-a", "CW_PIN_ROLE": "Executor"}, "bad_args"),
    ("role_type_text", {"CW_PIN_AGENT": "executor-a", "CW_PIN_ROLE": "true"}, "bad_args"),
    ("agent_type_text", {"CW_PIN_AGENT": "[true]", "CW_PIN_ROLE": "executor"}, "bad_agent"),
    ("invalid_agent_before_role", {"CW_PIN_AGENT": "../other", "CW_PIN_ROLE": "liaison"}, "bad_agent"),
    ("missing_role_before_bad_agent", {"CW_PIN_AGENT": "../other"}, "bad_args"),
    ("empty_role_before_bad_agent", {"CW_PIN_AGENT": "../other", "CW_PIN_ROLE": ""}, "bad_args"),
)
for _adapter in ("cli", "mcp"):
    for _label, _config, _code in CONFIGS:
        setattr(AdapterOracle, "test_startup_" + _adapter + "_" + _label,
                invalid_startup(_adapter, _config, _code))


def adapter_call(adapter, tool, same):
    def test(self):
        actor = "executor-a" if same else "executor-b"
        args = dict(room="demo", agent=actor, text="working")
        if tool == "room_send":
            args.update(to="coordinator", act="question", op_id="u120-extension-01")
        # Seed a journal so both bytes and head are meaningful on refusal.
        store.post("demo", "seed", "heartbeat", "seed")
        before = self.journal()
        table = app.LEGACY_DISPATCH if tool in app.LEGACY_DISPATCH else app.V2_DISPATCH
        original = table[tool]
        handler = Mock(wraps=original)
        with patch.dict(table, {tool: handler}), self.observe() as observed:
            if adapter == "mcp":
                code, out, err, _ = self.mcp([request(tool, args)], PIN_A)
                result, payload = self.mcp_payload(out)
                self.assertEqual(code, 0)
                self.assertIs(result["isError"], not same)
            elif adapter == "call":
                code, out, err, _ = self.cli(["call", tool, "--json", json.dumps(args)], PIN_A)
                self.assertEqual(code, 0 if same else 3)
                payload = self.one_json(out)
            else:
                code, out, err, _ = self.cli(["post", "--room", "demo", "--agent", actor,
                                             "--act", "heartbeat", "--text", "working"], PIN_A)
                self.assertEqual(code, 0 if same else 2)
                payload = self.one_json(out)
        self.assertEqual(err, "")
        if same:
            if adapter != "post":
                handler.assert_called_once()
            self.assertGreater(self.journal()[1], before[1])
            if tool == "room_send":
                self.assertEqual(set(payload), {"untrusted"})
                self.assertIs(payload["untrusted"]["ok"], True)
        else:
            handler.assert_not_called()
            self.untouched(observed)
            self.assertIs(payload["ok"], False)
            self.assertEqual(payload["code"], "bad_agent")
            self.assertIn("executor-a", payload.get("detail", ""))
            self.assertEqual(self.journal(), before)
    return test


for _adapter, _tools in (("mcp", ("post_status", "room_send")), ("call", ("post_status", "room_send")),
                         ("post", ("post_status",))):
    for _tool in _tools:
        for _same in (False, True):
            setattr(AdapterOracle, "test_" + _adapter + "_" + _tool + ("_same" if _same else "_foreign"),
                    adapter_call(_adapter, _tool, _same))


def legacy_stop(verb):
    def test(self):
        arguments = {"post": ["--agent", "executor-a", "--act", "heartbeat", "--text", "x"],
                     "read": [], "status": [], "wait": ["--timeout", "0"],
                     "export": ["--out", str(self.home / "exported")], "tools": [],
                     "call": ["post_status", "--json", json.dumps(dict(room="demo", agent="executor-a", text="x"))]}
        argv = [verb] + ([] if verb in ("call", "tools") else ["--room", "missing-private"]) + arguments[verb]
        with self.observe() as observed:
            code, out, err, _ = self.cli(argv, config={"CW_PIN_ROLE": "executor"})
        self.assertEqual(code, 2)
        payload = self.one_json(out)
        self.assertEqual(payload.get("code"), "bad_args")
        self.assertTrue(payload.get("detail"))
        self.untouched(observed)
        self.assertFalse(self.home.exists())
    return test


for _verb in ("post", "read", "wait", "status", "export", "tools", "call"):
    setattr(AdapterOracle, "test_invalid_startup_stops_" + _verb, legacy_stop(_verb))


def wait_actor(same):
    def test(self):
        store.post("demo", "seed", "heartbeat", "seed")
        before = self.journal()
        with self.observe() as observed:
            code, out, err, _ = self.cli(["wait", "--room", "demo", "--agent",
                                         "executor-a" if same else "executor-b", "--timeout", "0"], PIN_A)
        if same:
            self.assertEqual(code, 124)
            self.assertEqual(self.one_json(out)["code"], "timeout")
        else:
            self.assertEqual(code, 2)
            self.assertEqual(self.one_json(out).get("code"), "bad_agent")
            self.untouched(observed)
        self.assertEqual(self.journal(), before)
    return test


AdapterOracle.test_wait_explicit_foreign_agent_before_stat = wait_actor(False)
AdapterOracle.test_wait_same_agent_filter_is_preserved = wait_actor(True)


def valid_startup(adapter, role, actor):
    def test(self):
        pin = dict(agent=actor, role=role)
        args = dict(room="demo", agent=actor, text="working")
        if adapter == "mcp":
            code, out, err, _ = self.mcp([request("post_status", args)], pin)
            result, payload = self.mcp_payload(out)
            self.assertIs(result["isError"], False)
        else:
            code, out, err, _ = self.cli(["call", "post_status", "--json", json.dumps(args)], pin)
            payload = self.one_json(out)
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(payload["event"]["agent"], actor)
    return test


for _adapter in ("mcp", "cli"):
    for _role in ("executor", "harness"):
        for _label, _actor in (("one_char", "a"), ("punctuation", "a.b_c-1"), ("maximum", "a" * 48)):
            setattr(AdapterOracle, "test_valid_startup_" + _adapter + "_" + _role + "_" + _label,
                    valid_startup(_adapter, _role, _actor))
