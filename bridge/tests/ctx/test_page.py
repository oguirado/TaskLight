import os
import unittest

from bridge.ctx.page import page
from .helpers import TmpCase, assert_envelope, D, page_size, sha


class PageTests(TmpCase):
    def pg(self, p, frm=1, **kw):
        return page(p, frm, self.roots, **kw)

    def test_P1_lines_cap(self):
        content = "".join("l%08d\n" % i for i in range(1, 101))
        self.assertEqual(len(content), 1000)
        p = self.w("f.txt", content)
        r = self.pg(p)
        assert_envelope(self, r, "page", 0)
        d = D(r)
        self.assertEqual(d["lines"], ["l%08d" % i for i in range(1, 61)])
        self.assertEqual(d["next"], 61)
        self.assertEqual(d["total_lines"], 100)
        self.assertEqual(d["sha256"], sha(content.encode()))
        self.assertEqual(d["from"], 1)
        self.assertIs(d["line_cut"], False)
        self.assertIs(d["lossy"], False)
        r2 = self.pg(p, 61)
        self.assertEqual(len(D(r2)["lines"]), 40)
        self.assertIsNone(D(r2)["next"])

    def test_P2_bytes_cap_lines_of_199(self):
        p = self.w("f.txt", ("x" * 199 + "\n") * 50)
        d = D(self.pg(p))
        self.assertEqual(len(d["lines"]), 20)
        self.assertLessEqual(page_size(d["lines"]), 4096)
        self.assertEqual(d["next"], 21)
        self.assertIs(d["line_cut"], False)
        self.assertEqual(d["total_lines"], 50)

    def test_bytes_cap_before_lines_cap(self):
        p = self.w("f.txt", ("y" * 99 + "\n") * 100)
        d = D(self.pg(p))
        self.assertEqual(len(d["lines"]), 40)  # 41 lines = 4100 B > 4096
        self.assertEqual(d["next"], 41)

    def test_P2_single_9000_line_is_cut(self):
        p = self.w("f.txt", "z" * 9000 + "\ntail\n")
        r = self.pg(p)
        d = D(r)
        self.assertEqual(r["rc"], 0)
        self.assertIs(d["line_cut"], True)
        self.assertLessEqual(page_size(d["lines"]), 4096)
        self.assertGreaterEqual(page_size(d["lines"]), 4090)
        self.assertEqual(d["next"], 2)
        self.assertEqual(D(self.pg(p, 2))["lines"], ["tail"])

    def test_P2_multibyte_never_split(self):
        for ch in ("€", "é", "\U0001F600"):  # 3, 2, 4 byte sequences
            n = 9000 // len(ch.encode())
            p = self.w("m_%d.txt" % ord(ch), ch * n + "\nend\n")
            r = self.pg(p)
            d = D(r)
            self.assertEqual(r["rc"], 0)
            self.assertIs(d["line_cut"], True)
            self.assertIs(d["lossy"], False)
            self.assertTrue(set(d["lines"][0]) <= {ch}, "split sequence for %r" % ch)
            self.assertLessEqual(page_size(d["lines"]), 4096)
            self.assertGreaterEqual(page_size(d["lines"]), 4096 - 4)
            self.assertEqual(d["next"], 2)

    def test_P3_missing_stale_usage(self):
        self.assertEqual(self.pg(os.path.join(self.root, "nope.txt"))["rc"], 7)
        content = "".join("l%d\n" % i for i in range(100))
        p = self.w("f.txt", content)
        r = self.pg(p, expect_sha256="0" * 64)
        assert_envelope(self, r, "page", 4)
        self.assertEqual(self.pg(p, 0)["rc"], 2)
        self.assertEqual(self.pg(p, -3)["rc"], 2)
        self.assertEqual(self.pg(p, 102)["rc"], 2)

    def test_missing_beats_stale(self):
        r = self.pg(os.path.join(self.root, "nope"), expect_sha256="0" * 64)
        self.assertEqual(r["rc"], 7)

    def test_expect_sha_match_ok(self):
        content = "a\nb\n"
        p = self.w("f.txt", content)
        r = self.pg(p, expect_sha256=sha(content.encode()))
        self.assertEqual(r["rc"], 0)

    def test_from_total_plus_one_is_empty_page(self):
        p = self.w("f.txt", "".join("l%d\n" % i for i in range(100)))
        r = self.pg(p, 101)
        self.assertEqual(r["rc"], 0)
        self.assertEqual(D(r)["lines"], [])
        self.assertIsNone(D(r)["next"])

    def test_empty_file(self):
        p = self.w("e.txt", b"")
        r = self.pg(p)
        self.assertEqual(r["rc"], 0)
        d = D(r)
        self.assertEqual((d["lines"], d["total_lines"], d["next"]), ([], 0, None))
        self.assertEqual(d["sha256"], sha(b""))

    def test_no_trailing_newline_counts_line(self):
        p = self.w("f.txt", "a\nb")
        d = D(self.pg(p))
        self.assertEqual((d["lines"], d["total_lines"], d["next"]), (["a", "b"], 2, None))

    def test_B7_lossy_replace(self):
        p = self.w("f.txt", b"ok\xff\xfe\nfine\n")
        d = D(self.pg(p))
        self.assertIs(d["lossy"], True)
        self.assertEqual(d["lines"][0], "ok��")
        self.assertEqual(d["lines"][1], "fine")

    def test_never_exceeds_caps_walk(self):
        parts = []
        for i in range(700):
            parts.append(("é" * (i % 37) + "%d" % i + "€" * (i % 5)) if i % 7 else "")
        content = "\n".join(parts) + "\n"
        p = self.w("w.txt", content)
        want = content.split("\n")[:-1]
        got, frm, steps = [], 1, 0
        while frm is not None:
            d = D(self.pg(p, frm))
            self.assertLessEqual(len(d["lines"]), 60)
            self.assertLessEqual(page_size(d["lines"]), 4096)
            self.assertEqual(d["total_lines"], 700)
            got += d["lines"]
            frm = d["next"]
            steps += 1
            self.assertLess(steps, 800)
        self.assertEqual(got, want)

    def test_never_exceeds_caps_with_huge_lines(self):
        content = "\n".join(["q" * n for n in (5000, 10, 4096, 4095, 8191, 3)]) + "\n"
        p = self.w("h.txt", content)
        frm, steps = 1, 0
        while frm is not None:
            d = D(self.pg(p, frm))
            self.assertLessEqual(page_size(d["lines"]), 4096)
            self.assertLessEqual(len(d["lines"]), 60)
            self.assertGreater(len(d["lines"]) + (0 if d["lines"] else 1), 0)
            self.assertGreater(d["next"] or 10**9, frm)
            frm = d["next"]
            steps += 1
            self.assertLess(steps, 50)

    def test_deterministic(self):
        p = self.w("f.txt", "a\n" * 100)
        self.assertEqual(self.pg(p), self.pg(p))


if __name__ == "__main__":
    unittest.main()
