"""Fresh-interpreter virtual process/time fixture for the real CLI entry.

Only stdlib process and clock boundaries are substituted. No future supervisor
module or callable is imported or prescribed. Stream and signal contracts use
real Python children in test_run.py instead.
"""
import contextlib
import copy
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import threading
import time
from unittest import mock

from bridge.room import app, ext, store
from bridge.room.ext import lifecycle


class BoundExceeded(BaseException):
    """Escape broad product error handling when a virtual scenario is unbounded."""


class Clock:
    def __init__(self):
        self.now = 0.0
        self.timers = []
        self.steps = 0

    def advance(self, seconds):
        seconds = float(seconds)
        if seconds < 0 or self.steps > 10000:
            raise BoundExceeded("invalid or unbounded virtual wait")
        self.steps += 1
        target = self.now + seconds
        while True:
            pending = [timer for timer in self.timers if timer.active and timer.due <= target]
            if not pending:
                break
            timer = min(pending, key=lambda item: item.due)
            self.now = max(self.now, timer.due)
            timer.active = False
            self.steps += 1
            if self.steps > 10000:
                raise BoundExceeded("unbounded virtual timer callbacks")
            timer.function(*timer.args, **timer.kwargs)
        self.now = max(self.now, target)


class Timer:
    def __init__(self, clock, interval, function, args=None, kwargs=None):
        self.clock, self.interval, self.function = clock, interval, function
        self.args, self.kwargs = args or (), kwargs or {}
        self.active = False
        self.daemon = False

    def start(self):
        self.due = self.clock.now + float(self.interval)
        self.active = True
        self.clock.timers.append(self)

    def cancel(self):
        self.active = False

    def join(self, timeout=None):
        if self.active:
            self.clock.advance(max(0, self.due - self.clock.now) if timeout is None else timeout)

    def is_alive(self):
        return self.active


class Process:
    """Popen-compatible child whose observed lifetime is entirely synthetic."""
    def __init__(self, clock, duration, code, args):
        self.clock, self.end, self.code = clock, clock.now + duration, code
        self.args, self.returncode, self.pid = args, None, 12345
        self.stdin = self.stdout = self.stderr = None

    def poll(self):
        if self.clock.now >= self.end:
            self.returncode = self.code
        return self.returncode

    def wait(self, timeout=None):
        if self.poll() is not None:
            return self.returncode
        remaining = self.end - self.clock.now
        self.clock.advance(remaining if timeout is None else min(float(timeout), remaining))
        if self.poll() is None:
            raise subprocess.TimeoutExpired(self.args, timeout)
        return self.returncode

    def communicate(self, input=None, timeout=None):
        self.wait(timeout)
        return None, None

    def send_signal(self, number):
        self.code, self.end = -number, self.clock.now
        self.poll()

    def terminate(self):
        self.send_signal(signal.SIGTERM)

    def kill(self):
        self.send_signal(signal.SIGKILL)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.wait()


def main():
    configuration = json.loads(os.environ["C1B_PROBE"])
    clock = Clock()
    attempts, launches = [], []
    handler = lifecycle.agent_lifecycle
    processes = []
    report = {"exception": None}

    def record(args):
        if len(attempts) >= 100:
            raise BoundExceeded("unbounded lifecycle emission")
        attempts.append({"at": clock.now, "args": copy.deepcopy(args)})
        if args["state"] in configuration["fail"]:
            raise store.RoomError("internal", "injected journal failure")
        if configuration["parent_seam"]:
            return {"ok": True, "lamport": len(attempts)}
        return handler(args)

    def popen(args, *positional, **kwargs):
        launches.append({"at": clock.now, "shell": bool(kwargs.get("shell", False)),
                         "deployed": bool(attempts and attempts[0]["args"].get("state") == "deployed")})
        process = Process(clock, configuration["beat"] * 2.5, configuration["code"], args)
        processes.append(process)
        return process

    def event_wait(event, timeout=None):
        if not event.is_set():
            remaining = max(0, processes[0].end - clock.now) if processes else 0
            clock.advance(remaining if timeout is None else timeout)
        return event.is_set()

    def deny_network(*args, **kwargs):
        raise BoundExceeded("network forbidden")

    class ExitQueue:
        """Deterministic stand-in for the BSD kqueue exit probe.

        The synthetic child is not a kernel process, so a real kqueue would
        resolve its registration against a foreign PID and report NOTE_EXIT
        immediately. This stand-in accepts any registration and delivers the
        exit notification exactly when the virtual child has exited.
        """

        def control(self, changes, max_events, timeout):
            child = processes[0] if processes else None
            if changes:
                if child is not None and child.poll() is not None:
                    raise ProcessLookupError("already exited")
                return []
            if child is not None and child.poll() is not None:
                return [object()]
            return []

        def close(self):
            pass

    result = 2
    try:
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(time, "time", side_effect=lambda: 1800000000.0 + clock.now))
            stack.enter_context(mock.patch.object(time, "monotonic", side_effect=lambda: clock.now))
            stack.enter_context(mock.patch.object(time, "perf_counter", side_effect=lambda: clock.now))
            stack.enter_context(mock.patch.object(time, "sleep", side_effect=clock.advance))
            stack.enter_context(mock.patch.object(time, "time_ns", side_effect=lambda: int((1800000000.0 + clock.now) * 1e9)))
            stack.enter_context(mock.patch.object(time, "monotonic_ns", side_effect=lambda: int(clock.now * 1e9)))
            stack.enter_context(mock.patch.object(subprocess, "Popen", side_effect=popen))
            stack.enter_context(mock.patch.object(threading, "Timer", side_effect=lambda *a, **kw: Timer(clock, *a, **kw)))
            stack.enter_context(mock.patch.object(threading.Event, "wait", event_wait))
            stack.enter_context(mock.patch.object(lifecycle, "agent_lifecycle", side_effect=record))
            stack.enter_context(mock.patch.dict(app.V2_DISPATCH, {"agent_lifecycle": record}))
            stack.enter_context(mock.patch.dict(ext.EXT_DISPATCH, {"agent_lifecycle": record}))
            stack.enter_context(mock.patch.object(socket, "socket", side_effect=deny_network))
            stack.enter_context(mock.patch.object(socket, "create_connection", side_effect=deny_network))
            if hasattr(select, "kqueue"):
                # Only BSD-derived platforms reach the kqueue exit probe; keep
                # the probe deterministic against the synthetic child.
                stack.enter_context(mock.patch.object(select, "kqueue", side_effect=ExitQueue))
            # Import after clock/process replacement so from-imports see the same boundary.
            from bridge.room.__main__ import main as cli
            try:
                result = cli(sys.argv[1:])
            except SystemExit as exc:
                result = exc.code
            report["after_return"] = len(attempts)
            clock.advance(configuration["beat"] * 3)
            report["after_drain"] = len(attempts)
    except BaseException as exc:
        report["exception"] = type(exc).__name__ + ": " + str(exc)
    finally:
        report.update(attempts=attempts, launches=launches)
        Path(configuration["report"]).write_text(json.dumps(report), encoding="utf-8")
    return result


if __name__ == "__main__":
    sys.exit(main())
