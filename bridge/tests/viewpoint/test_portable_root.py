"""The default run directory follows the platform's temporary directory."""

import os
import tempfile
import unittest

from bridge.viewpoint.observer import DEFAULT_ROOT


class ViewpointRootTests(unittest.TestCase):
    def test_default_root_lives_below_platform_temp_directory(self):
        self.assertEqual(os.path.commonpath([tempfile.gettempdir(), DEFAULT_ROOT]),
                         tempfile.gettempdir())
        self.assertEqual(os.path.basename(DEFAULT_ROOT), "runs")
