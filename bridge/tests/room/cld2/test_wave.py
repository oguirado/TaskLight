"""Regressions at the wave coordinator and the public CLI boundary."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import unittest
from unittest import mock

from bridge.room import store
from bridge.room.ext import wave
from bridge.tests.room.cl.support import RoomCase


class WaveDebtTests(RoomCase):
    def lane(self, index, script="pass", *args, **options):
        path = self.scratch / f"result-{index}.json"
        path.write_text('{"verdict":"OK"}', encoding="utf-8")
        return {"agent": f"lane-{index}", "run_id": f"run-{index}",
                "argv": [sys.executable, "-c", script, *args],
                "result_file": str(path), **options}

    def manifest(self, *lanes):
        self.lifecycle("leader", "leader-run", "deployed")
        path = self.scratch / "manifest.json"
        path.write_text(json.dumps({"room": "demo", "parent": "leader",
                                    "parent_run": "leader-run", "lanes": lanes}),
                        encoding="utf-8")
        return str(path)

    # Orchestrator: snapshot read-count check lives in test_wave_snapshot.py (this variant also counted the simulated wrappers' own reads).

    def test_terminal_history_skips_malformed_records(self):
        self.lifecycle("leader", "leader-run", "deployed")
        good = {"kind": "agent.lifecycle", "state": "finished", "run_id": "run-0"}
        records = [
            {"agent": "lane-0", "op": {"kind": "agent.lifecycle"}},
            {"agent": "lane-0", "op": {**good, "state": []}},
            {"agent": [], "op": good},
            {"op": good},
            {"agent": "lane-0", "op": {**good, "run_id": {}}},
            {"agent": "lane-0", "op": {**good, "reason": []}},
            {"agent": "lane-0", "op": None},
            None,
            {"agent": "lane-0", "op": good},
        ]
        identity = ("lane-0", "run-0")
        with mock.patch.object(store, "read_checked", return_value=(records, 0)):
            self.assertEqual(wave._terminal_history("demo", {identity}), {identity: good})

    def test_closed_stderr_leaves_summary_and_default_stdin_is_eof(self):
        script = "import sys; assert sys.stdin.buffer.read() == b''; print('lane output')"
        manifest = self.manifest(self.lane(0, script))
        entry = "import os, runpy; os.close(2); runpy.run_module('bridge.room', run_name='__main__')"
        run = subprocess.run([sys.executable, "-c", entry, "wave", "--manifest", manifest],
                             input=b"must not reach the lane", capture_output=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertEqual(json.loads(run.stdout)["wave"]["lanes"][0]["reason"], "exit:0")

    def test_manifest_can_opt_in_to_inherited_stdin(self):
        script = "import sys; assert sys.stdin.buffer.read() == b'from wave'"
        manifest = self.manifest(self.lane(0, script, stdin="inherit"))
        run = subprocess.run([sys.executable, "-m", "bridge.room", "wave", "--manifest", manifest],
                             input=b"from wave", capture_output=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertEqual(json.loads(run.stdout)["wave"]["lanes"][0]["reason"], "exit:0")

    @unittest.skipUnless(sys.platform.startswith("linux"),
                         "requires Linux procfs and POSIX process-group signal delivery")
    def test_sigterm_cancels_and_reaps_every_running_lane(self):
        self.assert_signal_cancels_wave(signal.SIGTERM)

    @unittest.skipUnless(sys.platform.startswith("linux"),
                         "requires Linux procfs and POSIX process-group signal delivery")
    def test_sigint_cancels_and_reaps_every_running_lane(self):
        self.assert_signal_cancels_wave(signal.SIGINT)

    def assert_signal_cancels_wave(self, number):
        # Publish each group leader PID only after the descendant is running.
        script = (
            "import os, pathlib, signal, subprocess, sys, time\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "signal.signal(signal.SIGINT, signal.SIG_IGN)\n"
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(20)'])\n"
            "marker = pathlib.Path(sys.argv[1])\n"
            "pending = marker.with_suffix('.tmp')\n"
            "pending.write_text(f'{os.getpid()} {child.pid}')\n"
            "pending.replace(marker)\n"
            "time.sleep(20)\n"
        )
        markers = [self.scratch / f"ready-{index}" for index in range(2)]
        manifest = self.manifest(*(self.lane(index, script, str(marker), wall_s=12)
                                   for index, marker in enumerate(markers)))
        with subprocess.Popen(
            [sys.executable, "-m", "bridge.room", "wave", "--manifest", manifest],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        ) as process:
            try:
                deadline = time.monotonic() + 5
                while not all(marker.exists() for marker in markers):
                    self.assertIsNone(process.poll(), "wave exited during lane startup")
                    self.assertLess(time.monotonic(), deadline, "lanes did not start")
                    time.sleep(0.01)
                process.send_signal(number)
                process.wait(timeout=7)
                self.assertEqual(process.returncode, 1)
                out, err = process.communicate(timeout=3)
                self.assertEqual(len(out.splitlines()), 1, err)
                rows = json.loads(out)["wave"]["lanes"]
                self.assertEqual([(row["agent"], row["state"], row["reason"], row["exit"])
                                  for row in rows],
                                 [(f"lane-{i}", "failed", f"wrapper:{number.name}",
                                   128 + signal.SIGKILL) for i in range(len(markers))])
                for marker in markers:
                    leader, child = map(int, marker.read_text().split())
                    self.assertFalse(Path(f"/proc/{leader}/stat").exists(), "leader was not reaped")
                    stat = Path(f"/proc/{child}/stat")
                    try:
                        state = stat.read_bytes().rpartition(b") ")[2].split()[0]
                    except FileNotFoundError:
                        continue
                    self.assertIn(state, (b"Z", b"X"), "descendant survived cancellation")
            finally:
                # Bound failures against the old wave, whose wrappers survive it.
                if process.poll() is None:
                    process.kill()
                for marker in markers:
                    if marker.exists():
                        leader = int(marker.read_text().split()[0])
                        try:
                            os.killpg(leader, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
