"""CLI-only fixtures. The controlled dispatcher is a backend contract double.

No family implementation helper, admission flag, metadata key or parser API is
assumed. All runtime files live in disposable directories under this package.
"""
import copy
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from unittest import mock

from bridge.room import app, store

HERE = Path(__file__).resolve().parent
PROTOCOL = "tasklight.family/1"
REAL_DISPATCH = app.dispatch
REAL_FSYNC = os.fsync
REAL_OPEN = os.open
REAL_RENAME = os.rename
REAL_REPLACE = os.replace
REAL_UNLINK = os.unlink
MISSING = object()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def envelope(**changes):
    value = dict(schema=PROTOCOL, id="deploy-0001", source="harness",
                 target="board", kind="agent.deployed", room="demo",
                 agent="executor-a", run_id="run-a", payload={})
    for key, item in changes.items():
        if item is MISSING:
            value.pop(key, None)
        else:
            value[key] = item
    return value


def operation_id(value):
    identity = "\0".join(value[k] for k in ("source", "target", "id"))
    return "fam-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:44]


class Crash(BaseException):
    """Process-death stand-in, deliberately outside Exception handling."""


class IOTrace:
    """Observe real filesystem boundaries without changing adapter internals."""
    def __init__(self, case):
        self.case = case
        self.log = []
        self.fail_sync = None
        self.crash_at = None
        self.hard_crash = False
        self.locked = set()
        self.before_read_lock = None

    def fd_path(self, fd):
        try:
            identity = os.fstat(fd)
        except (OSError, TypeError):
            return None
        for candidate in (self.case.tmp, *self.case.tmp.rglob("*")):
            try:
                item = candidate.lstat()
            except OSError:
                continue
            if (identity.st_dev, identity.st_ino) == (item.st_dev, item.st_ino):
                return candidate
        return None

    def at(self, name, dir_fd=None):
        if isinstance(name, int):
            return self.fd_path(name)
        p = Path(os.fsdecode(name))
        if not p.is_absolute():
            base = Path.cwd() if dir_fd is None else self.fd_path(dir_fd)
            if base is None:
                raise AssertionError("unidentified descriptor")
            p = base / p
        return p

    def fsync(self, fd):
        path = self.fd_path(fd)
        is_dir = stat.S_ISDIR(os.fstat(fd).st_mode)
        kind = "directory" if is_dir else "file"
        if self.fail_sync is not None and self.fail_sync(path, is_dir):
            self.fail_sync = None
            raise OSError(errno.EIO, "injected durability failure")
        REAL_FSYNC(fd)
        self.log.append(("fsync", path, kind))

    def rename(self, src, dst, *args, **kwargs):
        return self._rename(REAL_RENAME, src, dst, args, kwargs)

    def replace(self, src, dst, *args, **kwargs):
        return self._rename(REAL_REPLACE, src, dst, args, kwargs)

    def _rename(self, operation, src, dst, args, kwargs):
        source = self.at(src, kwargs.get("src_dir_fd"))
        target = self.at(dst, kwargs.get("dst_dir_fd"))
        receipt = target.parent == self.case.spool and target.name.endswith(".result.json")
        if receipt and self.crash_at == "before_receipt_rename":
            self.crash_at = None
            if self.hard_crash:
                os._exit(77)
            raise Crash("before receipt rename")
        if receipt:
            self.case.assertEqual(source.parent, target.parent, "receipt temporary is not adjacent")
            self.case.assertTrue(any(row[0] == "fsync" and row[1] == source
                                     and row[2] == "file" for row in self.log),
                                     "receipt renamed before file fsync")
        operation(src, dst, *args, **kwargs)
        self.log.append(("rename", source, target))
        if receipt and self.crash_at == "after_receipt_rename":
            self.crash_at = None
            if self.hard_crash:
                os._exit(77)
            raise Crash("after receipt rename")

    def unlink(self, path, *args, **kwargs):
        target = self.at(path, kwargs.get("dir_fd"))
        receipt = target.with_name(target.stem + ".result.json")
        if target.parent == self.case.spool and receipt.is_file():
            renames = [i for i, row in enumerate(self.log)
                       if row[0] == "rename" and row[2] == receipt]
            if renames:
                self.case.assertTrue(any(row == ("fsync", self.case.spool, "directory")
                                         for row in self.log[renames[-1] + 1:]),
                                         "request removed before receipt directory fsync")
        REAL_UNLINK(path, *args, **kwargs)
        self.log.append(("unlink", target))

    def install(self, stack):
        stack.enter_context(mock.patch.object(os, "fsync", self.fsync))
        stack.enter_context(mock.patch.object(os, "rename", self.rename))
        stack.enter_context(mock.patch.object(os, "replace", self.replace))
        stack.enter_context(mock.patch.object(os, "unlink", self.unlink))
        stack.enter_context(mock.patch.object(os, "remove", self.unlink))
        # The specified events.lock is a POSIX writer lock in this corpus.
        from bridge.room import _lock
        backend = _lock._backend
        original = backend.flock
        def flock(fd, mode):
            path = self.fd_path(fd)
            room_lock = path is not None and path.name == "events.lock"
            if room_lock and mode & backend.LOCK_UN:
                self.locked.discard(fd)
            elif room_lock:
                if self.before_read_lock is not None:
                    action, self.before_read_lock = self.before_read_lock, None
                    action()
                self.locked.add(fd)
            return original(fd, mode)
        stack.enter_context(mock.patch.object(backend, "flock", flock))


