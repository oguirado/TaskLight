"""Agent uniqueness at the public wave command boundary."""

from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from bridge.room.__main__ import main as room_main
from bridge.room.ext import wave


class WaveManifestTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.scratch = Path(scratch.name)
        self.manifest = self.scratch / "manifest.json"

    def invoke(self, second_agent, second_run):
        lanes = [
            {
                "agent": agent,
                "run_id": run_id,
                "argv": [sys.executable, "-c", "raise SystemExit(0)"],
                "result_file": str(self.scratch / f"result-{index}.json"),
            }
            for index, (agent, run_id) in enumerate(
                [("worker-one", "run-one"), (second_agent, second_run)]
            )
        ]
        self.manifest.write_text(json.dumps({
            "room": "demo",
            "parent": "leader",
            "parent_run": "parent-run",
            "lanes": lanes,
        }), encoding="utf-8")
        stdout = io.StringIO()
        with (
            mock.patch.dict(os.environ, {"CW_HOME": str(self.scratch / "room-home")},
                            clear=True),
            mock.patch.object(wave, "_run_wave", return_value=0) as executor,
            redirect_stdout(stdout),
        ):
            status = room_main(["wave", "--manifest", str(self.manifest)])
        return status, stdout.getvalue(), executor

    def test_repeated_agent_with_distinct_runs_is_rejected_before_execution(self):
        status, stdout, executor = self.invoke("worker-one", "run-two")

        executor.assert_not_called()
        self.assertEqual(status, 2)
        response = json.loads(stdout)
        self.assertEqual(response["code"], "bad_args")
        self.assertTrue(response["detail"].startswith("lanes[1]:"))
        self.assertEqual(list(self.scratch.iterdir()), [self.manifest])

    def test_distinct_agents_with_a_shared_run_reach_the_executor(self):
        status, _, executor = self.invoke("worker-two", "run-one")

        self.assertEqual(status, 0)
        executor.assert_called_once()
        room, commands, _ = executor.call_args.args
        self.assertEqual(room, "demo")
        self.assertEqual(list(commands), [
            ("worker-one", "run-one"), ("worker-two", "run-one"),
        ])
