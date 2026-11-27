"""Cross-platform demo registration and replay path checks."""
import json
import ntpath
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

from tools.demo import setup_native, vp_replay


class NativeDemoTests(unittest.TestCase):
    def setup_demo(self, root, *extra):
        output = StringIO()
        with redirect_stdout(output):
            result = setup_native.main([
                "--profile", str(root / "profile"), "--ext-id", "a" * 32,
                "--cw-home", str(root / "rooms with spaces"),
                "--config-out", str(root / "wall.json"), *extra,
            ])
        self.assertEqual(result, 0)
        return json.loads(output.getvalue())

    def test_windows_launcher_and_registry_registration(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            with patch.object(setup_native.sys, "platform", "win32"), \
                    patch.object(setup_native, "register_windows_host") as register:
                result = self.setup_demo(root, "--browser", "edge")
            launcher = Path(result["launcher"])
            manifest = Path(result["manifest"])
            self.assertEqual(launcher.suffix, ".cmd")
            script = launcher.read_text(encoding="utf-8")
            self.assertIn("bridge.wall host --config", script)
            self.assertIn(" %1 ", script)
            self.assertNotIn("%*", script)
            data = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(data["path"], str(launcher))
            self.assertEqual(data["name"], setup_native.install.HOST_NAME + ".demo." + "a" * 32)
            register.assert_called_once_with("edge", data["name"], manifest)

    def test_macos_profile_manifest_and_executable_launcher(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            with patch.object(setup_native.sys, "platform", "darwin"), \
                    patch.object(setup_native.os, "chmod", wraps=setup_native.os.chmod) as chmod:
                result = self.setup_demo(root, "--browser", "chrome")
            expected = root / "profile" / "NativeMessagingHosts"
            self.assertEqual(Path(result["manifest"]).parent, expected)
            launcher = Path(result["launcher"])
            self.assertEqual(launcher.suffix, ".sh")
            chmod.assert_called_once_with(launcher, 0o755)
            if os.name != "nt":
                self.assertTrue(launcher.stat().st_mode & 0o100)
            self.assertIn("bridge.wall host --config", launcher.read_text(encoding="utf-8"))


class ReplayPathTests(unittest.TestCase):
    def test_replay_refuses_the_protected_root_on_another_windows_drive(self):
        def abspath(path):
            return ntpath.normpath(ntpath.join("C:" + ntpath.sep, path))

        windows_path = SimpleNamespace(
            abspath=abspath, realpath=abspath, normcase=ntpath.normcase, splitdrive=ntpath.splitdrive,
        )
        with patch.object(vp_replay, "os", SimpleNamespace(path=windows_path, sep=ntpath.sep)):
            self.assertTrue(vp_replay.is_forbidden(ntpath.join("D:" + ntpath.sep, "dev", "shm", "vqa-cu")))
            self.assertTrue(vp_replay.is_forbidden(ntpath.join("E:" + ntpath.sep, "DEV", "shm", "vqa-cu", "runs")))
            self.assertFalse(vp_replay.is_forbidden(ntpath.join("D:" + ntpath.sep, "dev", "shm", "vqa-cu-scratch")))


if __name__ == "__main__":
    unittest.main()
