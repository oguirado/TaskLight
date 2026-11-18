"""Exercise the standalone doctor against isolated hook and journal fixtures."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from bridge.room import store


class DoctorTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.project = self.root / "project"
        self.cwd = self.project / "nested"
        self.cwd.mkdir(parents=True)
        self.home = self.root / "home"
        self.wall = self.root / "wall"
        self.env = {
            "HOME": str(self.home), "USERPROFILE": str(self.home),
            "CW_HOME": str(self.wall), "PYTHONDONTWRITEBYTECODE": "1",
        }
        if "SYSTEMROOT" in os.environ:
            self.env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        self.journal = self.wall / "rooms" / "demo" / "events.jsonl"

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")

    def install_hook(self, harness, path, event="SessionStart"):
        module = {
            "claude-code": "hook_claude_native", "codex": "hook_codex_native",
        }[harness]
        self.write(path, {
            "env": {"unrelated": "DO-NOT-DISCLOSE-SETTINGS"},
            "hooks": {
                event: [{"hooks": [{"type": "command",
                                   "command": "python3 -m bridge.room." + module}]}],
                "PostToolUse": [{"hooks": [{"type": "command",
                                            "command": "DO-NOT-DISCLOSE-COMMAND"}]}],
            },
        })

    def append_lifecycle(self, harness, state, lamport):
        event = {
            "id": f"e-{lamport:016x}", "act": "op", "room": "demo",
            "agent": "agent-a", "text": "", "lamport": lamport, "ts": lamport * 10,
            "op": {"kind": "agent.lifecycle", "state": state, "harness": harness,
                   "run_id": "run-a", "op_id": f"op-{lamport:08x}",
                   "reason": "DO-NOT-DISCLOSE-JOURNAL"},
        }
        with self.journal.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event) + "\n")

    def snapshot(self):
        return {
            str(path.relative_to(self.root)): (
                path.stat().st_mtime_ns, path.read_bytes() if path.is_file() else None
            )
            for path in self.root.rglob("*")
        }

    def doctor(self, *args, status=0):
        before = self.snapshot()
        proc = subprocess.run(
            [sys.executable, "-m", "bridge.room.ext.doctor", "--cwd", str(self.cwd), *args],
            env=self.env, capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(self.snapshot(), before, "the doctor changed its fixtures")
        self.assertEqual(proc.returncode, status, proc.stderr or proc.stdout)
        self.assertEqual(proc.stderr, "")
        self.assertNotIn("DO-NOT-DISCLOSE", proc.stdout)
        self.assertNotIn(str(self.root), proc.stdout)
        report = json.loads(proc.stdout)
        self.assertEqual(report["ok"], status == 0)
        for problem in report["problems"]:
            self.assertTrue(problem["hint"])
            self.assertNotIn("\n", problem["hint"])
        return report

    def prepare_room(self):
        self.journal.parent.mkdir(parents=True)
        self.journal.touch()
        self.write(self.project / ".tasklight.json", {"room": "demo"})

    def test_default_harness_and_nearest_configuration(self):
        self.prepare_room()
        self.write(self.root / ".tasklight.json", {"room": "other"})
        self.install_hook("claude-code", self.project / ".claude" / "settings.json")
        self.append_lifecycle("claude-code", "deployed", 4)
        self.append_lifecycle("codex", "failed", 5)
        self.append_lifecycle("claude-code", "alive", 2)

        report = self.doctor()
        self.assertEqual(report["harness"], "claude-code")
        self.assertEqual(report["room"], {
            "name": "demo", "source": ".tasklight.json", "exists": True, "readable": True,
        })
        self.assertEqual(report["hook"]["events"], {"project": ["SessionStart"]})
        self.assertEqual(report["last_lifecycle"], {
            "agent": "agent-a", "run_id": "run-a", "state": "deployed", "lamport": 4, "ts": 40,
        })
        self.assertEqual(report["journal"]["free_bytes"],
                         store.CAP - self.journal.stat().st_size)

    def test_codex_environment_and_user_project_hook_settings(self):
        self.prepare_room()
        self.write(self.cwd / ".tasklight.json", {"room": "other"})
        self.env["TASKLIGHT_ROOM"] = "demo"
        self.env["CODEX_HOME"] = str(self.root / "codex")
        self.install_hook("codex", self.root / "codex" / "hooks.json")
        self.install_hook("codex", self.project / ".codex" / "hooks.json", "SessionEnd")
        self.append_lifecycle("codex", "failed", 1)

        report = self.doctor("--harness", "codex")
        self.assertEqual(report["room"]["source"], "TASKLIGHT_ROOM")
        self.assertEqual(report["hook"]["events"], {
            "project": ["SessionEnd"], "user": ["SessionStart"],
        })
        self.assertEqual(report["last_lifecycle"]["state"], "failed")

    def test_invalid_explicit_selection_blocks_project_fallback(self):
        self.prepare_room()
        self.install_hook("claude-code", self.home / ".claude" / "settings.json")
        self.env["TASKLIGHT_ROOM"] = "DO-NOT-DISCLOSE-ROOM"
        report = self.doctor(status=1)
        self.assertIsNone(report["room"]["name"])
        self.assertEqual(report["room"]["source"], "TASKLIGHT_ROOM")
        self.assertEqual([p["code"] for p in report["problems"]], ["invalid_room_env"])

    def test_malformed_nearest_configuration_blocks_parent_fallback(self):
        self.prepare_room()
        self.install_hook("claude-code", self.home / ".claude" / "settings.json")
        (self.cwd / ".tasklight.json").write_text('{"room":"demo","room":"other"}')
        report = self.doctor(status=1)
        self.assertIsNone(report["room"]["name"])
        self.assertEqual([p["code"] for p in report["problems"]], ["invalid_room_config"])

    def test_missing_room_selection_and_command(self):
        report = self.doctor(status=1)
        self.assertIsNone(report["room"]["source"])
        self.assertIsNone(report["room"]["exists"])
        self.assertIsNone(report["journal"]["has_space"])
        self.assertEqual({p["code"] for p in report["problems"]},
                         {"room_not_configured", "hook_command_missing"})

    def test_selected_room_is_absent_without_creating_storage(self):
        self.env["TASKLIGHT_ROOM"] = "demo"
        self.install_hook("claude-code", self.home / ".claude" / "settings.json")
        report = self.doctor(status=1)
        self.assertFalse(report["room"]["exists"])
        self.assertFalse(report["room"]["readable"])
        self.assertEqual([p["code"] for p in report["problems"]], ["room_missing"])

    def test_missing_journal_is_a_checked_read_failure(self):
        self.prepare_room()
        self.journal.unlink()
        self.install_hook("claude-code", self.home / ".claude" / "settings.json")
        report = self.doctor(status=1)
        self.assertTrue(report["room"]["exists"])
        self.assertFalse(report["room"]["readable"])
        self.assertIsNone(report["journal"]["free_bytes"])
        self.assertEqual([p["code"] for p in report["problems"]], ["room_read_failed"])

    def test_checked_read_does_not_return_events_from_corrupt_journal(self):
        self.prepare_room()
        self.install_hook("claude-code", self.home / ".claude" / "settings.json")
        self.append_lifecycle("claude-code", "deployed", 1)
        with self.journal.open("ab") as stream:
            stream.write(b"DO-NOT-DISCLOSE-BROKEN-ROW\n")
        report = self.doctor(status=1)
        self.assertTrue(report["room"]["exists"])
        self.assertFalse(report["room"]["readable"])
        self.assertTrue(report["journal"]["has_space"])
        self.assertIsNone(report["last_lifecycle"])
        self.assertEqual([p["code"] for p in report["problems"]], ["room_read_failed"])

    def test_journal_at_cap(self):
        self.prepare_room()
        self.install_hook("claude-code", self.home / ".claude" / "settings.json")
        with self.journal.open("wb") as stream:
            stream.write(b" " * (store.CAP - 1) + b"\n")
        report = self.doctor(status=1)
        self.assertTrue(report["room"]["readable"])
        self.assertEqual(report["journal"]["free_bytes"], 0)
        self.assertFalse(report["journal"]["has_space"])
        self.assertEqual([p["code"] for p in report["problems"]], ["room_full"])

    def test_empty_journal_is_ready_before_the_first_lifecycle_event(self):
        self.prepare_room()
        self.install_hook("claude-code", self.home / ".claude" / "settings.json")
        report = self.doctor()
        self.assertTrue(report["room"]["readable"])
        self.assertTrue(report["journal"]["has_space"])
        self.assertIsNone(report["last_lifecycle"])

    def test_malformed_hook_settings_and_deceptive_nested_command(self):
        self.prepare_room()
        user = self.home / ".codex" / "hooks.json"
        user.parent.mkdir(parents=True)
        user.write_text('{"DO-NOT-DISCLOSE-INVALID":')
        project = self.project / ".codex" / "hooks.json"
        expected = "python3 -m bridge.room.hook_codex_native"
        self.write(project, {
            "command": expected,
            "hooks": {"SessionStart": [{"hooks": [
                {"type": "command", "command": "echo " + expected},
                {"type": "command", "command": expected.replace(" ", "\n", 1)},
                {"type": "command", "command": expected + " --print-settings"},
                {"type": "other", "command": expected},
            ]}]},
        })
        report = self.doctor("--harness", "codex", status=1)
        self.assertFalse(report["hook"]["installed"])
        self.assertEqual({p["code"] for p in report["problems"]},
                         {"invalid_hook_settings", "hook_command_missing"})

    def test_room_lookup_stops_after_seven_parents(self):
        self.prepare_room()
        self.install_hook("claude-code", self.home / ".claude" / "settings.json")
        for _ in range(6):
            self.cwd /= "nested"
        self.cwd.mkdir(parents=True)
        self.assertEqual(self.doctor()["room"]["name"], "demo")
        self.cwd /= "one-too-far"
        self.cwd.mkdir()
        report = self.doctor(status=1)
        self.assertEqual([p["code"] for p in report["problems"]], ["room_not_configured"])

    @unittest.skipUnless(hasattr(os, "O_NOFOLLOW"), "requires no-follow open")
    def test_settings_symlink_is_unreadable(self):
        self.prepare_room()
        target = self.root / "unrelated.json"
        self.install_hook("codex", target)
        settings = self.home / ".codex" / "hooks.json"
        settings.parent.mkdir(parents=True)
        settings.symlink_to(target)
        report = self.doctor("--harness", "codex", status=1)
        self.assertFalse(report["hook"]["installed"])
        self.assertEqual({p["code"] for p in report["problems"]},
                         {"unreadable_hook_settings", "hook_command_missing"})

    def test_invalid_arguments_return_json(self):
        report = self.doctor("--harness", "DO-NOT-DISCLOSE-OPTION", status=1)
        self.assertEqual([p["code"] for p in report["problems"]], ["invalid_arguments"])
