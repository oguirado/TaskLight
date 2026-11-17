"""Real folds and existing adapters; no snapshot substitute or product stubs."""
import contextlib
import copy
import importlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
import unittest
from unittest import mock

from bridge.plan.fold import fold_plan
from bridge.plan.template import validate_template
from bridge.room import app, mcp
from bridge.room import __main__ as cli

emit = importlib.import_module("bridge.wall.emit")
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
STATES = ("working", "waiting", "idle", "registered", "finished", "failed", "unknown")
SECTIONS = ("completed_since", "available_work", "attention", "agents")
SECRET = "password=hunter2-SYNTHETIC"
RAW = "hunter2-SYNTHETIC"
MARKER = "password=[REDACTED:KEY_ASSIGN]"
C2 = json.loads((ROOT / "bridge/tests/room/c2/fixtures/inventories.json").read_text())


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def unwrap(value):
    return value.get("untrusted", value)


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


def mentions(value, identity):
    # Both plain IDs and generation-qualified keys are permitted by M2.
    return any(s == identity or s.endswith(":" + identity) for s in strings(value))


def kind(row):
    return row.get("kind", row.get("type", row.get("category")))


class SnapshotCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="runtime-", dir=HERE)
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.now = 150000
        self.enterContext(mock.patch.dict(os.environ, {
            "CW_HOME": str(self.home), "CW_AGENT": "", "CW_ROLE": "",
            "CW_SESSION_AGENT": "", "CW_SESSION_ROLE": "",
            "PYTHONDONTWRITEBYTECODE": "1",
        }))
        self.enterContext(mock.patch.object(time, "time", side_effect=lambda: self.now / 1000))
        self.enterContext(mock.patch.object(time, "monotonic", return_value=10.0))
        self.enterContext(mock.patch.object(time, "sleep", side_effect=AssertionError("real timers forbidden")))
        self.enterContext(mock.patch.object(socket, "socket", side_effect=AssertionError("network forbidden")))
        self.enterContext(mock.patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")))
        self.template = copy.deepcopy(C2["template"])
        self.install_template(self.template)
        self.events = []
        self.path = self.home / "rooms/demo/events.jsonl"
        self.path.parent.mkdir(parents=True)
        self.path.write_bytes(b"")

    def install_template(self, template):
        template = copy.deepcopy(template)
        template.pop("hash", None)
        self.template = validate_template(template)
        directory = self.home / "templates"
        directory.mkdir(exist_ok=True)
        (directory / (self.template["id"] + ".json")).write_text(compact(self.template), encoding="utf-8")

    def flush(self):
        self.path.write_text("".join(compact(e) + "\n" for e in self.events), encoding="utf-8")

    def event(self, *, agent="planner", act="op", text="", op=None, **fields):
        lamport = len(self.events) + 1
        event = dict(id=f"e-{lamport:016x}", room="demo", agent=agent,
                     act=act, text=text, lamport=lamport, ts=self.now, **fields)
        if op is not None:
            event["op"] = op
        self.events.append(event)
        self.flush()
        return event

    def op(self, kind_, agent="planner", **fields):
        return self.event(agent=agent, op=dict(kind=kind_, **fields))

    def life(self, agent="worker", state="deployed", **fields):
        fields.setdefault("run_id", "r1")
        if state in ("failed", "finished") and not any(
                e.get("agent") == agent and e.get("op", {}).get("kind") == "agent.lifecycle"
                and e["op"].get("run_id") == fields["run_id"] for e in self.events):
            self.life(agent=agent, harness=fields.get("harness", "codex"), run_id=fields["run_id"])
        fields.setdefault("op_id", f"life-{len(self.events) + 1:04d}")
        return self.op("agent.lifecycle", agent=agent, state=state, **fields)

    def plan(self):
        return self.op("plan.open", title="Snapshot oracle", template_id=self.template["id"],
                       template_hash=self.template["hash"], brief={"goal": "Verify snapshots"}, phase="plan")

    def task(self, *, owner=None, micros=1, title="A useful task", deps=None):
        task_id = f"T{1 + sum(e.get('op', {}).get('kind') == 'task.add' for e in self.events):02d}"
        fields = dict(title=title, type="task", phase="plan", accept="Verified",
                      microtasks=[dict(text=f"Check {i}", accept="Verified") for i in range(micros)])
        if owner is not None:
            fields["assignee"] = owner
        if deps is not None:
            fields["deps"] = deps
        self.op("task.add", **fields)
        return task_id

    def projection(self, *, rejected=0):
        projection = fold_plan(self.events, templates={self.template["id"]: self.template})
        self.assertEqual(len(projection["rejected"]), rejected,
                         "fixture admission must be proved before testing C3")
        return projection

    def fixture(self, name):
        case = copy.deepcopy(next(c for c in C2["cases"] if c["name"] == name))
        self.now, self.events = case["now"], case["events"]
        self.flush()
        self.projection()
        return case

    def advertised(self):
        tools = [t for t in app.list_tools() if t["name"] == "orchestrator_snapshot"]
        self.assertEqual(len(tools), 1, "M1 missing orchestrator_snapshot registration")
        return tools[0]

    def rpc(self, method, params):
        replies = []
        with mock.patch.object(mcp, "_send", side_effect=replies.append):
            mcp._handle(17, method, params)
        self.assertEqual(len(replies), 1, "one bounded MCP response required")
        return replies[0]

    def call(self, **args):
        reply = self.rpc("tools/call", dict(name="orchestrator_snapshot", arguments=args))
        self.assertNotIn("error", reply, "M1 existing MCP adapter must dispatch C3")
        result = reply["result"]
        payload = json.loads(result["content"][0]["text"])
        return result, payload

    def snapshot(self, **overrides):
        args = dict(room="demo", now=self.now)
        args.update(overrides)
        before = self.path.read_bytes()
        result, payload = self.call(**args)
        self.assertEqual(self.path.read_bytes(), before, "M7 snapshot must leave journal bytes identical")
        self.assertFalse(result.get("isError", False),
                         "M1 valid orchestrator_snapshot request rejected: " + compact(payload))
        data = unwrap(payload)
        self.assertIn("agents", data, "M2 successful snapshot must contain inventory")
        return data, payload

    def contract(self, data):
        required = {"room", "head_lamport", "generated_at", "freshness", "complete",
                    "agents", "attention", "available_work", "completed_since", "omitted", "cursor"}
        self.assertTrue(required <= data.keys(), "M2 missing snapshot fields")
        self.assertEqual(data["room"], "demo")
        self.assertIs(type(data["head_lamport"]), int)
        self.assertEqual(data["cursor"], data["head_lamport"])
        self.assertIn(data["freshness"], ("current", "stale", "unavailable"))
        self.assertIs(type(data["complete"]), bool)
        agents = data["agents"]
        self.assertIsInstance(agents, dict)
        self.assertIn("totals", agents)
        self.assertIn("rows", agents)
        totals = agents["totals"]
        self.assertEqual(set(totals), set(STATES) | {"total"})
        self.assertTrue(all(type(n) is int and n >= 0 for n in totals.values()))
        self.assertEqual(sum(totals[s] for s in STATES), totals["total"])
        self.assertTrue(set(SECTIONS) <= data["omitted"].keys())
        for section in SECTIONS:
            self.assertIs(type(data["omitted"][section]), int)
            self.assertGreaterEqual(data["omitted"][section], 0)
        if any(data["omitted"].get(s, 0) for s in SECTIONS):
            self.assertFalse(data["complete"], "M4 an omitted row forbids complete:true")
        for row in agents["rows"]:
            self.assertTrue({"agent", "state", "parent", "harness", "current", "last_seen_lamport"} <= row.keys())
            self.assertIn(row["state"], STATES)
            if row["current"] is not None:
                self.assertEqual(set(row["current"]), {"task_id", "micro_id"})
        for section in ("attention", "available_work", "completed_since"):
            self.assertIsInstance(data[section], list)

    def run_cli(self, args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                rc = cli.main(["call", "orchestrator_snapshot", "--json", compact(args)])
            except SystemExit as exc:
                rc = exc.code
        return rc, out.getvalue(), err.getvalue()

    def assert_refusal(self, args):
        self.advertised()  # Unknown-tool refusal cannot pass a negative control.
        before = self.path.read_bytes()
        result, payload = self.call(**args)
        self.assertTrue(result.get("isError", False), "invalid arguments must fail closed")
        self.assertFalse(unwrap(payload).get("ok", True))
        self.assertEqual(self.path.read_bytes(), before)

    @contextlib.contextmanager
    def broken_sanitizer(self):
        self.advertised()
        original = emit.sanitize_output
        # Cover ordinary from-import aliases of the same shared function.
        aliases = [(module, name) for module in list(sys.modules.values())
                   if module is not None and getattr(module, "__name__", "").startswith("bridge.")
                   for name, value in list(vars(module).items()) if value is original]
        with contextlib.ExitStack() as stack:
            for module, name in aliases:
                stack.enter_context(mock.patch.object(module, name, side_effect=RuntimeError(SECRET)))
            yield
