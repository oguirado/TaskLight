"""Fresh-interpreter fixture driver; no production entry points are replaced."""
import fcntl  # A-U133a: bridge.room._lock exposes the backend as _backend, not fcntl; patching the fcntl module patches the same object
import builtins
import _thread
import contextlib
import copy
import importlib.abc
import io
import json
import os
from pathlib import Path
import runpy
import signal
import sys
import threading
import time
from unittest import mock

class DenyClients(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        prefixes = ("openai", "anthropic", "litellm", "boto3", "google.genai", "google.generativeai")
        if any(fullname == prefix or fullname.startswith(prefix + ".") for prefix in prefixes):
            raise AssertionError("provider or network client imported: " + fullname)


# Guard the cold product import as well as the eventual invocation.
AUDIT_DENIED = []
def _audit(name, args):
    if name.startswith("socket.") or name in {"subprocess.Popen", "os.system", "os.fork", "os.posix_spawn"}:
        AUDIT_DENIED.append(name)
        raise AssertionError("forbidden operation: " + name)

sys.addaudithook(_audit)
sys.meta_path.insert(0, DenyClients())

from .support import Boundary, FakeTimer
from bridge.room import _lock, app
from bridge.room.store import RoomError


def main():
    entry = sys.argv[1]
    scenario = sys.argv[2]
    home = Path(os.environ["CW_HOME"])
    state_path = home / "boundary.json"
    boundary = Boundary()
    if state_path.exists():
        stored = json.loads(state_path.read_text())
        for key in ("projection", "events", "receipts", "last_alive"):
            setattr(boundary, key, stored[key])
        if "last_alive_lamport" in stored:
            boundary.last_alive_lamport = stored["last_alive_lamport"]
    boundary.now_ms = int(os.environ.get("U133_NOW_MS", "1000"))
    clock = [10.0]
    timer = FakeTimer()
    before_threads = {t.ident for t in threading.enumerate()}
    dispatch_active = [False]
    waits = []
    finder = DenyClients()
    sys.meta_path.insert(0, finder)
    denied = AUDIT_DENIED

    def expire():
        clock[0] = 12.0
        timer.fire()

    class IncompleteInput:
        buffer = None
        encoding = "utf-8"
        def __init__(self):
            self.buffer = self
        def read(self, size=-1):
            waits.append("stdin")
            expire()
        read1 = read
        readline = read
        def readinto(self, target):
            return self.read(len(target))
        def fileno(self):
            return 0
        def isatty(self):
            return False

    real_flock = fcntl.flock
    def flock(fd, mode):
        if mode & fcntl.LOCK_UN:
            return real_flock(fd, mode)
        if not dispatch_active[0]:
            raise AssertionError("outer room or hook-state lock in lifecycle entry")
        waits.append("events.lock")
        expire()

    def dispatch(name, args):
        dispatch_active[0] = True
        try:
            if scenario == "events-lock":
                # Mirror the real blocking storage boundary, including a broad
                # Exception handler. A deadline must pass through that handler.
                with (home / "rooms/demo/events.lock").open("a+b") as locked:
                    try:
                        _lock.lock_exclusive(locked.fileno())
                    except Exception:
                        raise AssertionError("deadline was swallowed by except Exception")
                raise AssertionError("continued after lock deadline")
            if scenario in ("internal", "capacity", "contention"):
                raise RoomError({"internal": "internal", "capacity": "limit_exceeded",
                                 "contention": "claimed_by_other"}[scenario], "injected failure")
            if scenario == "unexpected":
                raise RuntimeError("injected internal failure")
            if scenario == "write":
                # The deadline may interrupt waits, never the dispatch write.
                clock[0] = 12.01
                if timer.armed:
                    # A deferred signal is also valid; only interruption of
                    # the critical write is forbidden.
                    timer.handlers[signal.SIGALRM](signal.SIGALRM, None)
                return boundary(name, args)
            return boundary(name, args)
        finally:
            dispatch_active[0] = False

    original_loads = json.loads
    def expire_on_parse(raw, *args, **kwargs):
        result = original_loads(raw, *args, **kwargs)
        if isinstance(result, dict) and "event_id" in result:
            clock[0] = 12.001
        return result

    original_import = builtins.__import__
    def expire_app_import(name, globals=None, locals=None, fromlist=(), level=0):
        result = original_import(name, globals, locals, fromlist, level)
        package = globals.get("__package__", "") if globals else ""
        relative_app = level and package == "bridge.room" and (name == "app" or "app" in (fromlist or ()))
        if name == "bridge.room.app" or relative_app or (name == "bridge.room" and "app" in (fromlist or ())):
            waits.append("import")
            clock[0] = 12.001
        return result

    code = None
    try:
        with contextlib.ExitStack() as stack:
            timer.install(stack)
            stack.enter_context(mock.patch.object(time, "monotonic", side_effect=lambda: clock[0]))
            stack.enter_context(mock.patch.object(time, "perf_counter", side_effect=lambda: clock[0]))
            stack.enter_context(mock.patch.object(time, "monotonic_ns", side_effect=lambda: int(clock[0] * 1000000000)))
            stack.enter_context(mock.patch.object(time, "perf_counter_ns", side_effect=lambda: int(clock[0] * 1000000000)))
            stack.enter_context(mock.patch.object(time, "time", side_effect=lambda: boundary.now_ms / 1000 + clock[0] - 10.0))
            stack.enter_context(mock.patch.object(time, "sleep", side_effect=AssertionError("sleep forbidden")))
            stack.enter_context(mock.patch.object(threading.Thread, "start", side_effect=AssertionError("thread forbidden")))
            stack.enter_context(mock.patch.object(_thread, "start_new_thread", side_effect=AssertionError("thread forbidden")))
            if scenario != "real":
                stack.enter_context(mock.patch.object(app, "dispatch", side_effect=dispatch))
            if scenario in ("events-lock", "hook-state-lock"):
                stack.enter_context(mock.patch.object(fcntl, "flock", side_effect=flock))
            if scenario == "incomplete":
                stack.enter_context(mock.patch.object(sys, "stdin", IncompleteInput()))
            if scenario == "expired":
                stack.enter_context(mock.patch.object(json, "loads", side_effect=expire_on_parse))
            if scenario == "import-expired":
                stack.enter_context(mock.patch.object(builtins, "__import__", side_effect=expire_app_import))
            sys.modules.pop(entry, None)
            sys.argv = [entry] + (["--lifecycle"] if entry.endswith("hook_claude") and scenario != "todo" else [])
            try:
                runpy.run_module(entry, run_name="__main__", alter_sys=True)
                code = 0
            except SystemExit as exc:
                code = 0 if exc.code is None else exc.code
    finally:
        sys.meta_path.remove(finder)
        state = {key: getattr(boundary, key) for key in
                 ("projection", "events", "receipts", "last_alive")}
        if hasattr(boundary, "last_alive_lamport"):
            state["last_alive_lamport"] = boundary.last_alive_lamport
        state_path.write_text(json.dumps(state, ensure_ascii=False))
        prefixes = ("openai", "anthropic", "litellm", "boto3", "google.genai", "google.generativeai")
        loaded = sorted(name for name in sys.modules if any(
            name == prefix or name.startswith(prefix + ".") for prefix in prefixes))
        (home / "probe.json").write_text(json.dumps({
            "calls": boundary.calls, "clock": clock[0], "waits": waits,
            "timers": timer.delays, "timer_armed": timer.armed, "denied": denied,
            "new_threads": len({t.ident for t in threading.enumerate()} - before_threads),
            "provider_imports": loaded, "code": code}))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
