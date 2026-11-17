"""Regression oracles for cursor failures and descriptor-anchored mailboxes."""
import copy
import errno
import json
import os
import posix
from unittest import mock

from bridge.room import store
from .support import FamilyCase, REAL_OPEN, REAL_RENAME, canonical, envelope


class BackendFailureRepair(FamilyCase):
    def setUp(self):
        super().setUp()
        self.append_committed(dict(id="e-0000000000000001", lamport=1, ts=1,
                                   room="demo", agent="executor-a", act="heartbeat", text=""))

    def read_request(self, identity="read-0001", **payload):
        value = envelope(id=identity, kind="events.read", after=0, payload=payload)
        value.pop("run_id")
        return value, self.publish(value)

    def assert_recoverable_read(self, failure, identity="read-0001"):
        value, request = self.read_request(identity)
        before = self.journal_bytes()
        self.dispatch.side_effect = failure
        self.assertEqual(self.invoke(), 3)
        self.assertFalse((self.mailbox / "consumer.lock").exists())
        self.assertFalse(self.trace.locked)
        self.assertTrue(request.is_file())
        self.assertFalse((self.spool / (identity + ".result.json")).exists())
        retained = self.mailbox / "dedup" / (identity + ".json")
        pending = json.loads(retained.read_bytes())
        self.assertEqual(pending["phase"], "pending")
        self.assertNotIn("result", pending)
        self.assertNotIn("private port detail", self.stderr)
        self.dispatch.side_effect = self.backend
        self.assertEqual(self.invoke(), 0)
        self.assertFalse(request.exists())
        self.assertFalse((self.mailbox / "consumer.lock").exists())
        self.assertEqual(json.loads(retained.read_bytes())["phase"], "complete")
        self.assertEqual(self.receipt(value["id"])["result"]["untrusted"]["head"], 1)
        self.assertEqual(self.journal_bytes(), before)

    def test_bad_args_result_returns_durable_error_receipt_and_replays(self):
        value, request = self.read_request(acts=["bad-act"])
        self.dispatch.side_effect = lambda *_: {"ok": False, "code": "bad_args",
                                               "detail": "invalid cursor filter"}
        before = self.journal_bytes()
        self.assertEqual(self.invoke(), 0)
        self.error_receipt("bad_args", value["id"])
        original = self.receipt(value["id"])
        self.assertFalse(request.exists())
        self.assertFalse((self.mailbox / "consumer.lock").exists())
        self.assertFalse(self.trace.locked)
        retained = self.mailbox / "dedup" / "read-0001.json"
        self.assertEqual(json.loads(retained.read_bytes())["phase"], "complete")
        (self.spool / "read-0001.result.json").unlink()
        self.publish(value)
        self.dispatch.reset_mock()
        self.assertEqual(self.invoke(), 0)
        self.dispatch.assert_not_called()
        self.assertEqual(self.receipt(value["id"]), original)
        self.assertEqual(self.journal_bytes(), before)

    def test_internal_result_retains_request_and_recovers(self):
        self.assert_recoverable_read(lambda *_: {"ok": False, "code": "internal"})

    def test_raising_port_retains_request_and_recovers(self):
        self.assert_recoverable_read(RuntimeError("private port detail"))

    def test_room_error_is_a_terminal_receipt(self):
        value, request = self.read_request()
        self.dispatch.side_effect = store.RoomError("bad_args", "invalid cursor filter")
        self.assertEqual(self.invoke(), 0)
        self.error_receipt("bad_args", value["id"])
        self.assertFalse(request.exists())
        self.assertFalse((self.mailbox / "consumer.lock").exists())
        self.assertFalse(self.trace.locked)

    def test_invalid_cursor_results_are_recoverable(self):
        invalid = [
            {"untrusted": {}},
            {"untrusted": {"events": {}}},
            {"untrusted": {"events": [None]}},
            {"untrusted": {"events": [{}]}},
            {"untrusted": {"events": [{"lamport": True}]}},
            {"untrusted": {"events": [{"lamport": "1"}]}},
        ]
        for index, result in enumerate(invalid):
            with self.subTest(result=result):
                self.assert_recoverable_read(lambda *_, result=result: result,
                                             identity="invalid-%04d" % index)

    def test_revision_projection_does_not_mutate_backend_result(self):
        value, _ = self.read_request()
        result = {"untrusted": {"events": [{"id": "event-0001", "lamport": 1}],
                                "head": 1, "next_after": 1, "has_more": False, "resync": False}}
        before = copy.deepcopy(result)
        self.dispatch.side_effect = lambda *_: result
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(result, before)
        self.assertEqual(self.receipt(value["id"])["result"]["untrusted"]["events"],
                         [{"id": "event-0001", "lamport": 1, "revision": 1}])

    def test_mutating_port_exception_after_commit_recovers_without_append(self):
        request = self.publish()
        def fail_after_commit():
            raise RuntimeError("private port detail")
        self.backend.after_commit = fail_after_commit
        self.assertEqual(self.invoke(), 3)
        self.assertFalse((self.mailbox / "consumer.lock").exists())
        self.assertTrue(request.exists())
        before = self.journal_bytes()
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.journal_bytes(), before)
        self.assertEqual(self.receipt()["result"]["untrusted"]["lamport"], 2)
        retained = self.mailbox / "dedup" / "deploy-0001.json"
        self.assertEqual(json.loads(retained.read_bytes())["phase"], "complete")


