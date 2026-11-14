import os
import unittest

from bridge.ctx.tail import tail
from .helpers import TmpCase, assert_envelope, D, page_size, sha


class TailTests(TmpCase):
    def t(self, p, n):
        return tail(p, n, self.roots)

    def test_P8_last_n(self):
        content = "".join("line %04d\n" % i for i in range(1, 1001))
        p = self.w("s.log", content)
        r = self.t(p, 5)
        assert_envelope(self, r, "tail", 0)
        d = D(r)
        self.assertEqual(d["lines"], ["line %04d" % i for i in range(996, 1001)])
        self.assertEqual(d["line_count"], 1000)
        self.assertEqual(d["byte_count"], os.path.getsize(p))
        self.assertEqual(d["sha256"], sha(content.encode()))
        self.assertIs(d["cut"], False)

    def test_P8_usage(self):
        p = self.w("s.log", "a\n" * 300)
        for n in (0, -1, 201, 1000):
            self.assertEqual(self.t(p, n)["rc"], 2, n)
        self.assertEqual(self.t(p, 1)["rc"], 0)
        self.assertEqual(self.t(p, 200)["rc"], 0)

    def test_P8_n200_100B_lines_cut(self):
        lines = ["%04d" % i + "x" * 95 for i in range(300)]
        p = self.w("s.log", "".join(l + "\n" for l in lines))
        d = D(self.t(p, 200))
        self.assertIs(d["cut"], True)
        self.assertLessEqual(page_size(d["lines"]), 4096)
        self.assertEqual(len(d["lines"]), 40)
        self.assertEqual(d["lines"], lines[-40:])
        self.assertEqual(d["line_count"], 300)
        self.assertEqual(d["byte_count"], 30000)

    def test_n200_short_lines_not_cut(self):
        p = self.w("s.log", "".join("%d\n" % (i % 10) for i in range(500)))
        d = D(self.t(p, 200))
        self.assertEqual(len(d["lines"]), 200)
        self.assertIs(d["cut"], False)

    def test_partial_trailing_line_counts(self):
        p = self.w("s.log", "a\nb\nc")
        d = D(self.t(p, 2))
        self.assertEqual((d["lines"], d["line_count"], d["byte_count"]), (["b", "c"], 3, 5))

    def test_n_larger_than_file(self):
        p = self.w("s.log", "a\nb\n")
        d = D(self.t(p, 50))
        self.assertEqual((d["lines"], d["line_count"], d["cut"]), (["a", "b"], 2, False))

    def test_empty_file(self):
        p = self.w("e.log", b"")
        d = D(self.t(p, 3))
        self.assertEqual((d["lines"], d["line_count"], d["byte_count"], d["sha256"], d["cut"]),
                         ([], 0, 0, sha(b""), False))

    def test_large_file_sha_streams_whole_file(self):
        content = "".join("row %06d payload\n" % i for i in range(40000))
        p = self.w("big.log", content)
        d = D(self.t(p, 3))
        self.assertEqual(d["lines"], ["row %06d payload" % i for i in (39997, 39998, 39999)])
        self.assertEqual(d["line_count"], 40000)
        self.assertEqual(d["byte_count"], len(content))
        self.assertEqual(d["sha256"], sha(content.encode()))

    def test_oversize_last_line_trimmed(self):
        p = self.w("s.log", "first\n" + "€" * 3000 + "\n")
        r = self.t(p, 2)
        d = D(r)
        self.assertEqual(r["rc"], 0)
        self.assertIs(d["cut"], True)
        self.assertLessEqual(page_size(d["lines"]), 4096)
        self.assertNotIn("�", "".join(d["lines"]))

    def test_missing_and_outside(self):
        self.assertEqual(self.t(os.path.join(self.root, "nope"), 3)["rc"], 7)
        o = self.w("o.log", "x\n", base=self.outside)
        self.assertEqual(self.t(o, 3)["rc"], 2)

    def test_deterministic(self):
        p = self.w("s.log", "a\n" * 50)
        self.assertEqual(self.t(p, 7), self.t(p, 7))


if __name__ == "__main__":
    unittest.main()
