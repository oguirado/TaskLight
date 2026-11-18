"""Regression checks for terminal recording and actionable validation errors."""

from contextlib import redirect_stderr
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from bridge.plan import ops
from bridge.plan.errors import PlanError
from bridge.room import app, store
from bridge.room.ext import supervise


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]


class RoomCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.enterContext(patch.dict(os.environ, {
            "CW_HOME": str(self.home), "PYTHONDONTWRITEBYTECODE": "1",
        }))
        for key in ("CW_PIN_AGENT", "CW_PIN_ROLE"):
            os.environ.pop(key, None)


class SupervisorErrors(RoomCase):
    def command(self, code):
        fifo = self.home / "result.fifo"
        os.mkfifo(fifo)
        return ["--room", "demo", "--agent", "worker", "--result-file", str(fifo),
                "--", sys.executable, "-I", "-B", "-c", f"raise SystemExit({code})"]

    def assert_terminal(self, state, reason=None):
        events, malformed = store.read("demo", home=self.home)
        self.assertEqual(malformed, 0)
        states = [event["op"]["state"] for event in events]  # A-CL: SPEC_CL M5 emits alive right after spawn
        self.assertEqual([s for s in states if s != "alive"], ["deployed", state])
        terminal = events[-1]["op"]
        self.assertEqual(terminal.get("reason"), reason)
        self.assertNotIn("result", terminal)

    def test_closed_stderr_preserves_finished_event(self):
        closed = io.StringIO()
        closed.close()
        with redirect_stderr(closed):
            code = supervise.main(self.command(0))
        self.assert_terminal("finished", "exit:0")  # A-CL: A natural success records exit:0.
        self.assertEqual(code, 0)

    def test_broken_stderr_preserves_failed_event(self):
        read_fd, write_fd = os.pipe()
        os.close(read_fd)
        try:
            completed = subprocess.run(
                [sys.executable, "-B", "-m", "bridge.room", "run", *self.command(23)],
                cwd=ROOT, stderr=write_fd, timeout=10,
            )
        finally:
            os.close(write_fd)
        self.assert_terminal("failed", "exit:23")
        self.assertEqual(completed.returncode, 23)


class WorkErrors(RoomCase):
    def reject(self, tool, args, code, detail):
        with self.assertRaises(store.RoomError) as caught:
            app.dispatch(tool, dict(args, room="demo", agent="worker"))
        self.assertEqual(caught.exception.code, code)
        self.assertIn(detail, str(caught.exception))
        self.assertFalse((self.home / "rooms" / "demo" / "events.jsonl").exists())

    def test_task_id_and_preferred_task_details_name_the_range(self):
        for tool, args, field in (
            ("work_acquire", {"prefer_task": "T41"}, "prefer_task"),
            ("work_report", {"task_id": "T41", "claim_lamport": 1, "done": []}, "task_id"),
        ):
            with self.subTest(field=field):
                self.reject(tool, args, "bad_op", f"{field} must be T01-T40")

    def test_completion_field_types_name_the_entry(self):
        first = {"id": "T01.M01", "outcome": "done", "evidence": ["reports/check.txt"]}
        second = dict(first, id="T01.M02")
        for field in ("id", "outcome", "took", "evidence"):
            with self.subTest(field=field):
                args = {"task_id": "T01", "claim_lamport": 1,
                        "done": [first, {**second, field: False}]}
                self.reject("work_report", args, "bad_evidence" if field == "evidence" else "bad_args",
                            f"done[1].{field} must be")

    def test_completion_id_detail_names_the_entry_and_range(self):
        done = {"id": "T01.M13", "outcome": "done", "evidence": ["reports/check.txt"]}
        self.reject("work_report", {"task_id": "T01", "claim_lamport": 1, "done": [done]},
                    "bad_op", "done[0].id must be T01-T40 followed by .M01-.M12")


class OperationErrors(unittest.TestCase):
    def test_non_string_keys_are_bad_op_without_echoing_key(self):
        key = ("omitted",)
        operation = {"kind": "unit.decision", key: "value"}
        for validator in (lambda op: ops._check_unknown(op, {"kind"}), ops.validate_op_shape):
            with self.subTest(validator=validator):
                with self.assertRaises(PlanError) as caught:
                    validator(operation)
                self.assertEqual(caught.exception.code, "bad_op")  # A-DEBT2b: error codes never change (C9); bridge/tests/plan pins bad_op
                self.assertIn("non-string key", str(caught.exception))
                self.assertNotIn("omitted", str(caught.exception))

    def test_missing_keys_with_empty_label_have_no_leading_space(self):
        with self.assertRaises(PlanError) as caught:
            ops.check_arguments({}, {"phase", "key"}, {"phase", "key"}, label="")
        self.assertEqual(str(caught.exception), "required keys: key, phase")

    def test_missing_keys_detail_is_shorter_than_two_hundred_chars(self):
        required = {f"required_field_{index:02d}" for index in range(30)}
        with self.assertRaises(PlanError) as caught:
            ops.check_arguments({}, required, required)
        detail = str(caught.exception)
        self.assertTrue(detail.startswith("args required keys: required_field_00"))
        self.assertLess(len(detail), 200)
        self.assertTrue(detail.endswith("..."))
