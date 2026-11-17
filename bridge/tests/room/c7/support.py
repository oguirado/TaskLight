"""Deterministic adapters to the real C7 room, fold and transport seams."""
import contextlib
import copy
import io
import itertools
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from bridge.plan.errors import PlanError
from bridge.plan.fold import fold_plan
from bridge.room import app, mcp, store
from bridge.room import __main__ as cli
from bridge.room.ext.decision import unit_decide

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
FIXTURE = json.loads((HERE / "fixtures.json").read_text(encoding="utf-8"))
TEMPLATE = FIXTURE["template"]
TEMPLATES = {TEMPLATE["id"]: TEMPLATE}
NOW = 1800000001000
SECRET = "Authorization: Bearer " + "aBcD0123456789" * 3


def clone(value):
    return copy.deepcopy(value)


def unwrap(payload):
    return payload.get("untrusted", payload)


def event(n, op, agent="reviewer"):
    return {"id": f"e-{n:016x}", "room": "demo", "agent": agent,
            "act": "op", "text": "", "lamport": n, "ts": NOW - 1000 + n,
            "op": clone(op)}


def decision(n=6, **fields):
    op = clone(FIXTURE["base"])
    op["op_id"] = f"c7-decision-{n:04d}"
    op.update(fields)
    return op


def fold(events):
    return fold_plan(events, templates=TEMPLATES)


class StopRule(BaseException):
    """Cannot be hidden by product handlers that catch ordinary exceptions."""


@contextlib.contextmanager
def bounded():
    previous = sys.gettrace()
    remaining = 2000000

    def trace(frame, kind, arg):
        nonlocal remaining
        if kind == "line" and frame.f_globals.get("__name__", "").startswith("bridge."):
            remaining -= 1
            if remaining <= 0:
                raise StopRule("C7 instruction budget exceeded")
        return trace

    sys.settrace(trace)
    try:
        yield
    finally:
        sys.settrace(previous)


class RoomCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="runtime-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.now = NOW
        env = dict(os.environ, CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        for key in ("CW_AGENT", "CW_ROLE", "CW_SESSION_AGENT", "CW_SESSION_ROLE"):
            env.pop(key, None)
        self.enterContext(mock.patch.dict(os.environ, env, clear=True))
        originals = {"time": time.time, "monotonic": time.monotonic,
                     "perf_counter": time.perf_counter, "sleep": time.sleep}
        replacements = {"time": lambda: self.now / 1000,
                        "monotonic": lambda: 0.0, "perf_counter": lambda: 0.0,
                        "sleep": lambda *_: self.forbidden("real wait")}
        for name, module in list(sys.modules.items()):
            if name.startswith("bridge.") and module is not None:
                for field, value in list(vars(module).items()):
                    for source, original in originals.items():
                        if value is original:
                            self.enterContext(mock.patch.object(module, field, replacements[source]))
        for name, replacement in replacements.items():
            self.enterContext(mock.patch.object(time, name, side_effect=replacement))
        self.enterContext(mock.patch.object(time, "time_ns", side_effect=lambda: self.now * 1000000))
        self.enterContext(mock.patch.object(threading.Event, "wait", side_effect=StopRule("real wait")))
        self.enterContext(mock.patch.object(threading.Condition, "wait", side_effect=StopRule("real wait")))
        self.enterContext(mock.patch.object(socket, "socket", side_effect=StopRule("network forbidden")))
        self.enterContext(mock.patch.object(socket, "create_connection", side_effect=StopRule("network forbidden")))
        seq = itertools.count(1)
        self.enterContext(mock.patch.object(secrets, "token_hex", side_effect=lambda n: f"{next(seq):0{2*n}x}"))

    @staticmethod
    def forbidden(message):
        raise StopRule(message)

    def path(self, room="demo"):
        return self.home / "rooms" / room / "events.jsonl"

    def raw(self, room="demo"):
        path = self.path(room)
        return path.read_bytes() if path.exists() else b""

    def events(self):
        return [json.loads(line) for line in self.raw().splitlines() if line]

    def install(self, events=None):
        path = self.path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(item) + "\n" for item in
                               (FIXTURE["seed"] if events is None else events)), encoding="utf-8")

    def args(self, **fields):
        # Use the same identity as the referenced run, avoiding an assumption
        # about a new actor/source alias not named in the specification.
        op = decision(agent="worker", run_id="r1")
        op.pop("kind")
        return {"room": "demo", **op, **fields}

    def call_decision(self, args=None):
        with bounded():
            return unwrap(unit_decide(self.args() if args is None else args))

    def post_decision(self, op):
        with bounded():
            return store.post("demo", "reviewer", "op", "", op=clone(op),
                              templates=TEMPLATES, clock=lambda: self.now)

    def inventory(self):
        with bounded():
            data = unwrap(app.dispatch("agents_list", {"room": "demo", "now": self.now}))
        return next(row for row in data["agents"] if row["agent"] == "worker")

    def integration(self):
        with bounded():
            result = unwrap(app.dispatch("room_export", {"room": "demo", "agent": "reviewer", "what": "integration"}))
        self.assertEqual(result.get("format"), "markdown")
        self.assertIsInstance(result.get("text"), str)
        return result["text"]

    def mcp_call(self, name, args):
        sent = []
        with mock.patch.object(mcp, "_send", side_effect=sent.append), bounded():
            mcp._handle(42, "tools/call", {"name": name, "arguments": args})
        self.assertEqual(len(sent), 1, "one bounded MCP response")
        self.assertNotIn("error", sent[0])
        response = sent[0]["result"]
        return response, unwrap(json.loads(response["content"][0]["text"]))

    def cli_call(self, name, args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), bounded():
            rc = cli.main(["call", name, "--json", json.dumps(args)])
        self.assertTrue(out.getvalue().strip(), "CLI returns JSON")
        return rc, unwrap(json.loads(out.getvalue())), err.getvalue()

    def assert_redaction_stops_output(self, name, args, owner_text):
        sent = []
        with mock.patch("bridge.wall.emit.redact", side_effect=RuntimeError("redaction unavailable")), \
                mock.patch.object(mcp, "_send", side_effect=sent.append), bounded():
            try:
                mcp._handle(42, "tools/call", {"name": name, "arguments": args})
            except Exception:
                # Refusal without a response is also fail-closed. No raw-data
                # fallback is allowed, regardless of the transport error shape.
                pass
        for message in sent:
            self.assertNotIn(owner_text, json.dumps(message))
            if "result" in message:
                self.assertTrue(message["result"].get("isError", False))

    def assert_bad_decision(self, args, code="bad_op"):
        before = self.raw()
        with self.assertRaises(store.RoomError) as caught:
            self.call_decision(args)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.raw(), before, "rejection must not append any bytes")

    def task(self):
        return fold(self.events())["tasks"][0]
