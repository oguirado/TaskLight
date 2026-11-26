"""Offline checks for the two Antigravity MCP registries."""
import contextlib
import io
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from bridge import tasklight_setup


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "bridge" / "tasklight_setup.py"
SECRET = "fixture-private-header"
AGY_HEADER = "NAME             TYPE   STATUS    COMMAND/URL\n"
AGY_REAL_TABLE = AGY_HEADER + """\
context-wall     stdio  enabled   bash -c cd /example/tasklight && exec python3 -m bridge.room.mcp
alpha-server     stdio  enabled   /example/bin/alpha mcp
beta-agent       stdio  enabled   python3 -I /example/beta_mcp.py
gamma-helper     stdio  disabled  /example/gamma_mcp.sh
"""
AGY_TASKLIGHT_ENABLED = "tasklight        stdio  enabled   python3 /example/mcp.py\n"
AGY_TASKLIGHT_DISABLED = "tasklight        stdio  disabled  python3 /example/mcp.py\n"
FAKE_AGY = """
import json
import os
from pathlib import Path
import sys

home = Path.home()
args = sys.argv[1:]
with (home / "agy-calls.jsonl").open("a", encoding="utf-8") as log:
    print(json.dumps(args), file=log)
scenario = json.loads(os.environ["AGY_SCENARIO"])
if args == ["mcp", "list"]:
    if (home / "agy-added").exists():
        print(scenario["after"], end="")
    else:
        print(scenario["before"], end="")
        sys.exit(scenario.get("list_status", 0))
elif args[:2] == ["mcp", "add"]:
    print("fixture-private-header")
    print("fixture-private-header", file=sys.stderr)
    if scenario.get("add_status", 0):
        sys.exit(scenario["add_status"])
    (home / "agy-added").touch()
else:
    sys.exit(9)
"""


