"""A result FIFO without a writer cannot stall terminal lifecycle emission."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]


class NonregularResults(unittest.TestCase):
    def fifo_child(self, code):
        with tempfile.TemporaryDirectory(prefix="runtime-", dir=HERE) as directory:
            home = Path(directory)
            result_file = home / "result.fifo"
            os.mkfifo(result_file)
            environment = dict(os.environ, CW_HOME=str(home), PYTHONDONTWRITEBYTECODE="1")
            for key in ("CW_AGENT", "CW_ROLE", "CW_SESSION_AGENT", "CW_SESSION_ROLE"):
                environment.pop(key, None)
            wrapper = ("import sys; sys.path.insert(0, sys.argv[1]); "
                       "from bridge.room.__main__ import main; raise SystemExit(main(sys.argv[2:]))")
            child = "import sys; sys.exit(" + str(code) + ")"
            if code < 0:
                child = "import os, signal; os.kill(os.getpid(), signal.SIGTERM)"
            arguments = [sys.executable, "-I", "-B", "-c", wrapper, str(ROOT),
                "run", "--room", "demo", "--agent", "worker", "--run-id", "fifo-run",
                "--result-file", str(result_file), "--", sys.executable, "-I", "-B", "-c", child]
            try:
                completed = subprocess.run(arguments, cwd=ROOT, env=environment,
                    capture_output=True, text=True, timeout=3)
            except subprocess.TimeoutExpired:
                self.fail("supervisor blocked on a result FIFO after the child exited")
            self.assertEqual(completed.returncode, code if code >= 0 else 128 - code)
            self.assertEqual(completed.stdout, "")
            self.assertEqual(completed.stderr.splitlines(), [
                "tasklight run: result file missing or invalid; result omitted"])
            events = [json.loads(line) for line in
                      (home / "rooms/demo/events.jsonl").read_text().splitlines()]
            terminal = [event["op"] for event in events
                        if event["op"]["state"] in ("finished", "failed")]
            self.assertEqual(len(terminal), 1)
            self.assertEqual(terminal[0]["state"], "finished" if code == 0 else "failed")
            self.assertNotIn("result", terminal[0])
            if code > 0:
                self.assertEqual(terminal[0]["reason"], "exit:" + str(code))
            elif code < 0:
                self.assertEqual(terminal[0]["reason"], "signal:SIGTERM")

    def test_fifo_preserves_success_and_terminal_event(self):
        self.fifo_child(0)

    def test_fifo_preserves_failure_and_terminal_event(self):
        self.fifo_child(23)

    def test_fifo_preserves_signal_and_terminal_event(self):
        self.fifo_child(-signal.SIGTERM)
