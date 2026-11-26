"""Exercise process APIs through simulated Windows and macOS boundaries."""

import errno
from contextlib import ExitStack
import os
import select
import signal
import subprocess
import unittest
from unittest import mock

from bridge.room.ext import supervise, wave


class WindowsProcessTests(unittest.TestCase):
    def setUp(self):
        patches = self.enterContext(ExitStack())
        patches.enter_context(mock.patch.object(supervise, "_WINDOWS", True, create=True))
        patches.enter_context(mock.patch.object(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200, create=True))
        patches.enter_context(mock.patch.object(signal, "SIGBREAK", 21, create=True))
        patches.enter_context(mock.patch.object(signal, "CTRL_BREAK_EVENT", 1, create=True))
        self.job_type = patches.enter_context(
            mock.patch.object(supervise, "_WindowsJob", create=True))
        self.job = self.job_type.return_value
        self.job.__enter__.return_value = self.job
        self.child = mock.Mock(pid=123)
        self.child.poll.return_value = None
        self.popen = patches.enter_context(mock.patch.object(
            subprocess, "Popen", return_value=self.child))
        patches.enter_context(mock.patch.object(
            os, "waitid", side_effect=AssertionError("POSIX waitid"), create=True))
        patches.enter_context(mock.patch.object(
            os, "killpg", side_effect=AssertionError("POSIX killpg"), create=True))
        self.lifecycle = patches.enter_context(mock.patch.object(supervise, "_Lifecycle"))
        self.handlers = {}

        def install(number, handler):
            previous = self.handlers.get(number, signal.SIG_DFL)
            self.handlers[number] = handler
            return previous

        patches.enter_context(mock.patch.object(signal, "signal", side_effect=install))

    def run_command(self, *options):
        return supervise.main([
            "--room", "demo", "--agent", "worker", *options, "--", "synthetic-child",
        ])

    def assert_job_cleanup(self):
        self.assertEqual(self.popen.call_args.kwargs["creationflags"], 0x204)
        self.assertFalse(self.popen.call_args.kwargs.get("start_new_session"))
        self.job.attach.assert_called_once_with(self.child)
        self.job.__exit__.assert_called_once()

    def test_stop_terminates_the_job_and_reaps_the_child(self):
        def emit(state, *_args, **_kwargs):
            if state == "alive":
                self.handlers[signal.SIGBREAK](signal.SIGBREAK, None)

        self.lifecycle.return_value.emit.side_effect = emit
        self.child.wait.return_value = 1
        self.assertEqual(self.run_command(), 1)
        self.job.terminate.assert_called_once_with()
        self.child.wait.assert_called_with()
        self.assertEqual(self.lifecycle.return_value.emit.call_args.args[:2],
                         ("failed", "wrapper:SIGBREAK"))
        self.assert_job_cleanup()

    def test_wall_timeout_terminates_the_job_and_reaps_the_child(self):
        self.child.wait.side_effect = [subprocess.TimeoutExpired("child", 0.01), 1]
        with mock.patch.object(supervise.time, "monotonic", side_effect=[0, 0, 1, 1]):
            self.assertEqual(self.run_command("--wall-s", "0.01"), 1)
        self.job.terminate.assert_called_once_with()
        self.child.wait.assert_called_with()
        self.assertEqual(self.lifecycle.return_value.emit.call_args.args[:2],
                         ("failed", "wall_timeout"))
        self.assert_job_cleanup()

    def test_nonzero_exit_closes_the_job_and_preserves_exit_code(self):
        self.child.wait.return_value = 9
        self.assertEqual(self.run_command(), 9)
        self.assertEqual(self.lifecycle.return_value.emit.call_args.args[:2],
                         ("failed", "exit:9"))
        self.assert_job_cleanup()

    def test_failed_job_attachment_kills_and_reaps_suspended_child(self):
        self.job.attach.side_effect = OSError("job assignment failed")
        with mock.patch.object(supervise, "_warn"):
            self.assertEqual(self.run_command(), 126)
        self.child.kill.assert_called_once_with()
        self.child.wait.assert_called_once_with()
        self.assert_job_cleanup()

    def test_wave_sends_a_console_break_and_keeps_the_wrapper_job_open(self):
        identity = ("lane", "run-lane")
        self.child.wait.return_value = 1

        def spawn(*_args, **_kwargs):
            self.handlers[signal.SIGTERM](signal.SIGTERM, None)
            return self.child

        self.popen.side_effect = spawn
        with (
            mock.patch.object(wave, "_read_manifest",
                              return_value=("demo", {identity: (["wrapper"], None)})),
            mock.patch.object(wave, "_terminal_history", return_value={}),
            mock.patch.object(wave, "_emit") as emit,
        ):
            self.assertEqual(wave.main(["--manifest", "manifest.json"]), 1)
        self.child.send_signal.assert_called_once_with(signal.CTRL_BREAK_EVENT)
        self.assertEqual(emit.call_args.args[0]["wave"]["lanes"][0]["reason"],
                         "wrapper:SIGTERM")
        self.assert_job_cleanup()

    def test_wave_terminates_the_job_if_console_delivery_fails(self):
        self.child.send_signal.side_effect = OSError("console is unavailable")
        job = mock.Mock()
        exits, notified = wave._wait_for_wrappers(
            {"lane": self.child}, [signal.SIGTERM], {"lane": job})
        job.terminate.assert_called_once_with()
        self.assertEqual((exits, notified), ({"lane": self.child.wait.return_value}, {"lane"}))

    def test_unacknowledged_wave_stop_terminates_the_job(self):
        self.child.wait.side_effect = [subprocess.TimeoutExpired("wrapper", 0.1), 1]
        job = mock.Mock()
        with mock.patch.object(supervise.time, "monotonic", side_effect=[0, 0, 100]):
            exits, notified = wave._wait_for_wrappers(
                {"lane": self.child}, [signal.SIGTERM], {"lane": job})
        self.child.send_signal.assert_called_once_with(signal.CTRL_BREAK_EVENT)
        job.terminate.assert_called_once_with()
        self.assertEqual((exits, notified), ({"lane": 1}, {"lane"}))

    def test_unexpected_wait_failure_closes_the_job(self):
        self.child.wait.side_effect = RuntimeError("wait failed")
        with self.assertRaisesRegex(RuntimeError, "wait failed"):
            self.run_command()
        self.assert_job_cleanup()


