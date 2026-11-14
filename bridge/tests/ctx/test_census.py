import os
import unittest

from bridge.ctx import limits
from bridge.ctx.census import census
from .helpers import TmpCase, assert_envelope, canon, D


class CensusTests(TmpCase):
    def test_P7_counts(self):
        a = self.w("a.py", b"1" * 10)
        self.w("b.py", b"2" * 20)
        self.w("c.py", b"3" * 30)
        self.w("d.MD", b"4" * 40)
        self.w("e.MD", b"5" * 50)
        self.w("Makefile", b"6" * 60)
        self.w(".git/config", b"7" * 70)
        os.symlink(a, os.path.join(self.root, "link.py"))
        r = census(self.root, self.roots)
        assert_envelope(self, r, "census", 0)
        d = D(r)
        self.assertEqual(d["by_ext"], {"py": 3, "md": 2, "": 1})
        self.assertEqual(d["files"], 6)
        self.assertEqual(d["bytes"], 210)
        self.assertIs(d["complete"], True)
        self.assertEqual([(os.path.basename(e["path"]), e["bytes"]) for e in d["largest"]],
                         [("Makefile", 60), ("e.MD", 50), ("d.MD", 40), ("c.py", 30),
                          ("b.py", 20), ("a.py", 10)])
        self.assertEqual(set(d["largest"][0]), {"path", "bytes"})
        self.assertFalse(any(".git" in e["path"] or "link.py" in e["path"] for e in d["largest"]))

    def test_recursive_double_ext_and_dir_symlink(self):
        self.w("x/y/z.tar.gz", b"abc")
        self.w("TOPSECRET.txt", b"zzzz", base=self.outside)
        os.symlink(self.outside, os.path.join(self.root, "ldir"))
        d = D(census(self.root, self.roots))
        self.assertEqual(d["by_ext"], {"gz": 1})
        self.assertEqual((d["files"], d["bytes"]), (1, 3))

    def test_largest_top10_ties_by_path(self):
        for i in range(12):
            self.w("f%02d" % (11 - i), b"12345")
        d = D(census(self.root, self.roots))
        self.assertEqual(d["files"], 12)
        self.assertEqual(len(d["largest"]), 10)
        self.assertEqual([os.path.basename(e["path"]) for e in d["largest"]],
                         ["f%02d" % i for i in range(10)])

    def test_largest_top10_by_size(self):
        for i in range(1, 13):
            self.w("s%02d" % i, b"x" * i)
        d = D(census(self.root, self.roots))
        self.assertEqual([e["bytes"] for e in d["largest"]], list(range(12, 2, -1)))

    def test_empty_dir(self):
        d = D(census(self.root, self.roots))
        self.assertEqual((d["files"], d["bytes"], d["by_ext"], d["largest"], d["complete"]),
                         (0, 0, {}, [], True))

    def test_missing_and_outside(self):
        self.assertEqual(census(os.path.join(self.root, "nope"), self.roots)["rc"], 7)
        self.assertEqual(census(self.outside, self.roots)["rc"], 2)

    def test_entries_cap_incomplete(self):
        n = limits.CENSUS_ENTRIES_MAX + 1
        for d in range(10):
            os.mkdir(os.path.join(self.root, "d%d" % d))
        per = n // 10 + 1
        for d in range(10):
            base = os.path.join(self.root, "d%d" % d)
            for i in range(per):
                open(os.path.join(base, "f%d" % i), "wb").close()
        r = census(self.root, self.roots)
        self.assertEqual(r["rc"], 0)
        self.assertIs(D(r)["complete"], False)

    def test_deterministic(self):
        for i in range(8):
            self.w("d%d/f%d.txt" % (i % 3, i), b"x" * (i % 4))
        self.assertEqual(canon(census(self.root, self.roots)), canon(census(self.root, self.roots)))


if __name__ == "__main__":
    unittest.main()
