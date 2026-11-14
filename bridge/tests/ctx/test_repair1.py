"""Repair loop 1 regression tests (Sol HOLD). Each case is a concrete failing input."""
import json
import os
import stat
import tracemalloc
import unittest

from bridge.ctx.find import find
from bridge.ctx.page import page
from bridge.ctx.paths import Roots
from bridge.ctx.state import state
from bridge.ctx.tail import tail
from .helpers import (HAVE_GIT, TmpCase, assert_envelope, D, git, run_cli)


class SwapRoots(Roots):
    """Approves a path, then (once) replaces the file with a symlink to a secret."""
    def __init__(self, roots, victim, secret):
        super().__init__(roots)
        self.victim, self.secret, self.done = victim, secret, False

    def resolve(self, p):
        r = super().resolve(p)
        if r is not None and not self.done and os.path.abspath(p) == self.victim:
            self.done = True
            os.unlink(self.victim)
            os.symlink(self.secret, self.victim)
        return r


class RaceTests(TmpCase):
    def _setup(self, name):
        victim = self.w(name, "innocent\n")
        secret = self.w("secret.txt", "TOPSECRETLINE\n", base=self.outside)
        return victim, secret

    def test_page_symlink_swap_after_resolve(self):
        victim, secret = self._setup("f.txt")
        roots = SwapRoots((self.root,), victim, secret)
        r = page(victim, 1, roots)
        self.assertNotIn("TOPSECRETLINE", json.dumps(r))
        self.assertEqual(r["rc"], 2)

    def test_tail_symlink_swap_after_resolve(self):
        victim, secret = self._setup("g.txt")
        roots = SwapRoots((self.root,), victim, secret)
        r = tail(victim, 5, roots)
        self.assertNotIn("TOPSECRETLINE", json.dumps(r))
        self.assertEqual(r["rc"], 2)


@unittest.skipUnless(HAVE_GIT, "git binary not found on PATH")
class GitSafetyTests(TmpCase):
    def mkrepo(self, base=None):
        repo = os.path.join(base or self.root, "repo")
        os.makedirs(repo)
        git(repo, "init", "-q", "-b", "main")
        self.w("tracked.txt", "one\n", base=repo)
        git(repo, "add", ".")
        git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "c1")
        return repo

    def test_dot_git_symlink_to_outside_rejected(self):
        ext = self.mkrepo(self.outside)
        d = os.path.join(self.root, "proj")
        os.mkdir(d)
        os.symlink(os.path.join(ext, ".git"), os.path.join(d, ".git"))
        r = state(d, self.roots)
        assert_envelope(self, r, "state", 2)
        self.assertEqual(D(r), {"facts": {}})

    def test_fsmonitor_hook_not_executed(self):
        repo = self.mkrepo()
        marker = os.path.join(self.outside, "MARKER")
        hook = self.w("hook.sh", "#!/bin/sh\necho x > '%s'\nprintf '\\0'\n" % marker,
                      base=self.outside)
        os.chmod(hook, 0o755)
        git(repo, "config", "core.fsmonitor", hook)
        state(repo, self.roots)
        self.assertFalse(os.path.exists(marker))

    def test_state_does_not_rewrite_index(self):
        repo = self.mkrepo()
        t = os.path.join(repo, "tracked.txt")
        os.utime(t, (1_000_000_000, 1_000_000_000))      # stale stat data, same content
        idx = os.path.join(repo, ".git", "index")
        before = open(idx, "rb").read()
        r = state(repo, self.roots)
        self.assertEqual(r["rc"], 0)
        self.assertEqual(open(idx, "rb").read(), before)


class Seq:
    """Injected monotonic: 0.0 for the first `ok` calls, then far past any deadline."""
    def __init__(self, ok):
        self.ok, self.n = ok, 0

    def __call__(self):
        self.n += 1
        return 0.0 if self.n <= self.ok else 3600.0


