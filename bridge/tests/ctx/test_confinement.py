import ctypes
import os
import sys
import unittest
from ctypes import wintypes
from unittest.mock import Mock, patch

from bridge.ctx import _windows
from bridge.ctx.paths import Roots
from bridge.ctx.page import page
from bridge.ctx.find import find
from bridge.ctx.census import census
from bridge.ctx.check import check
from bridge.ctx.tail import tail
from bridge.ctx.state import state
from .helpers import ReadSpy, TmpCase, assert_envelope, canon, clk_tck, make_proc


from bridge.tests.xplat_support import windows_filesystem


class WindowsConfinement(TmpCase):
    def test_windows_resolve_returns_canonical_root_and_child(self):
        visible = self.w("folder/plain.txt", "visible\n")
        alias = os.path.join(self.base, "ROOT~1")
        alternate_file = os.path.join(alias, "folder", "plain.txt")
        with windows_filesystem(alias=(alias, self.root)):
            roots = Roots((alias,))
            self.assertEqual(roots.roots, (self.root,))
            self.assertEqual(roots.resolve(alternate_file), visible)
            missing = os.path.join(alias, "missing", "file.txt")
            self.assertEqual(roots.resolve(missing), os.path.join(self.root, "missing", "file.txt"))
        with windows_filesystem(alias, alias=(alias, self.root)):
            self.assertIsNone(Roots((alias,)).resolve(visible))
        with windows_filesystem(os.path.dirname(alternate_file), alias=(alias, self.root)):
            self.assertIsNone(Roots((alias,)).resolve(alternate_file))

    def test_windows_directory_handle_reads_attributes_and_shares_writes(self):
        create = Mock(return_value=123)
        close = Mock()

        def attributes(_handle, _kind, info, _size):
            info[0] = 0x10  # FILE_ATTRIBUTE_DIRECTORY
            return True

        bindings = {
            "CreateFileW": create, "CloseHandle": close,
            "GetDriveTypeW": Mock(return_value=3),
            "GetFileInformationByHandleEx": attributes,
        }
        with patch.object(_windows, "_kernel", return_value=(ctypes, wintypes, lambda name, *_: bindings[name])):
            with patch.dict(sys.modules, msvcrt=Mock()):
                with _windows.open_handle(self.root, directory=True) as handle:
                    self.assertIsNone(handle)
        self.assertEqual(create.call_args.args[:3], (self.root, 0x80, 3))
        close.assert_called_once_with(123)

    def test_windows_context_reads_and_skips_junction(self):
        visible = self.w("plain.txt", "visible\n")
        hidden = self.w("junction/hidden.txt", "hidden\n")
        junction = os.path.dirname(hidden)
        with windows_filesystem(junction):
            self.assertIsNone(self.roots.resolve(hidden))
            self.assertEqual(page(visible, 1, self.roots)["data"]["lines"], ["visible"])
            self.assertEqual(tail(visible, 1, self.roots)["data"]["lines"], ["visible"])
            self.assertEqual(find(["visible", "hidden"], self.root, 5, self.roots)
                             ["data"]["absent"], ["hidden"])
            self.assertEqual(census(self.root, self.roots)["data"]["files"], 1)

    def test_windows_git_state_refuses_unpinned_subprocess(self):
        with windows_filesystem():
            result = state(self.root, self.roots)
        self.assertEqual(result["rc"], 7)
        self.assertIn("confinement", result["data"]["error"])
        self.assertTrue(check(canon(result))["data"]["valid"])

    def test_windows_pid_state_rejects_invalid_pid(self):
        with windows_filesystem(), patch.object(sys, "platform", "win32"):
            result = state("pid:abc", self.roots)
        assert_envelope(self, result, "state", 2)
        self.assertEqual(result["data"], {"facts": {}})

    def test_windows_pid_state_reports_unavailable_default_procfs(self):
        with windows_filesystem(), patch.object(sys, "platform", "win32"):
            result = state("pid:1234", self.roots)
        assert_envelope(self, result, "state", 7)
        self.assertEqual(result["data"], {"facts": {}, "capability": "procfs_unavailable"})

    def test_windows_pid_state_reads_explicit_proc_root(self):
        proc = os.path.join(self.base, "proc")
        make_proc(proc, 1234, starttime_ticks=10 * clk_tck(), rss_kib=17)
        with windows_filesystem(), patch.object(sys, "platform", "win32"):
            result = state("pid:1234", self.roots, proc_root=proc, now_s=30)
        assert_envelope(self, result, "state", 0)
        self.assertEqual(result["data"], {
            "facts": {"kind": "pid", "alive": True, "rss_kib": 17, "runtime_s": 20}
        })

    def test_windows_git_state_rejects_unconfined_targets(self):
        junction = os.path.join(self.root, "junction")
        os.mkdir(junction)
        with windows_filesystem(junction), patch.object(sys, "platform", "win32"):
            for target in ("", self.outside, junction):
                with self.subTest(target=target):
                    result = state(target, self.roots)
                    assert_envelope(self, result, "state", 2)
                    self.assertEqual(result["data"], {"facts": {}})


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
