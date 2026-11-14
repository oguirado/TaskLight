import os
import subprocess
import sys
import tempfile
import unittest

from .helpers import HERE, REPO

SCAN = os.path.join(HERE, "scan_imports.py")
CTX = os.path.join(REPO, "bridge", "ctx")
FIX = os.path.join(HERE, "fixtures")


def scan(path):
    p = subprocess.run([sys.executable, "-I", SCAN, path], capture_output=True, text=True)
    return p.returncode, p.stdout


class StaticPurityTests(unittest.TestCase):
    def test_P14_ctx_package_clean(self):
        self.assertTrue(os.path.isdir(CTX))
        rc, out = scan(CTX)
        self.assertEqual((rc, out), (0, ""))

    def test_P14_control_planted_bad_module(self):
        with tempfile.TemporaryDirectory() as td:
            with open(os.path.join(FIX, "bad_mod.py")) as f:
                src = f.read()
            self.assertIn("import socket", src)
            self.assertIn("import requests", src)
            with open(os.path.join(td, "bad_mod.py"), "w") as f:
                f.write(src)
            rc, out = scan(td)
        self.assertNotEqual(rc, 0)
        self.assertIn("socket", out)
        self.assertIn("requests", out)

    def test_P14_fixtures_dir_fails(self):
        self.assertNotEqual(scan(FIX)[0], 0)

    def test_control_clean_module_passes(self):
        with tempfile.TemporaryDirectory() as td:
            with open(os.path.join(td, "good_mod.py"), "w") as f:
                f.write(open(os.path.join(FIX, "good_mod.py")).read())
            self.assertEqual(scan(td)[0], 0)

    def test_control_each_banned_pattern(self):
        snippets = {
            "a": "import socket", "b": "from urllib import request", "c": "import http.client",
            "d": "import ssl", "e": "import asyncio", "f": "import ftplib", "g": "import smtplib",
            "h": "import xmlrpc.client", "i": "import requests", "j": "import subprocess",
            "k": "__import__('socket')", "l": "open('x','w')", "m": "import importlib",
            "n": "from pathlib import Path\nPath('x').write_text('y')",
        }
        for k, src in snippets.items():
            with tempfile.TemporaryDirectory() as td:
                with open(os.path.join(td, "mod_%s.py" % k), "w") as f:
                    f.write(src + "\n")
                self.assertNotEqual(scan(td)[0], 0, src)

    def test_control_subprocess_allowed_only_in_state(self):
        with tempfile.TemporaryDirectory() as td:
            with open(os.path.join(td, "state.py"), "w") as f:
                f.write("import subprocess\n")
            self.assertEqual(scan(td)[0], 0)

    def test_no_module_imports_banned_names_anywhere_in_source_text(self):
        banned = ("socket", "ssl", "http", "urllib", "ftplib", "smtplib", "xmlrpc", "asyncio")
        for dp, _, fn in os.walk(CTX):
            for f in fn:
                if f.endswith(".py"):
                    src = open(os.path.join(dp, f), encoding="utf-8").read()
                    for b in banned:
                        self.assertNotRegex(src, r"(?m)^\s*(import|from)\s+%s\b" % b, (f, b))

    def test_subprocess_only_in_state(self):
        for f in sorted(os.listdir(CTX)):
            if f.endswith(".py") and f != "state.py":
                self.assertNotIn("subprocess", open(os.path.join(CTX, f)).read(), f)


if __name__ == "__main__":
    unittest.main()
