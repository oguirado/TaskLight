"""Portability checks for the process and Git state paths."""

import importlib
import os
import sys
from unittest import mock

from .helpers import TmpCase, assert_envelope

state_module = importlib.import_module("bridge.ctx.state")


class StatePlatformTests(TmpCase):
    def test_default_procfs_is_explicitly_unavailable_on_windows_and_macos(self):
        for platform in ("win32", "darwin"):
            with self.subTest(platform=platform):
                with (
                    mock.patch.object(sys, "platform", platform),
                    mock.patch("builtins.open", side_effect=AssertionError("procfs read")),
                ):
                    response = state_module.state("pid:42", self.roots)
                assert_envelope(self, response, "state", 7)
                self.assertEqual(response["data"], {"facts": {}, "capability": "procfs_unavailable"})

    def test_absent_procfs_root_differs_from_a_missing_pid(self):
        proc = os.path.join(self.base, "proc")
        unavailable = state_module.state("pid:42", self.roots, proc_root=proc)
        os.mkdir(proc)
        missing = state_module.state("pid:42", self.roots, proc_root=proc)
        self.assertEqual(unavailable["data"], {"facts": {}, "capability": "procfs_unavailable"})
        self.assertEqual(missing["data"], {"facts": {}})

    def test_git_environment_uses_the_platform_null_device(self):
        with mock.patch.object(os, "devnull", "NUL"):
            env = state_module._git_env()
        self.assertEqual(env["GIT_CONFIG_GLOBAL"], "NUL")
        self.assertEqual(env["GIT_CONFIG_SYSTEM"], "NUL")
