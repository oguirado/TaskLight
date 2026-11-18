"""Cancellation while a wave is starting its lane wrappers."""

from contextlib import redirect_stdout
import io
import json
import signal
import unittest
from unittest import mock

from bridge.room.ext import wave


class WaveStartupTests(unittest.TestCase):
    def test_signal_during_spawn_cancels_started_wrapper_and_stops_launch(self):
        first, second = ("lane-a", "run-a"), ("lane-b", "run-b")
        commands = {first: (["first"], None), second: (["second"], None)}
        wrapper = mock.Mock()
        wrapper.poll.return_value = None
        wrapper.wait.return_value = -signal.SIGTERM
        handlers = {}

        def install(number, handler):
            previous = handlers.get(number, signal.SIG_DFL)
            handlers[number] = handler
            return previous

        def spawn(*args, **kwargs):
            handler = handlers.get(signal.SIGTERM)
            if handler is not None:
                handler(signal.SIGTERM, None)
            return wrapper

        out = io.StringIO()
        with (
            mock.patch.object(wave, "_read_manifest", return_value=("demo", commands)),
            mock.patch.object(wave, "_terminal_history", return_value={}),
            mock.patch.object(signal, "signal", side_effect=install),
            mock.patch.object(wave.subprocess, "Popen", side_effect=spawn) as popen,
            redirect_stdout(out),
        ):
            code = wave.main(["--manifest", "manifest.json"])

        self.assertEqual(popen.call_count, 1)
        wrapper.send_signal.assert_called_once_with(signal.SIGTERM)
        wrapper.wait.assert_called_once()
        self.assertEqual(code, 1)
        rows = json.loads(out.getvalue())["wave"]["lanes"]
        self.assertEqual([(row["state"], row["reason"], row["exit"]) for row in rows], [
            ("failed", "wrapper:SIGTERM", 128 + signal.SIGTERM),
            ("failed", "wrapper:SIGTERM", None),
        ])
        self.assertEqual(handlers, {signal.SIGTERM: signal.SIG_DFL,
                                    signal.SIGINT: signal.SIG_DFL})
