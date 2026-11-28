"""Regression tests for journal metadata and byte handling across platforms."""
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from bridge.room import store
from bridge.room.ext.orchestrator_snapshot import orchestrator_snapshot
from bridge.tests.room.support import RoomCase


class JournalPortability(RoomCase):
    def windows_os_with_path_ctime(self):
        journal = Path(self.home, "rooms", "r1", "events.jsonl")

        def path_stat(path, *args, **kwargs):
            info = os.stat(path, *args, **kwargs)
            if Path(path) != journal:
                return info
            return SimpleNamespace(**{name: getattr(info, name) for name in (
                "st_mode", "st_dev", "st_ino", "st_size", "st_mtime_ns")},
                st_ctime_ns=info.st_ctime_ns - 1)

        windows_os = SimpleNamespace(**vars(os))
        windows_os.name = "nt"
        windows_os.O_BINARY = getattr(os, "O_BINARY", 0)
        windows_os.stat = path_stat
        return windows_os

    def test_room_read_compares_handle_metadata_on_windows(self):
        posted = self.post()
        with patch.object(store, "os", self.windows_os_with_path_ctime()):
            events, head, _ = store._read_event_view(self.home, "r1")
        self.assertEqual(events, [posted])
        self.assertEqual(head, posted["lamport"])

    def test_snapshot_compares_handle_metadata_on_windows(self):
        posted = self.post()
        with patch.dict(os.environ, {"CW_HOME": str(self.home)}):
            with patch.object(store, "os", self.windows_os_with_path_ctime()):
                result = orchestrator_snapshot({"room": "r1"})
        self.assertEqual(result["head_lamport"], posted["lamport"])
        self.assertTrue(result["complete"])

    def test_windows_only_tolerates_permission_error_for_directory_journal(self):
        self.post()
        journal = Path(self.home, "rooms", "r1", "events.jsonl")
        windows_os = self.windows_os_with_path_ctime()
        with patch.object(store, "os", windows_os), \
                patch.object(store, "open", side_effect=PermissionError, create=True):
            with self.assertRaises(PermissionError):
                store.read("r1", home=self.home)
            journal.unlink()
            journal.mkdir()
            self.assertEqual(store.read("r1", home=self.home), ([], 0))

    def test_room_append_keeps_utf8_and_lf_bytes(self):
        self.post(text="café")
        self.post(text="olé")
        journal = Path(self.home, "rooms", "r1", "events.jsonl").read_bytes()
        self.assertIn("café".encode("utf-8"), journal)
        self.assertIn("olé".encode("utf-8"), journal)
        self.assertEqual(journal.count(b"\n"), 2)
        self.assertNotIn(b"\r", journal)
