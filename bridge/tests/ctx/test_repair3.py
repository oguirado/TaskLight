"""Repair loop 3 regression tests (Sol HOLD, DISP_03 BLOCKING items only)."""
import json
import os
import unittest
from unittest import mock

import subprocess
from bridge.ctx.page import page
from bridge.ctx.paths import Roots
from bridge.ctx.state import state
from .helpers import HAVE_GIT, TmpCase, D, git


def _mkrepo(path, branch="main", content="one\n", msg="c1"):
    os.makedirs(path, exist_ok=True)
    git(path, "init", "-q", "-b", branch)
    with open(os.path.join(path, "tracked.txt"), "w") as fh:
        fh.write(content)
    git(path, "add", ".")
    git(path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg)
    return git(path, "rev-parse", "HEAD")


@unittest.skipUnless(HAVE_GIT, "git binary not found on PATH")
class GitMetadataConfinementTests(TmpCase):
    def _ext(self):
        ext = os.path.join(self.outside, "extrepo")
        head = _mkrepo(ext, branch="outsidebranch", content="EXT\n", msg="ext")
        return ext, head

    def _assert_no_outside(self, r, head):
        blob = json.dumps(r)
        self.assertNotIn(head, blob)
        self.assertNotIn("outsidebranch", blob)

    def test_gitfile_pointing_outside_not_followed(self):
        ext, head = self._ext()
        d = os.path.join(self.root, "proj")
        os.mkdir(d)
        with open(os.path.join(d, ".git"), "w") as fh:
            fh.write("gitdir: %s\n" % os.path.join(ext, ".git"))
        r = state(d, self.roots)
        self._assert_no_outside(r, head)
        self.assertNotEqual(r["rc"], 0)

    def test_gitfile_relative_escape_not_followed(self):
        ext, head = self._ext()
        d = os.path.join(self.root, "proj")
        os.mkdir(d)
        rel = os.path.relpath(os.path.join(ext, ".git"), d)
        with open(os.path.join(d, ".git"), "w") as fh:
            fh.write("gitdir: %s\n" % rel)
        r = state(d, self.roots)
        self._assert_no_outside(r, head)
        self.assertNotEqual(r["rc"], 0)

    def test_core_worktree_outside_ignored(self):
        repo = os.path.join(self.root, "repo")
        _mkrepo(repo)
        wt = os.path.join(self.outside, "wt")
        os.mkdir(wt)                       # empty: if followed, tracked.txt looks deleted
        git(repo, "config", "core.worktree", wt)
        r = state(repo, self.roots)
        # either rejected, or answered from the in-root tree (clean => dirty 0)
        if r["rc"] == 0:
            self.assertEqual(D(r)["facts"]["dirty"], 0)
        else:
            self.assertIn(r["rc"], (2, 7, 124))

    def test_config_include_outside_ignored(self):
        repo = os.path.join(self.root, "repo")
        _mkrepo(repo)
        wt = os.path.join(self.outside, "wt")
        os.mkdir(wt)
        inc = self.w("inc.cfg", "[core]\n\tworktree = %s\n" % wt, base=self.outside)
        with open(os.path.join(repo, ".git", "config"), "a") as fh:
            fh.write("[include]\n\tpath = %s\n" % inc)
        r = state(repo, self.roots)
        if r["rc"] == 0:
            self.assertEqual(D(r)["facts"]["dirty"], 0)
        else:
            self.assertIn(r["rc"], (2, 7, 124))

    def test_global_and_system_config_not_consulted(self):
        repo = os.path.join(self.root, "repo")
        _mkrepo(repo)
        wt = os.path.join(self.outside, "wt")
        os.mkdir(wt)
        gcfg = self.w("gitconfig", "[core]\n\tworktree = %s\n" % wt, base=self.outside)
        with mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": gcfg, "HOME": self.outside,
                                          "XDG_CONFIG_HOME": self.outside,
                                          "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.worktree",
                                          "GIT_CONFIG_VALUE_0": wt}):
            r = state(repo, self.roots)
        if r["rc"] == 0:
            self.assertEqual(D(r)["facts"]["dirty"], 0)


