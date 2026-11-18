"""Inclusive whole-transaction ceilings through each existing writer."""
from concurrent.futures import ThreadPoolExecutor
import errno
import os
from threading import Barrier, Event
from unittest import mock

from bridge.room import _lock, store

from .support import JournalCase, NEW_CAP, NOISE_CAP, OLD_CAP, RESERVE, ROOM, invoke, outcome


class JournalBoundaries(JournalCase):
    def exact_and_overflow(self, call, ceiling, *, torn=False, count=1):
        prefix = self.journal.read_bytes()
        written = self.payload_size(call)
        tail = b'{"incomplete":' if torn else b""
        written += int(torn)
        for overflow in (0, 1):
            with self.subTest(overflow=overflow):
                self.pad(prefix, ceiling - written + overflow, tail)
                before, old_head, _ = self.snapshot()
                if overflow:
                    self.refuses(call)
                    continue
                self.succeeds(call)
                after, head, malformed = self.snapshot()
                self.assertEqual(len(after), ceiling)
                self.assertTrue(after.startswith(before))
                self.assertEqual(head, old_head + count)
                committed, _ = store.read(ROOM, since=old_head)
                self.assertEqual([event["lamport"] for event in committed],
                                 list(range(old_head + 1, head + 1)))
                if torn:
                    self.assertEqual(after[len(before):len(before) + 1], b"\n")
                    self.assertEqual(malformed, 1)

    def test_legacy_room_heartbeat_and_terminal_result_survive_restart(self):
        self.life("deployed", "deploy-current")
        original_events = self.events()
        self.pad(self.journal.read_bytes(), OLD_CAP)
        prefix = self.journal.read_bytes()
        lock_inode = self.lock.stat().st_ino
        beat = self.succeeds(lambda: self.post(text="past the old ceiling", agent="worker"))
        result = {"verdict": "OK", "summary": "Worker completed the task"}
        finished = self.succeeds(lambda: self.life("finished", "finished-current", result=result))
        fresh = self.restart()["events"]
        self.assertTrue(self.journal.read_bytes().startswith(prefix))
        self.assertEqual(self.lock.stat().st_ino, lock_inode)
        self.assertEqual(fresh[:-2], original_events)
        self.assertEqual(fresh[-2], beat)
        self.assertEqual(fresh[-1]["op"]["result"], result)
        self.assertEqual([row["lamport"] for row in fresh[-2:]],
                         [original_events[-1]["lamport"] + 1, finished["lamport"]])
        self.assertEqual(finished["lamport"], beat["lamport"] + 1)

    def test_semantic_batch_exact_and_overflow_include_utf8_and_torn_separator(self):
        self.post()
        ops = [{"kind": "memory.set", "section": "goal", "text": "éclair", "base_rev": 0,
                "op_id": "semantic-batch"},
               {"kind": "memory.set", "section": "rules", "text": "持続", "base_rev": 0}]
        self.exact_and_overflow(lambda: self.batch(ops), NEW_CAP, torn=True, count=2)

    def test_heartbeat_exact_and_overflow_preserve_the_semantic_reserve(self):
        self.assertEqual(store.SEMANTIC_RESERVE_BYTES, RESERVE)
        self.post()
        self.exact_and_overflow(lambda: self.post(text="é🚀"), NOISE_CAP, torn=True)

    def active_reviewer(self):
        self.plan()
        invoke("task_claim", agent="reviewer", task_id="T01", op_id="reviewer-claim")
        invoke("microtask_set", agent="reviewer", id="T01.M01", state="active",
               op_id="reviewer-active")

    def test_activity_only_batch_exact_and_overflow_reserve_the_whole_transaction(self):
        self.active_reviewer()
        ops = [{"kind": "activity.beat", "task_id": "T01", "run_id": "run-reviewer",
                "note": note, "op_id": identity}
               for note, identity in (("é", "activity-batch"), ("持続", "activity-member"))]
        self.exact_and_overflow(lambda: self.batch(ops), NOISE_CAP, count=2)

    def test_mixed_batch_exact_and_overflow_reserve_the_whole_transaction(self):
        self.active_reviewer()
        ops = [{"kind": "memory.set", "section": "rules", "text": "déjà", "base_rev": 0,
                "op_id": "mixed-batch"},
               {"kind": "activity.beat", "task_id": "T01", "run_id": "run-reviewer",
                "note": "持続", "op_id": "mixed-activity"}]
        self.exact_and_overflow(lambda: self.batch(ops), NOISE_CAP, torn=True, count=2)

    def test_lifecycle_alive_exact_and_overflow_cannot_spend_the_reserve(self):
        self.life("deployed", "deploy-current")
        self.exact_and_overflow(lambda: self.life("alive", "alive-current", reason="prêt"),
                                NOISE_CAP, torn=True)

    def test_guarded_task_claim_exact_and_overflow_share_the_room_limit(self):
        self.plan()
        self.exact_and_overflow(lambda: invoke("task_claim", agent="worker", task_id="T01",
                                             op_id="guarded-claim"), NEW_CAP)

    def test_two_real_writers_race_for_the_final_transaction(self):
        self.post()
        prefix = self.journal.read_bytes()
        size = self.payload_size(lambda: self.post("verdict", "exact", "writer-a"))
        self.pad(prefix, NEW_CAP - size)
        before, head, _ = self.snapshot()
        start = Barrier(2)
        released = Event()
        unlock = _lock.unlock

        def release(fd):
            unlock(fd)
            released.set()

        def wait_for_lock(_):
            self.assertTrue(released.wait(5), "competing writer did not release events.lock")

        def run(agent):
            start.wait(5)
            return outcome(lambda: self.post("verdict", "exact", agent))

        with mock.patch.object(_lock.time, "sleep", side_effect=wait_for_lock), \
                mock.patch.object(_lock, "unlock", side_effect=release), \
                ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(run, ("writer-a", "writer-b")))
        winners = [item["reply"] for item in replies if "reply" in item]
        self.assertEqual(len(winners), 1, replies)
        self.assertEqual([item["code"] for item in replies if "code" in item], ["room_full"])
        after, new_head, malformed = self.snapshot()
        self.assertTrue(after.startswith(before))
        self.assertEqual(len(after), NEW_CAP)
        self.assertEqual((new_head, malformed), (head + 1, 0))
        self.assertEqual(self.events()[-1], winners[0])

    def test_writers_hold_room_lock_through_fsync_and_keep_io_error_envelope(self):
        self.plan()
        self.life("deployed", "deploy-current")
        fsync = os.fsync
        seen = []

        def is_journal(fd):
            item, journal = os.fstat(fd), self.journal.stat()
            return (item.st_dev, item.st_ino) == (journal.st_dev, journal.st_ino)

        def observe(fd):
            fsync(fd)
            if is_journal(fd):
                if _lock._posix:
                    with self.lock.open("r+b") as independent:
                        backend = _lock._backend
                        with self.assertRaises(OSError) as blocked:
                            backend.flock(independent.fileno(), backend.LOCK_EX | backend.LOCK_NB)
                        self.assertIn(blocked.exception.errno, (errno.EAGAIN, errno.EACCES))
                seen.append(self.snapshot()[1])

        calls = (
            lambda: self.post(),
            lambda: self.batch([{"kind": "memory.set", "section": "goal", "text": "synced",
                                "base_rev": 0, "op_id": "sync-batch"}]),
            lambda: invoke("task_claim", agent="worker", task_id="T01", op_id="sync-claim"),
            lambda: self.life("alive", "sync-alive"),
        )
        with mock.patch.object(os, "fsync", side_effect=observe):
            for call in calls:
                seen.clear()
                self.succeeds(call)
                self.assertIn(self.snapshot()[1], seen, "journal head must be synced before success")

        def fail_once(fd):
            if is_journal(fd) and not seen:
                seen.append("failed")
                raise OSError(errno.EIO, "synthetic sync failure")
            fsync(fd)

        for call in (lambda: self.post(text="sync failure"),
                     lambda: self.life("failed", "sync-failure"),
                     lambda: invoke("microtask_set", agent="worker", id="T01.M01",
                                    state="active", op_id="guard-sync-failure"),
                     lambda: self.batch([{"kind": "memory.set", "section": "rules", "text": "failure",
                                         "base_rev": 0, "op_id": "batch-sync-failure"}])):
            with self.subTest(call=call):
                seen.clear()
                with mock.patch.object(os, "fsync", side_effect=fail_once):
                    self.refuses(call, "internal")
                self.assertEqual(seen, ["failed"])
