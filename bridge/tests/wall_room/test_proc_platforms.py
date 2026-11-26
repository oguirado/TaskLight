"""Missing procfs is distinct from a process exit."""

import unittest
from unittest import mock

from bridge.wall.observers import ProcObserver


class ProcPlatformTests(unittest.TestCase):
    def test_windows_and_macos_report_disabled_without_probing(self):
        for platform in ("win32", "darwin"):
            with self.subTest(platform=platform):
                emit = mock.Mock()
                with mock.patch("os.path.isfile", side_effect=AssertionError("procfs probe")):
                    observer = ProcObserver("demo", [42], emit_fn=emit, platform=platform)
                    self.assertIn("unavailable", observer.disabled_reason)
                    self.assertEqual(observer.poll(), [])
                emit.assert_not_called()

    def test_missing_procfs_does_not_report_process_exit(self):
        emit = mock.Mock(return_value={"ok": True})
        observer = ProcObserver("demo", [42], emit_fn=emit, platform="linux")
        observer._seen.add(42)
        with (mock.patch("os.path.isfile", return_value=False),
              mock.patch("os.path.isdir", return_value=False)):
            self.assertEqual(observer.poll(), [])
            self.assertIn("unavailable", observer.disabled_reason)
        emit.assert_not_called()