@unittest.skipUnless(HAVE_GIT, "git binary not found on PATH")
class GitNoExecutionTests(TmpCase):
    def test_clean_filter_not_executed(self):
        repo = os.path.join(self.root, "repo")
        _mkrepo(repo, content="aaaa\n")
        marker = os.path.join(self.outside, "FILTER_MARKER")
        with open(os.path.join(repo, ".gitattributes"), "w") as fh:
            fh.write("*.txt filter=probe\n")
        git(repo, "config", "filter.probe.clean", "sh -c 'echo x > \"%s\"; cat'" % marker)
        git(repo, "config", "filter.probe.smudge", "sh -c 'echo x > \"%s\"; cat'" % marker)
        git(repo, "config", "filter.probe.process", "sh -c 'echo x > \"%s\"'" % marker)
        t = os.path.join(repo, "tracked.txt")
        with open(t, "w") as fh:
            fh.write("bbbb\n")             # same size, content changed
        os.utime(t, (1_000_000_000, 1_000_000_000))
        r = state(repo, self.roots)
        self.assertFalse(os.path.exists(marker), "clean/smudge filter executed by state")
        self.assertIn(r["rc"], (0, 2, 7, 124))

    def test_info_attributes_filter_not_executed(self):
        repo = os.path.join(self.root, "repo")
        _mkrepo(repo, content="aaaa\n")
        marker = os.path.join(self.outside, "FILTER_MARKER2")
        with open(os.path.join(repo, ".git", "info", "attributes"), "w") as fh:
            fh.write("* filter=probe\n")
        git(repo, "config", "filter.probe.clean", "sh -c 'echo x > \"%s\"; cat'" % marker)
        t = os.path.join(repo, "tracked.txt")
        with open(t, "w") as fh:
            fh.write("bbbb\n")
        os.utime(t, (1_000_000_000, 1_000_000_000))
        state(repo, self.roots)
        self.assertFalse(os.path.exists(marker), "clean filter executed via info/attributes")

    def test_hooks_and_fsmonitor_not_executed(self):
        repo = os.path.join(self.root, "repo")
        _mkrepo(repo)
        marker = os.path.join(self.outside, "HOOK_MARKER")
        script = "#!/bin/sh\necho x >> '%s'\nprintf '\\0'\n" % marker
        for name in ("post-index-change", "fsmonitor-watchman", "pre-commit", "post-checkout"):
            p = os.path.join(repo, ".git", "hooks", name)
            with open(p, "w") as fh:
                fh.write(script)
            os.chmod(p, 0o755)
        git(repo, "config", "core.fsmonitor", os.path.join(repo, ".git", "hooks", "fsmonitor-watchman"))
        git(repo, "config", "core.hooksPath", os.path.join(repo, ".git", "hooks"))
        t = os.path.join(repo, "tracked.txt")
        os.utime(t, (1_000_000_000, 1_000_000_000))
        state(repo, self.roots)
        self.assertFalse(os.path.exists(marker), "hook or fsmonitor executed by state")


class _SwapAncestorRoots(Roots):
    """Approves a path, then replaces `victim` (an ancestor of the root or of the
    target) with a symlink to `outside_target`."""
    def __init__(self, roots, victim, outside_target):
        super().__init__(roots)
        self.victim, self.outside_target, self.done = victim, outside_target, False

    def resolve(self, p):
        r = super().resolve(p)
        if r is not None and not self.done:
            self.done = True
            os.rename(self.victim, self.victim + "_moved")
            os.symlink(self.outside_target, self.victim)
        return r


