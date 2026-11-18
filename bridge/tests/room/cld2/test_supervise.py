"""Regressions for result polling and cancelled groups."""

from unittest import mock

from bridge.room.ext import supervise
from bridge.tests.room.cl.support import RoomCase, VirtualGroup


class SuperviseDebtTests(RoomCase):
    def test_final_result_read_survives_sleep_overshoot(self):
        path = self.scratch / "late-result.json"
        now = 0.0
        attempts = []

        def sleep(delay):
            nonlocal now
            now += delay
            if now >= supervise.RESULT_GRACE:
                path.write_text('{"verdict":"OK"}', encoding="utf-8")
                now += 0.001

        read_result = supervise._read_result

        def read(path, *, warn):
            attempts.append(now)
            return read_result(path, warn=warn)

        with (
            mock.patch.object(supervise.time, "monotonic", side_effect=lambda: now),
            mock.patch.object(supervise.time, "sleep", side_effect=sleep),
            mock.patch.object(supervise, "_read_result", side_effect=read),
            mock.patch.object(supervise, "_warn_result") as warn,
        ):
            result = supervise._Result(path).finish()

        self.assertEqual(result, {"verdict": "OK"})
        self.assertEqual(attempts[0], 0.0)
        self.assertEqual(sum(at >= supervise.RESULT_GRACE for at in attempts), 1)
        warn.assert_not_called()

    def test_missing_proc_still_kills_and_reaps_cancelled_group(self):
        import os
        import signal

        group = VirtualGroup(duration=20, descendant=True, signal_status=0)
        scans = []
        scandir = os.scandir

        def without_proc(path):
            if path == "/proc":
                scans.append(path)
                raise FileNotFoundError(path)
            return scandir(path)

        with mock.patch.object(os, "scandir", side_effect=without_proc):
            status, _, _ = group.run(self, ["--wall-s", "0.5"])

        self.assertEqual(status, 0)
        self.assertEqual(len(scans), 1)
        self.assertEqual([number for _, _, number, _ in group.signals],
                         [signal.SIGTERM, signal.SIGKILL])
        terminal = group.events[-1]
        self.assertTrue(terminal.reaped)
        self.assertFalse(terminal.descendant)
        self.assertEqual((terminal.data["state"], terminal.data["reason"]),
                         ("failed", "wall_timeout"))