class ContractBackend:
    """Small dispatcher double; U109/U119/U121/U132 correctness is not reimplemented.

Lifecycle records are fixture commits, not a substitute product implementation.
Cursor behavior delegates to the existing room_events handler.
"""
    def __init__(self, case):
        self.case = case
        self.calls = []
        self.error = None
        self.after_commit = None
        self.noop = None
        self.check_pending = False
        self.lifecycle_available = True

    def __call__(self, name, args):
        self.calls.append((name, copy.deepcopy(args)))
        if name == "room_events":
            if self.case.journal().exists():
                self.case.assertTrue(self.case.trace.locked,
                                     "cursor dispatch escaped the writer lock")
            self.case.assertEqual(args["wait_ms"], 0)
            return REAL_DISPATCH(name, args)
        self.case.assertFalse(self.case.trace.locked,
                              "mutation dispatched while adapter holds events.lock")
        self.case.assertEqual(name, "agent_lifecycle", "arbitrary dispatch")
        if not self.lifecycle_available:
            raise NotImplementedError("U132 stub")
        if self.error is not None:
            raise self.error
        if self.check_pending:
            pending = self.case.mailbox / "dedup" / (self.case.active_id + ".json")
            self.case.assertTrue(pending.is_file(), "pending identity missing before dispatch")
            log = self.case.trace.log
            published = [i for i, row in enumerate(log) if row[0] == "rename" and row[2] == pending]
            self.case.assertTrue(published, "pending identity was not atomically published")
            index = published[-1]
            temporary = log[index][1]
            self.case.assertEqual(temporary.parent, pending.parent)
            self.case.assertIn(("fsync", temporary, "file"), log[:index], "pending data not durable")
            self.case.assertIn(("fsync", pending.parent, "directory"), log[index + 1:],
                               "pending identity directory not durable")
        if self.noop is not None:
            return copy.deepcopy(self.noop)
        events = self.case.events()
        prior = next((e for e in events if e.get("agent") == args["agent"]
                      and e.get("op", {}).get("op_id") == args["op_id"]), None)
        if prior is None:
            n = max((e["lamport"] for e in events), default=0) + 1
            op = {k: copy.deepcopy(v) for k, v in args.items() if k not in ("room", "agent")}
            op["kind"] = "agent.lifecycle"
            prior = dict(id="e-%016x" % n, lamport=n, ts=n * 1000,
                         room=args["room"], agent=args["agent"], act="op", text="", op=op)
            self.case.append_committed(prior)
        if self.after_commit is not None:
            action, self.after_commit = self.after_commit, None
            action()
        return {"untrusted": {"ok": True, "lamport": prior["lamport"]}}


class FamilyCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix=".runtime-", dir=HERE)
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.home = self.tmp / "home"
        self.mailbox = self.home / "family" / "board"
        self.spool = self.mailbox / "spool"
        self.spool.mkdir(parents=True)
        self.config = dict(endpoint="board", rooms=["demo"], sources=["harness"], slice=1)
        self.configure()
        self.trace = IOTrace(self)
        self.backend = ContractBackend(self)
        self.active_id = "deploy-0001"
        self.stdout = self.stderr = ""
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        env = {k: v for k, v in os.environ.items() if not k.startswith("CW_")}
        env["CW_HOME"] = str(self.home)
        self.stack.enter_context(mock.patch.dict(os.environ, env, clear=True))
        for target in ("socket", "create_connection", "socketpair"):
            self.stack.enter_context(mock.patch.object(socket, target,
                side_effect=AssertionError("network access is outside this oracle")))
        self.stack.enter_context(mock.patch.object(subprocess, "Popen",
                side_effect=AssertionError("external process execution is forbidden")))
        # Timers never advance unless a polling test supplies a fake sleep.
        self.stack.enter_context(mock.patch("time.time", return_value=1700000000.0))
        self.stack.enter_context(mock.patch("time.monotonic", return_value=100.0))
        self.sleep = self.stack.enter_context(mock.patch("time.sleep",
                side_effect=AssertionError("unexpected real-time wait")))
        self.trace.install(self.stack)
        self.dispatch = self.stack.enter_context(mock.patch.object(app, "dispatch", side_effect=self.backend))
        self.original_tools = copy.deepcopy(app.list_tools())
        lifecycle = {"name": "agent_lifecycle", "description": "Fixture lifecycle contract",
                     "inputSchema": {"type": "object", "properties": {
                        k: {"type": "string"} for k in
                        ("room", "agent", "run_id", "state", "op_id", "swarm", "harness", "reason")},
                        "required": ["room", "agent", "run_id", "state"], "additionalProperties": False}}
        self.tools = self.original_tools + [lifecycle]
        self.stack.enter_context(mock.patch.object(app, "list_tools", side_effect=lambda: copy.deepcopy(self.tools)))
        self.stack.enter_context(mock.patch.object(app, "tool_names", side_effect=lambda: {t["name"] for t in self.tools}))
        self.stack.enter_context(mock.patch.dict(app.V2_DISPATCH, {"agent_lifecycle": self.backend}))

    def configure(self, **changes):
        self.config.update(changes)
        (self.mailbox / "config.json").write_bytes(canonical(self.config))

    def publish(self, value=None, *, raw=None, filename=None):
        value = envelope() if value is None else value
        self.active_id = value.get("id", "deploy-0001")
        name = filename or (value["id"] + ".json")
        path = self.spool / name
        path.write_bytes(canonical(value) if raw is None else raw)
        return path

    def invoke(self, *extra, endpoint="board"):
        # A retry cannot use family-module caches as durable replay authority.
        for module in ("bridge.room.family", "bridge.room.family_envelope"):
            sys.modules.pop(module, None)
        out, err = io.StringIO(), io.StringIO()
        argv = ["bridge.room.family", "drain", "--endpoint", endpoint, *extra]
        with mock.patch.object(sys, "argv", argv), redirect_stdout(out), redirect_stderr(err):
            try:
                runpy.run_module("bridge.room.family", run_name="__main__", alter_sys=True)
            except SystemExit as exc:
                code = 0 if exc.code is None else exc.code
            else:
                code = 0
        self.stdout, self.stderr = out.getvalue(), err.getvalue()
        return code

    def receipt(self, identity="deploy-0001"):
        path = self.spool / (identity + ".result.json")
        result = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(result["schema"], PROTOCOL)
        self.assertEqual(result["id"], identity)
        self.assertLessEqual(set(result), {"schema", "id", "correlation_id", "result"})
        return result

    def error_receipt(self, code, identity="deploy-0001"):
        data = self.receipt(identity)["result"]
        self.assertIs(data["ok"], False)
        self.assertEqual(data["code"], code)
        self.assertLessEqual(set(data), {"ok", "code", "detail"})
        return data

    def journal(self, room="demo"):
        return self.home / "rooms" / room / "events.jsonl"

    def journal_bytes(self, room="demo"):
        p = self.journal(room)
        return p.read_bytes() if p.exists() else b""

    def events(self, room="demo"):
        return [json.loads(line) for line in self.journal_bytes(room).splitlines() if line.strip()]

    def append_committed(self, event):
        p = self.journal(event["room"])
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("ab") as stream:
            stream.write(canonical(event) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())

    def assert_no_dispatch(self):
        self.assertEqual(self.backend.calls, [])
        self.assertEqual(self.journal_bytes(), b"")

    def drain_error(self, value, code="bad_args", *, raw=None, filename=None):
        self.publish(value, raw=raw, filename=filename)
        self.assertEqual(self.invoke(), 0)
        identity = Path(filename).stem if filename else value["id"]
        self.error_receipt(code, identity)
        self.assert_no_dispatch()


def assert_committed_receipt(case, receipt, events):
    """Independent A9 oracle: an acknowledged mutation must have a journal witness."""
    result = receipt["result"]["untrusted"]
    case.assertTrue(result["ok"])
    request = envelope(id=receipt.get("id", "deploy-0001"))
    expected = operation_id(request)
    case.assertTrue(any(e["lamport"] == result["lamport"]
                        and e.get("room") == request["room"]
                        and e.get("agent") == request["agent"]
                        and e.get("op", {}).get("op_id") == expected
                        and e.get("op", {}).get("state") == "deployed"
                        and e.get("op", {}).get("run_id") == request["run_id"]
                        for e in events),
                    "success receipt has no committed journal witness")
