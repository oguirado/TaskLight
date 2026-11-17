"""M2: real run entry and journal with a deterministic stdlib process boundary."""
import contextlib
import copy
import io
import json
import signal
import subprocess
from unittest import mock

from bridge.room import __main__ as cli
from .support import RESULT, RoomCase


class Child:
    def __init__(self, code, on_exit):
        self.code, self.on_exit = code, on_exit
        self.returncode = None
        self.pid = 12345
        self.stdin = self.stdout = self.stderr = None

    def wait(self, timeout=None):
        if self.returncode is None:
            self.on_exit()
            self.returncode = self.code
        return self.returncode

    def poll(self):
        return self.returncode

    def send_signal(self, number):
        self.code = -number

    def communicate(self, input=None, timeout=None):
        self.wait(timeout)
        return None, None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.wait()


class SupervisorOracle(RoomCase):
    def supervise(self, *, code=0, contents=None, file_mode="present", legacy=False):
        result_file = self.home / "result.json"
        # Valid results only appear at exit; reading at launch sees invalid JSON.
        if file_mode == "at_exit":
            result_file.write_text("not complete yet", encoding="utf-8")
        elif file_mode == "present":
            result_file.write_bytes(contents if isinstance(contents, bytes) else contents.encode("utf-8"))
        elif file_mode == "directory":
            result_file.mkdir()
        def on_exit():
            if file_mode == "at_exit":
                result_file.write_text(contents, encoding="utf-8")
        child = Child(code, on_exit)
        arguments = ["run", "--room", "demo", "--agent", "worker", "--run-id", "run-c6",
                     "--parent", "leader", "--parent-run", "lead-c6"]
        if not legacy:
            arguments += ["--result-file", str(result_file)]
        arguments += ["--", "synthetic-child", "literal-child-argument"]
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(subprocess, "Popen", return_value=child) as launched:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    exit_code = cli.main(arguments)
                except SystemExit as exc:
                    exit_code = exc.code
        self.assertEqual(launched.call_count, 1, "M2 --result-file must be accepted and the child must run")
        self.assertEqual(launched.call_args.args[0], ["synthetic-child", "literal-child-argument"])
        self.assertFalse(launched.call_args.kwargs.get("shell", False))
        self.assertEqual(exit_code, code if code >= 0 else 128 - code, "M2 child exit code must survive result handling")
        self.assertEqual(out.getvalue(), "", "M2 supervisor must not add stdout")
        events = self.events()
        terminal = [event for event in events if event["op"]["state"] in ("finished", "failed")]
        self.assertEqual(len(terminal), 1, "M2 exactly one terminal event is required even without a valid result")
        self.assertEqual(terminal[0]["op"]["state"], "finished" if code == 0 else "failed")
        self.assertTrue(all("result" not in event["op"] for event in events if event not in terminal))
        self.assertEqual(terminal[0]["op"]["parent_agent"], "leader")
        self.assertEqual(terminal[0]["op"]["parent_run_id"], "lead-c6")
        if code > 0:
            self.assertEqual(terminal[0]["op"].get("reason"), "exit:" + str(code))
        if code < 0:
            self.assertEqual(terminal[0]["op"].get("reason"), "signal:" + signal.Signals(-code).name)
        return terminal[0], err.getvalue(), result_file

    def test_m2_valid_result_is_read_after_child_exit_and_attached_to_finished(self):
        contents = json.dumps(RESULT, ensure_ascii=False)
        terminal, stderr, path = self.supervise(contents=contents, file_mode="at_exit")
        self.assertEqual(terminal["op"].get("result"), RESULT)
        self.assertEqual(stderr, "")
        self.assertEqual(path.read_text(encoding="utf-8"), contents, "result input must not be rewritten")

    def test_m2_valid_result_is_attached_to_failed_nonzero_exit(self):
        result = dict(RESULT, verdict="NO_PUDE")
        terminal, stderr, _ = self.supervise(code=7, contents=json.dumps(result))
        self.assertEqual(terminal["op"].get("result"), result)
        self.assertEqual(stderr, "")

    def test_m2_valid_result_is_attached_to_failed_signal_exit(self):
        terminal, stderr, _ = self.supervise(code=-signal.SIGTERM, contents=json.dumps(RESULT))
        self.assertEqual(terminal["op"].get("result"), RESULT)
        self.assertEqual(stderr, "")

    def test_m2_missing_result_still_finishes_with_one_diagnostic(self):
        self.check_invalid(file_mode="missing")

    def test_m2_missing_result_still_preserves_failed_child_exit(self):
        self.check_invalid(file_mode="missing", code=19)

    def test_m2_malformed_json_still_emits_terminal_event(self):
        self.check_invalid(contents="{not complete")

    def test_m2_invalid_encoding_still_emits_terminal_event(self):
        self.check_invalid(contents=b"\xff\xfe")

    def test_m2_directory_instead_of_file_still_emits_terminal_event(self):
        self.check_invalid(file_mode="directory")

    def test_m2_json_null_is_invalid_result(self):
        self.check_invalid(contents="null")

    def test_m2_json_array_is_invalid_result(self):
        self.check_invalid(contents="[]")

    def test_m2_unknown_result_key_is_not_attached(self):
        self.check_invalid(contents=json.dumps(dict(RESULT, unknown="UNTRUSTED_RESULT_MARKER")))

    def test_m2_oversize_result_summary_is_not_attached(self):
        self.check_invalid(contents=json.dumps(dict(RESULT, summary="s" * 2001)))

    def test_m2_invalid_evidence_hash_is_not_attached(self):
        self.check_invalid(contents=json.dumps(dict(RESULT, evidence=[{"path": "artifacts/e", "sha256": "bad"}])))

    def test_m2_missing_optional_receipt_is_attached(self):
        # A-C6b: only verdict is required; an omitted receipt stays omitted.
        value = copy.deepcopy(RESULT)
        del value["receipt"]
        terminal, stderr, _ = self.supervise(contents=json.dumps(value))
        self.assertEqual(terminal["op"].get("result"), value)
        self.assertEqual(stderr, "")

    def check_invalid(self, **options):
        terminal, stderr, _ = self.supervise(**options)
        self.assertNotIn("result", terminal["op"], "M2 invalid/missing result must be omitted")
        self.assertEqual(len(stderr.splitlines()), 1, "M2 one diagnostic line required")
        self.assertNotIn("UNTRUSTED_RESULT_MARKER", stderr, "result contents must not become diagnostics")

    def test_m2_legacy_run_without_result_option_is_unchanged(self):
        terminal, stderr, _ = self.supervise(legacy=True, file_mode="missing")
        self.assertNotIn("result", terminal["op"])
        self.assertEqual(stderr, "")

    def test_m2_legacy_failed_run_without_result_option_is_unchanged(self):
        terminal, stderr, _ = self.supervise(code=9, legacy=True, file_mode="missing")
        self.assertNotIn("result", terminal["op"])
        self.assertEqual(stderr, "")

    def test_m2_missing_result_file_flag_value_stops_before_launch(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(subprocess, "Popen") as launched:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    code = cli.main(["run", "--room", "demo", "--agent", "worker", "--result-file", "--", "synthetic-child"])
                except SystemExit as exc:
                    code = exc.code
        self.assertEqual(code, 2)
        launched.assert_not_called()
        self.assertEqual(self.raw(), b"")
