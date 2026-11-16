"""Regressions for accepted history, output substitution, and I/O errors."""
import errno
import os
import stat
from unittest.mock import patch

from bridge.plan.fold import fold_plan
from bridge.room import store
from bridge.room.ext import export
from .support import BASE_TS, Case, memory_event, tree


class RepairHistory(Case):
    def test_same_lamport_rejected_event_cannot_supply_accepted_metadata(self):
        rejected = memory_event(3, "rejected poison", 99, by="eve")
        rejected["id"] = "e-0000000000000001"
        accepted = memory_event(3, "accepted", 0, by="alice")
        accepted["id"] = "e-0000000000000002"
        accepted["ts"] = BASE_TS + 30
        journal = self.seed([accepted, rejected])
        original = journal.read_bytes()
        events, malformed = store.read("demo")
        self.assertEqual(malformed, 0)
        projection = fold_plan(events)
        self.assertEqual(projection["rejected"][0]["id"], rejected["id"])
        self.assertEqual(projection["memory"]["goal"]["text"], "accepted")
        self.assertEqual(self.history(), {"section": "goal", "versions": [
            {"rev": 3, "by": "alice", "ts": accepted["ts"], "text": "accepted"},
        ]})
        self.assertEqual(journal.read_bytes(), original)

    def test_same_lamport_accepted_events_keep_their_own_metadata(self):
        first = memory_event(3, "first", 0, by="alice")
        first["id"] = "e-0000000000000001"
        second = memory_event(3, "second", 3, by="bob")
        second["id"] = "e-0000000000000002"
        second["ts"] += 1
        self.seed([second, first])
        expected = [dict(rev=3, by=e["agent"], ts=e["ts"], text=e["op"]["text"])
                    for e in (second, first)]
        self.assertEqual(self.history()["versions"], expected)
        self.assertEqual(self.history(limit=1)["versions"], expected[:1])


    def test_limited_history_folds_the_captured_prefix_only_once(self):
        self.seed()
        with patch.object(export, "fold_plan", wraps=fold_plan) as fold:
            self.assertEqual(self.history(limit=1)["versions"], [
                {"rev": 9, "by": "carol", "ts": BASE_TS + 9, "text": ""},
            ])
        self.assertEqual(fold.call_count, 1)


