"""Regression coverage for registry access, batch literals and config races."""
import os
from pathlib import Path
import stat
import unittest
from unittest.mock import patch

from bridge import install
from bridge.tests.install import test_install as baseline


class StrictRegistry(baseline.Registry):
    def __init__(self, refuse_delete=False):
        super().__init__()
        self.refuse_delete = refuse_delete

    def OpenKey(self, root, subkey, reserved=0, access=baseline.Registry.KEY_READ):
        key = super().OpenKey(root, subkey, reserved, access)
        key.access = access
        return key

    OpenKeyEx = OpenKey

    def QueryValueEx(self, key, name):
        if not key.access & self.KEY_QUERY_VALUE:
            raise PermissionError("query access required")
        return super().QueryValueEx(key, name)

    def DeleteValue(self, key, name):
        if self.refuse_delete or not key.access & self.KEY_SET_VALUE:
            raise PermissionError("delete access denied")
        return super().DeleteValue(key, name)


class RepairInstaller(unittest.TestCase):
    setUp = baseline.Installer.setUp
    invoke = baseline.Installer.invoke

    def test_registry_removal_requests_write_access(self):
        self.registry = StrictRegistry()
        self.assertEqual(self.invoke("--apply", "--extension-id", baseline.EXT,
                                     platform="win32")[0], 0)
        key = self.registry.HKEY_CURRENT_USER + "\\" + install._registry_subkey("chrome")
        self.registry.values[key]["unrelated"] = ("preserve", self.registry.REG_SZ)
        rc, output = self.invoke("--remove", platform="win32")
        self.assertEqual(rc, 0, output)
        self.assertNotIn("", self.registry.values[key])
        self.assertEqual(self.registry.values[key]["unrelated"][0], "preserve")
        self.assertFalse((self.local / "TaskLight/native" / (baseline.HOST + ".json")).exists())
        self.assertFalse((self.local / "TaskLight/native" / (baseline.HOST + ".host.bat")).exists())

    def test_registry_delete_failure_is_reported(self):
        self.registry = StrictRegistry(refuse_delete=True)
        self.assertEqual(self.invoke("--apply", "--extension-id", baseline.EXT,
                                     platform="win32")[0], 0)
        key = self.registry.HKEY_CURRENT_USER + "\\" + install._registry_subkey("chrome")
        rc, output = self.invoke("--remove", platform="win32")
        self.assertNotEqual(rc, 0)
        self.assertEqual(len(output.splitlines()), 1)
        self.assertIn("registry", output.lower())
        self.assertIn("", self.registry.values[key])
        # Failure must leave ownership evidence available for a retry.
        self.registry.refuse_delete = False
        self.assertEqual(self.invoke("--remove", platform="win32")[0], 0)
        self.assertNotIn("", self.registry.values[key])

    def test_batch_percent_literals_preserve_argument_forwarding(self):
        text = install._bat_launcher_text(
            self.root / "%REPO%" / "bridge", r"C:\%PYTHON%\python.exe",
            r"C:\configs\%TEMP%\wall.config.json")
        self.assertIn("%%TEMP%%", text)
        self.assertIn("%%PYTHON%%", text)
        self.assertIn("%%REPO%%", text)
        self.assertTrue(text.endswith(" %*\n"))
        self.assertNotIn("%%*", text)

    def test_config_created_during_install_is_preserved(self):
        config = self.root / "racing" / "wall.config.json"
        first = '{"created_by": "first installer"}\n'
        mkdir = Path.mkdir
        raced = []

        def racing_mkdir(path, *args, **kwargs):
            result = mkdir(path, *args, **kwargs)
            if path == config.parent and not raced:
                config.write_text(first, encoding="utf-8")
                raced.append(True)
            return result

        with patch.object(Path, "mkdir", racing_mkdir):
            rc, output = self.invoke("--apply", "--extension-id", baseline.EXT,
                                     "--config", str(config))
        self.assertEqual(rc, 0, output)
        self.assertTrue(raced)
        self.assertEqual(config.read_text(encoding="utf-8"), first)

    def test_new_config_uses_private_permissions(self):
        config = self.root / "new" / "wall.config.json"
        rc, output = self.invoke("--apply", "--extension-id", baseline.EXT,
                                 "--config", str(config))
        self.assertEqual(rc, 0, output)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
