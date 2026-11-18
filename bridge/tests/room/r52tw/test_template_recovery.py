"""Exercise the registered waiter against a real filesystem fault."""
from concurrent.futures import Future
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from time import monotonic
import unittest
from unittest.mock import patch

from bridge.room import app


HERE = Path(__file__).resolve().parent
TIMEOUT = 1.5
DEADLINE_GRACE = 0.25


class TemplateRecoveryOracle(unittest.TestCase):
    def lifecycle(self, state, **fields):
        reply = app.dispatch("agent_lifecycle", {
            "room": "demo", "agent": "worker", "run_id": "run-a",
            "state": state, "op_id": f"r52tw-{state}", **fields,
        })["untrusted"]
        self.assertTrue(reply["ok"])
        return reply["lamport"]

    def scenario(self, *, obstructed, publish_terminal):
        with TemporaryDirectory(prefix="runtime-", dir=HERE) as directory:
            with patch.dict(os.environ, CW_HOME=directory):
                return self.wait_through_recovery(Path(directory), obstructed, publish_terminal)

    def wait_through_recovery(self, home, obstructed, publish_terminal):
        templates = home / "templates"
        saved = templates.with_suffix(".saved")
        templates.mkdir()
        since = self.lifecycle("deployed", parent_agent="leader", parent_run_id="lead-run")
        self.assertEqual(since, 1)

        started = Event()
        finished = Future()

        def wait():
            began = monotonic()
            started.set()
            try:
                reply = app.dispatch("wait_agents", {
                    "room": "demo", "agents": ["worker"], "parent": "leader",
                    "since_lamport": since, "timeout_s": TIMEOUT,
                })
            except Exception as error:
                finished.set_exception(error)
            else:
                finished.set_result((reply, began, monotonic()))

        thread = Thread(target=wait, daemon=True)
        thread.start()
        try:
            self.assertTrue(started.wait(timeout=1))
            with self.assertRaises(TimeoutError):
                finished.result(timeout=0.25)

            if obstructed:
                templates.rename(saved)
                templates.touch()
            try:
                if obstructed:
                    with self.assertRaises(NotADirectoryError):
                        with os.scandir(templates) as entries:
                            list(entries)
                else:
                    self.assertEqual(list(templates.iterdir()), [])
                with self.assertRaises(TimeoutError):
                    finished.result(timeout=0.4)
            finally:
                if obstructed:
                    templates.unlink()
                    saved.rename(templates)

            self.assertEqual(list(templates.iterdir()), [])
            with self.assertRaises(TimeoutError):
                finished.result(timeout=0.2)

            published = None
            if publish_terminal:
                published = monotonic()
                self.assertEqual(self.lifecycle("finished"), 2)
            reply, began, ended = finished.result(timeout=TIMEOUT + DEADLINE_GRACE)
            if published is not None:
                self.assertGreaterEqual(ended, published)
            return reply, ended - began, None if published is None else ended - published
        finally:
            thread.join(timeout=TIMEOUT + DEADLINE_GRACE)

    def test_terminal_reply_and_deadline_match_readable_control(self):
        control, control_elapsed, control_delivery = self.scenario(
            obstructed=False, publish_terminal=True)
        recovered, recovered_elapsed, recovered_delivery = self.scenario(
            obstructed=True, publish_terminal=True)
        self.assertEqual(control, {"untrusted": {"events": [{
            "agent": "worker", "run_id": "run-a", "state": "finished",
            "parent": {"agent": "leader", "run_id": "lead-run"}, "lamport": 2,
        }], "cursor": 2}})
        self.assertEqual(recovered, control)
        self.assertLess(control_elapsed, TIMEOUT)
        self.assertLess(recovered_elapsed, TIMEOUT)
        self.assertAlmostEqual(recovered_delivery, control_delivery, delta=DEADLINE_GRACE)

    def test_idle_deadline_matches_readable_control(self):
        control, control_elapsed, _ = self.scenario(obstructed=False, publish_terminal=False)
        recovered, recovered_elapsed, _ = self.scenario(obstructed=True, publish_terminal=False)
        self.assertEqual(control, {"untrusted": {"events": [], "cursor": 1, "timed_out": True}})
        self.assertEqual(recovered, control)
        for elapsed in (control_elapsed, recovered_elapsed):
            self.assertGreaterEqual(elapsed, TIMEOUT)
            self.assertLess(elapsed, TIMEOUT + DEADLINE_GRACE)
        self.assertAlmostEqual(recovered_elapsed, control_elapsed, delta=DEADLINE_GRACE)