class RootAncestorRaceTests(TmpCase):
    def _layout(self):
        parent = os.path.join(self.base, "PARENT")
        root = os.path.join(parent, "ROOT")
        os.makedirs(root)
        self.w("f.txt", "innocent\n", base=root)
        ext_parent = os.path.join(self.outside, "EXTPARENT")
        self.w("ROOT/f.txt", "TOPSECRETLINE\n", base=ext_parent)
        return parent, root, ext_parent

    def test_page_root_ancestor_replaced(self):
        parent, root, ext_parent = self._layout()
        roots = _SwapAncestorRoots((root,), parent, ext_parent)
        r = page(os.path.join(root, "f.txt"), 1, roots)
        self.assertNotIn("TOPSECRETLINE", json.dumps(r))

    def test_tail_root_ancestor_replaced(self):
        from bridge.ctx.tail import tail
        parent, root, ext_parent = self._layout()
        roots = _SwapAncestorRoots((root,), parent, ext_parent)
        r = tail(os.path.join(root, "f.txt"), 5, roots)
        self.assertNotIn("TOPSECRETLINE", json.dumps(r))

    @unittest.skipUnless(HAVE_GIT, "git binary not found on PATH")
    def test_state_root_ancestor_replaced(self):
        parent = os.path.join(self.base, "PARENT")
        root = os.path.join(parent, "ROOT")
        os.makedirs(root)
        _mkrepo(os.path.join(root, "repo"), content="IN\n", msg="in")
        ext_parent = os.path.join(self.outside, "EXTPARENT")
        ext_head = _mkrepo(os.path.join(ext_parent, "ROOT", "repo"), branch="outsidebranch",
                           content="EXT\n", msg="ext")
        roots = _SwapAncestorRoots((root,), parent, ext_parent)
        r = state(os.path.join(root, "repo"), roots)
        blob = json.dumps(r)
        self.assertNotIn(ext_head, blob)
        self.assertNotIn("outsidebranch", blob)


@unittest.skipUnless(HAVE_GIT, "git binary not found on PATH")
class GitWorkingDirectoryRaceTests(TmpCase):
    def _run_with_swap(self, victim, roots, target):
        real_run = subprocess.run
        done = {"v": False}

        def swapping_run(*a, **kw):
            if not done["v"]:
                done["v"] = True
                self.swap()
            return real_run(*a, **kw)
        with mock.patch("subprocess.run", swapping_run):
            return state(target, roots)

    def test_repo_dir_replaced_between_validation_and_git(self):
        repo = os.path.join(self.root, "repo")
        _mkrepo(repo, content="IN\n", msg="in")
        ext = os.path.join(self.outside, "extrepo")
        ext_head = _mkrepo(ext, branch="outsidebranch", content="EXT\n", msg="ext")

        def swap():
            os.rename(repo, repo + "_moved")
            os.symlink(ext, repo)
        self.swap = swap
        r = self._run_with_swap(repo, self.roots, repo)
        blob = json.dumps(r)
        self.assertNotIn(ext_head, blob)
        self.assertNotIn("outsidebranch", blob)

    def test_root_ancestor_replaced_between_validation_and_git(self):
        parent = os.path.join(self.base, "PARENT")
        root = os.path.join(parent, "ROOT")
        os.makedirs(root)
        repo = os.path.join(root, "repo")
        _mkrepo(repo, content="IN\n", msg="in")
        ext_parent = os.path.join(self.outside, "EXTPARENT")
        ext_head = _mkrepo(os.path.join(ext_parent, "ROOT", "repo"), branch="outsidebranch",
                           content="EXT\n", msg="ext")
        roots = Roots((root,))

        def swap():
            os.rename(parent, parent + "_moved")
            os.symlink(ext_parent, parent)
        self.swap = swap
        r = self._run_with_swap(parent, roots, repo)
        blob = json.dumps(r)
        self.assertNotIn(ext_head, blob)
        self.assertNotIn("outsidebranch", blob)


class FilesystemRootTests(unittest.TestCase):
    def test_slash_root_accepts_descendants(self):
        p = "/etc/hostname"
        if not os.path.exists(p) or any(os.path.islink(x) for x in ("/etc", p)):
            self.skipTest("host layout")
        self.assertEqual(Roots(("/",)).resolve(p), p)
        self.assertEqual(Roots(("/",)).resolve("/etc"), "/etc")


if __name__ == "__main__":
    unittest.main()
