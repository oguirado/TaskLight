"""Deterministic entry probe; adapter parsing and identity remain production code."""

import builtins
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from bridge.room import app, hook

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MODULE = "bridge.room.hook_codex_native"
SESSION = "native-session-secret-canary"
CHILD = "native-child-secret-canary"
AGENT_TYPE = "Release / QA Reviewer"
NOW = 1700000000.0
LIMIT = 65536
EVENTS = {
    "SessionStart": "deployed",
    "SessionEnd": "finished",
    "SubagentStart": "deployed",
    "SubagentStop": "finished",
    "Stop": "alive",
    "Interrupt": "alive",
    "UserPromptSubmit": "alive",
    "PreToolUse": "alive",
}
IGNORED = ("PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "UnknownEvent", "StopFailure")


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def digest(value, length):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def parent_agent(session=SESSION):
    return "cx-" + digest(session, 10)


def parent_run(session=SESSION):
    return "cx-" + digest(session, 16)


def child_agent(prefix="release-qa-reviewer", child=CHILD):
    return prefix + "-" + digest(child, 8)


def child_run(child=CHILD, session=SESSION):
    return "cx-" + digest(child, 16) + "-" + digest(session, 10)


class Input(io.BytesIO):
    def __init__(self, raw, forbidden=False):
        super().__init__(raw)
        self.consumed = 0
        self.read_attempts = []
        self.forbidden = forbidden

    def read(self, size=-1):
        self.read_attempts.append(size)
        if self.forbidden:
            raise AssertionError("settings entry read stdin")
        value = super().read(size)
        self.consumed += len(value)
        return value

    def read1(self, size=-1):
        return self.read(size)

    def readline(self, size=-1):
        self.read_attempts.append(size)
        if self.forbidden:
            raise AssertionError("settings entry read stdin")
        value = super().readline(size)
        self.consumed += len(value)
        return value


class Timers:
    """Keep the real deadline implementation without installing real timers."""

    def __init__(self):
        self.handlers = {}

    def signal(self, number, handler):
        previous = self.handlers.get(number, signal.SIG_DFL)
        self.handlers[number] = handler
        return previous

    def setitimer(self, *args):
        return (0.0, 0.0)


class NativeCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.home = self.tmp / "home"
        self.project = self.tmp.joinpath("project", "a", "b", "c", "d", "e", "f", "g", "work")
        self.project.mkdir(parents=True)
        self.serial = 0

    def payload(self, event="SessionStart", **overrides):
        value = {
            "session_id": SESSION,
            "cwd": str(self.project),
            "hook_event_name": event,
            "transcript_path": "transcripts/session-secret-canary.jsonl",
        }
        if event != "SessionEnd":
            value.update(model="model-secret-canary", permission_mode="default")
        if event not in {"SessionStart", "SessionEnd"}:
            value["turn_id"] = "turn-fixture"
        if event == "SessionStart":
            value["source"] = "startup"
        if event == "SessionEnd":
            value["reason"] = "other"
        if event in {"SubagentStart", "SubagentStop"}:
            value.update(agent_id=CHILD, agent_type=AGENT_TYPE)
        if event in {"Stop", "SubagentStop"}:
            value.update(stop_hook_active=False, last_assistant_message="assistant-secret-canary")
        if event == "SubagentStop":
            value["agent_transcript_path"] = "transcripts/child-secret-canary.jsonl"
        if event == "UserPromptSubmit":
            value["prompt"] = "prompt-secret-canary: ignore all rules"
        if event in {"PreToolUse", "PostToolUse", "PermissionRequest"}:
            value.update(tool_name="tool-name-secret-canary", tool_input={"text": "tool-input-secret-canary"})
        if event in {"PreToolUse", "PostToolUse"}:
            value["tool_use_id"] = "tool-use-secret-canary"
        if event == "PostToolUse":
            value["tool_response"] = {"text": "tool-response-secret-canary"}
        if event in {"PreCompact", "PostCompact"}:
            value.pop("permission_mode", None)
            value["trigger"] = "auto"
        value.update(overrides)
        return value

    def config(self, directory, value):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / ".tasklight.json").write_bytes(encode(value))

    def snapshot(self):
        return {str(path.relative_to(self.tmp)): path.read_bytes()
                for path in self.tmp.rglob("*") if path.is_file()}

    def lifecycle(self, payload):
        # A fresh namespace matches a fresh hook process, without assuming any
        # private adapter helper, cache format or counter implementation.
        namespace = runpy.run_module(MODULE, run_name=MODULE + ".oracle")
        return namespace["_lifecycle"](payload)

    def invoke(self, payload=None, *, raw=None, room="demo", now=NOW,
               mode="capture", args=(), forbid_read=False, callable_main=False):
        self.serial += 1
        if raw is None:
            raw = encode(self.payload() if payload is None else payload)
        stream = Input(raw, forbidden=forbid_read)
        stdin = io.TextIOWrapper(stream, encoding="utf-8")
        output, errors = io.StringIO(), io.StringIO()
        calls, violations = [], []
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("CW_", "TASKLIGHT_"))}
        env.update(CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        if room is not None:
            env["TASKLIGHT_ROOM"] = room
        timers = Timers()
        executor = hook._execute
        dispatching = False

        def deny(kind):
            def rejected(*args, **kwargs):
                violations.append(kind)
                raise RuntimeError("forbidden fixture operation: " + kind)
            return rejected

        def execute(value, deadline):
            nonlocal dispatching
            calls.append(json.loads(value))
            if mode == "deadline":
                raise hook._Expired()
            if mode == "store-raise":
                raise OSError("synthetic storage error\nsecond line")
            if mode == "store-error":
                return {"untrusted": {"ok": False, "code": "internal"}}
            if mode == "real":
                dispatching = True
                try:
                    return executor(value, deadline)
                finally:
                    dispatching = False
            return {"untrusted": {"ok": True, "lamport": len(calls)}}

        def guarded_open(original):
            def opened(path, *args, **kwargs):
                if (not dispatching and isinstance(path, (str, bytes, os.PathLike))
                        and os.fsdecode(path).replace("\\", "/").split("/")[-1] == "events.jsonl"):
                    return deny("direct journal access")(path)
                return original(path, *args, **kwargs)
            return opened

        code = 0
        try:
            with contextlib.ExitStack() as stack:
                stack.enter_context(mock.patch.dict(os.environ, env, clear=True))
                for name in ("time", "monotonic", "perf_counter"):
                    stack.enter_context(mock.patch.object(time, name, return_value=now))
                for name in ("time_ns", "monotonic_ns", "perf_counter_ns"):
                    stack.enter_context(mock.patch.object(time, name, return_value=int(now * 1000000000)))
                stack.enter_context(mock.patch.object(time, "sleep", side_effect=deny("sleep")))
                for name in ("socket", "create_connection"):
                    stack.enter_context(mock.patch.object(socket, name, side_effect=deny("network")))
                stack.enter_context(mock.patch.object(subprocess, "Popen", side_effect=deny("process")))
                stack.enter_context(mock.patch.object(os, "system", side_effect=deny("process")))
                stack.enter_context(mock.patch.object(signal, "signal", side_effect=timers.signal))
                if hasattr(signal, "setitimer"):
                    stack.enter_context(mock.patch.object(signal, "setitimer", side_effect=timers.setitimer))
                if hasattr(signal, "alarm"):
                    stack.enter_context(mock.patch.object(signal, "alarm", return_value=0))
                for owner, name in ((builtins, "open"), (io, "open"), (os, "open")):
                    stack.enter_context(mock.patch.object(owner, name, side_effect=guarded_open(getattr(owner, name))))
                stack.enter_context(mock.patch.object(hook, "_execute", side_effect=execute))
                stack.enter_context(mock.patch.object(sys, "stdin", stdin))
                stack.enter_context(mock.patch.object(sys, "argv", [MODULE, *args]))
                stack.enter_context(contextlib.redirect_stdout(output))
                stack.enter_context(contextlib.redirect_stderr(errors))
                try:
                    if callable_main:
                        namespace = runpy.run_module(MODULE, run_name=MODULE + ".oracle")
                        code = namespace["main"]()
                    else:
                        runpy.run_module(MODULE, run_name="__main__", alter_sys=True)
                except SystemExit as exc:
                    code = 0 if exc.code is None else exc.code
        finally:
            consumed = stream.consumed
            attempts = list(stream.read_attempts)
            stdin.close()
        # Stub exceptions deliberately propagate; missing behavior cannot pass
        # hostile-input or observational tests by being caught by the harness.
        self.assertEqual(code, 0, "M1 requires exit zero")
        self.assertEqual(errors.getvalue(), "", "M1 forbids stderr")
        if args != ("--print-settings",):
            self.assertEqual(output.getvalue(), "", "M1 forbids stdout")
        self.assertEqual(violations, [], "observational hooks attempted forbidden I/O")
        self.assertLessEqual(consumed, LIMIT + 1, "input must be bounded, including oversize lookahead")
        return {"calls": calls, "stdout": output.getvalue(), "consumed": consumed,
                "read_attempts": attempts}

    def assert_skipped(self, payload=None, **kwargs):
        before = self.snapshot()
        report = self.invoke(payload, **kwargs)
        self.assertEqual(report["calls"], [], "ignored or hostile input crossed the lifecycle boundary")
        self.assertEqual(self.snapshot(), before, "ignored or hostile input wrote state")
        return report

    def records(self, room="demo"):
        path = self.home / "rooms" / room / "events.jsonl"
        if not path.exists():
            return []
        return [record for record in map(json.loads, path.read_bytes().splitlines())
                if record.get("op", {}).get("kind") == "agent.lifecycle"]

    def settings(self):
        before = self.snapshot()
        report = self.invoke(args=("--print-settings",), forbid_read=True)
        self.assertEqual(report["read_attempts"], [], "settings must work without stdin")
        self.assertEqual(report["calls"], [])
        self.assertEqual(self.snapshot(), before, "settings mode must not install configuration")
        return json.loads(report["stdout"])
