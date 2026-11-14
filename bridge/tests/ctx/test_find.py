import os
import unittest

from bridge.ctx import limits
from bridge.ctx.find import find
from .helpers import Clock, TmpCase, assert_envelope, canon, D


class FindTests(TmpCase):
    def f(self, terms, k=10, root=None, **kw):
        return find(terms, root or self.root, k, self.roots, **kw)

    def tree_p4(self):
        self.w("a.txt", "alpha\nnothing\nalpha beta\n")
        self.w("b.txt", "alpha " + "t" * 300 + "\n")

    @staticmethod
    def key(h):
        return (os.path.basename(h["path"]), h["line"], h["cover"])

    def test_P4_rank_and_snippet(self):
        self.tree_p4()
        r = self.f(["alpha", "beta"], 3)
        assert_envelope(self, r, "find", 0)
        hits = D(r)["hits"]
        self.assertEqual([self.key(h) for h in hits],
                         [("a.txt", 3, 2), ("a.txt", 1, 1), ("b.txt", 1, 1)])
        for h in hits:
            self.assertEqual(set(h), {"path", "line", "cover", "snippet"})
            self.assertLessEqual(len(h["snippet"]), 160)
        self.assertEqual(hits[0]["snippet"], "alpha beta")
        self.assertEqual(hits[2]["snippet"], ("alpha " + "t" * 300)[:160])
        self.assertFalse(hits[2]["snippet"].endswith("..."))

    def test_k_truncates(self):
        self.tree_p4()
        self.assertEqual(len(D(self.f(["alpha", "beta"], 2))["hits"]), 2)
        self.assertEqual(len(D(self.f(["alpha"], 1))["hits"]), 1)

    def test_snippet_strips_cr(self):
        self.w("a.txt", "alpha end\r\n")
        h = D(self.f(["alpha"]))["hits"][0]
        self.assertEqual(h["snippet"], "alpha end")

    def test_casefold_and_dedupe(self):
        self.w("a.txt", "ALPHA Beta\n")
        h = D(self.f(["Alpha", "ALPHA", "beta"]))["hits"][0]
        self.assertEqual(h["cover"], 2)

    def test_order_cover_then_path_then_line(self):
        self.w("sub/c.txt", "alpha\n")
        self.w("a.txt", "x\nalpha\nalpha\n")
        self.w("z.txt", "alpha beta\n")
        hits = D(self.f(["alpha", "beta"], 10))["hits"]
        self.assertEqual([self.key(h) for h in hits],
                         [("z.txt", 1, 2), ("a.txt", 2, 1), ("a.txt", 3, 1), ("c.txt", 1, 1)])

    def test_P5_1_full_scan_absent(self):
        self.tree_p4()
        r = self.f(["alpha", "zeta"])
        d = D(r)
        self.assertEqual(r["rc"], 0)
        self.assertIs(d["complete"], True)
        self.assertEqual(d["absent"], ["zeta"])
        self.assertEqual((d["scanned"], d["skipped"], d["binary"]), (2, 0, 0))

    def test_all_present_gives_empty_absent(self):
        self.tree_p4()
        d = D(self.f(["alpha", "beta"]))
        self.assertEqual(d["absent"], [])

    def test_P5_2_deadline_rc124_no_absent(self):
        self.tree_p4()
        r = self.f(["alpha", "zeta"], monotonic=Clock(0.0, 3600.0))
        assert_envelope(self, r, "find", 124)
        d = D(r)
        self.assertIs(r["ok"], False)
        self.assertIs(d["complete"], False)
        self.assertNotIn("absent", d)
        self.assertIsInstance(d["hits"], list)
        self.assertLessEqual(len(d["hits"]), 3)
        for h in d["hits"]:
            self.assertLessEqual(len(h["snippet"]), 160)

    def test_timeout_never_claims_absent_even_for_missing_term(self):
        for i in range(5):
            self.w("f%d.txt" % i, "alpha\n")
        r = self.f(["qqqq"], monotonic=Clock(0.0, 3600.0))
        self.assertEqual(r["rc"], 124)
        self.assertNotIn("absent", D(r))

    def test_frozen_clock_completes(self):
        self.tree_p4()
        r = self.f(["alpha", "zeta"], monotonic=Clock(0.0, 0.0))
        self.assertEqual(r["rc"], 0)
        self.assertEqual(D(r)["absent"], ["zeta"])

    def test_P5_3_oversize_file_skipped(self):
        self.w("a.txt", "alpha\n")
        self.w("big.txt", b"x" * (limits.FIND_FILE_MAX + 1))
        r = self.f(["alpha", "zeta"])
        d = D(r)
        self.assertEqual(r["rc"], 0)
        self.assertEqual(d["skipped"], 1)
        self.assertIs(d["complete"], False)
        self.assertNotIn("absent", d)

    def test_file_exactly_at_limit_is_read(self):
        body = b"alpha\n" + b"x" * (limits.FIND_FILE_MAX - 6)
        self.assertEqual(len(body), limits.FIND_FILE_MAX)
        self.w("edge.txt", body)
        d = D(self.f(["alpha", "zeta"]))
        self.assertEqual(d["skipped"], 0)
        self.assertIs(d["complete"], True)
        self.assertEqual(d["absent"], ["zeta"])
        self.assertEqual(len(d["hits"]), 1)

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads everything")
    def test_unreadable_file_skipped(self):
        p = self.w("secret.txt", "alpha\n")
        self.w("a.txt", "alpha\n")
        os.chmod(p, 0)
        self.addCleanup(os.chmod, p, 0o644)
        d = D(self.f(["alpha", "zeta"]))
        self.assertEqual(d["skipped"], 1)
        self.assertIs(d["complete"], False)
        self.assertNotIn("absent", d)

    def test_P6_binary_excluded(self):
        self.w("bin.dat", b"alpha\x00\x01\n")
        self.w("a.txt", "nothing\n")
        r = self.f(["alpha"])
        d = D(r)
        self.assertEqual(r["rc"], 0)
        self.assertEqual(d["hits"], [])
        self.assertEqual(d["binary"], 1)
        self.assertIs(d["complete"], True)
        self.assertEqual(d["skipped"], 0)

    def test_binary_sniff_is_first_8kib_only(self):
        self.w("in.dat", b"alpha\n" + b"x" * 8185 + b"\x00")      # NUL at index 8191
        self.w("out.dat", b"alpha\n" + b"x" * 8186 + b"\x00\n")   # NUL at index 8192
        d = D(self.f(["alpha"]))
        self.assertEqual(d["binary"], 1)
        self.assertEqual([os.path.basename(h["path"]) for h in d["hits"]], ["out.dat"])

    def test_git_dir_and_symlinks_excluded(self):
        self.w(".git/config", "alpha\n")
        self.w("a.txt", "x\n")
        self.w("TOPSECRET.txt", "alpha TOPSECRET\n", base=self.outside)
        os.symlink(os.path.join(self.outside, "TOPSECRET.txt"), os.path.join(self.root, "l.txt"))
        os.symlink(self.outside, os.path.join(self.root, "ldir"))
        r = self.f(["alpha"])
        self.assertEqual(r["rc"], 0)
        self.assertEqual(D(r)["hits"], [])
        self.assertNotIn("TOPSECRET", canon(r))

    def test_usage_errors(self):
        self.tree_p4()
        for terms, k in ((["a"], 0), (["a"], 51), (["a"], -1), ([], 3), ([""], 3),
                         (["a" + str(i) for i in range(9)], 3), (["a", "  "[:0]], 3)):
            self.assertEqual(self.f(terms, k)["rc"], 2, (terms, k))
        self.assertEqual(self.f(["a"], 50)["rc"], 0)
        self.assertEqual(self.f(["a" + str(i) for i in range(8)], 1)["rc"], 0)

    def test_B13_missing_root(self):
        self.assertEqual(self.f(["a"], root=os.path.join(self.root, "nope"))["rc"], 7)

    def test_root_outside_confinement(self):
        r = self.f(["alpha"], root=self.outside)
        self.assertEqual(r["rc"], 2)

    def test_deterministic(self):
        for i in range(6):
            self.w("d%d/f.txt" % (5 - i), "alpha %d\nalpha\n" % i)
        a, b = self.f(["alpha", "x"], 20), self.f(["alpha", "x"], 20)
        self.assertEqual(canon(a), canon(b))


if __name__ == "__main__":
    unittest.main()