class RepairFileExport(Case):
    def old_outputs(self):
        target = self.home / "exports"
        target.mkdir()
        for name in ("PLAN.md", "MEMORY.md"):
            (target / name).write_text("old " + name)
        return target

    def assert_room_error(self, code, function, *args):
        with self.assertRaises(store.RoomError) as raised:
            function(*args)
        self.assertEqual(raised.exception.code, code)

    def test_fifo_swapped_after_stat_is_opened_without_blocking_and_rejected(self):
        self.seed()
        target = self.old_outputs()
        real_open = os.open
        real_read = os.read
        swapped = []
        fifo_fds = set()

        def swap(path, flags, *args, **kwargs):
            if path == "PLAN.md" and kwargs.get("dir_fd") is not None:
                (target / "PLAN.md").unlink()
                os.mkfifo(target / "PLAN.md")
                swapped.append(path)
                # Fail fast on the old implementation rather than hanging.
                self.assertTrue(flags & os.O_NONBLOCK, "FIFO race must not block")
                self.assertTrue(flags & os.O_NOFOLLOW)
                fd = real_open(path, flags, *args, **kwargs)
                self.assertTrue(stat.S_ISFIFO(os.fstat(fd).st_mode))
                fifo_fds.add(fd)
                return fd
            return real_open(path, flags, *args, **kwargs)

        def read(fd, size):
            self.assertNotIn(fd, fifo_fds, "non-regular output must be rejected before read")
            return real_read(fd, size)

        journal = (self.home / "rooms/demo/events.jsonl").read_bytes()
        with patch.object(os, "open", side_effect=swap), patch.object(os, "read", side_effect=read):
            self.assert_room_error("bad_args", export.export_room, "demo", "exports")
        self.assertEqual(swapped, ["PLAN.md"])
        self.assertEqual((target / "MEMORY.md").read_text(), "old MEMORY.md")
        self.assertEqual((self.home / "rooms/demo/events.jsonl").read_bytes(), journal)
        self.assertEqual({p.name for p in target.iterdir()}, {"PLAN.md", "MEMORY.md"})

    def test_journal_read_eacces_becomes_export_failed_without_writes(self):
        self.seed()
        self.old_outputs()
        before = tree(self.tmp)
        readers = [
            (export.export_room, ("demo", "exports")),
            (export.room_export, ({"room": "demo", "agent": "reader", "what": "memory"},)),
            (export.memory_history, ({"room": "demo", "agent": "reader", "section": "goal"},)),
        ]
        with patch.object(store, "read", side_effect=PermissionError(errno.EACCES, "read denied")):
            for function, args in readers:
                with self.subTest(function=function.__name__):
                    self.assert_room_error("export_failed", function, *args)
        self.assertEqual(tree(self.tmp), before)

    def test_successful_staging_close_eio_is_translated_and_stage_cleaned(self):
        self.seed()
        self.old_outputs()
        before = tree(self.tmp)
        real_open, real_close = os.open, os.close
        staging_fds = set()
        failures = []

        def track(path, flags, *args, **kwargs):
            fd = real_open(path, flags, *args, **kwargs)
            if flags & os.O_CREAT:
                staging_fds.add(fd)
            return fd

        def close(fd):
            real_close(fd)
            if fd in staging_fds and not failures:
                failures.append(fd)
                raise OSError(errno.EIO, "close failed")

        with patch.object(os, "open", side_effect=track), patch.object(os, "close", side_effect=close):
            self.assert_room_error("export_failed", export.export_room, "demo", "exports")
        self.assertEqual(len(failures), 1)
        self.assertEqual(tree(self.tmp), before)

    def test_existing_output_close_eio_is_translated_without_changes(self):
        self.seed()
        self.old_outputs()
        before = tree(self.tmp)
        real_close = os.close
        failures = []

        def close(fd):
            regular = stat.S_ISREG(os.fstat(fd).st_mode)
            real_close(fd)
            if regular and not failures:
                failures.append(fd)
                raise OSError(errno.EIO, "close failed")

        with patch.object(os, "close", side_effect=close):
            self.assert_room_error("export_failed", export.export_room, "demo", "exports")
        self.assertEqual(len(failures), 1)
        self.assertEqual(tree(self.tmp), before)

    def test_directory_close_failure_is_reported_after_all_fds_are_closed(self):
        self.seed()
        real_open, real_close = os.open, os.close
        directory_fds, closed = [], []
        failures = []

        def track(path, flags, *args, **kwargs):
            fd = real_open(path, flags, *args, **kwargs)
            if flags & os.O_DIRECTORY:
                directory_fds.append(fd)
            return fd

        def close(fd):
            real_close(fd)
            if fd in directory_fds:
                closed.append(fd)
                if not failures:
                    failures.append(fd)
                    raise OSError(errno.EIO, "close failed")

        with patch.object(os, "open", side_effect=track), patch.object(os, "close", side_effect=close):
            self.assert_room_error("export_failed", export.export_room, "demo", "nested/exports")
        self.assertEqual(closed, list(reversed(directory_fds)))
        self.assertEqual(len(failures), 1)
        self.assertFalse(any(p.name.startswith(".u94-") for p in self.home.rglob("*")))

    def test_cleanup_close_failure_preserves_bad_args(self):
        self.seed()
        target = self.old_outputs()
        (target / "PLAN.md").unlink()
        (target / "PLAN.md").mkdir()
        before = tree(self.tmp)
        real_close = os.close

        def close(fd):
            real_close(fd)
            raise OSError(errno.EIO, "close failed")

        with patch.object(os, "close", side_effect=close):
            self.assert_room_error("bad_args", export.export_room, "demo", "exports")
        self.assertEqual(tree(self.tmp), before)
