"""Setup polish regressions using disposable homes and fake subprocesses."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from bridge import install, tasklight_setup as setup


class SetupPolish(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.cw = self.home / ".context-wall"
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.dict(os.environ, {
            "HOME": str(self.home), "USERPROFILE": str(self.home),
            "CW_HOME": str(self.cw), "PATH": ""}, clear=True))
        stack.enter_context(patch.object(Path, "home", return_value=self.home))
        stack.enter_context(patch.object(setup.sys, "platform", "linux"))
        stack.enter_context(patch.object(setup.shutil, "which", return_value="fake-bin"))
        stack.enter_context(patch.object(setup.subprocess, "run", return_value=
            subprocess.CompletedProcess([], 0, "v22.0.0\n", "")))

    def invoke(self, module, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = module.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def checks(self, *args):
        rc, out, err = self.invoke(setup, "doctor", *args, "--json")
        self.assertIn(rc, (0, 1))
        self.assertEqual(err, "")
        return {c["id"]: c for c in json.loads(out)["checks"]}

    def test_invalid_room_and_tier_diagnostics(self):
        for value, expected in (
            ("TaskLight:private", "Invalid room 'TaskLight'; expected [a-z0-9][a-z0-9-]{0,47}. Try --room tasklight:private."),
            ("My_Room!:standard", "Invalid room 'My_Room!'; expected [a-z0-9][a-z0-9-]{0,47}. Try --room my-room-:standard."),
            ("tasklight:PRIVATE", "Invalid tier 'PRIVATE'; expected private or standard. Try --room tasklight:private."),
            ("tasklight:unknown", "Invalid tier 'unknown'; expected private or standard. Try --room tasklight:private."),
        ):
            with self.subTest(value=value):
                rc, out, err = self.invoke(install, "--room", value)
                self.assertEqual(rc, 2)
                self.assertEqual(out, "")
                self.assertEqual(err, expected + "\n")
        self.assertFalse(self.cw.exists())

    def test_apply_summary_reports_actual_preserved_rooms(self):
        args = ("--browser", "chrome", "--room", "tasklight:private", "--room", "work:standard", "--apply")
        config = self.cw / "wall.config.json"
        manifest = self.home / ".config/google-chrome/NativeMessagingHosts" / (install.HOST_NAME + ".json")
        rc, out, _ = self.invoke(install, *args)
        self.assertEqual(rc, 0)
        self.assertIn("Config: " + str(config) + " (created)", out.splitlines())
        self.assertIn("Room: tasklight (private)", out.splitlines())
        self.assertIn("Room: work (standard)", out.splitlines())
        self.assertIn("Installed: " + str(manifest), out.splitlines())
        before = config.read_bytes(), config.stat().st_mtime_ns
        rc, out, _ = self.invoke(install, "--browser", "chrome", "--room", "ignored:private", "--apply")
        self.assertEqual(rc, 0)
        self.assertIn("Config: " + str(config) + " (preserved)", out.splitlines())
        self.assertIn("Room: tasklight (private)", out.splitlines())
        self.assertNotIn("Room: ignored", out)
        self.assertEqual(before, (config.read_bytes(), config.stat().st_mtime_ns))

    def test_missing_config_fix_uses_selected_browser_and_room(self):
        check = self.checks("--browser", "brave", "--room", "tasklight:private")["config"]
        self.assertEqual(check["detail"], "wall.config.json missing")
        self.assertEqual(check["fix"], "python3 bridge/install.py --browser brave --room tasklight:private --apply")

    def test_invalid_config_keeps_parser_error_and_bytes(self):
        self.cw.mkdir()
        config = self.cw / "wall.config.json"
        config.write_text("{")
        try:
            json.loads("{")
        except json.JSONDecodeError as exc:
            error = str(exc)
        check = self.checks("--browser", "chrome")["config"]
        self.assertIn("invalid content", check["detail"])
        self.assertIn(str(config), check["fix"])
        self.assertIn(error, check["fix"])
        self.assertEqual(config.read_text(), "{")

    def test_valid_json_invalid_config_is_distinguished(self):
        self.cw.mkdir()
        (self.cw / "wall.config.json").write_text("{}")
        check = self.checks("--browser", "chrome")["config"]
        self.assertIn("invalid content", check["detail"])
        self.assertIn("validation", check["fix"])

    def test_profiles_not_path_control_detection(self):
        checks = self.checks()
        self.assertEqual(checks["native_host"]["detail"], "no Chrome-family browser detected")
        (self.home / ".config/google-chrome").mkdir(parents=True)
        check = self.checks()["native_host"]
        self.assertIn("--browser chrome", check["fix"])
        (self.home / ".config/BraveSoftware/Brave-Browser").mkdir(parents=True)
        checks = self.checks()
        self.assertNotIn("native_host", checks)
        for browser in ("chrome", "brave"):
            check = checks["native_host_" + browser]
            self.assertEqual(check["status"], "fail")
            self.assertIn("--browser " + browser, check["fix"])
        checks = self.checks("--browser", "edge")
        self.assertIn("--browser edge", checks["native_host"]["fix"])
        self.assertNotIn("native_host_chrome", checks)

    def test_each_browser_reports_its_own_status(self):
        rc, _, _ = self.invoke(install, "--browser", "chrome", "--apply")
        self.assertEqual(rc, 0)
        (self.home / ".config/BraveSoftware/Brave-Browser").mkdir(parents=True)
        checks = self.checks()
        self.assertEqual(checks["native_host_chrome"]["status"], "ok")
        self.assertEqual(checks["native_host_brave"]["status"], "fail")
        self.assertIn("--browser brave", checks["native_host_brave"]["fix"])
        self.assertNotIn("fix", checks["native_host_chrome"])

    def test_profile_must_be_a_directory(self):
        (self.home / ".config").mkdir()
        (self.home / ".config/google-chrome").write_text("not a profile directory")
        self.assertEqual(self.checks()["native_host"]["detail"],
                         "no Chrome-family browser detected")

    def test_profile_detection_platform_locations(self):
        for platform, profile in (
            ("darwin", "Library/Application Support/Chromium"),
            ("win32", "AppData/Local/Microsoft/Edge/User Data"),
        ):
            with self.subTest(platform=platform), patch.object(setup.sys, "platform", platform):
                (self.home / profile).mkdir(parents=True)
                browser = "chromium" if platform == "darwin" else "edge"
                self.assertIn("--browser " + browser, self.checks()["native_host"]["fix"])


if __name__ == "__main__":
    unittest.main()
