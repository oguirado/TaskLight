"""M6/A5 amended direct exporter: path attacks, staging, fd races, rollback."""
import errno
import os
import stat
from pathlib import Path
from unittest.mock import patch

from bridge.plan.fold import fold_plan
from bridge.plan.markdown import render_memory_md, render_plan_md
from bridge.room import store
from bridge.room.ext import export
from .support import Case, file_export, history_events, memory_event, tree


from bridge.tests.xplat_support import windows_filesystem


class FileExport(Case):
    def expected(self):
        projection = fold_plan(store.read("demo")[0])
        return {"PLAN.md": render_plan_md(projection).encode("utf-8"),
                "MEMORY.md": render_memory_md(projection).encode("utf-8")}

    def old_outputs(self):
        target = self.home / "exports"
        target.mkdir()
        for name in ("PLAN.md", "MEMORY.md"):
            (target / name).write_bytes(("old " + name).encode())
        return target

    def test_windows_export_writes_under_home_and_refuses_junction(self):
        self.seed()
        target = self.home / "exports"
        with windows_filesystem():
            file_export("demo", "exports")
        for name, data in self.expected().items():
            self.assertEqual((target / name).read_bytes(), data)
        before = tree(self.tmp)
        with windows_filesystem(target):
            self.assert_file_error("bad_args", "exports/child")
        with windows_filesystem(target / "PLAN.md"):
            self.assert_file_error("bad_args", "exports")
        self.assertEqual(tree(self.tmp), before)

    def test_windows_snapshot_reads_under_canonical_home(self):
        self.seed()
        expected = store.read("demo")[0]
        alias = self.home.with_name("HOME~1")
        with patch.dict(os.environ, CW_HOME=str(alias)):
            with windows_filesystem(alias=(alias, self.home)):
                self.assertEqual(export._read_snapshot("demo"), (expected, expected))
            with windows_filesystem(alias, alias=(alias, self.home)):
                with self.assertRaises(store.RoomError) as exc:
                    export._read_snapshot("demo")
                self.assertEqual(exc.exception.code, "export_failed")

    def test_windows_export_uses_canonical_home_for_absolute_destination(self):
        self.seed()
        alias = self.home.with_name("HOME~1")
        target = self.home / "exports"
        with patch.dict(os.environ, CW_HOME=str(alias)), patch.object(export, "_read_snapshot", return_value=([], [])):
            with windows_filesystem(alias=(alias, self.home)):
                file_export("demo", str(target))
            before = tree(self.tmp)
            with windows_filesystem(alias, alias=(alias, self.home)):
                self.assert_file_error("bad_args", str(target))
            self.assertEqual(tree(self.tmp), before)
        self.assertTrue((target / "PLAN.md").is_file())
        self.assertFalse(alias.exists())

    def test_windows_export_refuses_reparse_journal(self):
        journal = self.seed()
        before = tree(self.tmp)
        with windows_filesystem(journal):
            self.assert_file_error("export_failed", "exports")
        self.assertEqual(tree(self.tmp), before)

    def test_a5_relative_destination_writes_only_both_exact_documents(self):
        journal = self.seed(history_events() + [memory_event(13, "café ✓\n第二行", 0, section="utf8")])
        original = journal.read_bytes()
        expected = self.expected()
        file_export("demo", "rooms/demo")
        target = self.home / "rooms/demo"
        self.assertEqual({p.name for p in target.iterdir()}, {"events.jsonl", "PLAN.md", "MEMORY.md"})
        for name, content in expected.items():
            self.assertEqual((target / name).read_bytes(), content)
        self.assertEqual(journal.read_bytes(), original)

    def test_a5_absolute_inside_home(self):
        self.seed()
        target = self.home / "nested/export"
        file_export("demo", str(target))
        self.assertEqual({p.name for p in target.iterdir()}, {"PLAN.md", "MEMORY.md"})
        for name, content in self.expected().items():
            self.assertEqual((target / name).read_bytes(), content)

    def test_m6_dot_is_home_and_fallback_home_matches_store_semantics(self):
        # Empty is forbidden by Amendment B; '.' has no forbidden component.
        self.seed()
        expected = self.expected()
        file_export("demo", ".")
        for name, content in expected.items():
            self.assertEqual((self.home / name).read_bytes(), content)
        with patch.dict(os.environ, {"CW_HOME": ""}):
            expected_home = Path(os.environ["HOME"]) / ".context-wall"
            self.assertEqual(Path(store._home(None)), expected_home)
            expected_home.mkdir(parents=True)
            file_export("demo", "exports")
            self.assertEqual((expected_home / "exports/PLAN.md").read_text(), render_plan_md(fold_plan([])))
            self.assertEqual((expected_home / "exports/MEMORY.md").read_text(), render_memory_md(fold_plan([])))
            self.assertFalse((expected_home / "rooms/demo").exists())

    def test_m6_file_export_empty_room_does_not_create_journal(self):
        file_export("demo", "exports")
        self.assertFalse((self.home / "rooms/demo").exists())
        expected = self.expected()
        for name, content in expected.items():
            self.assertEqual((self.home / "exports" / name).read_bytes(), content)

    def test_m6_files_share_one_captured_prefix(self):
        self.seed()
        with patch.object(store, "read", wraps=store.read) as reader:
            file_export("demo", "exports")
        self.assertEqual(reader.call_count, 1)

    def test_a5_empty_nul_traversal_and_outside_prefix_sibling_rejected(self):
        self.seed()
        sibling = self.tmp / "home-other"
        sibling.mkdir()
        (sibling / "PLAN.md").write_text("do not replace")
        for out in ("", "bad\x00name", "..", "exports/../escape", str(self.home / "../escape"), str(sibling)):
            with self.subTest(out=out):
                before = tree(self.tmp)
                self.assert_file_error("bad_args", out)
                self.assertEqual(tree(self.tmp), before)

    def test_a5_symlink_destination_or_ancestor_rejected_even_inside_home(self):
        self.seed()
        for link_points_inside in (False, True):
            target = (self.home if link_points_inside else self.tmp) / ("inside" if link_points_inside else "outside")
            target.mkdir()
            link = self.home / ("link-in" if link_points_inside else "link-out")
            link.symlink_to(target, target_is_directory=True)
            for out in (str(link), str(link / "nested")):
                with self.subTest(inside=link_points_inside, out=out):
                    before = tree(self.tmp)
                    self.assert_file_error("bad_args", out)
                    self.assertEqual(tree(self.tmp), before)

    def test_a5_symlink_output_files_rejected_before_any_replacement(self):
        self.seed()
        for name in ("PLAN.md", "MEMORY.md"):
            with self.subTest(name=name):
                target = self.home / ("link-" + name)
                target.mkdir()
                outside = self.tmp / ("outside-" + name)
                outside.write_text("keep")
                (target / name).symlink_to(outside)
                other = "MEMORY.md" if name == "PLAN.md" else "PLAN.md"
                (target / other).write_text("old")
                before = tree(self.tmp)
                self.assert_file_error("bad_args", str(target))
                self.assertEqual(tree(self.tmp), before)

    def test_a5_directory_and_fifo_outputs_rejected_without_opening_or_writing(self):
        self.seed()
        for name in ("PLAN.md", "MEMORY.md"):
            for kind in ("directory", "fifo"):
                with self.subTest(name=name, kind=kind):
                    target = self.home / (name + "-" + kind)
                    target.mkdir()
                    output = target / name
                    output.mkdir() if kind == "directory" else os.mkfifo(output)
                    other = "MEMORY.md" if name == "PLAN.md" else "PLAN.md"
                    (target / other).write_text("old")
                    before = tree(self.tmp)
                    self.assert_file_error("bad_args", str(target))
                    self.assertEqual(tree(self.tmp), before)

    def test_a5_staging_failure_export_failed_and_preserves_old_files_and_journal(self):
        self.seed()
        target = self.old_outputs()
        before = tree(self.tmp)
        real_open = os.open

        def fail_write(path, flags, *args, **kwargs):
            if flags & os.O_CREAT and flags & (os.O_WRONLY | os.O_RDWR):
                raise OSError(errno.ENOSPC, "injected staging failure")
            return real_open(path, flags, *args, **kwargs)

        with patch.object(os, "open", side_effect=fail_write):
            self.assert_file_error("export_failed", str(target))
        after = tree(self.tmp)
        for path in ("home/exports/PLAN.md", "home/exports/MEMORY.md", "home/rooms/demo/events.jsonl"):
            self.assertEqual(after[path], before[path])

    def test_m6_walks_directories_without_following_links(self):
        self.seed()
        real_open = os.open
        records = []

        def observe(path, flags, *args, **kwargs):
            records.append((flags, kwargs.get("dir_fd")))
            return real_open(path, flags, *args, **kwargs)

        with patch.object(os, "open", side_effect=observe):
            file_export("demo", "nested/export")
        # Amendment B explicitly mandates O_DIRECTORY|O_NOFOLLOW fd traversal.
        self.assertTrue(any(flags & os.O_DIRECTORY and flags & os.O_NOFOLLOW and fd is not None
                            for flags, fd in records))

    def test_m6_staging_creation_is_fd_relative_and_resists_symlink_substitution(self):
        self.seed()
        real_open = os.open
        creations = []

        def observe(path, flags, *args, **kwargs):
            if flags & os.O_CREAT and flags & (os.O_WRONLY | os.O_RDWR):
                self.assertIsInstance(kwargs.get("dir_fd"), int)
                self.assertFalse(os.path.isabs(path))
                self.assertTrue(flags & (os.O_NOFOLLOW | os.O_EXCL))
                creations.append(path)
            return real_open(path, flags, *args, **kwargs)

        with patch.object(os, "open", side_effect=observe):
            file_export("demo", "exports")
        self.assertGreaterEqual(len(creations), 2)

    def test_m6_both_documents_staged_before_first_fd_scoped_replacement(self):
        self.seed()
        expected = self.expected()
        target = self.old_outputs()
        real_replace, real_open = os.replace, os.open
        replacements = []

        def replace(src, dst, *args, **kwargs):
            if Path(dst).name in expected:
                self.assertIsInstance(kwargs.get("src_dir_fd"), int)
                self.assertIsInstance(kwargs.get("dst_dir_fd"), int)
                if not replacements:
                    contents = []
                    fd = kwargs["src_dir_fd"]
                    for name in os.listdir(fd):
                        if not stat.S_ISREG(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode):
                            continue
                        with os.fdopen(real_open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd), "rb") as f:
                            contents.append(f.read())
                    for content in expected.values():
                        self.assertIn(content, contents)
                replacements.append(Path(dst).name)
            return real_replace(src, dst, *args, **kwargs)

        with patch.object(os, "replace", side_effect=replace):
            file_export("demo", str(target))
        self.assertEqual(set(replacements), set(expected))

    def test_m6_second_replace_failure_attempts_rollback_and_reports_export_failed(self):
        self.seed()
        target = self.old_outputs()
        before = tree(self.tmp)
        real_replace = os.replace
        count = 0

        def fail_second(src, dst, *args, **kwargs):
            nonlocal count
            if Path(dst).name in ("PLAN.md", "MEMORY.md"):
                count += 1
                if count == 2:
                    raise OSError(errno.ENOSPC, "injected second replacement failure")
            return real_replace(src, dst, *args, **kwargs)

        with patch.object(os, "replace", side_effect=fail_second):
            self.assert_file_error("export_failed", str(target))
        self.assertGreaterEqual(count, 2)
        # Fault is transient; a best-effort rollback can succeed in this fixture.
        after = tree(self.tmp)
        for path in ("home/exports/PLAN.md", "home/exports/MEMORY.md", "home/rooms/demo/events.jsonl"):
            self.assertEqual(after[path], before[path])

    def test_m6_parent_swap_before_replace_cannot_modify_outside_root(self):
        self.seed()
        target = self.old_outputs()
        moved = self.home / "pinned-original"
        outside = self.tmp / "outside"
        outside.mkdir()
        for name in ("PLAN.md", "MEMORY.md"):
            (outside / name).write_text("outside must remain unchanged")
        before_outside = tree(outside)
        journal = (self.home / "rooms/demo/events.jsonl").read_bytes()
        real_replace = os.replace
        swapped = False

        def swap_parent(src, dst, *args, **kwargs):
            nonlocal swapped
            if not swapped and Path(dst).name in ("PLAN.md", "MEMORY.md"):
                swapped = True
                target.rename(moved)
                target.symlink_to(outside, target_is_directory=True)
            return real_replace(src, dst, *args, **kwargs)

        with patch.object(os, "replace", side_effect=swap_parent):
            try:
                result = file_export("demo", str(target))
            except store.RoomError as exc:
                self.assertIn(exc.code, ("bad_args", "export_failed"))
            else:
                if isinstance(result, dict) and "code" in result:
                    self.assertIn(result["code"], ("bad_args", "export_failed"))
        self.assertTrue(swapped, "race injection must execute")
        self.assertEqual(tree(outside), before_outside)
        self.assertEqual((self.home / "rooms/demo/events.jsonl").read_bytes(), journal)
