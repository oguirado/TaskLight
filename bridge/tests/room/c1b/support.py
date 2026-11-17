"""Contract helpers: real CLI, isolated storage, bounded process cleanup."""
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
BASE = ["--room", "demo", "--agent", "exec-a", "--run-id", "run-A_1"]
ALLOWED_OP = {"kind", "op_id", "state", "run_id", "harness", "reason",
              "parent_agent", "parent_run_id"}
ALLOWED_EVENT = {"id", "room", "agent", "act", "text", "op", "lamport", "ts"}


class RunCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="scratch-", dir=HERE)
        self.addCleanup(self.directory.cleanup)
        self.scratch = Path(self.directory.name)
        self.home = self.scratch / "home"
        self.marker = self.scratch / "child-started"
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("CW_", "PYTHON", "C1B_"))}
        self.env.update(CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1",
                        C1B_CHILD_MARKER=str(self.marker))

    def child(self, mode="exit", *args):
        return [sys.executable, "-B", "-m", "bridge.tests.room.c1b.child", mode, *args]

    def command(self, options=None, child=None, separator=True, entry=None):
        return [sys.executable, "-B", "-m", entry or "bridge.room", "run",
                *(BASE if options is None else options),
                *(["--"] if separator else []), *(self.child("exit", "0") if child is None else child)]

    def launch(self, command, env=None):
        process = subprocess.Popen(command, cwd=ROOT, env=env or self.env,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
        self.addCleanup(self.cleanup_process, process)
        return process

    @staticmethod
    def cleanup_process(process):
        # Kill the isolated process group even when only a descendant survived.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
            process.kill()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass

    def invoke(self, options=None, child=None, data=b"", separator=True, env=None):
        process = self.launch(self.command(options, child, separator), env)
        try:
            out, err = process.communicate(data, timeout=10)
        except subprocess.TimeoutExpired:
            self.fail("public run entry did not terminate after its bounded fixture child")
        return subprocess.CompletedProcess(process.args, process.returncode, out, err)

    def events(self, room="demo"):
        path = self.home / "rooms" / room / "events.jsonl"
        if not path.is_file():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]

    def lifecycle(self, agent="exec-a"):
        return [event for event in self.events() if event.get("agent") == agent
                and event.get("op", {}).get("kind") == "agent.lifecycle"]

    def assert_lifecycle(self, terminal="finished", reason=None):
        events = self.lifecycle()
        self.assertGreaterEqual(len(events), 2, "run must write deployment and a terminal lifecycle event")
        states = [event["op"]["state"] for event in events]
        self.assertEqual(states[0], "deployed")
        self.assertEqual(states[-1], terminal)
        self.assertTrue(all(state == "alive" for state in states[1:-1]), states)
        self.assertEqual(sum(state in ("finished", "failed") for state in states), 1)
        self.assertEqual({event["op"]["run_id"] for event in events}, {"run-A_1"})
        for event in events:
            self.assertEqual(event["room"], "demo")
            self.assertIsInstance(event.get("ts"), (int, float))
        if reason is not None:
            self.assertEqual(events[-1]["op"].get("reason"), reason)
        return events

    def signal_run(self, name, catch=False):
        process = self.launch(self.command(child=self.child("catch-signal" if catch else "signal", name)))
        ready = b""
        deadline = time.monotonic() + 10  # Deadlock guard, never a scheduling oracle.
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while b"\n" not in ready and len(ready) < 128:
                self.assertTrue(selector.select(timeout=max(0, deadline - time.monotonic())),
                                "fixture child never became ready")
                chunk = os.read(process.stdout.fileno(), 128)
                if not chunk:
                    break
                ready += chunk
        self.assertEqual(ready, b"CHILD-READY\n",
                         "run must start the child before testing signal forwarding")
        process.send_signal(getattr(signal, name))
        try:
            # Do not release stdin EOF until the child's signal outcome is known.
            process.wait(timeout=10)
            out, err = process.communicate(b"", timeout=10)
        except subprocess.TimeoutExpired:
            self.fail("supervisor did not forward the signal and finish")
        return subprocess.CompletedProcess(process.args, process.returncode, out, err)

    def probe(self, options=None, *, beat=15, code=0, fail=(), parent_seam=False):
        report_path = self.scratch / "probe.json"
        configuration = {"report": str(report_path), "beat": beat, "code": code,
                         "fail": list(fail), "parent_seam": parent_seam}
        env = dict(self.env, C1B_PROBE=json.dumps(configuration))
        process = self.launch(self.command(options, entry="bridge.tests.room.c1b.virtual_cli"), env)
        try:
            out, err = process.communicate(b"", timeout=10)
        except subprocess.TimeoutExpired:
            self.fail("supervisor did not complete with the deterministic virtual clock")
        self.assertTrue(report_path.exists(), "virtual CLI fixture failed to publish its observations")
        report = json.loads(report_path.read_text())
        self.assertIsNone(report["exception"], report["exception"])
        return subprocess.CompletedProcess(process.args, process.returncode, out, err), report
