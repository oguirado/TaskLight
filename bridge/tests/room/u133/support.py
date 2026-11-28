"""Contract fixtures: fixed clocks, public dispatch, real task-release fold."""
import contextlib
import copy
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import signal
import socket
import tempfile
import sys
import time
import unittest
from unittest import mock

from bridge.plan.errors import PlanError
from bridge.plan.fold import apply_op_event, empty_projection
from bridge.room import app
from bridge.room.store import RoomError


# A-FLK1: Preserve real sleeps only for direct stdlib wait callers. Product
# sleeps still fail, including product callbacks reached through stdlib frames.
_REAL_SLEEP = time.sleep


def _sleep_guard(message="real sleep forbidden"):
    def guarded_sleep(delay):
        caller_globals = sys._getframe(1).f_globals
        if any(caller_globals is vars(sys.modules[name])
               for name in ("subprocess", "threading", "selectors")
               if name in sys.modules):
            return _REAL_SLEEP(delay)
        raise AssertionError(message)
    return guarded_sleep


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
L = 100


def encode(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def payload(state="deployed", **fields):
    return dict(event_id="deploy-a", room="demo", agent="exec-a", state=state,
                run_id="r1", **fields)


def digest(parts):
    return hashlib.sha256(encode(parts)).hexdigest()


def success(lamport=L):
    return {"untrusted": {"ok": True, "lamport": lamport}}


def event(n, op, agent="exec-a"):
    return dict(id="event-%016x" % n, room="demo", agent=agent, act="op",
                text="", ts=1000, lamport=n, op=copy.deepcopy(op))


def work_projection():
    """Build public fixture shapes using the shipped fold, not guessed fields."""
    state = empty_projection()
    n = 0

    def add(op, agent="exec-a"):
        nonlocal state, n
        n += 1
        state, _ = apply_op_event(state, event(n, op, agent))

    add(dict(kind="plan.open", title="Hook oracle", template_id="blank",
             template_hash="a" * 64, brief={"goal": "Verify cleanup"}, phase="start"))
    for i in range(1, 6):
        add(dict(kind="task.add", title="Work %d" % i, type="action", phase="start",
                 accept="", deps=[], microtasks=[{"text": "Check"}, {"text": "Keep"}]))
        tid = "T%02d" % i
        owner = "other" if i == 3 else "exec-a"
        add(dict(kind="task.claim", task_id=tid), owner)
        add(dict(kind="micro.set", micro_id=tid + ".M01", state="active"), owner)
        add(dict(kind="micro.set", micro_id=tid + ".M02", state="done",
                 outcome="Keep completed outcome", took="1m"), owner)
    # Terminal work remains owned to discriminate the Amendment B exclusion.
    for index, status in ((3, "done"), (4, "cancelled")):
        task = state["tasks"][index]
        if status == "done":
            add(dict(kind="micro.set", micro_id=task["id"] + ".M01", state="done",
                     outcome="Complete", took="1m"))
        else:
            add(dict(kind="task.set", task_id=task["id"], base_rev=task["rev"], state=status))
    state["agent_lifecycle"] = {"exec-a": {"run_id": "r1", "lifecycle": "failed"}}
    return state


class Boundary:
    """U132 frozen replies; U109 release semantics use the real public fold.

    This is an explicit dependency double, not proof of U132 journal admission.
    Hooks see only app.dispatch; tests never depend on hook private functions.
    """
    def __init__(self, projection=None):
        self.projection = copy.deepcopy(projection)
        self.calls = []
        self.events = []
        self.receipts = {}
        self.now_ms = 1000
        self.last_alive = None
        self.on_read = None
        self.on_release = None
        self.on_lifecycle = None
        self.reads = 0

    def __call__(self, name, args):
        self.calls.append((name, copy.deepcopy(args)))
        if name == "agent_lifecycle":
            if self.on_lifecycle:
                self.on_lifecycle(args)
            oid = args["op_id"]
            if oid in self.receipts:
                original, result = self.receipts[oid]
                if original != args:
                    raise RoomError("bad_op", "op_id conflict")
                return copy.deepcopy(result)
            if args["state"] == "alive" and self.last_alive is not None:
                if self.now_ms - self.last_alive < 30000:
                    return success(self.last_alive_lamport)
            lamport = L + len(self.events)
            result = success(lamport)
            self.events.append((name, copy.deepcopy(args), lamport))
            self.receipts[oid] = (copy.deepcopy(args), result)
            if args["state"] == "alive":
                self.last_alive = self.now_ms
                self.last_alive_lamport = lamport
            if self.projection is not None:
                self.projection.setdefault("agent_lifecycle", {})[args["agent"]] = {
                    "run_id": args["run_id"], "lifecycle": args["state"]}
            return copy.deepcopy(result)
        if name == "plan_get":
            self.reads += 1
            if self.on_read:
                self.on_read(self)
            if self.projection is None:
                raise RoomError("no_plan", "no active plan")
            return {"untrusted": copy.deepcopy(self.projection)}
        if name == "task_release":
            if self.on_release:
                self.on_release(self, args)
            oid = args["op_id"]
            if oid in self.receipts:
                return copy.deepcopy(self.receipts[oid][1])
            op = dict(kind="task.release", **{k: v for k, v in args.items()
                                              if k not in ("room", "agent")})
            lamport = L + len(self.events)
            try:
                updated, _ = apply_op_event(self.projection, event(lamport, op, args["agent"]))
            except PlanError as exc:
                raise RoomError(exc.code, str(exc)) from exc
            self.projection = updated
            result = success(lamport)
            self.events.append((name, copy.deepcopy(args), lamport))
            self.receipts[oid] = (copy.deepcopy(args), result)
            return result
        raise AssertionError("forbidden tool: " + name)

    def releases(self):
        return [args for name, args in self.calls if name == "task_release"]


class FakeTimer:
    """POSIX timer API with explicit delivery; never arms an OS timer."""
    def __init__(self):
        self.handlers = {}
        self.armed = False
        self.delays = []

    def signal(self, signum, handler):
        old = self.handlers.get(signum, signal.SIG_DFL)
        self.handlers[signum] = handler
        return old

    def setitimer(self, which, seconds, interval=0):
        self.armed = seconds > 0
        if self.armed:
            self.delays.append(seconds)
        return (0.0, 0.0)

    def alarm(self, seconds):
        self.setitimer(signal.ITIMER_REAL, seconds)
        return 0

    def fire(self):
        handler = self.handlers.get(signal.SIGALRM)
        if not self.armed or not callable(handler):
            raise AssertionError("POSIX deadline was not armed before a wait")
        handler(signal.SIGALRM, None)
        raise AssertionError("deadline handler returned into a blocked wait")

    def install(self, stack):
        if os.name != "posix" or not hasattr(signal, "setitimer"):
            return
        stack.enter_context(mock.patch.object(signal, "signal", side_effect=self.signal))
        stack.enter_context(mock.patch.object(signal, "getsignal", side_effect=lambda n: self.handlers.get(n, signal.SIG_DFL)))
        stack.enter_context(mock.patch.object(signal, "setitimer", side_effect=self.setitimer))
        stack.enter_context(mock.patch.object(signal, "alarm", side_effect=self.alarm))


class HookCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.room = self.home / "rooms/demo"
        self.room.mkdir(parents=True)
        self.now = 10.0
        self.timer = FakeTimer()
        stack = self.enterContext(contextlib.ExitStack())
        stack.enter_context(mock.patch.dict(os.environ, {"CW_HOME": str(self.home),
                            "PYTHONDONTWRITEBYTECODE": "1"}))
        stack.enter_context(mock.patch.object(time, "monotonic", side_effect=lambda: self.now))
        stack.enter_context(mock.patch.object(time, "perf_counter", side_effect=lambda: self.now))
        stack.enter_context(mock.patch.object(time, "monotonic_ns", side_effect=lambda: int(self.now * 1000000000)))
        stack.enter_context(mock.patch.object(time, "perf_counter_ns", side_effect=lambda: int(self.now * 1000000000)))
        stack.enter_context(mock.patch.object(time, "time", side_effect=lambda: 1.0 + self.now - 10.0))
        stack.enter_context(mock.patch.object(time, "sleep", new=_sleep_guard()))
        stack.enter_context(mock.patch.object(socket, "socket", side_effect=AssertionError("network forbidden")))
        stack.enter_context(mock.patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")))
        self.timer.install(stack)
        self.real_dispatch = app.dispatch
        self.boundary = lambda name, args: success()
        stack.enter_context(mock.patch.object(app, "dispatch", side_effect=lambda name, args: self.boundary(name, args)))
        # Install the public dependency before loading the module, so both
        # module-qualified and directly imported dispatch references work.
        self.hook = importlib.import_module("bridge.room.hook")
        importlib.reload(self.hook)
        # All cases, including CLI/control tests, first exercise the public seam.
        # The real NotImplementedError is propagated, never counted as a mutant.
        self.assertEqual(self.hook.run_hook_bytes(encode(payload())), success())

    def invoke(self, value=None, boundary=None, raw=None):
        boundary = boundary if boundary is not None else Boundary()
        self.boundary = boundary
        return self.hook.run_hook_bytes(raw if raw is not None else encode(value or payload()))

    def assert_error(self, result, code):
        # Existing dispatch errors are unwrapped; success alone is untrusted.
        self.assertIsInstance(result, dict)
        self.assertIs(result.get("ok"), False)
        self.assertEqual(result.get("code"), code)

    def assert_cleaned(self, projection):
        tasks = {t["id"]: t for t in projection["tasks"]}
        for tid in ("T01", "T02"):
            self.assertIsNone(tasks[tid]["assignee"], "cleanup omitted " + tid)
            self.assertEqual(tasks[tid]["microtasks"][0]["state"], "pending")

