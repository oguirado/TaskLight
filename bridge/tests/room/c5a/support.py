"""Bounded fixtures and real in-process MCP/CLI adapters; no reader substitute."""
import builtins
import contextlib
import errno
import hashlib
import io
import itertools
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

from bridge.plan.template import validate_template
from bridge.room import app, mcp, store
from bridge.room import __main__ as cli

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
NOW = 1700000000000
RAW_RECORD = "RAW_RECORD_MUST_STAY_PRIVATE"
RAW_IO = "RAW_IO_MUST_STAY_PRIVATE"
REASONS = {
    "room_read_failed": "Room data could not be read.",
    "template_unavailable": "A required template is unavailable.",
}
BROKEN_JOURNALS = (
    "missing", "directory", "fifo", "malformed_json", "invalid_utf8",
    "invalid_shape", "wrong_room", "open_denied", "read_failed",
)
TRANSPORTS = ("direct", "mcp", "cli")


def unwrap(payload):
    return payload.get("untrusted", payload)


def record(room="demo", lamport=1, **fields):
    result = dict(id="e-%016x" % lamport, lamport=lamport, ts=NOW,
                  room=room, agent="worker", act="heartbeat", text="healthy")
    result.update(fields)
    return result


def encoded(event):
    return (json.dumps(event, ensure_ascii=True) + "\n").encode("utf-8")


class _ReadFailure:
    def __init__(self, stream, fail):
        self.stream, self.fail = stream, fail

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.stream.close()

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def read(self, *args, **kwargs):
        self.fail()

    read1 = readinto = readline = readlines = read

    def __iter__(self):
        self.fail()


class OracleCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="runtime-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.runtime = Path(temporary.name)
        self.home = self.runtime / "home"
        env = dict(os.environ, CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        for name in ("CW_PIN_AGENT", "CW_PIN_ROLE", "CW_AGENT", "CW_ROLE",
                     "CW_SESSION_AGENT", "CW_SESSION_ROLE"):
            env.pop(name, None)
        self.enterContext(mock.patch.dict(os.environ, env, clear=True))
        self.enterContext(mock.patch.object(time, "time", return_value=NOW / 1000))
        self.enterContext(mock.patch.object(time, "monotonic", return_value=100.0))
        self.enterContext(mock.patch.object(time, "sleep", side_effect=AssertionError("real waits forbidden")))
        self.enterContext(mock.patch.object(threading, "Timer", side_effect=AssertionError("real timers forbidden")))
        self.enterContext(mock.patch.object(socket, "socket", side_effect=AssertionError("network forbidden")))
        self.enterContext(mock.patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")))
        counter = itertools.count()
        self.enterContext(mock.patch.object(secrets, "token_hex", side_effect=lambda size:
            hashlib.sha256(str(next(counter)).encode()).hexdigest()[:size * 2]))

    def path(self, room="demo"):
        return self.home / "rooms" / room / "events.jsonl"

    def install(self, data=b"", room="demo"):
        path = self.path(room)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def direct(self, tool, args):
        return unwrap(app.dispatch(tool, args))

    def seed_agent(self, room="demo"):
        self.direct("agent_lifecycle", dict(room=room, agent="worker", state="deployed",
                     run_id="run-one", op_id="c5a-life-0001"))
        result = self.direct("agents_list", dict(room=room, now=NOW))
        self.assertEqual([row["agent"] for row in result["agents"]], ["worker"],
                         "healthy admitted fixture must contain its agent")
        return result

    def seed_plan(self, room="demo"):
        template = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
        template["id"] = "c5a-required-template"
        template.pop("hash", None)
        template = validate_template(template)
        directory = self.home / "templates"
        directory.mkdir(parents=True, exist_ok=True)
        self.template_path = directory / (template["id"] + ".json")
        self.template_path.write_text(json.dumps(template), encoding="utf-8")
        self.template_bytes = self.template_path.read_bytes()
        self.direct("plan_create", dict(room=room, agent="worker", template_id=template["id"],
                     title="Healthy plan", brief={"goal": "Read honestly"}, strict=False,
                     tasks=[dict(key="first", title="Check read", type="action", phase="start",
                                 microtasks=[dict(text="Check read")])], op_id="c5a-plan-0001"))
        result = self.direct("plan_get", dict(room=room))
        self.assertEqual(result["plan"]["state"], "active", "fixture must have a healthy active plan")
        self.assertEqual(result["rejected"], [], "fixture operations must be accepted")
        return result

    def args(self, tool, room="demo"):
        return dict(room=room, **({"now": NOW} if tool == "agents_list" else {}))

    def snapshot(self):
        """Ignore access time; compare names, types, metadata, links and file bytes."""
        result = {}
        for path in [self.runtime, *sorted(self.runtime.rglob("*"))]:
            metadata = path.lstat()
            stamp = (metadata.st_mode, metadata.st_ino, metadata.st_size,
                     metadata.st_mtime_ns, metadata.st_ctime_ns)
            if stat.S_ISLNK(metadata.st_mode):
                data = os.readlink(path)
            elif stat.S_ISREG(metadata.st_mode):
                data = hashlib.sha256(path.read_bytes()).hexdigest()
            else:
                data = None
            result[str(path.relative_to(self.runtime))] = (stamp, data)
        return result

    @contextlib.contextmanager
    def unchanged(self):
        before = self.snapshot()
        try:
            yield
        finally:
            self.assertEqual(self.snapshot(), before,
                             "M1 reads must not create, replace or modify storage or locks")

    def checked(self, room="demo"):
        reader = getattr(store, "read_checked", None)
        self.assertTrue(callable(reader), "M1 requires the real store.read_checked entry point")
        result = reader(room)
        # The spec fixes event contents, but does not choose list vs legacy pair.
        if isinstance(result, tuple) and len(result) == 2:
            result = result[0]
        self.assertIsInstance(result, list, "M1 checked read must return the journal events")
        return result

    def assert_private(self, wire):
        for value in (str(self.runtime), str(self.home), "events.jsonl", RAW_RECORD, RAW_IO,
                      "Traceback", "PermissionError", "OSError"):
            self.assertNotIn(value, wire, "M5 must expose only the fixed public reason")

    def assert_public_error(self, payload, code):
        self.assertIsInstance(payload, dict)
        self.assertEqual(payload.get("code"), code, "broken reads must retain their public error code")
        reason = REASONS[code]
        allowed = {code, reason, code + ": " + reason}
        strings = []

        def collect(value):
            if isinstance(value, str):
                strings.append(value)
            elif isinstance(value, dict):
                for child in value.values():
                    collect(child)
            elif isinstance(value, list):
                for child in value:
                    collect(child)

        collect(payload)
        self.assertTrue(any(reason in value for value in strings), "M5 fixed reason missing")
        self.assertTrue(all(value in allowed for value in strings), "M5 non-public error detail escaped")
        self.assert_private(json.dumps(payload))

    def expect_room_error(self, action, code="room_read_failed", fixed=True):
        try:
            action()
        except store.RoomError as exc:
            self.assertEqual(exc.code, code, "failed reads must not become no_plan or healthy emptiness")
            if fixed:
                self.assertEqual(str(exc), code + ": " + REASONS[code])
                self.assert_private(str(exc))
            return exc
        except AssertionError:
            raise
        except Exception as exc:
            self.fail("expected RoomError(%s), got %s" % (code, type(exc).__name__))
        self.fail("expected RoomError(%s); reader reported success" % code)

    @contextlib.contextmanager
    def io_fault(self, path, kind):
        """Inject at file I/O, not at dispatch, projection or the proposed reader."""
        if kind not in ("fifo", "open_denied", "read_failed"):
            yield
            return
        target = os.fspath(path)
        metadata = path.stat()
        original_open, original_io_open, original_os_open = builtins.open, io.open, os.open
        original_read = os.read

        def targets(value):
            return not isinstance(value, int) and os.fspath(value) == target

        def fail():
            if kind == "open_denied":
                raise PermissionError(errno.EACCES, RAW_IO, target)
            raise OSError(errno.ENXIO if kind == "fifo" else errno.EIO, RAW_IO, target)

        def wrapped_open(original):
            def opened(file, *args, **kwargs):
                if not targets(file):
                    return original(file, *args, **kwargs)
                if kind != "read_failed":
                    fail()
                return _ReadFailure(original(file, *args, **kwargs), fail)
            return opened

        def opened_fd(file, flags, *args, **kwargs):
            if targets(file) and (kind == "open_denied" or
                                  (kind == "fifo" and not flags & os.O_NONBLOCK)):
                fail()
            return original_os_open(file, flags, *args, **kwargs)

        def is_target_fd(fd):
            current = os.fstat(fd)
            return (current.st_dev, current.st_ino) == (metadata.st_dev, metadata.st_ino)

        def read_fd(fd, *args):
            if kind == "read_failed" and is_target_fd(fd):
                fail()
            return original_read(fd, *args)

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(builtins, "open", side_effect=wrapped_open(original_open)))
            stack.enter_context(mock.patch.object(io, "open", side_effect=wrapped_open(original_io_open)))
            stack.enter_context(mock.patch.object(os, "open", side_effect=opened_fd))
            stack.enter_context(mock.patch.object(os, "read", side_effect=read_fd))
            if hasattr(os, "pread"):
                original_pread = os.pread

                def pread(fd, *args):
                    if kind == "read_failed" and is_target_fd(fd):
                        fail()
                    return original_pread(fd, *args)

                stack.enter_context(mock.patch.object(os, "pread", side_effect=pread))
            yield

    def break_journal(self, kind, room="demo"):
        path = self.path(room)
        if kind in ("missing", "directory", "fifo"):
            path.unlink()
            if kind == "directory":
                path.mkdir()
            elif kind == "fifo":
                os.mkfifo(path)
        elif kind == "malformed_json":
            path.write_bytes(path.read_bytes() + b'{"private":"' + RAW_RECORD.encode() + b'"\n')
        elif kind == "invalid_utf8":
            path.write_bytes(path.read_bytes() + b"\xff\xfe\n")
        elif kind == "invalid_shape":
            path.write_bytes(path.read_bytes() + b"[1,2]\n")
        elif kind == "wrong_room":
            path.write_bytes(path.read_bytes() + encoded(record(room="other", lamport=99)))
        elif kind not in ("open_denied", "read_failed"):
            self.fail("unknown fixture case")
        return path

    def mcp_call(self, tool, args):
        request = dict(jsonrpc="2.0", id=17, method="tools/call",
                       params=dict(name=tool, arguments=args))
        output, errors = io.StringIO(), io.StringIO()
        stdin = types.SimpleNamespace(buffer=io.BytesIO((json.dumps(request) + "\n").encode()))
        with mock.patch.object(sys, "stdin", stdin), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            rc = mcp.main()
        self.assertEqual(rc, 0, "MCP must return a protocol reply")
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        reply = json.loads(output.getvalue())
        self.assertEqual(reply.get("id"), 17)
        self.assertNotIn("error", reply, "valid tools/call must produce a tool result")
        result = reply["result"]
        payload = unwrap(json.loads(result["content"][0]["text"]))
        return result, payload, output.getvalue() + errors.getvalue()

    def cli_call(self, tool, args):
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            try:
                rc = cli.main(["call", tool, "--json", json.dumps(args)])
            except SystemExit as exc:
                rc = exc.code
        return rc, output.getvalue(), errors.getvalue()

    def query_error(self, tool, transport, code="room_read_failed", args=None):
        args = self.args(tool) if args is None else args
        if transport == "direct":
            self.expect_room_error(lambda: app.dispatch(tool, args), code)
        elif transport == "mcp":
            result, payload, wire = self.mcp_call(tool, args)
            self.assertIs(result.get("isError"), True, "M3/M4 broken reads must be MCP errors")
            self.assert_public_error(payload, code)
            self.assert_private(wire)
        else:
            rc, output, errors = self.cli_call(tool, args)
            self.assertNotEqual(rc, 0, "M3/M4 broken reads must fail the CLI call")
            wire = output + errors
            self.assertIn(code, wire)
            self.assertIn(REASONS[code], wire)
            self.assert_private(wire)
            # Existing adapters use JSON on stdout. A stderr-only error is valid too.
            if output.strip():
                self.assert_public_error(unwrap(json.loads(output)), code)
