"""CLI `export` writes PLAN.md and MEMORY.md under CW_HOME and refuses escapes (O-U94c)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]


def cli(home, *args):
    env = dict(os.environ, CW_HOME=home)
    r = subprocess.run([sys.executable, "-m", "bridge.room", *args], cwd=ROOT, env=env,
                       capture_output=True, text=True, timeout=120)
    return r.returncode, r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""


class CliExport(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        rc, _ = cli(self.home, "post", "--room", "demo", "--agent", "a", "--act", "open", "--text", "hello")
        self.assertEqual(rc, 0)

    def test_export_writes_under_home(self):
        rc, out = cli(self.home, "export", "--room", "demo", "--out", "exports")
        self.assertEqual(rc, 0, out)
        self.assertTrue(json.loads(out)["ok"])
        for name in ("PLAN.md", "MEMORY.md"):
            self.assertTrue((Path(self.home) / "exports" / name).is_file())

    def test_traversal_refused(self):
        rc, out = cli(self.home, "export", "--room", "demo", "--out", "../escape")
        self.assertEqual(rc, 2)
        self.assertEqual(json.loads(out)["code"], "bad_args")
        self.assertFalse((Path(self.home).parent / "escape").exists())

    def test_missing_out_is_bad_args(self):
        rc, _ = cli(self.home, "export", "--room", "demo")
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