class AntigravitySetup(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(scratch.cleanup)
        self.home = Path(scratch.name)
        self.cw_home = self.home / "TaskLight's data"
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.config = self.home / ".gemini" / "antigravity" / "mcp_config.json"
        self.entry = {
            "command": sys.executable,
            "args": [str(ROOT / "bridge" / "room" / "mcp.py")],
            "env": {"CW_HOME": str(self.cw_home)},
        }
        self.add_argv = [
            "agy", "mcp", "add", "--env", "CW_HOME=" + str(self.cw_home),
            "tasklight", self.entry["command"], *self.entry["args"],
        ]
        self.env = {
            "HOME": str(self.home), "USERPROFILE": str(self.home),
            "CW_HOME": str(self.cw_home), "PATH": str(self.bin),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        if "SystemRoot" in os.environ:
            self.env["SystemRoot"] = os.environ["SystemRoot"]

    def fake_agy(self, before=AGY_HEADER, after=AGY_HEADER, **options):
        if os.name == "nt":
            self.skipTest("fake agy uses a POSIX executable")
        executable = self.bin / "agy"
        executable.write_text("#!" + sys.executable + "\n" + FAKE_AGY, encoding="utf-8")
        executable.chmod(0o700)
        self.env["AGY_SCENARIO"] = json.dumps({"before": before, "after": after, **options})

    def calls(self):
        log = self.home / "agy-calls.jsonl"
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]

    def invoke(self, verb, *args):
        options = {"umask": 0o022} if os.name == "posix" else {}
        run = subprocess.run(
            [sys.executable, str(SCRIPT), verb, *args, "--json"],
            cwd=ROOT, env=self.env, capture_output=True, text=True, timeout=20, **options,
        )
        self.assertNotIn(SECRET, run.stdout + run.stderr)
        self.assertNotIn("other-fixture-server", run.stdout + run.stderr)
        self.assertEqual(run.stderr, "")
        return run.returncode, json.loads(run.stdout)

    def mcp_config(self, client, *flags):
        return self.invoke("mcp-config", "--client", client, *flags)

    def write_config(self, path, raw):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        path.chmod(0o600)

    def check_private_mode(self, path):
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_desktop_dry_run(self):
        for platform in ("linux", "darwin", "win32"):
            with self.subTest(platform=platform):
                output = io.StringIO()
                with patch.object(sys, "platform", platform), patch.object(Path, "home", return_value=self.home):
                    with patch.dict(os.environ, self.env, clear=True), contextlib.redirect_stdout(output):
                        rc = tasklight_setup.main(["mcp-config", "--client", "antigravity", "--json"])
                self.assertEqual(rc, 0)
                payload = json.loads(output.getvalue())
                self.assertEqual(payload["file"], str(self.config))
                self.assertEqual(payload["snippet"], {"mcpServers": {"tasklight": self.entry}})
                self.assertFalse(self.config.parent.exists())

    def test_desktop_merge_keeps_private_config_and_backup(self):
        existing = {"mcpServers": {"other-fixture-server": {"headers": {"Authorization": SECRET}}}}
        raw = json.dumps(existing).encode()
        self.write_config(self.config, raw)
        rc, payload = self.mcp_config("antigravity", "--apply")
        self.assertEqual(rc, 0)
        self.assertEqual(payload["snippet"], {"mcpServers": {"tasklight": self.entry}})
        existing["mcpServers"]["tasklight"] = self.entry
        self.assertEqual(json.loads(self.config.read_bytes()), existing)
        backups = list(self.config.parent.glob(self.config.name + ".bak-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), raw)
        self.check_private_mode(backups[0])
        self.check_private_mode(self.config)

    def test_desktop_different_entry_requires_force(self):
        raw = json.dumps({"mcpServers": {"tasklight": {"command": SECRET}}}).encode()
        self.write_config(self.config, raw)
        rc, payload = self.mcp_config("antigravity", "--apply")
        self.assertEqual((rc, payload["error"]), (1, "exists_different"))
        self.assertEqual(self.config.read_bytes(), raw)
        self.assertEqual(list(self.config.parent.iterdir()), [self.config])
        rc, _ = self.mcp_config("antigravity", "--apply", "--force")
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(self.config.read_bytes())["mcpServers"]["tasklight"], self.entry)

    def test_desktop_malformed_config_is_untouched(self):
        for raw in (b'{"secret":"' + SECRET.encode(), b'{"secret":"\xff' + SECRET.encode(), b'[]'):
            with self.subTest(raw=raw):
                self.write_config(self.config, raw)
                rc, payload = self.mcp_config("antigravity", "--apply", "--force")
                self.assertEqual((rc, payload["error"]), (1, "invalid_json"))
                self.assertEqual(self.config.read_bytes(), raw)
                self.assertEqual(list(self.config.parent.iterdir()), [self.config])

    def test_codex_force_backup_keeps_private_mode(self):
        config = self.home / ".codex" / "config.toml"
        raw = b'[mcp_servers.tasklight]\ncommand = "old"\n'
        self.write_config(config, raw)
        rc, _ = self.mcp_config("codex", "--apply", "--force")
        self.assertEqual(rc, 0)
        backups = list(config.parent.glob(config.name + ".bak-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), raw)
        self.check_private_mode(backups[0])

    def test_cli_dry_run_requires_no_executable(self):
        rc, payload = self.mcp_config("antigravity-cli")
        self.assertEqual(rc, 0)
        self.assertEqual(payload["command_argv"], self.add_argv)
        if os.name == "nt":
            self.assertEqual(payload["command"], subprocess.list2cmdline(self.add_argv))
        else:
            self.assertEqual(shlex.split(payload["command"]), self.add_argv)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.config.parent.exists())

    def test_cli_lists_names_from_real_table(self):
        self.assertEqual(
            list(tasklight_setup._parse_agy_list(AGY_REAL_TABLE)),
            ["context-wall", "alpha-server", "beta-agent", "gamma-helper"],
        )

    def test_cli_list_handles_color_spacing_and_markers(self):
        table = (
            "\n  ✓ NAME\tTYPE STATUS COMMAND/URL\n"
            "\x1b[1;32m  ✓tasklight\x1b[0m\tstdio    enabled python3 /example/mcp.py\n"
            "  - context-wall stdio disabled python3 /example/legacy.py\n"
            "  *name-only\n"
            "  type-only stdio\n"
        )
        self.assertEqual(
            tasklight_setup._parse_agy_list(table),
            {"tasklight": "enabled", "context-wall": "disabled", "name-only": None, "type-only": None},
        )

    def test_cli_existing_tasklight_requires_force(self):
        self.fake_agy(before=AGY_HEADER + AGY_TASKLIGHT_DISABLED)
        rc, payload = self.mcp_config("antigravity-cli", "--apply")
        self.assertEqual((rc, payload["error"]), (1, "exists"))
        self.assertEqual(payload["tasklight_status"], "disabled")
        self.assertEqual(self.calls(), [["mcp", "list"]])

    def test_cli_force_adds_without_removing_existing_entry(self):
        self.fake_agy(before=AGY_HEADER + AGY_TASKLIGHT_DISABLED, after=AGY_HEADER + AGY_TASKLIGHT_ENABLED)
        rc, payload = self.mcp_config("antigravity-cli", "--apply", "--force")
        self.assertEqual((rc, payload["ok"]), (0, True))
        self.assertEqual(payload["tasklight_status"], "enabled")
        self.assertEqual(self.calls(), [["mcp", "list"], self.add_argv[1:], ["mcp", "list"]])

    def test_cli_adds_then_verifies_and_reports_legacy(self):
        self.fake_agy(
            before=AGY_REAL_TABLE + "other-fixture-server http enabled https://example.test/" + SECRET + "\n",
            after=AGY_REAL_TABLE + AGY_TASKLIGHT_ENABLED,
        )
        rc, payload = self.mcp_config("antigravity-cli", "--apply")
        self.assertEqual((rc, payload["ok"]), (0, True))
        self.assertEqual(payload["tasklight_status"], "enabled")
        self.assertTrue(payload["legacy_entry"])
        self.assertIn("agy mcp remove context-wall", payload["legacy_hint"])
        self.assertEqual(self.calls(), [["mcp", "list"], self.add_argv[1:], ["mcp", "list"]])
        self.assertFalse(self.config.parent.exists())

    def test_cli_add_success_requires_exact_tasklight_name_in_second_list(self):
        self.fake_agy(after=AGY_HEADER + "tasklight-copy stdio enabled python3 tasklight\n")
        rc, payload = self.mcp_config("antigravity-cli", "--apply")
        self.assertEqual((rc, payload["error"]), (1, "agy_verify_failed"))
        self.assertNotIn("tasklight_status", payload)
        self.assertEqual(self.calls(), [["mcp", "list"], self.add_argv[1:], ["mcp", "list"]])

    def test_cli_add_success_requires_enabled_tasklight(self):
        self.fake_agy(after=AGY_HEADER + AGY_TASKLIGHT_DISABLED)
        rc, payload = self.mcp_config("antigravity-cli", "--apply")
        self.assertEqual((rc, payload["error"]), (1, "agy_verify_failed"))
        self.assertEqual(payload["tasklight_status"], "disabled")
        self.assertEqual(self.calls(), [["mcp", "list"], self.add_argv[1:], ["mcp", "list"]])

    def test_cli_failed_list_prevents_add(self):
        self.fake_agy(before=SECRET, list_status=1)
        rc, payload = self.mcp_config("antigravity-cli", "--apply")
        self.assertEqual((rc, payload["ok"]), (1, False))
        self.assertEqual(self.calls(), [["mcp", "list"]])

    def test_cli_failed_add_is_reported_without_command_output(self):
        self.fake_agy(add_status=1)
        rc, payload = self.mcp_config("antigravity-cli", "--apply")
        self.assertEqual((rc, payload["ok"]), (1, False))
        self.assertEqual(self.calls(), [["mcp", "list"], self.add_argv[1:], ["mcp", "list"]])

    def test_cli_timeout_is_bounded_and_does_not_echo_output(self):
        self.fake_agy()
        output = io.StringIO()
        timeout = subprocess.TimeoutExpired("agy", 10, output=SECRET, stderr=SECRET)
        with patch.dict(os.environ, self.env, clear=True), contextlib.redirect_stdout(output):
            with patch.object(subprocess, "run", side_effect=timeout) as run:
                rc = tasklight_setup.main(["mcp-config", "--client", "antigravity-cli", "--apply", "--json"])
        self.assertEqual(rc, 1)
        self.assertNotIn(SECRET, output.getvalue())
        run.assert_called_once()
        self.assertEqual(run.call_args.kwargs["timeout"], 10)

    def test_cli_missing_executable(self):
        rc, payload = self.mcp_config("antigravity-cli", "--apply")
        self.assertEqual((rc, payload["error"]), (1, "agy_not_found"))

    def test_doctor_checks_both_registries(self):
        self.fake_agy(before=AGY_HEADER + AGY_TASKLIGHT_ENABLED)
        data = {"mcpServers": {
            "tasklight": self.entry,
            "other-fixture-server": {"headers": {"Authorization": SECRET}},
        }}
        self.write_config(self.config, json.dumps(data).encode())
        _, payload = self.invoke("doctor", "--client", "antigravity", "--client", "antigravity-cli")
        checks = {check["id"]: check for check in payload.get("checks", [])}
        self.assertEqual({key: checks[key]["status"] for key in checks if key.startswith("mcp_")},
                         {"mcp_antigravity": "ok", "mcp_antigravity-cli": "ok"})
        self.assertEqual(checks["mcp_antigravity-cli"]["tasklight_status"], "enabled")
        self.assertEqual(self.calls(), [["mcp", "list"]])

    def test_doctor_fails_for_disabled_tasklight(self):
        self.fake_agy(before=AGY_HEADER + AGY_TASKLIGHT_DISABLED)
        rc, payload = self.invoke("doctor", "--client", "antigravity-cli")
        check = next(check for check in payload["checks"] if check["id"] == "mcp_antigravity-cli")
        self.assertEqual((rc, check["status"]), (1, "fail"))
        self.assertEqual(check["tasklight_status"], "disabled")
        self.assertEqual(check["fix"], "agy mcp enable tasklight")
        self.assertEqual(self.calls(), [["mcp", "list"]])

    def test_doctor_failures_have_one_line_fixes(self):
        for raw in (b'{"bad":"' + SECRET.encode(), b'{"mcpServers":{"tasklight":{"command":"wrong"}}}'):
            with self.subTest(raw=raw):
                self.write_config(self.config, raw)
                rc, payload = self.invoke("doctor", "--client", "antigravity", "--client", "antigravity-cli")
                self.assertEqual(rc, 1)
                self.assertFalse(payload["ok"])
                checks = {check["id"]: check for check in payload["checks"]}
                for key in ("mcp_antigravity", "mcp_antigravity-cli"):
                    self.assertEqual(checks[key]["status"], "fail")
                    self.assertEqual(len(checks[key]["fix"].splitlines()), 1)
