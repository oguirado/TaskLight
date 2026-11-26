"""Exercise platform branches without using a real registry or desktop client."""

import contextlib
import errno
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

from bridge import install, tasklight_setup as setup
from bridge.tests.install.test_install import Registry


class CrossPlatformInstall(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.home = self.root / "Home with spaces"
        self.home.mkdir()
        self.registry = Registry()
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(Path, "home", return_value=self.home))
        stack.enter_context(patch.dict(os.environ, {"HOME": str(self.home)}, clear=True))
        stack.enter_context(patch.object(install, "winreg", self.registry))

    def setup_cli(self, *args):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            rc = setup.main(args)
        return rc, json.loads(output.getvalue())

    def apply_native(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(install.main(["--apply"]), 0, output.getvalue())

    def test_windows_install_and_client_writes_use_native_permissions(self):
        target = self.home / ".cursor" / "mcp.json"
        target.parent.mkdir()
        target.write_text('{"setting":true}', encoding="utf-8")
        with patch.object(sys, "platform", "win32"), patch.object(os, "chmod") as chmod:
            self.apply_native()
            rc, result = self.setup_cli("mcp-config", "--client", "cursor", "--apply")
            self.assertEqual(rc, 0, result)
        chmod.assert_not_called()
        self.assertTrue(json.loads(target.read_bytes())["setting"])
        backup, = target.parent.glob("mcp.json.bak-*")
        self.assertEqual(backup.read_bytes(), b'{"setting":true}')

    @unittest.skipUnless(os.name == "posix", "POSIX mode comparison")
    def test_macos_modes_when_optional_os_features_are_missing(self):
        with patch.object(sys, "platform", "darwin"), contextlib.ExitStack() as stack:
            if hasattr(os, "O_NOFOLLOW"):
                stack.enter_context(patch.object(os, "O_NOFOLLOW"))
                del os.O_NOFOLLOW
            if hasattr(os, "fchmod"):
                stack.enter_context(patch.object(os, "fchmod"))
                del os.fchmod
            self.apply_native()
            base = self.home / "Library/Application Support/Google/Chrome/NativeMessagingHosts"
            manifest = base / (install.HOST_NAME + ".json")
            launcher = Path(json.loads(manifest.read_bytes())["path"])
            manifest.chmod(0o644)
            self.apply_native()
            self.assertEqual(stat.S_IMODE(manifest.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(launcher.stat().st_mode), 0o700)
            self.assertTrue(setup._check_one_native("chrome", install.DEFAULT_DEV_ID)[0])
            launcher.chmod(0o600)
            self.assertFalse(setup._check_one_native("chrome", install.DEFAULT_DEV_ID)[0])

    def test_windows_doctor_accepts_registered_batch_without_executable_bit(self):
        with patch.object(sys, "platform", "win32"):
            self.apply_native()
            with patch.object(os, "access", return_value=False) as access:
                result = setup._check_one_native("chrome", install.DEFAULT_DEV_ID)
            self.assertTrue(result[0], result)
            self.assertFalse(any(mode == os.X_OK for _, mode in
                                 (call.args for call in access.call_args_list)))

    def test_windows_doctor_rejects_missing_registration_and_non_launchable_suffix(self):
        with patch.object(sys, "platform", "win32"):
            self.apply_native()
            with patch.object(os, "access", return_value=True):
                key = install._registry_subkey("chrome")
                with self.registry.OpenKey(self.registry.HKEY_CURRENT_USER, key) as handle:
                    manifest, kind = self.registry.QueryValueEx(handle, "")
                    self.registry.DeleteValue(handle, "")
                    self.assertFalse(setup._check_one_native("chrome", install.DEFAULT_DEV_ID)[0])
                    self.registry.SetValueEx(handle, "", 0, kind, manifest)
                path = Path(manifest)
                data = json.loads(path.read_bytes())
                launcher = path.with_suffix(".txt")
                launcher.write_text("plain text", encoding="utf-8")
                data["path"] = str(launcher)
                path.write_text(json.dumps(data), encoding="utf-8")
                self.assertFalse(setup._check_one_native("chrome", install.DEFAULT_DEV_ID)[0])

    def test_windows_profile_and_client_roots_prefer_their_appdata(self):
        local = self.root / "Local Data"
        roaming = self.root / "Roaming Data"
        with patch.object(sys, "platform", "win32"), patch.dict(
            os.environ, {"LOCALAPPDATA": str(local), "APPDATA": str(roaming)}
        ):
            self.assertEqual(setup._browser_profile("edge"), local / "Microsoft/Edge/User Data")
            self.assertEqual(setup._target_path("claude-desktop"),
                             roaming / "Claude/claude_desktop_config.json")
            del os.environ["LOCALAPPDATA"]
            self.assertEqual(setup._browser_profile("edge"), roaming / "Microsoft/Edge/User Data")
            self.assertEqual(install._manifest_dir("edge"), roaming / "TaskLight/native")
            os.environ["LOCALAPPDATA"] = str(local)
            del os.environ["APPDATA"]
            self.assertEqual(setup._target_path("claude-desktop"),
                             local / "Claude/claude_desktop_config.json")

    def test_linux_xdg_and_chrome_overrides(self):
        xdg = self.root / "XDG Config"
        chrome_config = self.root / "Chrome Config"
        profile = self.root / "Chrome Profile"
        with patch.object(sys, "platform", "linux"), patch.dict(
            os.environ, {"XDG_CONFIG_HOME": str(xdg), "CHROME_CONFIG_HOME": str(chrome_config)}
        ):
            self.assertEqual(setup._browser_profile("edge"), xdg / "microsoft-edge")
            self.assertEqual(setup._target_path("claude-desktop"),
                             xdg / "Claude/claude_desktop_config.json")
            self.assertEqual(setup._browser_profile("chrome"), chrome_config / "google-chrome")
            os.environ["CHROME_USER_DATA_DIR"] = str(profile)
            self.assertEqual(setup._browser_profile("chrome"), profile)
            self.assertEqual(install._manifest_dir("chrome"), profile / "NativeMessagingHosts")
            self.assertEqual(setup._manifest_dir("chrome"), install._manifest_dir("chrome"))

    def test_macos_codex_home_override_and_standard_browser_root(self):
        codex_home = self.root / "Codex Config"
        with patch.object(sys, "platform", "darwin"), patch.dict(
            os.environ, {"CODEX_HOME": str(codex_home)}
        ):
            rc, payload = self.setup_cli("mcp-config", "--client", "codex")
            self.assertEqual(rc, 0, payload)
            self.assertEqual(Path(payload["file"]), codex_home / "config.toml")
            self.assertEqual(setup._browser_profile("edge"),
                             self.home / "Library/Application Support/Microsoft Edge")

    def test_macos_codex_toml_accepts_unicode_paths(self):
        state = self.root / "State with \U0001f4c1"
        target = self.home / ".codex" / "config.toml"
        with patch.object(sys, "platform", "darwin"), patch.dict(
            os.environ, {"CW_HOME": str(state)}
        ):
            rc, payload = self.setup_cli("mcp-config", "--client", "codex", "--apply")
            self.assertEqual(rc, 0, payload)
            data = setup._codex_data(target.read_text(encoding="utf-8"))
            self.assertEqual(data["mcp_servers"]["tasklight"]["env"]["CW_HOME"], str(state))

    def test_backup_timestamp_name_and_same_second_collision(self):
        target = self.root / "mcp.json"
        first_backup = target.with_name("mcp.json.bak-20260102030405")
        with patch.object(setup, "_stamp", return_value="20260102030405"):
            with patch.object(sys, "platform", "darwin"):
                target.write_bytes(b"first config")
                setup._backup_if_exists(target)
                target.write_bytes(b"second config")
                setup._backup_if_exists(target)
        self.assertEqual(first_backup.read_bytes(), b"first config")
        other, = self.root.glob("mcp.json.bak-20260102030405-*")
        self.assertEqual(other.read_bytes(), b"second config")

    def test_command_preview_quoting_follows_platform(self):
        state = self.root / "State with apostrophe's and spaces"
        executable = self.root / "Runtime with spaces" / "python.exe"
        cases = {
            "claude-code": ["claude", "mcp", "add", "tasklight", "--scope", "user",
                            "-e", "CW_HOME=" + str(state), "--"],
            "antigravity-cli": ["agy", "mcp", "add", "--env", "CW_HOME=" + str(state), "tasklight"],
        }
        for platform, render in (("win32", subprocess.list2cmdline), ("darwin", shlex.join)):
            with patch.object(sys, "platform", platform), patch.object(
                sys, "executable", str(executable)
            ), patch.dict(os.environ, {"CW_HOME": str(state)}):
                for client, prefix in cases.items():
                    with self.subTest(platform=platform, client=client):
                        rc, payload = self.setup_cli("mcp-config", "--client", client)
                        argv = prefix + [str(executable), setup._mcp_path_str()]
                        self.assertEqual(rc, 0, payload)
                        self.assertEqual(payload["command"], render(argv))

    def test_windows_client_retries_sharing_violation_from_unique_temporary_file(self):
        target = self.home / ".cursor" / "mcp.json"
        target.parent.mkdir()
        target.write_bytes(b'{"setting":true}')
        sentinel = target.with_suffix(".json.tmp")
        sentinel.write_bytes(b"another writer")
        attempted = []
        replace = os.replace

        def temporarily_busy(source, destination):
            attempted.append(Path(source))
            self.assertNotEqual(Path(source), sentinel)
            self.assertEqual(Path(source).parent, target.parent)
            self.assertEqual(Path(destination), target)
            self.assertEqual(target.read_bytes(), b'{"setting":true}')
            if len(attempted) == 1:
                error = PermissionError(errno.EACCES, "file is open")
                error.winerror = 32
                raise error
            replace(source, destination)

        with patch.object(sys, "platform", "win32"), patch.object(
            os, "replace", side_effect=temporarily_busy
        ), patch.object(setup.time, "sleep"):
            rc, payload = self.setup_cli("mcp-config", "--client", "cursor", "--apply")
        self.assertEqual(rc, 0, payload)
        self.assertEqual(len(attempted), 2)
        self.assertEqual(attempted[0], attempted[1])
        self.assertFalse(attempted[0].exists())
        self.assertIn("tasklight", json.loads(target.read_bytes())["mcpServers"])
        self.assertEqual(sentinel.read_bytes(), b"another writer")

    def test_macos_permanent_replace_error_preserves_original_and_cleans_temp(self):
        target = self.home / ".cursor" / "mcp.json"
        target.parent.mkdir()
        target.write_bytes(b'{"setting":true}')
        with patch.object(sys, "platform", "darwin"), patch.object(
            os, "replace", side_effect=OSError(errno.ENOSPC, "disk full")
        ) as replace:
            rc, payload = self.setup_cli("mcp-config", "--client", "cursor", "--apply")
        self.assertEqual(rc, 1, payload)
        self.assertEqual(payload["error"], "write_failed")
        replace.assert_called_once()
        self.assertEqual(target.read_bytes(), b'{"setting":true}')
        self.assertEqual(list(target.parent.glob("*.tmp")), [])
