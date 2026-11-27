"""Exercise desktop discovery against fake application installations."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bridge import tasklight_setup as setup


class OpenDiscovery(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)

    def fake_executable(self, *parts):
        executable = self.root.joinpath(*parts)
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_bytes(b"")
        executable.chmod(0o755)
        return executable

    def test_windows_finds_edge_in_program_files(self):
        edge = self.fake_executable("Program Files (x86)", "Microsoft", "Edge", "Application",
                                    "msedge.exe")
        with (patch.object(setup.sys, "platform", "win32"),
              patch.dict(os.environ, {"PATH": "", "ProgramFiles(x86)": str(edge.parents[3])},
                         clear=True)):
            self.assertEqual(setup._find_browser("edge"), ("edge", str(edge)))

    def test_windows_finds_chromium_chrome_exe_in_local_app_data(self):
        chromium = self.fake_executable("Chromium", "Application", "chrome.exe")
        with (patch.object(setup.sys, "platform", "win32"),
              patch.dict(os.environ, {"PATH": "", "LOCALAPPDATA": str(self.root)}, clear=True)):
            self.assertEqual(setup._find_browser("chromium"), ("chromium", str(chromium)))

    def test_macos_finds_user_application_bundle(self):
        brave = self.fake_executable("Applications", "Brave Browser.app", "Contents", "MacOS",
                                     "Brave Browser")
        with (patch.object(setup.sys, "platform", "darwin"),
              patch.dict(os.environ, {"HOME": str(self.root), "PATH": ""}, clear=True)):
            self.assertEqual(setup._find_browser("brave"), ("brave", str(brave)))

    def test_hosted_address_uses_production_extension_configuration(self):
        manifest = self.root / "extension" / "manifest.json"
        manifest.parent.mkdir()
        manifest.write_text(
            '{"externally_connectable":{"matches":["https://wall.example.com/*"]}}',
            encoding="utf-8",
        )
        with patch.object(setup, "_repo_root", return_value=self.root):
            self.assertEqual(setup._hosted_wall_url(), "https://wall.example.com")