class FilesystemRepair(FamilyCase):
    def test_ancestor_swap_never_opens_outside_configuration_or_creates_state(self):
        anchor = self.tmp / "anchor"
        anchor.mkdir()
        REAL_RENAME(self.home, anchor / "home")
        self.home = anchor / "home"
        self.mailbox = self.home / "family" / "board"
        self.spool = self.mailbox / "spool"
        os.environ["CW_HOME"] = str(self.home)
        self.publish()
        outside = self.tmp / "outside"
        outside_mailbox = outside / "home" / "family" / "board"
        (outside_mailbox / "spool").mkdir(parents=True)
        config = outside_mailbox / "config.json"
        config.write_bytes(canonical(self.config))
        watched = config.stat()
        anchor_info = anchor.stat()
        detached = self.tmp / "detached"
        opened_anchor, swapped, outside_opens = [], [], []
        original_stat = os.stat
        def racing_open(path, flags, *args, **kwargs):
            fd = REAL_OPEN(path, flags, *args, **kwargs)
            info = os.fstat(fd)
            if (info.st_dev, info.st_ino) == (watched.st_dev, watched.st_ino):
                outside_opens.append(os.fspath(path))
            if (info.st_dev, info.st_ino) == (anchor_info.st_dev, anchor_info.st_ino):
                opened_anchor.append(fd)
            return fd
        def racing_stat(path, *args, **kwargs):
            # Swap after the parent's open and identity checks, immediately
            # before the next component is resolved through that parent.
            if (opened_anchor and not swapped and
                    os.fspath(path) in ("home", str(anchor / "home"))):
                REAL_RENAME(anchor, detached)
                anchor.symlink_to(outside, target_is_directory=True)
                swapped.append(True)
            return original_stat(path, *args, **kwargs)
        with (mock.patch.object(os, "open", racing_open),
              mock.patch.object(posix, "open", racing_open),
              mock.patch.object(os, "stat", racing_stat)):
            self.assertIn(self.invoke(), (2, 3))
        self.assertEqual(swapped, [True], "ancestor race was not exercised")
        self.assertEqual(outside_opens, [], "outside configuration was opened")
        self.assertEqual(config.read_bytes(), canonical(self.config))
        self.assertEqual(sorted(p.name for p in outside_mailbox.iterdir()), ["config.json", "spool"])
        self.dispatch.assert_not_called()
        self.assertFalse((detached / "home" / "family" / "board" / "consumer.lock").exists())

    def test_read_only_directory_is_skipped_and_drain_continues(self):
        planted = self.spool / "blocked-0001.json"
        planted.mkdir()
        child = planted / "untouched"
        child.write_bytes(b"passive data")
        planted.chmod(0o500)
        self.addCleanup(lambda: next(p for p in self.tmp.rglob("untouched")).parent.chmod(0o700))
        self.publish()
        rename = os.rename
        refused = []
        def reject_cross_parent(src, dst, *args, **kwargs):
            source = self.trace.at(src, kwargs.get("src_dir_fd"))
            target = self.trace.at(dst, kwargs.get("dst_dir_fd"))
            if source == planted and target.parent != self.spool:
                refused.append(True)
                raise PermissionError(errno.EACCES, "directory parent cannot change")
            return rename(src, dst, *args, **kwargs)
        with mock.patch.object(os, "rename", reject_cross_parent):
            self.assertEqual(self.invoke(), 0)
        self.assertEqual(refused, [True])
        self.assertFalse(planted.exists())
        self.assertFalse((self.spool / "blocked-0001.result.json").exists())
        self.assertEqual(next(self.tmp.rglob("untouched")).read_bytes(), b"passive data")
        self.assertTrue(self.receipt()["result"]["untrusted"]["ok"])
        self.assertFalse((self.mailbox / "consumer.lock").exists())
        self.backend.calls.clear()
        self.assertEqual(self.invoke(), 0)
        self.dispatch.assert_called_once()
