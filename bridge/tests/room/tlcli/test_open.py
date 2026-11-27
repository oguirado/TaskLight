"""Exercise tasklight open with executables that only record their arguments."""

import json
import sys
import unittest

from bridge.tests.room.tlcli.test_tlcli import CliCase, MODULE


@unittest.skipUnless(sys.platform.startswith("linux"), "isolated Linux browser lookup")
class OpenWindow(CliCase):
    def setUp(self):
        super().setUp()
        self.bin = self.scratch / "browser binaries"
        self.bin.mkdir()
        (self.bin / "python3").symlink_to(sys.executable)
        self.record = self.scratch / "browser arguments"
        for key in ("CHROME", "CHROME_CONFIG_HOME", "CHROME_USER_DATA_DIR"):
            self.env.pop(key, None)
        # Browser launch waits briefly on a real child process.
        self.env.pop("PYTHONPATH", None)
        self.env.update(
            PATH=str(self.bin),
            OPEN_RECORD=str(self.record),
            XDG_CONFIG_HOME=str(self.scratch / "config"),
        )

    def fake_browser(self, name):
        browser = self.bin / name
        browser.write_text(
            '#!/bin/sh\nprintf "%s\\n" "$@" > "$OPEN_RECORD"\nexit "${OPEN_STATUS:-0}"\n',
            encoding="utf-8",
        )
        browser.chmod(0o755)
        return browser

    def test_launcher_passes_literal_url_and_size_to_default_profile(self):
        browser = self.fake_browser("microsoft-edge")
        url = "https://example.test/wall?q=$(echo+unwanted)&x=1#room"
        result = self.process(self.launcher(), "open", "--browser", "edge",
                              "--url", url, "--width", "950", "--height", "700", "--json")
        self.assertEqual((result.returncode, result.stderr), (0, b""))
        self.assertEqual(self.json_line(result.stdout),
                         {"browser": str(browser), "url": url, "exit_status": 0})
        self.assertEqual(self.record.read_text().splitlines(),
                         ["--app=" + url, "--window-size=950,700"])
        self.assertFalse(self.home.exists())

    def test_default_prefers_browser_with_tasklight_native_host(self):
        self.fake_browser("google-chrome")
        browser = self.fake_browser("brave-browser")
        manifests = self.scratch / "config" / "BraveSoftware" / "Brave-Browser" / "NativeMessagingHosts"
        manifests.mkdir(parents=True)
        (manifests / "com.contextwall.bridge.json").write_text("{}", encoding="utf-8")
        result = self.process(MODULE, "open")
        self.assertEqual((result.returncode, result.stderr), (0, b""))
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertIn(str(browser).encode(), result.stdout)
        self.assertEqual(self.record.read_text().splitlines(),
                         ["--app=https://tasklight-d59f6.web.app"])

    def test_refusals_return_json_and_never_start_a_browser(self):
        self.fake_browser("google-chrome")
        for arguments, reason in (
            (("--browser", "unknown"), "unknown_browser"),
            (("--browser", "edge"), "browser_not_found"),
            (("--url", "file:///overview", "--json"), "invalid_url"),
            (("--url", "https:///wall"), "invalid_url"),
            (("--url", "https://example.test:bad/wall"), "invalid_url"),
        ):
            with self.subTest(arguments=arguments):
                result = self.process(MODULE, "open", *arguments)
                self.assertEqual((result.returncode, result.stderr), (2, b""))
                self.assertEqual(self.json_line(result.stdout)["reason"], reason)
                self.assertFalse(self.record.exists())

    def test_uses_existing_profile_with_extension_when_last_used_profile_lacks_it(self):
        self.fake_browser("google-chrome")
        root = self.scratch / "config" / "google-chrome"
        manifests = root / "NativeMessagingHosts"
        manifests.mkdir(parents=True)
        extension = "abcdefghijklmnopabcdefghijklmnop"
        (manifests / "com.contextwall.bridge.json").write_text(
            json.dumps({"allowed_origins": [f"chrome-extension://{extension}/"]}), encoding="utf-8")
        (root / "Local State").write_text(json.dumps({
            "profile": {"last_used": "Default", "info_cache": {"Default": {}, "Profile 1": {}}},
        }), encoding="utf-8")
        profile = root / "Profile 1"
        profile.mkdir()
        (profile / "Secure Preferences").write_text(json.dumps({
            "extensions": {"settings": {extension: {"state": 1, "location": 4}}},
        }), encoding="utf-8")
        url = "http://localhost:5173/"
        result = self.process(MODULE, "open", "--url", url)
        self.assertEqual((result.returncode, result.stderr), (0, b""))
        self.assertEqual(self.record.read_text().splitlines(),
                         ["--app=" + url, "--profile-directory=Profile 1"])

    def test_reports_browser_exit_status_if_it_exits_during_launch(self):
        browser = self.fake_browser("google-chrome")
        url = "http://localhost:5173/"
        result = self.process(MODULE, "open", "--url", url, "--json",
                              env={**self.env, "OPEN_STATUS": "7"})
        self.assertEqual((result.returncode, result.stderr), (7, b""))
        self.assertEqual(self.json_line(result.stdout),
                         {"browser": str(browser), "url": url, "exit_status": 7})
        self.assertEqual(self.record.read_text().splitlines(), ["--app=" + url])
