import os
import unittest
from unittest import mock

from bridge.ctx.state import state
from .helpers import HAVE_GIT, TmpCase, assert_envelope, clk_tck, D, git, make_proc


@unittest.skipUnless(HAVE_GIT, "git binary not found on PATH")
class StateGitTests(TmpCase):
    def mkrepo(self):
        repo = os.path.join(self.root, "repo")
        os.mkdir(repo)
        git(repo, "init", "-q", "-b", "main")
        self.w("repo/tracked.txt", "one\n")
        self.w("repo/other.txt", "o\n")
        git(repo, "add", ".")
        git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "c1")
        return repo

    def test_P9_git_facts(self):
        repo = self.mkrepo()
        self.w("repo/tracked.txt", "two\n")      # tracked edit
        self.w("repo/untracked.txt", "u\n")       # must not count
        r = state(repo, self.roots)
        assert_envelope(self, r, "state", 0)
        f = D(r)["facts"]
        self.assertEqual(set(f), {"kind", "branch", "head", "dirty"})
        self.assertEqual(f["kind"], "git")
        self.assertEqual(f["branch"], "main")
        self.assertRegex(f["head"], r"^[0-9a-f]{40}$")
        self.assertEqual(f["head"], git(repo, "rev-parse", "HEAD"))
        self.assertEqual(f["dirty"], 1)
        self.assertIs(type(f["dirty"]), int)

    def test_clean_repo_dirty_zero(self):
        repo = self.mkrepo()
        self.w("repo/untracked.txt", "u\n")
        self.assertEqual(D(state(repo, self.roots))["facts"]["dirty"], 0)

    def test_staged_and_unstaged_both_count(self):
        repo = self.mkrepo()
        self.w("repo/tracked.txt", "two\n")
        git(repo, "add", "tracked.txt")
        self.w("repo/other.txt", "changed\n")
        self.assertEqual(D(state(repo, self.roots))["facts"]["dirty"], 2)

    def test_detached_branch_empty(self):
        repo = self.mkrepo()
        git(repo, "checkout", "-q", "--detach")
        f = D(state(repo, self.roots))["facts"]
        self.assertEqual(f["branch"], "")
        self.assertRegex(f["head"], r"^[0-9a-f]{40}$")

    def test_plain_dir_is_absent(self):
        d = os.path.join(self.root, "plain")
        os.mkdir(d)
        assert_envelope(self, state(d, self.roots), "state", 7)

    def test_deterministic(self):
        repo = self.mkrepo()
        self.assertEqual(state(repo, self.roots), state(repo, self.roots))


class StateGitDegradedTests(TmpCase):
    def test_git_missing_is_124(self):
        d = os.path.join(self.root, "fakerepo")
        os.makedirs(os.path.join(d, ".git"))
        empty = os.path.join(self.base, "emptybin")
        os.mkdir(empty)
        with mock.patch.dict(os.environ, {"PATH": empty}):
            r = state(d, self.roots)
        assert_envelope(self, r, "state", 124)

    def test_outside_root(self):
        os.makedirs(os.path.join(self.outside, ".git"))
        self.assertEqual(state(self.outside, self.roots)["rc"], 2)


class StatePidTests(TmpCase):
    def setUp(self):
        super().setUp()
        self.proc = os.path.join(self.base, "proc")
        os.mkdir(self.proc)

    def st(self, target, now_s=None):
        return state(target, self.roots, proc_root=self.proc, now_s=now_s)

    def test_P10_pid_facts(self):
        make_proc(self.proc, 42, starttime_ticks=5000 * clk_tck(), rss_kib=2048)
        r = self.st("pid:42", now_s=5123)
        assert_envelope(self, r, "state", 0)
        f = D(r)["facts"]
        self.assertEqual(set(f), {"kind", "alive", "rss_kib", "runtime_s"})
        self.assertEqual(f["kind"], "pid")
        self.assertIs(f["alive"], True)
        self.assertEqual(f["rss_kib"], 2048)
        self.assertIs(type(f["rss_kib"]), int)
        self.assertEqual(f["runtime_s"], 123)
        self.assertIs(type(f["runtime_s"]), int)

    def test_P10_absent_pid(self):
        make_proc(self.proc, 42)
        assert_envelope(self, self.st("pid:43", now_s=10), "state", 7)

    def test_comm_with_parens_and_spaces(self):
        make_proc(self.proc, 7, comm="my (weird) proc", starttime_ticks=100 * clk_tck(), rss_kib=17)
        f = D(self.st("pid:7", now_s=160))["facts"]
        self.assertEqual((f["runtime_s"], f["rss_kib"]), (60, 17))

    def test_runtime_follows_injected_clock(self):
        make_proc(self.proc, 5, starttime_ticks=10 * clk_tck())
        a = D(self.st("pid:5", now_s=20))["facts"]["runtime_s"]
        b = D(self.st("pid:5", now_s=1020))["facts"]["runtime_s"]
        self.assertEqual((a, b), (10, 1010))

    def test_bad_targets(self):
        for t in ("pid:abc", "pid:-1", "pid:", "", "pid:4 2", "nonsense"):
            self.assertEqual(self.st(t, now_s=1)["rc"], 2, repr(t))

    def test_facts_flat_scalars(self):
        make_proc(self.proc, 42)
        for v in D(self.st("pid:42", now_s=9))["facts"].values():
            self.assertIn(type(v), (str, int, bool))

    def test_deterministic(self):
        make_proc(self.proc, 42, starttime_ticks=7 * clk_tck())
        self.assertEqual(self.st("pid:42", now_s=99), self.st("pid:42", now_s=99))


if __name__ == "__main__":
    unittest.main()
