"""Real room fixtures and bounded in-process transport adapters."""
import copy
import hashlib
import io
import importlib
import itertools
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
import time
import types
import unittest
from contextlib import ExitStack, contextmanager, redirect_stderr, redirect_stdout
from unittest.mock import patch

from bridge.plan.fold import fold_plan
from bridge.plan.template import validate_template
from bridge.room import app, mcp, store
from bridge.room import __main__ as cli
from bridge.room.ext import export as exporter
from bridge.wall import room_relay
emit = importlib.import_module("bridge.wall.emit")

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
SECRET = "password=hunter2-SYNTHETIC"
RAW = "hunter2-SYNTHETIC"
REDACTED = "password=[REDACTED:KEY_ASSIGN]"
CLEAN = "Ship safely — café / 漢字"
BASE_TS = 1700000000000


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def task(text):
    return dict(key="first", title=text, type="action", phase="start", accept=text,
                microtasks=[dict(text=text, accept=text)])


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


class RoomCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.home = self.tmp / "home"
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        env = dict(os.environ, CW_HOME=str(self.home))
        for key in ("CW_AGENT", "CW_ROLE"):
            env.pop(key, None)
        self.stack.enter_context(patch.dict(os.environ, env, clear=True))
        self.stack.enter_context(patch.object(time, "time", return_value=BASE_TS / 1000))
        self.stack.enter_context(patch.object(time, "monotonic", return_value=100.0))
        self.stack.enter_context(patch.object(time, "sleep", side_effect=AssertionError("real sleep forbidden")))
        self.stack.enter_context(patch.object(socket, "socket", side_effect=AssertionError("network forbidden")))
        counter = itertools.count()
        self.stack.enter_context(patch.object(secrets, "token_hex", side_effect=lambda n:
            hashlib.sha256(str(next(counter)).encode()).hexdigest()[:2*n]))
        self.template = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
        self.install_template(self.template)

    def install_template(self, template):
        template = validate_template(template)
        directory = self.home / "templates"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / (template["id"] + ".json")).write_text(compact(template), encoding="utf-8")
        self.template = template
        return template

    def direct(self, name, **args):
        return app.dispatch(name, args)

    def seed(self, text=SECRET):
        self.direct("plan_create", room="demo", agent="alice", template_id=self.template["id"],
                    title=text, brief={"goal": text},
                    tasks=[task(text)], strict=False, op_id="seed-plan")
        self.direct("memory_set", room="demo", agent="alice", section="notes", text="old " + text,
                    base_rev=0, op_id="memory-old")
        previous = self.projection()["memory"]["notes"]["rev"]
        self.direct("memory_set", room="demo", agent="alice", section="notes", text="current " + text,
                    base_rev=previous, op_id="memory-current")
        store.post("demo", "bob", "question", text, to="alice")
        self.assertEqual(self.projection()["rejected"], [], "fixture must be accepted before output checks")

    def journal(self):
        path = self.home / "rooms/demo/events.jsonl"
        return path.read_bytes() if path.exists() else b""

    def events(self):
        return [json.loads(line) for line in self.journal().splitlines()]

    def projection(self):
        return fold_plan(self.events(), templates={self.template["id"]: self.template})

    def rpc(self, method, params=None):
        request = compact(dict(jsonrpc="2.0", id=17, method=method, params=params or {})) + "\n"
        output, errors = io.StringIO(), io.StringIO()
        stdin = types.SimpleNamespace(buffer=io.BytesIO(request.encode("utf-8")))
        with patch.object(sys, "stdin", stdin), redirect_stdout(output), redirect_stderr(errors):
            rc = mcp.main()
        wire = output.getvalue()
        self.assertEqual(rc, 0, errors.getvalue())
        self.assertEqual(len(wire.splitlines()), 1, "exactly one MCP reply, including on refusal")
        reply = json.loads(wire)
        self.assertEqual((reply["jsonrpc"], reply["id"]), ("2.0", 17))
        return reply, wire + errors.getvalue()

    def tool(self, name, **args):
        return self.rpc("tools/call", dict(name=name, arguments=args))

    def ok_tool(self, name, **args):
        reply, wire = self.tool(name, **args)
        self.assertNotIn("error", reply, "valid fixture request must succeed")
        result = reply["result"]
        self.assertIs(result.get("isError"), False, "valid fixture request must succeed")
        payload = json.loads(result["content"][0]["text"])
        return payload, wire

    def run_cli(self, *args):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            try:
                rc = cli.main(list(args))
            except SystemExit as exc:
                rc = exc.code
        return rc, output.getvalue(), errors.getvalue()

    def redacted(self, wire):
        self.assertNotIn(RAW, wire, "U163: raw synthetic secret escaped output redaction")
        self.assertIn(REDACTED, wire, "U163: exact Wall replacement must remain visible")

    def success(self, reply):
        self.assertNotIn("error", reply)
        if "isError" in reply.get("result", {}):
            self.assertFalse(reply["result"]["isError"])

    def refusal(self, reply, wire):
        self.assertNotIn(RAW, wire, "sanitizer exception detail leaked")
        refused = "error" in reply or reply.get("result", {}).get("isError") is True
        self.assertTrue(refused, "U163: sanitizer failure must produce an error, never success")

    def tool_args(self, name, text=SECRET):
        args = dict(room="demo", agent="alice")
        current = self.projection()["tasks"][0]
        if name == "post_status":
            args.update(text=text)
        elif name == "post_plan":
            args.update(title=text, steps=[dict(text=text, accept=text)])
        elif name == "post_step":
            args.update(index=0, state="done", outcome=text, took="1s")
        elif name == "close_task":
            args.update(outcome=text)
        elif name in ("read_inbox", "wait_inbox"):
            args.update(since=0)
            if name == "wait_inbox":
                args.update(timeout_s=0)
        elif name == "task_add":
            args.update(title=text, type="action", phase="start", accept=text,
                        microtasks=[dict(text=text, accept=text)], op_id="add-again")
        elif name == "task_update":
            args.update(task_id=current["id"], base_rev=current["rev"], title=text, accept=text,
                        op_id="update-once")
        elif name in ("task_claim", "task_release"):
            if name == "task_release":
                self.direct("task_claim", **args, task_id=current["id"], base_rev=current["rev"])
                current = self.projection()["tasks"][0]
            args.update(task_id=current["id"], base_rev=current["rev"], op_id=name + "-once")
        elif name == "microtask_set":
            self.direct("task_claim", **args, task_id=current["id"], base_rev=current["rev"])
            args.update(id=current["microtasks"][0]["id"], state="blocked", outcome=text,
                        took="1s", op_id="micro-once")
        elif name == "room_events":
            args.update(after_lamport=0, wait_ms=0)
        elif name == "room_export":
            args.update(what="plan")
        elif name == "memory_history":
            args.update(section="notes")
        elif name == "work_acquire":
            args.update(op_id="acquire-once", run_id="RunAbCdEfGhIjKlMnOpQrStUvWxYz0123456789")
        return args

    def cli_args(self, verb, text=SECRET):
        if verb == "post":
            return [verb, "--room", "demo", "--agent", "alice", "--act", "heartbeat", "--text", text]
        if verb == "read":
            return [verb, "--room", "demo", "--since", "0", "--json"]
        if verb == "wait":
            return [verb, "--room", "demo", "--since", "0", "--timeout", "0"]
        if verb == "status":
            return [verb, "--room", "demo"]
        if verb == "call":
            return [verb, "plan_get", "--json", compact(dict(room="demo", agent="alice"))]
        if verb == "export":
            return [verb, "--room", "demo", "--out", "exports"]
        raise AssertionError("unknown test verb")


@contextmanager
def broken_redactor(fail_when=None):
    """Fault-inject the real shared function and its bound import aliases."""
    original = emit.redact
    def fail(*args, **kwargs):
        if fail_when is None or fail_when(args[0]):
            raise RuntimeError(SECRET)
        return original(*args, **kwargs)
    with ExitStack() as stack:
        for module in list(sys.modules.values()):
            if module is None or not getattr(module, "__name__", "").startswith("bridge."):
                continue
            for name, value in list(vars(module).items()):
                if value is original:
                    stack.enter_context(patch.object(module, name, fail))
        yield