class MacProcessTests(unittest.TestCase):
    def test_group_stop_without_waitid_keeps_leader_until_group_is_killed(self):
        child = mock.Mock(pid=123)
        child.poll.side_effect = AssertionError("leader must stay waitable")
        child.wait.return_value = -signal.SIGTERM
        queue = mock.MagicMock()
        queue.control.side_effect = [[], [object()], [object()]]
        handlers = {}

        def install(number, handler):
            previous = handlers.get(number, signal.SIG_DFL)
            handlers[number] = handler
            return previous

        def emit(state, *_args, **_kwargs):
            if state == "alive":
                handlers[signal.SIGTERM](signal.SIGTERM, None)

        kill_signal = getattr(signal, "SIGKILL", 9)
        with (
            mock.patch.object(signal, "SIGKILL", kill_signal, create=True),
            mock.patch.object(supervise.sys, "platform", "darwin"),
            mock.patch.object(supervise, "_WINDOWS", False, create=True),
            mock.patch.object(os, "waitid", None, create=True),
            mock.patch.object(select, "kqueue", return_value=queue, create=True),
            mock.patch.object(select, "kevent", create=True),
            mock.patch.object(select, "KQ_FILTER_PROC", -5, create=True),
            mock.patch.object(select, "KQ_EV_ADD", 1, create=True),
            mock.patch.object(select, "KQ_NOTE_EXIT", 0x80000000, create=True),
            mock.patch.object(subprocess, "Popen", return_value=child),
            mock.patch.object(signal, "signal", side_effect=install),
            mock.patch.object(supervise, "_Lifecycle") as lifecycle,
            mock.patch.object(supervise, "SHUTDOWN_GRACE", 0),
            mock.patch.object(os, "killpg", create=True) as killpg,
        ):
            lifecycle.return_value.emit.side_effect = emit
            actions = mock.Mock()
            actions.attach_mock(killpg, "killpg")
            actions.attach_mock(child.wait, "wait")
            code = supervise.main(["--room", "demo", "--agent", "worker", "--", "child"])

        self.assertEqual(code, 128 + signal.SIGTERM)
        self.assertEqual(actions.mock_calls, [
            mock.call.killpg(child.pid, signal.SIGTERM),
            mock.call.killpg(child.pid, kill_signal),
            mock.call.wait(),
        ])
        queue.close.assert_called_once_with()

    def test_kqueue_registration_of_an_exited_child_preserves_exit_status(self):
        queue = mock.Mock()
        queue.control.side_effect = ProcessLookupError(errno.ESRCH, "already exited")
        child = mock.Mock(pid=123)
        child.wait.return_value = 23
        child.poll.side_effect = AssertionError("leader must stay waitable")
        with (
            mock.patch.object(supervise.sys, "platform", "darwin"),
            mock.patch.object(supervise, "_WINDOWS", False, create=True),
            mock.patch.object(os, "waitid", None, create=True),
            mock.patch.object(select, "kqueue", return_value=queue, create=True),
            mock.patch.object(select, "kevent", create=True),
            mock.patch.object(select, "KQ_FILTER_PROC", -5, create=True),
            mock.patch.object(select, "KQ_EV_ADD", 1, create=True),
            mock.patch.object(select, "KQ_NOTE_EXIT", 0x80000000, create=True),
            mock.patch.object(subprocess, "Popen", return_value=child),
            mock.patch.object(supervise, "_Lifecycle"),
            mock.patch.object(os, "killpg", create=True) as killpg,
        ):
            self.assertEqual(supervise.main(
                ["--room", "demo", "--agent", "worker", "--", "child"]), 23)
        killpg.assert_not_called()
        queue.close.assert_called_once_with()
