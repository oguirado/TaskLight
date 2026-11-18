"""Isolated room fixtures and a deterministic POSIX process boundary."""
from contextlib import ExitStack, redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from bridge.room import app
from bridge.tests.room.c1b.virtual_cli import BoundExceeded, Clock, Process, Timer


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
TERMINAL = {"finished", "failed"}


class RoomCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="scratch-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.scratch = Path(temporary.name)
        self.home = self.scratch / "home"
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("CW_", "PYTHON"))}
        self.env.update(CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        environment = mock.patch.dict(os.environ, self.env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def journal(self):
        path = self.home / "rooms" / "demo" / "events.jsonl"
        if not path.is_file():
            return []
        return [json.loads(row) for row in path.read_text(encoding="utf-8").splitlines()]

    def lifecycle(self, agent, run_id, state, **extras):
        return app.dispatch("agent_lifecycle", {
            "room": "demo", "agent": agent, "run_id": run_id,
            "state": state, **extras,
        })

    def invoke(self, entry, argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            try:
                code = entry(argv)
            except SystemExit as exc:
                code = exc.code
        return code, stdout.getvalue(), stderr.getvalue()


class VirtualGroup:
    """One direct child, an optional descendant and a separate sentinel group."""

    wrapper_pgid = 8999
    sentinel_pgid = 9000

    def __init__(self, *, duration=0.5, status=0, startup=0, descendant=False,
                 signal_status=None, interrupts=(), launch_error=None):
        self.clock = Clock()
        self.clock_reads = 0
        self.duration = duration
        self.status = status
        self.startup = startup
        self.descendant_alive = descendant
        self.signal_status = signal_status
        self.interrupts = interrupts
        self.launch_error = launch_error
        self.child = None
        self.reaped = False
        self.sentinel_alive = True
        self.handlers = {}
        self.signals = []
        self.events = []
        self.launches = []
        self.spawned_at = None

    def install(self, stack):
        def patch(owner, name, effect):
            stack.enter_context(mock.patch.object(owner, name, side_effect=effect))

        def deny_network(*args, **kwargs):
            raise BoundExceeded("network forbidden")

        patch(time, "monotonic", self.read_clock)
        patch(time, "monotonic_ns", lambda: int(self.read_clock() * 1e9))
        patch(time, "perf_counter", self.read_clock)
        patch(time, "time", lambda: 1_800_000_000)
        patch(time, "sleep", self.clock.advance)
        patch(threading, "Timer", lambda *args, **kwargs: Timer(self.clock, *args, **kwargs))
        patch(subprocess, "Popen", self.spawn)
        stack.enter_context(mock.patch.object(threading.Event, "wait", self.event_wait))
        patch(signal, "signal", self.set_handler)
        patch(signal, "getsignal", lambda number: self.handlers.get(number, signal.SIG_DFL))
        patch(os, "getpgid", self.getpgid)
        patch(os, "getpgrp", lambda: self.wrapper_pgid)
        patch(os, "killpg", self.group_signal)
        patch(os, "kill", self.kill)
        patch(os, "waitid", self.waitid)
        patch(os, "waitpid", self.waitpid)
        patch(socket, "socket", deny_network)
        patch(socket, "create_connection", deny_network)

    def read_clock(self):
        self.clock_reads += 1
        if self.clock_reads > 10_000:
            raise BoundExceeded("unbounded virtual clock polling")
        return self.clock.now

    def event_wait(self, event, timeout=None):
        if not event.is_set():
            if timeout is None:
                raise BoundExceeded("unbounded virtual event wait")
            self.clock.advance(timeout)
        return event.is_set()

    def set_handler(self, number, handler):
        previous = self.handlers.get(number, signal.SIG_DFL)
        self.handlers[number] = handler
        return previous

    def schedule(self, delay, callback, *args):
        Timer(self.clock, delay, callback, args).start()

    def deliver_wrapper_signal(self, number):
        handler = self.handlers.get(number)
        if callable(handler):
            handler(number, None)

    def spawn(self, argv, *args, **kwargs):
        self.launches.append((list(argv), dict(kwargs)))
        if len(self.launches) != 1:
            raise BoundExceeded("standalone run attempted more than one launch")
        if self.launch_error is not None:
            raise self.launch_error
        self.clock.advance(self.startup)
        self.spawned_at = self.clock.now
        group = self

        class Child(Process):
            def poll(self):
                code = super().poll()
                if code is not None:
                    group.reaped = True
                return code

            def send_signal(self, number):
                group.direct_signal(number)

        self.child = Child(self.clock, self.duration, self.status, argv)
        self.child.pgid = (self.child.pid if kwargs.get("start_new_session")
                           or kwargs.get("process_group") == 0 else self.wrapper_pgid)
        for delay, number in self.interrupts:
            self.schedule(delay, self.deliver_wrapper_signal, number)
        return self.child

    def getpgid(self, pid):
        if pid in (0, os.getpid()):
            return self.wrapper_pgid
        if self.child is not None and pid == self.child.pid and not self.reaped:
            return self.child.pgid
        raise ProcessLookupError(pid)

    def kill(self, pid, number):
        if pid < 0:
            return self.group_signal(-pid, number)
        if self.child is None or pid != self.child.pid:
            raise BoundExceeded("signal attempted against an unrelated process")
        self.direct_signal(number)

    def direct_signal(self, number):
        if number:
            self.signals.append((self.clock.now, self.child.pid, number, "leader"))
            self.signal_leader(number)

    def group_signal(self, pgid, number):
        if pgid == self.sentinel_pgid:
            if number:
                self.sentinel_alive = False
            return
        if self.child is None or pgid != self.child.pgid or pgid == self.wrapper_pgid:
            raise BoundExceeded("signal attempted against a group the child does not own")
        if self.reaped and not self.descendant_alive:
            raise ProcessLookupError(pgid)
        if number and (self.clock.now < self.child.end or self.descendant_alive):
            self.signals.append((self.clock.now, pgid, number, "group"))
            self.signal_leader(number)
        if number == signal.SIGKILL:
            self.descendant_alive = False

    def signal_leader(self, number):
        if self.clock.now < self.child.end:
            if number == signal.SIGKILL:
                self.child.code = -number
            elif self.signal_status is not None:
                self.child.code = self.signal_status
            else:
                return
            self.child.end = self.clock.now

    def waitid(self, kind, identity, options):
        child = self.child
        if child is None or identity != child.pid or self.reaped:
            raise ChildProcessError(identity)
        if self.clock.now < child.end:
            if options & os.WNOHANG:
                return None
            self.clock.advance(child.end - self.clock.now)
        if not options & os.WNOWAIT:
            child.poll()
        return SimpleNamespace(si_pid=child.pid, si_status=abs(child.code),
                               si_code=os.CLD_KILLED if child.code < 0 else os.CLD_EXITED)

    def waitpid(self, pid, options):
        result = self.waitid(os.P_PID, pid, options)
        if result is None:
            return 0, 0
        return pid, result.si_status if self.child.code < 0 else result.si_status << 8

    def observe(self, args):
        if len(self.events) >= 100:
            raise BoundExceeded("unbounded lifecycle emissions")
        self.events.append(SimpleNamespace(at=self.clock.now, data=dict(args),
                                           reaped=self.reaped, descendant=self.descendant_alive))
        return {"ok": True, "lamport": len(self.events)}

    def run(self, case, options=(), child=("fixture-executable",)):
        from bridge.room import ext

        with ExitStack() as stack:
            self.install(stack)
            stack.enter_context(mock.patch.dict(app.V2_DISPATCH, {"agent_lifecycle": self.observe}))
            stack.enter_context(mock.patch.dict(ext.EXT_DISPATCH, {"agent_lifecycle": self.observe}))
            from bridge.room.__main__ import main
            result = case.invoke(main, ["run", "--room", "demo", "--agent", "lane-a",
                                        "--run-id", "attempt-a", *options, "--", *child])
            count = len(self.events)
            self.clock.advance(30)
            case.assertEqual(len(self.events), count, "lifecycle emissions continued after return")
        return result
