"""Child identities survive optional type changes across native hook processes."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from bridge.room import app, hook, hook_claude_native as native, store
from bridge.room.ext.inventory import derive_inventory

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MODULE = "bridge.room.hook_claude_native"


def digest(value, length):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


class StableChildIdentity(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / "home"
        self.room = "identity"
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("CW_", "TASKLIGHT_", "PYTHON"))}
        self.env.update(CW_HOME=str(self.home), TASKLIGHT_ROOM=self.room,
                        PYTHONDONTWRITEBYTECODE="1")
        self.agent = "explore-" + digest("child-1", 8)
        self.run_id = "cc-" + digest("child-1", 16) + "-" + digest("sess-1", 10)

    def payload(self, event, **fields):
        return dict(hook_event_name=event, session_id="sess-1", **fields)

    def invoke(self, payload):
        result = subprocess.run(
            [sys.executable, "-B", "-m", MODULE],
            input=json.dumps(payload).encode("utf-8"), cwd=ROOT, env=self.env,
            capture_output=True, timeout=8,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertEqual(result.stdout, b"")
        self.assertLessEqual(len(result.stderr.splitlines()), 1)

    def events(self):
        path = self.home / "rooms" / self.room / "events.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_bytes().splitlines() if line]

    def start_child(self):
        self.invoke(self.payload("SessionStart"))
        self.invoke(self.payload("SubagentStart", agent_id="child-1", agent_type="Explore"))
        event = self.events()[-1]
        self.assertEqual((event["agent"], event["op"]["run_id"]),
                         (self.agent, self.run_id))
        self.assertEqual(event["op"]["state"], "deployed")

    def capture(self, payload):
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode("utf-8")))
        self.addCleanup(stdin.close)
        stdout, stderr = io.StringIO(), io.StringIO()
        with (mock.patch.dict(os.environ, self.env, clear=True),
              mock.patch.object(sys, "stdin", stdin),
              mock.patch.object(sys, "argv", [MODULE]),
              mock.patch.object(native, "_STARTED", time.monotonic()),
              mock.patch.object(hook, "_execute", return_value={}) as execute,
              contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr)):
            code = native.main()
        self.assertEqual(code, 0)
        self.assertEqual(stdout.getvalue(), "")
        self.assertLessEqual(len(stderr.getvalue().splitlines()), 1)
        execute.assert_called_once()
        return json.loads(execute.call_args.args[0])

    def assert_child_state(self, state):
        inventory = derive_inventory(self.room, self.events(), time.time() * 1000)
        children = [row for row in inventory["agents"] if row["run_id"] == self.run_id]
        self.assertEqual([(row["agent"], row["state"]) for row in children],
                         [(self.agent, state)])

    def test_start_with_type_then_stop_without_type(self):
        self.start_child()
        self.invoke(self.payload("SubagentStop", agent_id="child-1"))
        self.assert_child_state("finished")
        self.assertEqual(self.events()[-1]["agent"], self.agent)

    def test_tool_event_with_changed_type_reuses_registered_name(self):
        self.start_child()
        self.invoke(self.payload("PreToolUse", agent_id="child-1", agent_type="Reviewer",
                                 tool_name="Read", tool_use_id="child-tool-1"))
        self.assert_child_state("idle")
        self.assertEqual(self.events()[-1]["agent"], self.agent)

    def test_child_stop_with_changed_type_reuses_registered_name(self):
        self.start_child()
        self.invoke(self.payload("Stop", agent_id="child-1", agent_type="Reviewer"))
        self.assert_child_state("idle")
        self.assertEqual(self.events()[-1]["agent"], self.agent)

    def test_stop_without_prior_start_keeps_default_name(self):
        value = self.capture(self.payload("SubagentStop", agent_id="child-1"))
        self.assertEqual((value["agent"], value["run_id"], value["state"]),
                         ("agent-" + digest("child-1", 8), self.run_id, "finished"))

    def test_lookup_failure_falls_back_and_stays_observational(self):
        self.start_child()
        with mock.patch.object(store, "read", side_effect=OSError("lookup unavailable")) as read:
            value = self.capture(self.payload("SubagentStop", agent_id="child-1"))
        read.assert_called_once_with(self.room)
        self.assertEqual(value["agent"], "agent-" + digest("child-1", 8))
        self.assertEqual(value["run_id"], self.run_id)
        self.assertEqual(value["state"], "finished")

    def test_replayed_stop_is_idempotent(self):
        self.start_child()
        stop = self.payload("SubagentStop", agent_id="child-1")
        self.invoke(stop)
        self.assert_child_state("finished")
        events = self.events()
        terminal = [event for event in events if event["agent"] == self.agent
                    and event["op"]["state"] == "finished"]
        self.assertEqual(len(terminal), 1)
        journal = self.home / "rooms" / self.room / "events.jsonl"
        before = journal.read_bytes()
        self.invoke(stop)
        self.assertEqual(journal.read_bytes(), before)
        self.assert_child_state("finished")

    def test_session_identities_skip_child_lookup(self):
        for event in ("SessionStart", "SessionEnd", "Stop"):
            with self.subTest(event=event):
                with mock.patch.object(store, "read", side_effect=OSError("must not look up")) as read:
                    value = self.capture(self.payload(event))
                read.assert_not_called()
                self.assertEqual(value["agent"], "cc-" + digest("sess-1", 10))
                self.assertEqual(value["run_id"], "cc-" + digest("sess-1", 16))

    def test_same_native_child_in_another_session_keeps_its_own_name(self):
        self.start_child()
        payload = self.payload("SubagentStop", agent_id="child-1", agent_type="Reviewer")
        payload["session_id"] = "sess-2"
        value = self.capture(payload)
        self.assertEqual(value["agent"], "reviewer-" + digest("child-1", 8))
        self.assertEqual(value["run_id"],
                         "cc-" + digest("child-1", 16) + "-" + digest("sess-2", 10))


if __name__ == "__main__":
    unittest.main()
