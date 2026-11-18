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

from bridge.plan.template import validate_template
from bridge.room import app, hook, hook_claude_native, store


def digest(value, length=64):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


class RoomCase(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(tempfile.TemporaryDirectory(dir=Path(__file__).parent))
        self.home = Path(temporary)
        self.room = self.home / "rooms" / "demo"
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("CW_", "TASKLIGHT_"))}
        self.env.update(CW_HOME=str(self.home), TASKLIGHT_ROOM="demo",
                        PYTHONDONTWRITEBYTECODE="1")
        self.enterContext(mock.patch.dict(os.environ, self.env, clear=True))

    def query(self, tool):
        return app.dispatch(tool, {"room": "demo"})["untrusted"]

    def assert_room_error(self, code, detail, action, *args, **kwargs):
        with self.assertRaises(store.RoomError) as raised:
            action(*args, **kwargs)
        self.assertEqual(raised.exception.code, code)
        self.assertEqual(str(raised.exception), f"{code}: {detail}")


class CheckedQueries(RoomCase):
    def dangling_room(self):
        self.room.parent.mkdir()
        try:
            self.room.symlink_to("missing-room", target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("directory symlinks are unavailable")

    def test_plan_get_reports_a_dangling_room_directory(self):
        self.dangling_room()
        self.assert_room_error("room_read_failed", "Room data could not be read.",
                               self.query, "plan_get")

    def test_agents_list_reports_a_dangling_room_directory(self):
        self.dangling_room()
        self.assert_room_error("room_read_failed", "Room data could not be read.",
                               self.query, "agents_list")

    def test_agents_list_reports_a_corrupt_required_template(self):
        template = json.loads(Path("templates/planning/blank.json").read_text(encoding="utf-8"))
        template.pop("hash", None)
        template["id"] = "custom-plan"
        template_dir = self.home / "templates"
        template_dir.mkdir()
        path = template_dir / "custom-plan.json"
        healthy = json.dumps(validate_template(template))
        path.write_text(healthy, encoding="utf-8")
        app.dispatch("plan_create", {
            "room": "demo", "agent": "worker", "template_id": "custom-plan",
            "title": "Healthy plan", "brief": {"goal": "Read consistently"},
            "tasks": [{"key": "first", "title": "Check read", "type": "task", "phase": "plan",
                       "microtasks": [{"text": "Check read"}]}],
        })
        expected = self.query("agents_list")
        path.write_text("{", encoding="utf-8")
        self.assert_room_error("template_unavailable", "A required template is unavailable.",
                               self.query, "agents_list")
        path.write_text(healthy, encoding="utf-8")
        self.assertEqual(self.query("agents_list"), expected)

    def test_agents_list_maps_template_loader_exceptions(self):
        self.room.mkdir(parents=True)
        (self.room / "events.jsonl").touch()
        with mock.patch.object(store, "_load_templates", side_effect=OSError("loader failure")):
            self.assert_room_error("template_unavailable", "A required template is unavailable.",
                                   self.query, "agents_list")

    def test_read_checked_validates_since_before_reading(self):
        app.dispatch("agent_lifecycle", {
            "room": "demo", "agent": "worker", "run_id": "run-one", "state": "deployed",
        })
        events, malformed = store.read_checked("demo", since=0)
        self.assertEqual(malformed, 0)
        self.assertEqual(len(events), 1)
        self.assertEqual(store.read_checked("demo", since=events[0]["lamport"]), ([], 0))
        for invalid in (None, -1, True, 0.0, "0"):
            with self.subTest(since=invalid):
                with self.assertRaises(store.RoomError) as raised:
                    store.read_checked("demo", since=invalid)
                self.assertEqual(raised.exception.code, "bad_args")


class ClaudeIdentity(RoomCase):
    run_id = f"cc-{digest('child', 16)}-{digest('session', 10)}"
    first = f"explore-{digest('child', 8)}"
    fallback = f"agent-{digest('child', 8)}"

    def record(self, agent, lamport):
        return {"act": "op", "agent": agent, "lamport": lamport,
                "op": {"kind": "agent.lifecycle", "run_id": self.run_id}}

    def captured_agent(self, records):
        payload = {"hook_event_name": "SubagentStop", "session_id": "session", "agent_id": "child"}
        with (io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode("utf-8"))) as stdin,
              mock.patch.object(sys, "stdin", stdin),
              mock.patch.object(sys, "argv", ["hook_claude_native"]),
              mock.patch.object(hook_claude_native, "_STARTED", time.monotonic()),
              mock.patch.object(store, "read", return_value=(records, 0)),
              mock.patch.object(hook, "_execute") as execute):
            self.assertEqual(hook_claude_native.main(), 0)
        execute.assert_called_once()
        return json.loads(execute.call_args.args[0])["agent"]

    def test_malformed_matches_do_not_abort_the_lookup(self):
        missing = self.record(self.fallback, 2)
        del missing["agent"]
        for malformed in (None, missing, self.record("", 2), self.record("invalid agent", 2)):
            with self.subTest(malformed=malformed):
                self.assertEqual(self.captured_agent([malformed, self.record(self.first, 3)]),
                                 self.first)

    def test_a_later_registered_alias_does_not_replace_the_earliest_identity(self):
        records = [self.record(self.first, 2), self.record(self.fallback, 3)]
        self.assertEqual(self.captured_agent(records), self.first)
        self.assertEqual(self.captured_agent(list(reversed(records))), self.first)


