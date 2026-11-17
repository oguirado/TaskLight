"""Deterministic adapters and observations; scratch stays under this package."""
import copy
import inspect
import io
import itertools
import json
import os
import runpy
import sys
import warnings
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import unittest
from contextlib import ExitStack, contextmanager, redirect_stderr, redirect_stdout
from unittest.mock import Mock, patch

from bridge.room import app, ext, mcp, store
from bridge.room import __main__ as cli

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PIN_A = {"agent": "executor-a", "role": "executor"}
PIN_B = {"agent": "executor-b", "role": "executor"}
HARNESS = {"agent": "coordinator", "role": "harness"}
TRUST = ("The session pin prevents accidental cross-agent calls. It is not authentication. "
         "Agent identity remains caller-asserted within the same-user CW_HOME boundary.")
MISSING = object()


class Environment(dict):
    def __init__(self, values, accesses):
        super().__init__(values)
        self.accesses = accesses

    def get(self, key, default=None):
        if key == "CW_HOME":
            self.accesses.append(key)
        return super().get(key, default)

    def __getitem__(self, key):
        if key == "CW_HOME":
            self.accesses.append(key)
        return super().__getitem__(key)


def module_entry(module, argv):
    # Run a fresh __main__ namespace, allowing startup capture either at import
    # or in main(). No subprocess, provider, wall-clock deadline or port is used.
    with patch.object(sys, "argv", [module, *argv]), warnings.catch_warnings():
        warnings.filterwarnings("ignore", message=".*found in sys.modules.*", category=RuntimeWarning)
        try:
            runpy.run_module(module, run_name="__main__", alter_sys=True)
        except SystemExit as exc:
            return exc.code
    return 0


class Input:
    def __init__(self, requests=(), after_first=None):
        self.buffer = self
        self.lines = iter((json.dumps(r) + "\n").encode() for r in requests)
        self.reads = 0
        self.after_first = after_first
        self.home_reads = []

    def readline(self, *args):
        if self.reads == 1 and self.after_first is not None:
            self.after_first()
        self.reads += 1
        return next(self.lines, b"")


def request(name, args, id_=1, **extra):
    return {"jsonrpc": "2.0", "id": id_, "method": "tools/call",
            "params": dict(name=name, arguments=args, **extra)}


class PinCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / "cw"
        environment = {k: v for k, v in os.environ.items() if not k.startswith("CW_")}
        environment.update(CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        self.enterContext(patch.dict(os.environ, environment, clear=True))
        self.enterContext(patch.object(time, "time", return_value=1700000000.0))
        self.enterContext(patch.object(time, "monotonic", return_value=100.0))
        self.enterContext(patch.object(subprocess, "Popen", side_effect=AssertionError("process creation forbidden")))
        self.enterContext(patch.object(os, "system", side_effect=AssertionError("shell invocation forbidden")))
        self.enterContext(patch.object(time, "sleep", side_effect=AssertionError("sleep forbidden")))
        self.enterContext(patch.object(socket, "socket", side_effect=AssertionError("network forbidden")))
        ids = itertools.count(1)
        self.enterContext(patch.object(secrets, "token_hex", side_effect=lambda n: format(next(ids), "0%dx" % (2*n))))
        app.list_tools()
        self._contexts = {}

    def context(self, configuration):
        """Capture the public adapter argument; prescribe no context class/factory."""
        key = configuration["agent"], configuration["role"]
        if key not in self._contexts:
            captured = []
            def capture(name, args, **kwargs):
                captured.append(kwargs.get("pin", MISSING))
                return {"ok": True}
            args = dict(room="demo", agent=configuration["agent"], text="working")
            with patch.object(app, "dispatch", side_effect=capture):
                code, output, error, _ = self.cli(["call", "post_status", "--json", json.dumps(args)], configuration)
            self.assertEqual((code, error), (0, ""))
            self.assertEqual(len(captured), 1)
            self.assertIsNot(captured[0], MISSING, "adapter must pass its trusted context explicitly")
            self.assertIsNotNone(captured[0], "configured adapter passed an unpinned context")
            self._contexts[key] = captured[0]
        return self._contexts[key]

    def dispatch(self, name, args, pin=MISSING):
        if pin is MISSING:
            return app.dispatch(name, args)
        signature = inspect.signature(app.dispatch)
        self.assertIn("pin", signature.parameters,
                      "M2 missing trusted keyword-only pin on app.dispatch")
        self.assertEqual(signature.parameters["pin"].kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertIsNone(signature.parameters["pin"].default)
        if isinstance(pin, dict) and set(pin) == {"agent", "role"}:
            if isinstance(pin.get("agent"), str) and pin.get("role") in ("executor", "harness"):
                try:
                    store._check_agent(pin["agent"])
                except store.RoomError:
                    pass
                else:
                    pin = self.context(pin)
        return app.dispatch(name, args, pin=pin)

    def journal(self, room="demo"):
        path = self.home / "rooms" / room / "events.jsonl"
        raw = path.read_bytes() if path.exists() else b""
        events = [json.loads(line) for line in raw.splitlines()]
        return raw, max((e["lamport"] for e in events), default=0)

    @contextmanager
    def observe(self):
        """Observe access without blocking it or fabricating a refusal."""
        with ExitStack() as stack:
            observations = []
            for name in ("post", "post_ops", "read", "inbox", "wait", "status",
                         "_ensure_dirs", "_op_identity_index", "_message_replay", "_single_replay"):
                spy = stack.enter_context(patch.object(store, name, wraps=getattr(store, name)))
                observations.append(("store." + name, spy))
            for owner, name in ((os, "stat"), (os, "open")):
                original = getattr(owner, name)
                accesses = Mock()
                def observed(path, *args, _original=original, _accesses=accesses, **kwargs):
                    if isinstance(path, (str, bytes, os.PathLike)):
                        value = os.fsdecode(path)
                        if value == str(self.home) or value.startswith(str(self.home) + os.sep):
                            _accesses(value)
                    return _original(path, *args, **kwargs)
                stack.enter_context(patch.object(owner, name, side_effect=observed))
                observations.append(("room " + name, accesses))
            yield observations

    def untouched(self, observations):
        for label, spy in observations:
            self.assertEqual(spy.call_count, 0, "guard was late: " + label)

    def refusal(self, name, args, pin=PIN_A, codes=("bad_agent",)):
        before = self.journal()
        caught = None
        with self.observe() as observed:
            try:
                self.dispatch(name, args, pin)
            except Exception as exc:
                caught = exc
        # Signature assertions remain assertion failures, never TypeError/import failures.
        if isinstance(caught, AssertionError):
            raise caught
        self.untouched(observed)
        self.assertIsInstance(caught, store.RoomError, "expected RoomError before handler access")
        self.assertIn(caught.code, codes)
        self.assertTrue(str(caught), "refusal must include actionable detail")
        self.assertNotIn("private-marker", str(caught))
        self.assertEqual(self.journal(), before, "refusal changed journal bytes/head")
        return caught

    def cli(self, argv, pin=None, config=None):
        environment = dict(os.environ)
        environment.pop("CW_PIN_AGENT", None)
        environment.pop("CW_PIN_ROLE", None)
        if pin is not None:
            environment.update(CW_PIN_AGENT=pin["agent"], CW_PIN_ROLE=pin["role"])
        if config is not None:
            environment.update(config)
        output, error = io.StringIO(), io.StringIO()
        inp = Input()
        with patch.object(os, "environ", Environment(environment, inp.home_reads)), patch("sys.stdin", inp), \
             redirect_stdout(output), redirect_stderr(error):
            code = module_entry("bridge.room", argv)
        return code, output.getvalue(), error.getvalue(), inp

    def mcp(self, requests=(), pin=None, config=None, inp=None):
        environment = dict(os.environ)
        environment.pop("CW_PIN_AGENT", None)
        environment.pop("CW_PIN_ROLE", None)
        if pin is not None:
            environment.update(CW_PIN_AGENT=pin["agent"], CW_PIN_ROLE=pin["role"])
        if config is not None:
            environment.update(config)
        inp = inp or Input(requests)
        output, error = io.StringIO(), io.StringIO()
        with patch.object(os, "environ", Environment(environment, inp.home_reads)), patch("sys.stdin", inp), \
             redirect_stdout(output), redirect_stderr(error):
            code = module_entry("bridge.room.mcp", [])
        return code, output.getvalue(), error.getvalue(), inp

    def one_json(self, text):
        self.assertEqual(len(text.splitlines()), 1, "expected one JSON object")
        try:
            result = json.loads(text)
        except ValueError:
            self.fail("adapter output is not refusal JSON")
        self.assertIsInstance(result, dict)
        return result

    def mcp_payload(self, output):
        frame = self.one_json(output)
        self.assertNotIn("error", frame, "valid tool request must use tool-error payload")
        self.assertIn("result", frame)
        result = frame["result"]
        self.assertIn("content", result)
        return result, json.loads(result["content"][0]["text"])

    def no_io_handler(self, name, handler):
        table = app.LEGACY_DISPATCH if name in app.LEGACY_DISPATCH else app.V2_DISPATCH
        return patch.dict(table, {name: handler})

    def make_plan(self, assignee="executor-a", dependency=False):
        template = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
        folder = self.home / "templates"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / (template["id"] + ".json")).write_text(json.dumps(template))
        op = dict(kind="plan.open", title="Oracle plan", template_id=template["id"],
                  template_hash=template["hash"], brief={"goal": "Verify pin"}, phase="start")
        store.post("demo", "coordinator", "op", "", op=op, templates={template["id"]: template})
        for index in range(1, 3 if dependency else 2):
            store.post("demo", "coordinator", "op", "", templates={template["id"]: template},
                       op=dict(kind="task.add", title="Task", type="action", phase="start",
                               deps=["T01"] if index == 2 else [], assignee=assignee,
                               microtasks=[{"text": "Verify"}]))
