"""Public-contract helpers; no replacement lifecycle implementation."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest import mock

from bridge.plan.errors import PlanError
from bridge.plan.fold import apply_op_event, empty_projection, fold_plan
from bridge.room import app, ext, store
from bridge.room.ext.lifecycle import agent_lifecycle

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
FIXTURE_PATH = ROOT / "tests/unit/u132/fixtures.json"
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
ARGS = FIXTURE["a1_args"]
TEMPLATES = {"blank": FIXTURE["template"]}


def event(n, op, agent="exec-a", ts=None, room="demo"):
    return dict(id=f"e-{n:016x}", room=room, agent=agent, act="op", text="",
                lamport=n, ts=n * 1000 if ts is None else ts, op=copy.deepcopy(op))


def lifecycle_event(n, state="deployed", run="r1", ts=None, **meta):
    return event(n, dict(kind="agent.lifecycle", state=state, run_id=run,
                         op_id=f"life{n:04d}", **meta), ts=ts)


def semantic(projection):
    """Lifecycle and replay cursors must not alter planning semantics."""
    return copy.deepcopy({k: projection[k] for k in
                          ("plan", "tasks", "memory", "archived_plans", "rollup")})


def assert_frozen(projection, history):
    actual = projection.get("agent_lifecycle")
    if actual != history["expected_agent_lifecycle"]:
        raise AssertionError("frozen lifecycle expectation: " + history["name"])
    rejected = [{"lamport": r["lamport"], "code": r["code"]}
                for r in projection["rejected"]]
    if rejected != history["rejected"]:
        raise AssertionError("frozen rejection expectation: " + history["name"])


def probe():
    """Real minimal deployment prerequisite, also used by TypeScript tests.

    Do not catch NotImplementedError: red must name the real handler stub.
    The room is isolated and all temporary writes stay in this test directory.
    """
    with tempfile.TemporaryDirectory(dir=HERE) as directory:
        with mock.patch.dict(os.environ, {"CW_HOME": directory}), \
             mock.patch.object(store.time, "time", return_value=1.0):
            result = agent_lifecycle(copy.deepcopy(ARGS))
            if result != {"ok": True, "lamport": 1}:
                raise AssertionError("A1 minimal deployment receipt")
            path = Path(directory) / "rooms/demo/events.jsonl"
            events = [json.loads(s) for s in path.read_text().splitlines()]
            if len(events) != 1:
                raise AssertionError("A1 exactly one committed event")
            assert_frozen(fold_plan(events), FIXTURE["histories"][0])
    return {"ok": True}


class LifecycleCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.now = 1000
        self.enterContext(mock.patch.dict(os.environ, {
            "CW_HOME": str(self.home), "PYTHONDONTWRITEBYTECODE": "1"}))
        self.enterContext(mock.patch.object(store.time, "time", side_effect=lambda: self.now / 1000))
        # No test contacts a network service; transports are driven in process.
        self.enterContext(mock.patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")))
        self.enterContext(mock.patch.object(socket, "socket", side_effect=AssertionError("network forbidden")))
        self.call = agent_lifecycle
        # All behavior tests stop here at the actual stub until implementation.
        self.first = self.call(copy.deepcopy(ARGS))

    def path(self, room="demo"):
        return self.home / "rooms" / room / "events.jsonl"

    def raw(self, room="demo"):
        p = self.path(room)
        return p.read_bytes() if p.exists() else b""

    def events(self, room="demo"):
        return [json.loads(s) for s in self.raw(room).splitlines() if s]

    def projection(self, room="demo"):
        return fold_plan(self.events(room), templates=TEMPLATES)

    def reset(self, events=(), room="demo"):
        path = self.path(room)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(e, ensure_ascii=True) + "\n" for e in events), encoding="utf-8")

    def invoke(self, state="alive", run="r1", room="demo", agent="exec-a", **meta):
        args = dict(room=room, agent=agent, state=state, run_id=run,
                    op_id=f"call{len(self.events(room)):04d}-{self.now}")
        args.update(meta)
        return self.call(args)

    def deny(self, args, code, room="demo"):
        before = self.raw(room)
        projection = self.projection(room)
        with self.assertRaises(store.RoomError) as caught:
            self.call(args)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.raw(room), before, "rejected input appended bytes")
        self.assertEqual(self.projection(room), projection, "rejection changed projection")
        return str(caught.exception)

    def post(self, op, agent="exec-a", room="demo"):
        return store.post(room, agent, "op", "", op=op, clock=lambda: self.now,
                          templates=TEMPLATES)

    def active_work(self):
        self.post(dict(kind="memory.set", section="goal", text="Verify lifecycle", base_rev=0))
        self.post(copy.deepcopy(FIXTURE["open_op"]))
        self.post(copy.deepcopy(FIXTURE["add_op"]))
        self.post(dict(kind="task.claim", task_id="T01"))
        self.post(dict(kind="micro.set", micro_id="T01.M01", state="active"))

    def api(self, transport, args):
        if transport == "dispatch":
            try:
                return app.dispatch("agent_lifecycle", args)
            except store.RoomError as exc:
                return {"ok": False, "code": exc.code, "detail": str(exc)}
        if transport == "mcp":
            from bridge.room import mcp
            sent = []
            with mock.patch.object(mcp, "_send", side_effect=sent.append):
                mcp._handle(7, "tools/call", {"name": "agent_lifecycle", "arguments": args})
            self.assertEqual(len(sent), 1)
            response = sent[0]
            self.assertNotIn("error", response)
            return json.loads(response["result"]["content"][0]["text"])
        if transport == "cli":
            from bridge.room import __main__ as cli
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                rc = cli.main(["call", "agent_lifecycle", "--json", json.dumps(args)])
            payload = json.loads(output.getvalue())
            self.assertEqual(rc, 0 if payload.get("untrusted", {}).get("ok") else 3)
            return payload
        raise AssertionError("unknown test transport")