class CodexRuntime(RoomCase):
    def invoke(self, event, session, **fields):
        payload = {"hook_event_name": event, "session_id": session, **fields}
        result = subprocess.run([sys.executable, "-B", "-m", "bridge.room.hook_codex_native"],
                                input=json.dumps(payload).encode("utf-8"), env=self.env,
                                capture_output=True, timeout=8)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))

    def state_path(self, run_id):
        return self.room / "runtime" / f"codex-native-{digest(run_id)}.json"

    def test_successful_write_prunes_stale_codex_state_and_legacy_locks(self):
        old_state = self.state_path("old-run")
        old_state.parent.mkdir(parents=True)
        old_lock = old_state.with_suffix(".json.lock")
        orphaned_lock = self.state_path("orphaned-run").with_suffix(".json.lock")
        fresh = self.state_path("fresh-run")
        unrelated = old_state.parent / ("claude-" + old_state.name)
        stale_time = time.time() - 25 * 60 * 60
        for path in (old_state, old_lock, orphaned_lock, fresh, unrelated):
            path.write_text("{}", encoding="utf-8")
            if path != fresh:
                os.utime(path, (stale_time, stale_time))
        self.invoke("SessionStart", "live-session")
        self.invoke("UserPromptSubmit", "live-session")
        self.assertTrue(self.state_path(f"cx-{digest('live-session', 16)}").is_file())
        self.assertEqual([path.exists() for path in (old_state, old_lock, orphaned_lock)],
                         [False, False, False])
        self.assertTrue(fresh.is_file())
        self.assertTrue(unrelated.is_file())

    def test_corrupt_codex_state_is_replaced_after_an_accepted_event(self):
        for index, damaged in enumerate((b"{", b" " * 257, b"[]", b'{"last_alive":true}',
                                         b'{"agent":"wrong-agent","last_alive":true}')):
            with self.subTest(damaged=damaged):
                session = f"session-{index}"
                child = f"child-{index}"
                path = self.state_path(f"cx-{digest(child, 16)}-{digest(session, 10)}")
                self.invoke("SubagentStart", session, agent_id=child, agent_type="Explore")
                expected = json.loads(path.read_bytes())
                path.write_bytes(damaged)
                self.invoke("SubagentStop", session, agent_id=child, agent_type="Explore")
                self.assertEqual(path.read_bytes(), json.dumps(expected, separators=(",", ":")).encode("utf-8") + b"\n")
                events, _ = store.read("demo")
                self.assertEqual(events[-1]["op"]["state"], "finished")
                self.assertEqual(events[-1]["agent"], expected["agent"])
