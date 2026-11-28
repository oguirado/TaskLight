import ctypes
from ctypes.wintypes import LPDWORD
import io
import json
import os
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from bridge.room import store
from bridge.wall import __main__ as cli, native_host


ORIGIN = "chrome-extension://" + "a" * 32 + "/"
FLOOR = "ONLY_ON_DEVICE"
HELLO = {"t": "hello", "v": 1, "projects": []}
ROOM_HELLO = {
    "t": "room_hello", "v": 1, "agent": "wall-user",
    "rooms": [{"room": "demo", "floor": FLOOR}],
}
BYE = {"t": "bye", "v": 1}


def frame(message):
    body = json.dumps(message).encode("utf-8")
    return struct.pack("<I", len(body)) + body


def sync(rid):
    return {"t": "room_sync", "v": 1, "rid": rid, "since": {"demo": 0}}


def synced(rid, upto=0):
    return {
        "t": "room_synced", "v": 1, "room": "demo",
        "rid": rid, "upto": upto, "more": False,
    }


class PipeOutput(io.BytesIO):
    def __init__(self, calls):
        super().__init__()
        self.calls = calls

    def fileno(self):
        return 41

    def write(self, data):
        self.calls.append(("write",))
        return super().write(data)


class WindowsHost(unittest.TestCase):
    def setUp(self):
        self.runtime = Path(self.enterContext(tempfile.TemporaryDirectory(
            dir=Path(__file__).resolve().parent)))
        self.config = self.runtime / "wall.json"
        self.config.write_text(json.dumps({
            "v": 1, "extensionId": "a" * 32, "spoolDir": str(self.runtime),
            "projects": [], "rooms": {
                "home": str(self.runtime), "agent": "wall-user",
                "allow": [{"room": "demo", "tier": "private"}],
            },
        }), encoding="utf-8")
        self.calls = []
        self.stdin = SimpleNamespace(fileno=lambda: 40)
        self.stdout = PipeOutput(self.calls)
        self.stderr = io.StringIO()
        self.args = ["--config", str(self.config), ORIGIN]

    def frames(self):
        wire = io.BytesIO(self.stdout.getvalue())
        frames = []
        while header := wire.read(4):
            self.assertEqual(len(header), 4)
            size, = struct.unpack("<I", header)
            body = wire.read(size)
            self.assertEqual(len(body), size)
            frames.append(json.loads(body))
        return frames

    def run_pipe(self, chunks, *, args=None):
        # Byte chunks become available one read at a time. None is an open,
        # idle pipe. Once the sequence is exhausted the writer has closed.
        chunks = iter(chunks)
        pending = b""
        idle = False
        closed = False
        clock = 0.0

        def peek(handle, buffer, size, read, available, left):
            nonlocal pending, idle, closed
            self.assertEqual(handle, 140)
            self.calls.append(("peek",))
            self.assertFalse(closed, "host kept polling a closed pipe")
            if not pending and not idle:
                pending = next(chunks, b"")
                idle = pending is None
            if pending == b"":
                closed = True
                return 0
            ctypes.cast(available, LPDWORD)[0] = len(pending) if pending else 0
            return 1

        def read(fd, size):
            nonlocal pending
            self.assertEqual(fd, self.stdin.fileno())
            self.assertTrue(pending, "read would block on a Windows pipe")
            self.assertLessEqual(size, len(pending))
            self.assertEqual(self.frames()[:2], [HELLO, ROOM_HELLO])
            self.calls.append(("read",))
            data, pending = pending[:size], pending[size:]
            return data

        def sleep(seconds):
            nonlocal pending, idle, clock
            self.assertTrue(idle, "wait should only occur for an idle pipe")
            self.assertGreater(seconds, 0)
            self.assertLessEqual(seconds, native_host._POLL_S)
            self.calls.append(("wait",))
            clock += seconds
            idle = False
            pending = b""

        def setmode(fd, mode):
            self.calls.append(("mode", fd, mode))

        crt = SimpleNamespace(setmode=setmode, get_osfhandle=lambda fd: fd + 100)
        kernel = SimpleNamespace(
            GetFileType=Mock(return_value=3),
            PeekNamedPipe=Mock(side_effect=peek),
        )
        with patch.object(native_host.sys, "platform", "win32"), \
             patch.dict(native_host.sys.modules, {"msvcrt": crt}), \
             patch.object(native_host.os, "O_BINARY", 0x8000, create=True), \
             patch.object(ctypes, "WinDLL", return_value=kernel, create=True), \
             patch.object(native_host.os, "read", side_effect=read), \
             patch.object(native_host.os, "set_blocking", create=True, side_effect=AssertionError(
                 "Windows pipe must not use POSIX nonblocking setup")), \
             patch.object(native_host.select, "select", side_effect=AssertionError(
                 "Windows pipe is unsupported by select")), \
             patch.object(native_host.time, "sleep", side_effect=sleep), \
             patch.object(native_host.time, "monotonic", side_effect=lambda: clock):
            return native_host.main(self.args if args is None else args,
                                    self.stdin, self.stdout, self.stderr)

    @unittest.skipUnless(os.name == "posix", "POSIX select must support regular file descriptors")
    def test_leading_parent_window_accepted_by_cli_on_posix(self):
        with tempfile.TemporaryFile(dir=self.runtime) as pipe:
            pipe.write(frame(BYE))
            pipe.seek(0)
            with patch.object(cli.sys, "platform", "linux"), \
                 patch.object(cli.sys, "stdin", SimpleNamespace(buffer=pipe)), \
                 patch.object(cli.sys, "stdout", SimpleNamespace(buffer=self.stdout)), \
                 patch.object(cli.sys, "stderr", self.stderr):
                rc = cli.main(["host", "--parent-window=123", *self.args])
        self.assertEqual(rc, 0)
        self.assertEqual(self.frames(), [HELLO, ROOM_HELLO])

    def test_invalid_or_misplaced_parent_window_and_unknown_flag_are_refused(self):
        for args in (
            ["--parent-window=", *self.args],
            ["--parent-window=-1", *self.args],
            ["--parent-window=12x", *self.args],
            ["--parent-window=１２", *self.args],
            [*self.args, "--parent-window=1"],
            ["--parent-window=1", "--parent-window=2", *self.args],
            ["--other=1", *self.args],
        ):
            with self.subTest(args=args):
                self.assertEqual(self.run_pipe([], args=args), 2)
                self.assertEqual(self.calls, [])
                self.assertEqual(self.frames(), [])

    def test_split_prefix_and_body_survive_idle_pipe(self):
        data = frame(sync("split"))
        self.assertEqual(self.run_pipe([data[:2], None, data[2:9], data[9:]]), 0)
        self.assertEqual(self.frames(), [HELLO, ROOM_HELLO, synced("split")])
        self.assertEqual(self.calls.count(("read",)), 3)
        self.assertEqual(self.calls.count(("wait",)), 1)

    def test_two_frames_in_one_read_are_both_processed(self):
        self.assertEqual(self.run_pipe([frame(sync("first")) + frame(sync("second"))]), 0)
        self.assertEqual(self.frames(), [HELLO, ROOM_HELLO, synced("first"), synced("second")])
        self.assertEqual(self.calls.count(("read",)), 1)

    def test_eof_is_clean_at_boundary_and_fatal_mid_frame(self):
        self.assertEqual(self.run_pipe([]), 0)
        self.assertEqual(self.frames(), [HELLO, ROOM_HELLO])
        self.stdout.seek(0)
        self.stdout.truncate()
        self.assertEqual(self.run_pipe([frame(sync("partial"))[:-1]]), 2)
        self.assertEqual(self.frames(), [HELLO, ROOM_HELLO])

    def test_incomplete_frame_expires_while_writer_is_still_open(self):
        self.assertEqual(self.run_pipe([frame(sync("stalled"))[:2], *([None] * 100)]), 2)
        self.assertEqual(self.frames(), [HELLO, ROOM_HELLO])
        self.assertGreater(self.calls.count(("wait",)), 0)
        self.assertLess(self.calls.count(("wait",)), 100)

    def test_binary_mode_is_set_on_both_descriptors_before_io(self):
        self.assertEqual(self.run_pipe([frame(BYE)]), 0)
        self.assertCountEqual(self.calls[:2], [
            ("mode", self.stdin.fileno(), 0x8000), ("mode", self.stdout.fileno(), 0x8000),
        ])
        self.assertEqual(self.calls[2], ("write",))
        self.assertIn(("read",), self.calls)

    def test_regular_file_stdin_with_in_memory_stdout(self):
        self.stdout = io.BytesIO()
        crt = SimpleNamespace(setmode=Mock(), get_osfhandle=lambda fd: fd + 100)
        kernel = SimpleNamespace(GetFileType=Mock(return_value=1))
        with tempfile.TemporaryFile(dir=self.runtime) as stdin:
            stdin.write(frame(sync("redirected")))
            stdin.seek(0)
            fd = stdin.fileno()
            with (
                patch.object(native_host.sys, "platform", "win32"),
                patch.dict(native_host.sys.modules, {"msvcrt": crt}),
                patch.object(native_host.os, "O_BINARY", 0x8000, create=True),
                patch.object(ctypes, "WinDLL", return_value=kernel, create=True),
            ):
                rc = native_host.main(self.args, stdin, self.stdout, self.stderr)

        self.assertEqual(rc, 0)
        self.assertEqual(self.frames(), [HELLO, ROOM_HELLO, synced("redirected")])
        crt.setmode.assert_called_once_with(fd, 0x8000)
        kernel.GetFileType.assert_called_once_with(fd + 100)

    def test_hello_then_room_sync_replays_a_stored_event(self):
        event = store.post("demo", "wall-user", "question", "hello room", home=self.runtime)
        args = ["--parent-window=0", *self.args]
        self.assertEqual(self.run_pipe([None, frame(sync("replay")), frame(BYE)], args=args), 0)
        self.assertEqual(self.frames(), [
            HELLO, ROOM_HELLO,
            {"t": "room_event", "v": 1, "room": "demo", "rid": "replay",
             "floor": FLOOR, "event": event},
            synced("replay", event["lamport"]),
        ])
        self.assertEqual(self.stderr.getvalue(), "")
