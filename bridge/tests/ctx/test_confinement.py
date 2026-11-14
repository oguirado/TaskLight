import os
import unittest

from bridge.ctx.paths import Roots
from bridge.ctx.page import page
from bridge.ctx.find import find
from bridge.ctx.census import census
from bridge.ctx.tail import tail
from bridge.ctx.state import state
from .helpers import ReadSpy, TmpCase, assert_envelope, canon


class RootsTests(TmpCase):
    def test_inside_resolves(self):
        p = self.w("a/b.txt", "x")
        for q in (p, self.root + "/a/../a/b.txt", self.root):
            out = self.roots.resolve(q)
            self.assertIsInstance(out, str, q)
            self.assertEqual(os.path.realpath(out), os.path.realpath(q))

    def test_missing_inside_still_resolves(self):
        self.assertIsInstance(self.roots.resolve(os.path.join(self.root, "nope", "x")), str)

    def test_escapes_rejected(self):
        self.w("o.txt", "x", base=self.outside)
        for q in (self.root + "/../OUTSIDE_SECRET_DIR/o.txt", self.outside + "/o.txt",
                  "/etc/hostname", self.root + "/../", self.root + "_evil/x"):
            self.assertIsNone(self.roots.resolve(q), q)

    def test_sibling_prefix_not_confused(self):
        evil = self.root + "_evil"
        os.mkdir(evil)
        p = self.w("f", "x", base=evil)
        self.assertIsNone(self.roots.resolve(p))

    def test_symlinks_never_followed(self):
        inner = self.w("real.txt", "x")
        out = self.w("o.txt", "TOPSECRET", base=self.outside)
        os.symlink(out, os.path.join(self.root, "to_out"))
        os.symlink(inner, os.path.join(self.root, "to_in"))
        os.symlink(self.outside, os.path.join(self.root, "dir_out"))
        os.mkdir(os.path.join(self.root, "d"))
        os.symlink(os.path.join(self.root, "d"), os.path.join(self.root, "dir_in"))
        self.w("d/k.txt", "x")
        for q in ("to_out", "to_in", "dir_out/o.txt", "dir_in/k.txt", "dir_out"):
            self.assertIsNone(self.roots.resolve(os.path.join(self.root, q)), q)

    def test_multiple_roots(self):
        r2 = Roots((self.root, self.outside))
        self.assertIsInstance(r2.resolve(self.outside), str)
        self.assertIsNone(r2.resolve(self.base))


class VerbConfinementTests(TmpCase):
    """P13: rc 2 for each escape, and the filesystem spy records 0 reads."""
    def setUp(self):
        super().setUp()
        self.secret = self.w("o.txt", "alpha TOPSECRET\n", base=self.outside)
        os.symlink(self.secret, os.path.join(self.root, "lnk.txt"))
        os.symlink(self.outside, os.path.join(self.root, "lnkdir"))

    def calls(self):
        R = self.roots
        up = os.path.join(self.root, "..", "OUTSIDE_SECRET_DIR")
        return [
            ("page", lambda: page(os.path.join(up, "o.txt"), 1, R)),
            ("page", lambda: page(self.secret, 1, R)),
            ("page", lambda: page("/etc/hostname", 1, R)),
            ("page", lambda: page(os.path.join(self.root, "lnk.txt"), 1, R)),
            ("page", lambda: page(os.path.join(self.root, "lnkdir", "o.txt"), 1, R)),
            ("tail", lambda: tail(os.path.join(up, "o.txt"), 3, R)),
            ("tail", lambda: tail(os.path.join(self.root, "lnk.txt"), 3, R)),
            ("tail", lambda: tail("/etc/hostname", 3, R)),
            ("find", lambda: find(["alpha"], self.outside, 3, R)),
            ("find", lambda: find(["alpha"], os.path.join(self.root, "lnkdir"), 3, R)),
            ("find", lambda: find(["alpha"], up, 3, R)),
            ("census", lambda: census(self.outside, R)),
            ("census", lambda: census(os.path.join(self.root, "lnkdir"), R)),
            ("census", lambda: census(up, R)),
            ("state", lambda: state(self.outside, R)),
        ]

    def test_P13_rc2_and_no_reads(self):
        for verb, fn in self.calls():
            with ReadSpy("OUTSIDE_SECRET_DIR") as spy:
                r = fn()
            assert_envelope(self, r, verb, 2)
            self.assertEqual(spy.hits, [], (verb, spy.hits))
            self.assertNotIn("TOPSECRET", canon(r))

    def test_real_target_not_echoed(self):
        r = page(os.path.join(self.root, "lnk.txt"), 1, self.roots)
        self.assertNotIn(self.outside, canon(r))


if __name__ == "__main__":
    unittest.main()
