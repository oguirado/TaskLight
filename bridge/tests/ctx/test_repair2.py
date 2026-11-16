"""Repair loop 2 regression tests (review HOLD, DISP_03 BLOCKING items only)."""
import json
import os
import threading
import unittest

from bridge.ctx.check import check
from bridge.ctx.page import page
from bridge.ctx.paths import Roots
from bridge.ctx.tail import tail
from .helpers import TmpCase, D, sha, canon


class AncestorSwapRoots(Roots):
    """Approves ROOT/d/f, then replaces directory ROOT/d with a symlink to outside."""
    def __init__(self, roots, dirpath, outside_dir):
        super().__init__(roots)
        self.dirpath, self.outside_dir, self.done = dirpath, outside_dir, False

    def resolve(self, p):
        r = super().resolve(p)
        if r is not None and not self.done:
            self.done = True
            os.rename(self.dirpath, self.dirpath + "_moved")
            os.symlink(self.outside_dir, self.dirpath)
        return r


class AncestorRaceTests(TmpCase):
    def _setup(self):
        victim = self.w("d/f.txt", "innocent\n")
        self.w("f.txt", "TOPSECRETLINE\n", base=self.outside)
        return victim, AncestorSwapRoots((self.root,), os.path.join(self.root, "d"),
                                         self.outside)

    def test_page_ancestor_symlink_swap(self):
        victim, roots = self._setup()
        r = page(victim, 1, roots)
        self.assertNotIn("TOPSECRETLINE", json.dumps(r))

    def test_tail_ancestor_symlink_swap(self):
        victim, roots = self._setup()
        r = tail(victim, 5, roots)
        self.assertNotIn("TOPSECRETLINE", json.dumps(r))


class FifoStallTests(TmpCase):
    def _call(self, fn):
        fifo = os.path.join(self.root, "pipe")
        os.mkfifo(fifo)
        out = {}

        def run():
            try:
                out["r"] = fn(fifo)
            except BaseException as e:  # noqa: BLE001
                out["e"] = e
        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(3.0)
        stalled = t.is_alive()
        if stalled:  # release the blocked open so no handle leaks
            try:
                fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
                os.close(fd)
            except OSError:
                pass
            t.join(3.0)
        self.assertFalse(stalled, "verb blocked on a FIFO with no writer")
        return out.get("r")

    def test_page_fifo_does_not_stall(self):
        r = self._call(lambda p: page(p, 1, self.roots))
        self.assertIsNotNone(r)
        self.assertNotEqual(r["rc"], 0)

    def test_tail_fifo_does_not_stall(self):
        r = self._call(lambda p: tail(p, 3, self.roots))
        self.assertIsNotNone(r)
        self.assertNotEqual(r["rc"], 0)


class TailFrontTrimTests(TmpCase):
    def test_oversized_last_line_keeps_newest_text(self):
        p = self.w("big.txt", "A" * 9000 + "END\n")
        r = tail(p, 1, self.roots)
        self.assertEqual(r["rc"], 0)
        d = D(r)
        self.assertTrue(d["cut"])
        self.assertEqual(len(d["lines"]), 1)
        self.assertTrue(d["lines"][0].endswith("END"))
        self.assertLessEqual(len(d["lines"][0].encode("utf-8")) + 1, 4096 + 4)

    def test_oversized_last_line_multibyte_front_trim(self):
        p = self.w("big2.txt", "é" * 5000 + "FIN\n")
        d = D(tail(p, 1, self.roots))
        self.assertTrue(d["lines"][0].endswith("FIN"))
        d["lines"][0].encode("utf-8")
        self.assertNotIn("�", d["lines"][0])


class CheckDigestFailureTests(unittest.TestCase):
    def test_lone_surrogate_never_valid(self):
        text = ('{"schema":"ctx.resp/v1","verb":"state","rc":0,"ok":true,'
                '"data":{"facts":{"x":"\\ud800"}},"sha256":"%s"}' % ("0" * 64))
        r = check(text)
        self.assertNotEqual(r["rc"], 0)
        self.assertIs(r["data"]["valid"], False)
        self.assertTrue(r["data"]["errors"])


if __name__ == "__main__":
    unittest.main()
