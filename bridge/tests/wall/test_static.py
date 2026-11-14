import pathlib, subprocess, sys, unittest
from . import netscan, support as S

NEEDED = ["__init__.py", "__main__.py", "emit.py", "native_host.py", "observers.py"]


def targets():
    return sorted((S.BRIDGE / "wall").rglob("*.py")) + [S.INSTALL]


class NoNetwork(S.Base):
    def test_w12_tree_is_clean_and_complete(self):
        for n in NEEDED:
            self.assertTrue((S.BRIDGE / "wall" / n).is_file(), n)
        self.assertTrue(S.INSTALL.is_file())
        self.assertEqual(netscan.scan_files(targets()), [])
        p = subprocess.run([sys.executable, "-I", str(S.HERE / "netscan.py"), *map(str, targets())], capture_output=True)
        self.assertEqual(p.returncode, 0, p.stdout)

    def test_w12_control_planted_import_fails_scanner(self):
        cases = ["import urllib.request", "from urllib import request", "import socket as s", "from http.client import X",
                 "import ssl", "import asyncio", "import importlib", "x = __import__('os')", "eval('1')", "exec('1')",
                 "import ftplib", "import smtplib", "import xmlrpc.client", "import anthropic", "from openai import OpenAI",
                 "import google.generativeai"]
        for i, src in enumerate(cases):
            f = self.tmp / ("planted%d.py" % i)
            f.write_text(src + "\n")
            self.assertTrue(netscan.scan_files([f]), src)
            p = subprocess.run([sys.executable, "-I", str(S.HERE / "netscan.py"), str(f)], capture_output=True)
            self.assertNotEqual(p.returncode, 0, src)
        ok = self.tmp / "ok.py"
        ok.write_text("import json, os, subprocess\nfrom . import emit\n")
        self.assertEqual(netscan.scan_files([ok]), [])
        self.assertEqual(subprocess.run([sys.executable, "-I", str(S.HERE / "netscan.py"), str(ok)]).returncode, 0)

    def test_no_secret_literals_in_oracle_sources(self):
        for p in S.HERE.glob("*.py"):
            t = p.read_text()
            self.assertNotIn("-----BEGIN" + " RSA", t, p.name)
            self.assertNotIn("sk-" + "proj", t, p.name)


if __name__ == "__main__":
    unittest.main()
