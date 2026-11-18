"""CL M1–M5 through the public run command."""
import json
import os
import signal
import subprocess
import sys
from unittest import mock

from .support import BoundExceeded, ROOT, RoomCase, TERMINAL, VirtualGroup


class RunOracle(RoomCase):
    def run_stream_child(self, options):
        code = (
            "import json, os, sys\n"
            "identity = [os.getpid(), os.getsid(0), os.getpgrp(), "
            "os.getsid(os.getppid()), os.getpgid(os.getppid())]\n"
            "sys.stdout.buffer.write(json.dumps([identity, sys.argv[1:]]).encode() + b'\\n')\n"
            "sys.stdout.buffer.write(sys.stdin.buffer.read())\n"
            "sys.stderr.buffer.write(bytes([0, 255, 10]))\n"
        )
        argv = ["two words", "", "--", "$HOME; echo surprise", "λ"]
        binary = bytes(range(256))
        result = subprocess.run(
            [sys.executable, "-B", "-m", "bridge.room", "run", "--room", "demo",
             "--agent", "lane-a", "--run-id", "attempt-a", *options, "--",
             sys.executable, "-B", "-c", code, *argv],
            cwd=ROOT, env=self.env, input=binary, capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        line, output = result.stdout.split(b"\n", 1)
        identity, seen_argv = json.loads(line)
        self.assertEqual(seen_argv, argv)
        self.assertEqual(output, binary)
        self.assertEqual(result.stderr, bytes([0, 255, 10]))
        return identity

    def test_m1_default_is_an_owned_session_and_preserves_binary_io_and_argv(self):
        pid, sid, pgid, parent_sid, parent_pgid = self.run_stream_child([])
        self.assertEqual((sid, pgid), (pid, pid))
        self.assertNotEqual(sid, parent_sid)
        self.assertNotEqual(pgid, parent_pgid)

    def test_m1_no_group_preserves_foreground_group_and_streams(self):
        _, sid, pgid, parent_sid, parent_pgid = self.run_stream_child(["--no-group"])
        self.assertEqual((sid, pgid), (parent_sid, parent_pgid))

    def terminal(self, group, state, reason=None):
        rows = [row for row in group.events if row.data["state"] in TERMINAL]
        self.assertEqual(len(rows), 1, "there must be one terminal lifecycle event")
        self.assertIs(group.events[-1], rows[0])
        self.assertEqual(rows[0].data["state"], state)
        if reason is not None:
            self.assertEqual(rows[0].data.get("reason"), reason)
        return rows[0]

    def test_m2_term_escalates_after_leader_exits_and_before_terminal(self):
        group = VirtualGroup(duration=1, descendant=True,
                             interrupts=((0.25, signal.SIGTERM),))
        code, _, _ = group.run(self)
        self.assertEqual(code, 0, "the baseline child status must survive cancellation")
        self.assertEqual(group.signals, [
            (0.25, group.child.pid, signal.SIGTERM, "group"),
            (2.25, group.child.pid, signal.SIGKILL, "group"),
        ])
        event = self.terminal(group, "failed", "wrapper:SIGTERM")
        self.assertGreaterEqual(event.at, 2.25)
        self.assertTrue(event.reaped)
        self.assertFalse(event.descendant)
        self.assertTrue(group.sentinel_alive)

    def test_m2_kills_term_ignoring_leader_and_descendant(self):
        group = VirtualGroup(duration=12, descendant=True,
                             interrupts=((0.25, signal.SIGTERM),))
        code, _, _ = group.run(self)
        self.assertEqual(code, 128 + signal.SIGKILL)
        self.assertEqual(group.signals, [
            (0.25, group.child.pid, signal.SIGTERM, "group"),
            (2.25, group.child.pid, signal.SIGKILL, "group"),
        ])
        event = self.terminal(group, "failed", "wrapper:SIGTERM")
        self.assertTrue(event.reaped)
        self.assertFalse(event.descendant)

    def test_m2_first_cause_wins_over_later_signal_and_wall_limit(self):
        group = VirtualGroup(duration=12, descendant=True, interrupts=(
            (0.25, signal.SIGINT), (0.50, signal.SIGTERM),
        ))
        code, _, _ = group.run(self, ["--wall-s", "1"])
        self.assertEqual(code, 128 + signal.SIGKILL)
        self.assertEqual(group.signals, [
            (0.25, group.child.pid, signal.SIGINT, "group"),
            (2.25, group.child.pid, signal.SIGKILL, "group"),
        ])
        self.terminal(group, "failed", "wrapper:SIGINT")

    def test_m3_timeout_uses_monotonic_time_from_spawn_and_zero_exit_stays_failed(self):
        group = VirtualGroup(duration=12, startup=7, signal_status=0)
        code, _, _ = group.run(self, ["--wall-s", "1"])
        self.assertEqual(code, 0)
        self.assertEqual(group.signals, [
            (8, group.child.pid, signal.SIGTERM, "group"),
        ])
        event = self.terminal(group, "failed", "wall_timeout")
        self.assertTrue(event.reaped)

    def test_m3_wrapper_int_forwarding_preserves_actual_signal_status(self):
        group = VirtualGroup(duration=10, signal_status=-signal.SIGINT,
                             interrupts=((0.25, signal.SIGINT),))
        code, _, _ = group.run(self)
        self.assertEqual(code, 128 + signal.SIGINT)
        self.assertEqual(group.signals, [
            (0.25, group.child.pid, signal.SIGINT, "group"),
        ])
        self.terminal(group, "failed", "wrapper:SIGINT")

    def test_m3_natural_success_has_exit_zero_reason(self):
        group = VirtualGroup()
        code, _, _ = group.run(self)
        self.assertEqual(code, 0)
        self.terminal(group, "finished", "exit:0")

    def test_m3_natural_nonzero_exit(self):
        group = VirtualGroup(status=17)
        code, _, _ = group.run(self)
        self.assertEqual(code, 17)
        self.terminal(group, "failed", "exit:17")

    def test_m3_natural_signal_exit(self):
        group = VirtualGroup(status=-signal.SIGKILL)
        code, _, _ = group.run(self)
        self.assertEqual(code, 128 + signal.SIGKILL)
        self.terminal(group, "failed", "signal:SIGKILL")

    def test_m3_missing_executable_returns_127(self):
        group = VirtualGroup(launch_error=FileNotFoundError())
        code, _, _ = group.run(self)
        self.assertEqual(code, 127)
        self.terminal(group, "failed", "exit:127")
        self.assertNotIn("alive", [row.data["state"] for row in group.events])

    def test_m3_permission_denied_returns_126(self):
        group = VirtualGroup(launch_error=PermissionError())
        code, _, _ = group.run(self)
        self.assertEqual(code, 126)
        self.terminal(group, "failed", "exit:126")
        self.assertNotIn("alive", [row.data["state"] for row in group.events])

    def test_m4_result_one_second_after_exit_is_attached(self):
        group = VirtualGroup(status=13)
        path = self.scratch / "result.json"
        group.schedule(1.5, path.write_text, '{"verdict":"OK"}')
        code, _, stderr = group.run(self, ["--result-file", str(path)])
        self.assertEqual(code, 13)
        event = self.terminal(group, "failed", "exit:13")
        self.assertEqual(event.data.get("result"), {"verdict": "OK"})
        self.assertGreaterEqual(event.at, 1.5)
        self.assertLessEqual(event.at, 2.5)
        self.assertEqual(stderr, "")

    def test_m4_retries_invalid_publication_and_freezes_first_valid_result(self):
        group = VirtualGroup()
        path = self.scratch / "result.json"
        staged = self.scratch / "staged.json"
        path.write_text('{"verdict":', encoding="utf-8")
        staged.write_text('{"verdict":"FAIL"}', encoding="utf-8")
        group.schedule(1.0, staged.replace, path)

        code, _, _ = group.run(self, ["--result-file", str(path)])
        self.assertEqual(code, 0)
        event = self.terminal(group, "finished")
        self.assertEqual(event.data.get("result"), {"verdict": "FAIL"})
        self.assertGreaterEqual(event.at, 1.0)
        self.assertLessEqual(event.at, 2.5)

    def test_m4_reads_at_exit_and_accepts_exact_byte_limit(self):
        group = VirtualGroup()
        path = self.scratch / "result.json"
        payload = b'{"verdict":"OK"}'
        path.write_bytes(payload.ljust(65_536))
        group.schedule(0.75, path.write_text, '{"verdict":"FAIL"}')
        code, _, stderr = group.run(self, ["--result-file", str(path)])
        self.assertEqual(code, 0)
        event = self.terminal(group, "finished")
        self.assertEqual(event.data.get("result"), {"verdict": "OK"})
        self.assertEqual(event.at, 0.5)
        self.assertEqual(stderr, "")

    def assert_result_omitted(self, group, path):
        code, _, stderr = group.run(self, ["--result-file", str(path)])
        self.assertEqual(code, 7)
        event = self.terminal(group, "failed", "exit:7")
        self.assertNotIn("result", event.data)
        self.assertAlmostEqual(event.at, 2.5)
        self.assertEqual(len(stderr.splitlines()), 1)
        self.assertNotIn(str(path), stderr)

    def test_m4_one_byte_over_limit_is_rejected_through_grace(self):
        path = self.scratch / "oversize.json"
        path.write_bytes(b'{"verdict":"OK"}'.ljust(65_537))
        self.assert_result_omitted(VirtualGroup(status=7), path)

    def test_m4_rejects_fifo_without_waiting_for_writer(self):
        path = self.scratch / "result-fifo"
        os.mkfifo(path)
        real_open = os.open

        def guarded_open(name, flags, *args, **kwargs):
            if name in (str(path), os.fsencode(path), path) and not flags & os.O_NONBLOCK:
                raise BoundExceeded("result reader attempted a blocking FIFO open")
            return real_open(name, flags, *args, **kwargs)

        with mock.patch.object(os, "open", side_effect=guarded_open):
            self.assert_result_omitted(VirtualGroup(status=7), path)

    def test_m4_invalid_schema_at_deadline_is_omitted(self):
        path = self.scratch / "invalid.json"
        path.write_text('{"verdict":"OK","unknown":1}', encoding="utf-8")
        self.assert_result_omitted(VirtualGroup(status=7), path)

    def test_m4_result_arriving_after_deadline_cannot_change_terminal(self):
        group = VirtualGroup(status=7)
        path = self.scratch / "late.json"
        group.schedule(2.75, path.write_text, '{"verdict":"OK"}')
        self.assert_result_omitted(group, path)

    def test_m5_alive_is_immediate_and_periodic_until_exit(self):
        group = VirtualGroup(duration=5, startup=0.25)
        code, _, _ = group.run(self, ["--beat", "2"])
        self.assertEqual(code, 0)
        alive = [row.at for row in group.events if row.data["state"] == "alive"]
        self.assertEqual(alive, [0.25, 2.25, 4.25])
        self.terminal(group, "finished", "exit:0")
