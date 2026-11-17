"""Real journal fixtures and deterministic schedules; no product substitutes."""
import copy
import itertools
import json
import os
from pathlib import Path
import secrets
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from bridge.plan import fold_plan
from bridge.room import _lock, app, store

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
ROOM = "u140"
AGENT = "executor-a"
TS = 1700000000000
MISSING = object()


class RoomCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / "cw"
        clean = {k: v for k, v in os.environ.items() if not k.startswith("CW_")}
        clean.update(CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        self.enterContext(patch.dict(os.environ, clean, clear=True))
        self.enterContext(patch.object(time, "time", return_value=TS / 1000))
        self.enterContext(patch.object(time, "sleep", side_effect=AssertionError("sleep forbidden")))
        self.enterContext(patch.object(_lock, "time", SimpleNamespace(
            monotonic=lambda: 0.0,
            sleep=lambda delay: self.fail("unexpected lock contention"))))
        counter = itertools.count(100)
        self.enterContext(patch.object(secrets, "token_hex", side_effect=lambda n:
                                      format(next(counter), "0%dx" % (2 * n))))
        for target in ("socket.create_connection", "socket.socket.connect",
                       "socket.socket.connect_ex", "socket.socket.sendto"):
            self.enterContext(patch(target, side_effect=AssertionError("network forbidden")))
        template = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
        self.templates = {template["id"]: template}
        directory = self.home / "templates"
        directory.mkdir(parents=True)
        (directory / (template["id"] + ".json")).write_text(json.dumps(template))
        self.template = template
        self.post(self.open_op())
        self.assertEqual(self.projection()["rejected"], [], "invalid fixture")
        self.assertGreater(self.generation, 0)

    @property
    def path(self):
        return self.home / "rooms" / ROOM / "events.jsonl"

    def raw(self):
        return self.path.read_bytes()

    def events(self):
        return [json.loads(line) for line in self.raw().splitlines()]

    def projection(self):
        return fold_plan(self.events(), templates=self.templates)

    @property
    def generation(self):
        return self.projection()["plan"]["opened_lamport"]

    def snapshot(self):
        events = self.events()
        return self.raw(), events[-1]["lamport"], self.projection()

    def open_op(self):
        return dict(kind="plan.open", title="Fencing fixture",
                    template_id=self.template["id"], template_hash=self.template["hash"],
                    brief={"goal": "Verify generation fencing"}, phase="start")

    def add_op(self, title="Guarded work"):
        return dict(kind="task.add", title=title, type="action", phase="start",
                    accept="Verified", microtasks=[{"text": "Execute"}])

    def post(self, op, *, agent=AGENT, **kwargs):
        return store.post(ROOM, agent, "op", "", op=copy.deepcopy(op), home=self.home,
                          clock=lambda: TS, templates=self.templates, **kwargs)

    def backend(self, batch, expected=MISSING, title="Guarded work"):
        kwargs = {} if expected is MISSING else {"expected_opened_lamport": expected}
        try:
            if batch:
                return store.post_ops(ROOM, AGENT,
                                      [self.add_op(title), self.add_op(title + " second")],
                                      home=self.home, clock=lambda: TS,
                                      templates=self.templates, **kwargs)
            return self.post(self.add_op(title), **kwargs)
        except TypeError as exc:
            if expected is not MISSING and "expected_opened_lamport" in str(exc):
                raise self.failureException(
                    "missing backend generation fence: expected_opened_lamport is unsupported") from None
            raise

    def succeeds(self, call):
        try:
            return call()
        except store.RoomError as exc:
            self.fail("matching generation must admit this valid request: %s" % exc)

    def api(self, name, expected=MISSING, **args):
        if expected is not MISSING:
            args["expected_opened_lamport"] = expected
        return app.dispatch(name, dict(room=ROOM, agent=AGENT, **args))["untrusted"]

    def close_plan(self):
        if self.projection()["plan"]["state"] == "closed":
            return
        for task in self.projection()["tasks"]:
            if task["state"] not in ("done", "cancelled"):
                self.post(dict(kind="task.set", task_id=task["id"],
                               base_rev=task["rev"], state="cancelled"))
        self.post(dict(kind="plan.close", base_rev=self.projection()["plan"]["rev"]))

    def reopen(self):
        previous = self.generation
        self.close_plan()
        self.post(self.open_op())
        self.assertGreater(self.generation, previous, "reopen did not change generation")
        self.assertEqual(self.projection()["rejected"], [], "invalid reopen fixture")
        return self.snapshot()

    def refusal(self, call, before=None):
        before = self.snapshot() if before is None else before
        error = None
        try:
            call()
        except store.RoomError as exc:
            error = exc
        self.assertEqual(self.snapshot(), before, "refused generation appended or changed state")
        self.assertIsInstance(error, store.RoomError, "generation mismatch must refuse the request")
        return error

    def mutation_args(self, tool):
        if tool == "task_add":
            return {k: v for k, v in self.add_op().items() if k != "kind"}
        if tool in ("plan_phase", "plan_close"):
            args = {"base_rev": self.projection()["plan"]["rev"]}
            if tool == "plan_phase":
                args["phase"] = "finish"
            return args
        self.post(self.add_op())
        task = self.projection()["tasks"][-1]
        if tool == "task_update":
            return dict(task_id=task["id"], base_rev=task["rev"], title="Updated")
        if tool == "task_claim":
            return dict(task_id=task["id"])
        if tool == "microtask_add":
            return dict(task_id=task["id"], base_rev=task["rev"], text="Verify")
        if tool == "task_release":
            self.post(dict(kind="task.claim", task_id=task["id"]))
            task = self.projection()["tasks"][-1]
            return dict(task_id=task["id"], claim_lamport=task["claim_lamport"])
        if tool == "microtask_set":
            self.post(dict(kind="task.claim", task_id=task["id"]))
            return dict(id=task["microtasks"][0]["id"], state="active")
        raise AssertionError("unknown fixture mutation")

    def race_at_lock(self, call):
        """Reopen after caller pre-read but before its real lock acquisition."""
        real_lock = _lock.lock_exclusive
        state = {"armed": True}

        def acquire(fd, *args, **kwargs):
            if state["armed"]:
                state["armed"] = False
                state["after_reopen"] = self.reopen()
            return real_lock(fd, *args, **kwargs)

        error = None
        with patch.object(_lock, "lock_exclusive", side_effect=acquire):
            try:
                call()
            except store.RoomError as exc:
                error = exc
        self.assertFalse(state["armed"], "writer never reached the race boundary")
        self.assertEqual(self.snapshot(), state["after_reopen"],
                         "stale request appended after the reopener committed")
        self.assertIsInstance(error, store.RoomError, "stale in-flight write was admitted")

    def overlap_at_lock(self, batch):
        """Two overlapping calls, separate lock descriptors, then a third writer.

        Re-entrant scheduling enumerates an actual lock-entry interleaving
        without threads, sleeps, clock deadlines or scheduler dependence.
        """
        expected = self.generation
        real_lock = _lock.lock_exclusive
        state = {"role": "a", "entered": set(), "errors": {}}

        def write(role):
            try:
                self.backend(batch, expected, title="Writer " + role)
            except store.RoomError as exc:
                state["errors"][role] = exc

        def acquire(fd, *args, **kwargs):
            role = state["role"]
            if role not in state["entered"] and role in ("a", "b"):
                state["entered"].add(role)
                if role == "a":
                    state["role"] = "b"
                    write("b")
                else:
                    state["role"] = "reopener"
                    state["after_reopen"] = self.reopen()
                state["role"] = role
            return real_lock(fd, *args, **kwargs)

        with patch.object(_lock, "lock_exclusive", side_effect=acquire):
            write("a")
        self.assertEqual(state["entered"], {"a", "b"}, "overlap precondition was not reached")
        self.assertEqual(self.snapshot(), state["after_reopen"],
                         "overlapping stale writers appended after reopen")
        self.assertEqual(set(state["errors"]), {"a", "b"}, "both stale writers must refuse")
        # Also reject a forged future generation in this hostile history.
        self.refusal(lambda: self.backend(batch, self.generation + 100, title="Forged future"))

    def probe_writer_locked(self):
        """Use a separate real descriptor and fake retry time to test exclusion."""
        fd = os.open(self.path.with_name("events.lock"), os.O_RDWR)
        clock = {"now": 0.0}

        def advance(delay):
            clock["now"] += delay
            self.assertLessEqual(clock["now"], 0.025, "unbounded probe")

        try:
            timing = SimpleNamespace(monotonic=lambda: clock["now"], sleep=advance)
            with patch.object(_lock, "time", timing):
                try:
                    _lock.lock_exclusive(fd, timeout_s=0.02)
                except TimeoutError:
                    return True
                else:
                    _lock.unlock(fd)
                    return False
        finally:
            os.close(fd)

    def commit_under_lock(self, batch):
        real_write, real_sync = os.write, os.fsync
        seen = set()

        def is_journal(fd):
            opened, journal = os.fstat(fd), self.path.stat()
            return (opened.st_dev, opened.st_ino) == (journal.st_dev, journal.st_ino)

        def check(fd, stage):
            if is_journal(fd):
                self.assertTrue(self.probe_writer_locked(), "writer lock released before " + stage)
                seen.add(stage)

        def write(fd, data):
            check(fd, "write")
            return real_write(fd, data)

        def sync(fd):
            check(fd, "fsync")
            return real_sync(fd)

        with patch.object(os, "write", side_effect=write), patch.object(os, "fsync", side_effect=sync):
            self.succeeds(lambda: self.backend(batch, self.generation))
        self.assertEqual(seen, {"write", "fsync"}, "commit observation was incomplete")
