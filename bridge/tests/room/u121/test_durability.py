"""M7/A6: actual writes and syncs, failures, acknowledged-prefix preservation."""
import errno
import os
from unittest.mock import patch

from bridge.room import _lock, store
from bridge.tests.room.u121.support import BEAT, RoomCase, memory
from bridge.tests.room.u121.test_lock import fd_count


class DurabilityTests(RoomCase):
    def is_journal(self, fd):
        return os.fstat(fd).st_ino == self.path.stat().st_ino

    def request(self, batch):
        return (lambda: self.batch([memory(), memory("memory0002", section="other")])) if batch else (lambda: self.post(BEAT))

    def recoverable(self, batch, mode):
        original = self.raw()
        call = self.request(batch)
        real_write = os.write
        calls = []
        def writing(fd, data):
            if not self.is_journal(fd):
                return real_write(fd, data)
            calls.append(len(data))
            self.assertLessEqual(len(calls), 100, "write loop failed to progress")
            if mode == "interrupt" and len(calls) == 1:
                raise InterruptedError(errno.EINTR, "injected interrupt")
            return real_write(fd, data[:max(1, len(data) // 2)])
        with patch.object(os, "write", side_effect=writing):
            events = call()
        self.assertGreater(len(calls), 1)
        self.assertTrue(self.raw().startswith(original))
        self.assertEqual(self.projection()["rejected"], [])
        for event in events if batch else [events]:
            self.assertIn(event, self.events())

    def failure(self, batch, mode):
        call = self.request(batch)
        before = self.snapshot()
        initial_fds = fd_count()
        real_write, real_sync, real_truncate = os.write, os.fsync, os.ftruncate
        writes = 0
        syncs = 0
        timeline = []
        def writing(fd, data):
            nonlocal writes
            if not self.is_journal(fd):
                return real_write(fd, data)
            writes += 1
            timeline.append("write")
            if mode in ("write_error", "zero_write"):
                if writes == 1:
                    return real_write(fd, data[:7])
                if mode == "zero_write":
                    return 0
                raise OSError(errno.ENOSPC, "injected write failure")
            return real_write(fd, data)
        def syncing(fd):
            nonlocal syncs
            if self.is_journal(fd):
                syncs += 1
                timeline.append("sync")
                if mode in ("sync_once", "rollback_error") and syncs == 1:
                    raise OSError(errno.EIO, "injected original sync failure")
                if mode == "rollback_sync_error":
                    raise OSError(errno.EIO, "injected persistent sync failure")
            return real_sync(fd)
        def truncating(fd, size):
            timeline.append("truncate")
            result = real_truncate(fd, size)
            if mode == "rollback_error":
                raise OSError(errno.EIO, "injected secondary rollback failure")
            return result
        real_unlock = _lock.unlock
        def unlocking(fd):
            timeline.append("unlock")
            return real_unlock(fd)
        with patch.object(os, "write", side_effect=writing), \
             patch.object(os, "fsync", side_effect=syncing), \
             patch.object(os, "ftruncate", side_effect=truncating), \
             patch.object(_lock, "unlock", side_effect=unlocking):
            error = self.refuse(call, "internal")
        self.assertEqual(fd_count(), initial_fds, "failed append leaked descriptors")
        if mode == "rollback_error":
            self.assertIn("injected original sync failure", str(error))
        self.assertEqual(self.snapshot(), before)
        # Reopen via the real parser, then prove the lock is reusable.
        parsed, malformed = store.read("u121", home=self.home)
        self.assertEqual(malformed, 0)
        self.assertEqual(parsed, self.events())
        self.assertIn("truncate", timeline)
        if mode in ("sync_once", "write_error", "zero_write"):
            truncate_at = timeline.index("truncate")
            unlock_at = timeline.index("unlock")
            self.assertIn("sync", timeline[truncate_at + 1:unlock_at], "rollback was not synced before unlock")
        if mode == "rollback_sync_error":
            self.assertGreaterEqual(syncs, 2, "rollback fsync was never attempted")
        result = call()
        self.assertTrue(result)
        self.assertTrue(self.raw().startswith(before[0]))

    def acknowledged_after_sync(self, batch):
        call = self.request(batch)
        durable_ids = set()
        timeline = []
        real_sync, real_unlock = os.fsync, _lock.unlock
        def syncing(fd):
            result = real_sync(fd)
            if self.is_journal(fd):
                timeline.append("sync")
                durable_ids.update(e["id"] for e in self.events())
            return result
        def unlocking(fd):
            timeline.append("unlock")
            return real_unlock(fd)
        with patch.object(os, "fsync", side_effect=syncing), patch.object(_lock, "unlock", side_effect=unlocking):
            result = call()
            timeline.append("success")
        for event in result if batch else [result]:
            self.assertIn(event["id"], durable_ids, "receipt preceded journal sync")
        self.assertLess(timeline.index("sync"), timeline.index("unlock"))
        self.assertLess(timeline.index("unlock"), timeline.index("success"))


for batch in (False, True):
    prefix = "test_a6_" + ("batch_" if batch else "single_")
    for mode in ("short", "interrupt"):
        def test(self, b=batch, m=mode):
            self.recoverable(b, m)
        setattr(DurabilityTests, prefix + mode + "_writes_complete", test)
    for mode in ("write_error", "zero_write", "sync_once", "rollback_error", "rollback_sync_error"):
        def test(self, b=batch, m=mode):
            self.failure(b, m)
        setattr(DurabilityTests, prefix + mode + "_rollback", test)
    def test(self, b=batch):
        self.acknowledged_after_sync(b)
    setattr(DurabilityTests, prefix + "success_after_sync", test)
