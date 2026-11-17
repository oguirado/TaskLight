"""Existing public transports with isolated journals and virtual wait boundaries."""
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

from bridge.plan.fold import fold_plan
from bridge.room import app, mcp, store
from bridge.room import __main__ as cli

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
VECTORS = json.loads((HERE / "result_cases.json").read_text(encoding="utf-8"))
RESULT = VECTORS["base"]


class VirtualBound(BaseException):
    """A stop rule that cannot be swallowed by product Exception handling."""


class Clock:
    def __init__(self):
        self.now = 0.0
        self.calls = 0
        self.pending = []

    def later(self, delay, callback):
        self.pending.append((self.now + delay, callback))

    def advance(self, seconds):
        if (isinstance(seconds, bool) or not isinstance(seconds, (int, float))
                or not 0 <= seconds <= 600):
            raise VirtualBound("unbounded or invalid wait")
        self.calls += 1
        if self.calls > 1000000:
            raise VirtualBound("virtual wait iteration budget exceeded")
        target = self.now + seconds
        due = sorted(self.pending, key=lambda item: item[0])
        if due and due[0][0] <= target:
            at, callback = due[0]
            self.pending.remove((at, callback))
            self.now = at
            callback()
        else:
            self.now = target
        if self.now > 1200:
            raise VirtualBound("virtual deadline budget exceeded")


@contextlib.contextmanager
def operation_budget():
    """Stop a busy-looping implementation without real watchdog timers."""
    previous = sys.gettrace()
    remaining = 20000000
    def trace(frame, event, arg):
        nonlocal remaining
        if event == "line" and frame.f_globals.get("__name__", "").startswith("bridge."):
            remaining -= 1
            if remaining <= 0:
                raise VirtualBound("room operation exceeded its instruction budget")
        return trace
    sys.settrace(trace)
    try:
        yield
    except VirtualBound as exc:
        raise AssertionError("bounded operation stop rule: " + str(exc)) from exc
    finally:
        sys.settrace(previous)


def unwrap(payload):
    return payload.get("untrusted", payload)


class RoomCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="runtime-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.clock = Clock()
        self.seq = itertools.count(1)
        self.deployed = {}
        env = dict(os.environ, CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        for key in ("CW_AGENT", "CW_ROLE", "CW_SESSION_AGENT", "CW_SESSION_ROLE"):
            env.pop(key, None)
        self.enterContext(mock.patch.dict(os.environ, env, clear=True))
        originals = {"time": time.time, "monotonic": time.monotonic,
                     "perf_counter": time.perf_counter, "sleep": time.sleep}
        replacements = {"time": lambda: 1800000000 + self.clock.now,
                        "monotonic": lambda: self.clock.now,
                        "perf_counter": lambda: self.clock.now,
                        "sleep": self.clock.advance}
        # Cover both `import time` and already-loaded `from time import ...`.
        for module_name, module in list(sys.modules.items()):
            if module_name.startswith("bridge.room") and module is not None:
                for name, value in list(vars(module).items()):
                    for source, original in originals.items():
                        if value is original:
                            self.enterContext(mock.patch.object(module, name, replacements[source]))
        for name, replacement in replacements.items():
            self.enterContext(mock.patch.object(time, name, side_effect=replacement))
        self.enterContext(mock.patch.object(time, "time_ns", side_effect=lambda: int((1800000000 + self.clock.now) * 1e9)))
        self.enterContext(mock.patch.object(time, "monotonic_ns", side_effect=lambda: int(self.clock.now * 1e9)))
        self.enterContext(mock.patch.object(threading.Event, "wait", lambda event, timeout=None: self.event_wait(event, timeout)))
        self.enterContext(mock.patch.object(threading.Condition, "wait", lambda condition, timeout=None: self.condition_wait(condition, timeout)))
        self.enterContext(mock.patch.object(socket, "socket", side_effect=VirtualBound("network forbidden")))
        self.enterContext(mock.patch.object(socket, "create_connection", side_effect=VirtualBound("network forbidden")))
        counter = itertools.count(1)
        self.enterContext(mock.patch.object(secrets, "token_hex", side_effect=lambda n: format(next(counter), "x").zfill(2*n)))

    def event_wait(self, event, timeout=None):
        if not event.is_set():
            self.clock.advance(timeout)
        return event.is_set()

    def condition_wait(self, condition, timeout=None):
        self.clock.advance(timeout)
        return True

    def raw(self, room="demo"):
        path = self.home / "rooms" / room / "events.jsonl"
        return path.read_bytes() if path.exists() else b""

    def events(self, room="demo"):
        return [json.loads(line) for line in self.raw(room).splitlines() if line]

    def life(self, agent="worker", state="deployed", run="r1", room="demo", **fields):
        # C2 requires deployment before liveness or termination of a run.
        if state != "deployed" and self.deployed.get((room, agent)) != run:
            metadata = {key: value for key, value in fields.items()
                        if key in ("parent_agent", "parent_run_id", "harness", "swarm")}
            self.life(agent=agent, run=run, room=room, **metadata)
        args = dict(room=room, agent=agent, state=state, run_id=run,
                    op_id=f"c6-life-{next(self.seq):06d}", **fields)
        try:
            result = unwrap(app.dispatch("agent_lifecycle", args))
            if state == "deployed":
                self.deployed[(room, agent)] = run
            return result
        except store.RoomError as exc:
            self.fail(f"M1 lifecycle with valid C6 data must be admitted, got {exc.code}")

    def terminals(self):
        return [event for event in self.events() if event.get("op", {}).get("kind") == "agent.lifecycle"
                and event["op"]["state"] in ("finished", "failed")]

    def require_waiter(self):
        matches = [tool for tool in app.list_tools() if tool["name"] == "wait_agents"]
        self.assertEqual(len(matches), 1, "M3 wait_agents must be registered through existing tool discovery")
        return matches[0]

    def direct_wait(self, **fields):
        self.require_waiter()
        try:
            with operation_budget():
                data = unwrap(app.dispatch("wait_agents", dict(room="demo", **fields)))
        except store.RoomError as exc:
            self.fail(f"M3 valid wait_agents rejected: {exc.code}")
        except VirtualBound as exc:
            self.fail("M3 waiter violated the bounded execution stop rule: " + str(exc))
        self.assertIsInstance(data, dict)
        self.assertIsInstance(data.get("events"), list, "M3 events array required")
        self.assertIs(type(data.get("cursor")), int, "M3 integer Lamport cursor required")
        return data

    def mcp_call(self, name, args):
        sent = []
        with mock.patch.object(mcp, "_send", side_effect=sent.append):
            with operation_budget():
                mcp._handle(42, "tools/call", {"name": name, "arguments": args})
        self.assertEqual(len(sent), 1, "one bounded MCP response required")
        self.assertNotIn("error", sent[0], "C6 tool must be available over MCP")
        result = sent[0]["result"]
        return result, unwrap(json.loads(result["content"][0]["text"]))

    def cli_call(self, name, args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            with operation_budget():
                code = cli.main(["call", name, "--json", json.dumps(args)])
        self.assertTrue(out.getvalue().strip(), "CLI JSON response required")
        return code, unwrap(json.loads(out.getvalue())), err.getvalue()

    def inventory_row(self, agent="worker"):
        data = unwrap(app.dispatch("agents_list", {"room": "demo", "now": 1800000000000 + self.clock.now * 1000}))
        rows = [row for row in data["agents"] if row["agent"] == agent]
        self.assertEqual(len(rows), 1)
        self.assertIn("last_result", rows[0], "M6 inventory must expose last_result, including null")
        return rows[0]

    def assert_wait_rows(self, data, expected):
        rows = data["events"]
        self.assertEqual([row.get("lamport") for row in rows], [event["lamport"] for event in expected],
                         "M3 return every match once, in Lamport order")
        for row, event in zip(rows, expected):
            op = event["op"]
            prefix = [item for item in self.events() if item["lamport"] <= event["lamport"]]
            record = fold_plan(prefix)["agent_lifecycle"].get(event["agent"], {})
            parent = ({"agent": record["parent_agent"], "run_id": record.get("parent_run_id")}
                      if "parent_agent" in record else None)
            for key, value in {"agent": event["agent"], "run_id": op["run_id"], "state": op["state"],
                               "parent": parent, "lamport": event["lamport"]}.items():
                self.assertIn(key, row)
                self.assertEqual(row[key], value)
            if "result" in op:
                self.assertEqual(row.get("result"), op["result"])
            else:
                self.assertNotIn("result", row, "legacy events must not acquire a fabricated result")
        floor = max([event["lamport"] for event in expected], default=0)
        self.assertGreaterEqual(data["cursor"], floor)
        self.assertLessEqual(data["cursor"], max((event["lamport"] for event in self.events()), default=0))
        self.assertFalse(data.get("timed_out", False))