class FindRepairTests(TmpCase):
    def test_unreadable_dir_never_complete_never_absent(self):
        self.w("a.txt", "alpha\n")
        self.w("locked/z.txt", "zeta\n")
        d = os.path.join(self.root, "locked")
        os.chmod(d, 0)
        self.addCleanup(os.chmod, d, stat.S_IRWXU)
        if os.access(d, os.R_OK):
            self.skipTest("permissions not enforced")
        r = find(["zeta"], self.root, 1, self.roots)
        self.assertNotEqual((D(r)["complete"], "absent" in D(r)), (True, True))
        self.assertFalse(D(r)["complete"])
        self.assertNotIn("absent", D(r))
        self.assertGreaterEqual(D(r)["skipped"], 1)

    def test_deadline_checked_after_last_file(self):
        self.w("only.txt", "alpha\n")
        # clock calls: start, pre-file ok; anything later is past the deadline
        r = find(["alpha"], self.root, 3, self.roots, monotonic=Seq(2))
        assert_envelope(self, r, "find", 124)
        self.assertFalse(D(r)["complete"])
        self.assertNotIn("absent", D(r))

    def test_walk_order_bytewise_sorted_on_partial_scan(self):
        names = ["d%02d" % i for i in range(20)]
        for n in reversed(names):
            self.w("%s/x.txt" % n, "alpha\n")
        r = find(["alpha"], self.root, 50, self.roots, monotonic=Seq(2))
        self.assertEqual(r["rc"], 124)
        first = os.path.join(self.root, "d00", "x.txt")
        for h in D(r)["hits"]:
            self.assertIn(os.path.basename(os.path.dirname(h["path"])), ("d00",))
        self.assertLessEqual(D(r)["scanned"], 1)


class TailMemoryTests(TmpCase):
    def test_tail_bounded_memory_on_large_file(self):
        p = os.path.join(self.root, "big.log")
        line = b"x" * 99 + b"\n"
        with open(p, "wb") as f:
            for _ in range(240):
                f.write(line * 1000 * 1)  # 100 KB per write
        # 24 MB total, 240000 lines; no trailing partial line
        tracemalloc.start()
        try:
            r = tail(p, 3, self.roots)
            _cur, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        assert_envelope(self, r, "tail", 0)
        self.assertEqual(D(r)["line_count"], 240000)
        self.assertEqual(D(r)["byte_count"], 24_000_000)
        self.assertEqual(D(r)["lines"], ["x" * 99] * 3)
        self.assertLess(peak, 6 * 1024 * 1024)


class CliUsageTests(TmpCase):
    def setUp(self):
        super().setUp()
        self.f = self.w("f.txt", "a\nb\n")
        self.ar = ("--allow-root", self.root)

    def _one_envelope(self, argv, verb):
        rc, out, _ = run_cli(*argv, *self.ar)
        self.assertEqual(rc, 2, argv)
        self.assertEqual(out.count(b"\n"), 1, argv)
        obj = json.loads(out)
        assert_envelope(self, obj, verb, 2)
        return obj

    def test_missing_flags_emit_usage_envelope(self):
        self._one_envelope(["page"], "page")
        self._one_envelope(["tail", "--path", self.f], "tail")
        self._one_envelope(["census"], "census")

    def test_non_integer_flag_emits_usage_envelope(self):
        self._one_envelope(["page", "--path", self.f, "--from-line", "x"], "page")

    def test_unknown_flag_rejected(self):
        rc, out, _ = run_cli("page", "--path", self.f, "--from-line", "1",
                             "--bogus", "v", *self.ar)
        self.assertEqual(rc, 2)
        self._one_envelope(["page", "--path", self.f, "--from-line", "1",
                            "--bogus", "v"], "page")

    def test_duplicate_singleton_flag_rejected(self):
        self._one_envelope(["page", "--path", self.f, "--path", self.f,
                            "--from-line", "1"], "page")


if __name__ == "__main__":
    unittest.main()
