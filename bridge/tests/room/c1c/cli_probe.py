"""Run the real module entry under deterministic clocks and forbidden I/O guards.

The capture mode replaces only the existing lifecycle dispatch seam. It does
not implement adapter parsing, identity, event mapping, throttling or replay.
"""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import runpy
import signal
import socket
import subprocess
import sys
import time
from unittest import mock


class Input(io.BytesIO):
    def __init__(self, value, forbidden=False):
        super().__init__(value)
        self.forbidden = forbidden
        self.consumed = 0

    def read(self, size=-1):
        if self.forbidden:
            raise AssertionError("settings mode must not read stdin")
        result = super().read(size)
        self.consumed += len(result)
        return result

    def read1(self, size=-1):
        return self.read(size)

    def readline(self, size=-1):
        if self.forbidden:
            raise AssertionError("settings mode must not read stdin")
        result = super().readline(size)
        self.consumed += len(result)
        return result


class Timers:
    def __init__(self):
        self.handlers = {}

    def signal(self, number, handler):
        old = self.handlers.get(number, signal.SIG_DFL)
        self.handlers[number] = handler
        return old

    def setitimer(self, *args):
        return (0.0, 0.0)


def main():
    target, arguments = sys.argv[1], sys.argv[2:]
    raw = sys.stdin.buffer.read()
    stream = Input(raw, forbidden=os.environ["C1C_NO_READ"] == "1")
    stdin = io.TextIOWrapper(stream, encoding="utf-8")
    report_path = Path(os.environ["C1C_REPORT"])
    now = float(os.environ["C1C_NOW"])
    mode = os.environ["C1C_MODE"]
    calls, violations = [], []
    timers = Timers()
    report = {"exit_code": 0, "exception": None, "calls": calls, "violations": violations}

    def deny(kind):
        def rejected(*args, **kwargs):
            violations.append(kind)
            raise RuntimeError("forbidden fixture operation: " + kind)
        return rejected

    # Load the established boundary before executing the adapter, as the other
    # hook entry oracles do. No replacement production module is installed.
    from bridge.room import app
    from bridge.room.store import RoomError

    def capture(name, args, **kwargs):
        calls.append([name, copy.deepcopy(args)])
        if name == "agent_lifecycle":
            if mode == "store-raise":
                raise RoomError("internal", "synthetic store error\nsecond line")
            if mode == "store-error":
                return {"untrusted": {"ok": False, "code": "internal"}}
            return {"untrusted": {"ok": True, "lamport": len(calls)}}
        if name == "plan_get":
            raise RoomError("no_plan", "fixture has no active plan")
        raise AssertionError("unexpected dispatch at native lifecycle boundary")

    with contextlib.ExitStack() as stack:
        for name in ("time", "monotonic"):
            stack.enter_context(mock.patch.object(time, name, return_value=now))
        for name in ("time_ns", "monotonic_ns"):
            stack.enter_context(mock.patch.object(time, name, return_value=int(now * 1000000000)))
        stack.enter_context(mock.patch.object(time, "sleep", side_effect=deny("sleep")))
        stack.enter_context(mock.patch.object(socket, "socket", side_effect=deny("network")))
        stack.enter_context(mock.patch.object(socket, "create_connection", side_effect=deny("network")))
        stack.enter_context(mock.patch.object(subprocess, "Popen", side_effect=deny("process")))
        stack.enter_context(mock.patch.object(os, "system", side_effect=deny("process")))
        stack.enter_context(mock.patch.object(signal, "signal", side_effect=timers.signal))
        if hasattr(signal, "setitimer"):
            stack.enter_context(mock.patch.object(signal, "setitimer", side_effect=timers.setitimer))
        if hasattr(signal, "alarm"):
            stack.enter_context(mock.patch.object(signal, "alarm", return_value=0))
        stack.enter_context(mock.patch.object(sys, "stdin", stdin))
        stack.enter_context(mock.patch.object(sys, "argv", [target, *arguments]))
        if mode != "real":
            stack.enter_context(mock.patch.object(app, "dispatch", side_effect=capture))
        started = time.perf_counter()
        try:
            runpy.run_module(target, run_name="__main__", alter_sys=True)
        except SystemExit as exc:
            report["exit_code"] = 0 if exc.code is None else exc.code
        except BaseException as exc:
            report["exception"] = type(exc).__name__
        report["elapsed"] = time.perf_counter() - started
        report["consumed"] = stream.consumed
    report_path.write_text(json.dumps(report), encoding="utf-8")


if __name__ == "__main__":
    main()
