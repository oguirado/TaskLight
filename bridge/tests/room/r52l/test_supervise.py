"""Exercise cancellation through the public TaskLight run command."""

import builtins
import errno
import io
import os
import signal
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

from bridge.tests.room.cl.support import RoomCase, TERMINAL, VirtualGroup


class ProcessEntries:
    """A scandir iterator whose next entry can raise an I/O error."""

    def __init__(self, entries):
        self.entries = iter(entries)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def __iter__(self):
        return self

    def __next__(self):
        return next(self.entries)

    def close(self):
        self.entries.close()


class CancellationGroup(VirtualGroup):
    def __init__(self, *, linger):
        super().__init__(duration=20, descendant=True, signal_status=23)
        self.linger = linger
        self.escalated_at = None
        self.descendant_exited_at = None
        self.reaped_before_descendant_exit = None
        self.signals_after_reap = []

    def group_signal(self, pgid, number):
        if number and self.reaped:
            self.signals_after_reap.append(number)
        super().group_signal(pgid, number)
        if pgid == self.child.pgid and number == signal.SIGKILL:
            if self.escalated_at is None:
                self.escalated_at = self.clock.now
            if self.linger and self.descendant_exited_at is None:
                self.descendant_alive = True

    def direct_signal(self, number):
        if number and self.reaped:
            self.signals_after_reap.append(number)
        super().direct_signal(number)

    def exit_descendant(self):
        self.reaped_before_descendant_exit = self.reaped
        self.descendant_alive = False
        self.descendant_exited_at = self.clock.now


@unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux procfs supervision")
class SuperviseInspectionTests(RoomCase):
    def setUp(self):
        # Lifecycle dispatch is virtual. The inherited scratch room is unnecessary.
        env = {key: value for key, value in os.environ.items() if not key.startswith("CW_")}
        self.enterContext(mock.patch.dict(os.environ, env, clear=True))

    def run_inspection_case(self, fault=None):
        group = CancellationGroup(linger=fault is None)
        error = (FileNotFoundError(errno.ENOENT, "procfs unavailable") if fault == "open"
                 else OSError(errno.EIO, f"procfs {fault} failed"))
        injected = []
        observed_live = []
        scandir, builtin_open, io_open = os.scandir, builtins.open, io.open
        proc = "/proc"

        def inject_fault():
            injected.append((group.clock.now, group.reaped))
            raise error

        def entries():
            for pid in (group.child.pid, group.child.pid + 1):
                yield SimpleNamespace(name=str(pid), path=f"{proc}/{pid}")
                if fault == "iteration" and group.escalated_at is not None:
                    inject_fault()

        def scan(path):
            if path != proc:
                return scandir(path)
            if fault == "open" and group.escalated_at is not None:
                inject_fault()
            return ProcessEntries(entries())

        def open_record(fallback, path, *args, **kwargs):
            if isinstance(path, int) or not os.fsdecode(path).startswith(proc + "/"):
                return fallback(path, *args, **kwargs)
            pgid = group.child.pid
            leader = os.fsdecode(path) == f"{proc}/{pgid}/stat"
            pid = pgid if leader else pgid + 1
            alive = not leader and group.descendant_alive
            state = "S" if alive else "Z"
            stream = io.BytesIO(f"{pid} (fixture worker) {state} 1 {pgid} {pgid}\n".encode())
            read_stat = stream.read

            def read(*read_args, **read_kwargs):
                if not leader and fault == "record read" and group.escalated_at is not None:
                    inject_fault()
                if alive and group.escalated_at is not None:
                    if not observed_live:
                        group.schedule(0.5, group.exit_descendant)
                    observed_live.append((group.clock.now, group.reaped))
                return read_stat(*read_args, **read_kwargs)

            stream.read = read
            return stream

        with (
            mock.patch.object(os, "scandir", side_effect=scan),
            mock.patch.object(builtins, "open",
                              side_effect=lambda *a, **kw: open_record(builtin_open, *a, **kw)),
            mock.patch.object(io, "open",
                              side_effect=lambda *a, **kw: open_record(io_open, *a, **kw)),
        ):
            try:
                status, _, _ = group.run(self, ["--wall-s", "0.5"])
            except OSError as exc:
                if exc is not error:
                    raise
                self.fail(f"{fault} fault escaped cancellation after SIGKILL: {exc}")

        self.assertEqual(status, 23, "the wrapper must return the leader's actual exit status")
        self.assertIsNotNone(group.escalated_at, "cancellation never escalated")
        self.assertEqual([sent[2] for sent in group.signals[:1]], [signal.SIGTERM])
        self.assertEqual(group.signals_after_reap, [], "signal attempted after releasing the leader")
        terminal = [event for event in group.events if event.data["state"] in TERMINAL]
        self.assertEqual(len(terminal), 1, "cancellation must emit exactly one terminal event")
        event = terminal[0]
        self.assertEqual((event.data["state"], event.data["reason"]), ("failed", "wall_timeout"))
        self.assertTrue(event.reaped, "the leader must be reaped before terminal publication")
        self.assertFalse(event.descendant)
        self.assertGreaterEqual(event.at, group.escalated_at)
        if fault is None:
            self.assertTrue(observed_live, "the scan must see a live descendant after SIGKILL")
            self.assertIsNotNone(group.descendant_exited_at)
            self.assertIs(group.reaped_before_descendant_exit, False,
                          "the leader must stay waitable until the live descendant exits")
            self.assertGreaterEqual(event.at, group.descendant_exited_at)
            self.assertTrue(all(not reaped for _, reaped in observed_live),
                            "a live descendant must keep the leader waitable")
        else:
            self.assertTrue(injected, "the requested inspection fault was never reached")
            self.assertTrue(all(at >= group.escalated_at and not reaped for at, reaped in injected),
                            "the fault must occur after SIGKILL with the leader still waitable")

    def test_iteration_eio_preserves_cancelled_leader_outcome(self):
        self.run_inspection_case("iteration")

    def test_record_read_eio_preserves_cancelled_leader_outcome(self):
        self.run_inspection_case("record read")

    def test_unavailable_inspection_preserves_cancelled_leader_outcome(self):
        self.run_inspection_case("open")

    def test_observed_live_descendant_keeps_leader_waitable(self):
        self.run_inspection_case()
