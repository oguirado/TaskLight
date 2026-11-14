"""P12: CLI determinism, exit code == rc, golden vectors.

CLI flag spelling is [ASSUMED] (see ORACLE.md): parameter names with '-' for '_',
`--term` repeatable for find, `--allow-root` repeatable for Roots.
"""
import glob
import json
import os
import unittest

from bridge.ctx.envelope import canonical
from .helpers import (FIXTURES_V1, HAVE_GIT, TmpCase, canon, clk_tck, git, make_proc, run_cli,
                      sha, ENVELOPE_KEYS)


class CliTests(TmpCase):
    def setUp(self):
        super().setUp()
        self.f = self.w("f.txt", "".join("l%03d alpha\n" % i for i in range(1, 101)))
        self.proc = os.path.join(self.base, "proc")
        make_proc(self.proc, 42, starttime_ticks=5000 * clk_tck())
        self.ar = ("--allow-root", self.root, "--allow-root", self.proc)

    def cases(self):
        good = run_cli("page", "--path", self.f, "--from-line", "1", *self.ar)[1]
        cs = [
            ("page", ["--path", self.f, "--from-line", "1"], 0),
            ("page", ["--path", self.f, "--from-line", "61"], 0),
            ("page", ["--path", self.f + ".nope", "--from-line", "1"], 7),
            ("page", ["--path", self.f, "--from-line", "0"], 2),
            ("page", ["--path", self.f, "--from-line", "1", "--expect-sha256", "0" * 64], 4),
            ("find", ["--term", "alpha", "--term", "zeta", "--root", self.root, "--k", "5"], 0),
            ("find", ["--root", self.root, "--k", "0", "--term", "alpha"], 2),
            ("census", ["--dir", self.root], 0),
            ("census", ["--dir", self.root + "/nope"], 7),
            ("tail", ["--path", self.f, "--n", "5"], 0),
            ("tail", ["--path", self.f, "--n", "201"], 2),
            ("state", ["--target", "pid:42", "--proc-root", self.proc, "--now-s", "5123"], 0),
            ("state", ["--target", "pid:43", "--proc-root", self.proc, "--now-s", "5123"], 7),
            ("check", ["--obj-json", good.decode().strip()], 0),
            ("check", ["--obj-json", "{"], 2),
        ]
        if HAVE_GIT:
            repo = os.path.join(self.root, "repo")
            os.mkdir(repo)
            git(repo, "init", "-q", "-b", "main")
            self.w("repo/a", "1\n")
            git(repo, "add", ".")
            git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "m")
            cs.append(("state", ["--target", repo], 0))
        return cs

    def test_P12_deterministic_line_and_exit_code(self):
        for verb, args, want in self.cases():
            a = run_cli(verb, *args, *self.ar)
            b = run_cli(verb, *args, *self.ar)
            tag = (verb, args[:2], want, a[2][-300:])
            self.assertEqual(a[1], b[1], tag)                    # byte-identical stdout
            self.assertEqual(a[0], want, tag)                    # exit code == rc
            self.assertTrue(a[1].endswith(b"\n"), tag)
            self.assertEqual(a[1].count(b"\n"), 1, tag)          # exactly one line
            line = a[1].decode("utf-8")[:-1]
            obj = json.loads(line)
            self.assertEqual(set(obj), ENVELOPE_KEYS, tag)
            self.assertEqual(obj["rc"], want, tag)
            self.assertEqual(obj["verb"], verb, tag)
            self.assertEqual(line, canon(obj), tag)              # canonical form
            self.assertEqual(line, canonical(obj), tag)
            self.assertEqual(obj["sha256"], sha(canon(obj["data"]).encode("utf-8")), tag)

    def test_usage_error_exit_2(self):
        for argv in (["bogus"], [], ["page"], ["tail", "--path"]):
            rc, out, _ = run_cli(*argv, *self.ar)
            self.assertEqual(rc, 2, argv)
            self.assertLessEqual(out.count(b"\n"), 1)

    def test_outside_root_exit_2(self):
        o = self.w("o.txt", "x\n", base=self.outside)
        rc, out, _ = run_cli("page", "--path", o, "--from-line", "1", *self.ar)
        self.assertEqual(rc, 2)

    def test_unicode_output_byte_stable(self):
        p = self.w("u.txt", "café €\n")
        a = run_cli("page", "--path", p, "--from-line", "1", *self.ar)
        b = run_cli("page", "--path", p, "--from-line", "1", *self.ar)
        self.assertEqual(a[1], b[1])
        self.assertIn("café €".encode("utf-8"), a[1])


class GoldenTests(unittest.TestCase):
    """fixtures/ctx/v1 is read-only U28 surface; every vector must be reproduced
    byte-for-byte by the Python canonical form (P12, B2)."""
    files = sorted(glob.glob(os.path.join(FIXTURES_V1, "*.out.jsonl")))

    @unittest.skipUnless(files, "fixtures/ctx/v1/*.out.jsonl not present")
    def test_canonical_reproduces_vectors(self):
        for fp in self.files:
            for ln in open(fp, encoding="utf-8").read().splitlines():
                obj = json.loads(ln)
                self.assertEqual(canonical(obj), ln, fp)
                self.assertEqual(obj["sha256"], sha(canonical(obj["data"]).encode("utf-8")), fp)
                self.assertEqual(obj["schema"], "ctx.resp/v1")
                self.assertEqual(set(obj), ENVELOPE_KEYS)


if __name__ == "__main__":
    unittest.main()
