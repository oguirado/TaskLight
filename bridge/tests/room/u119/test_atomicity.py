"""A7: discriminating race oracles and executable negative controls."""
import copy
from unittest.mock import patch
from bridge.room import store
from .support import WorkCase


class AtomicityOracle(WorkCase):
    def dependency_race(self, *, remove_activation=False, existing_active=False):
        self.make_plan(count=2, micros=1, deps={"T02": ["T01"]})
        self.claim("T01"); self.micro(state="done")
        if existing_active:
            self.claim("T02"); self.micro("T02.M01", "active")
        original = store.post_ops
        observed = {}
        def commit(room, agent, ops, **kw):
            if "external" not in observed:
                # Change upstream readiness without changing selected T02.rev.
                self.micro(state="active")
                observed["external"] = self.raw()
                observed["selected"] = copy.deepcopy(self.task("T02"))
            if remove_activation:
                ops = [o for o in ops if not (o.get("kind") == "micro.set" and o.get("state") == "active")]
            return original(room, agent, ops, **kw)
        error = None
        with patch.object(store, "post_ops", side_effect=commit):
            try:
                self.acquire(prefer_task="T02", op_id="dependency-race")
            except NotImplementedError:
                raise
            except Exception as caught:
                error = caught
        self.assertIn("external", observed, "handler never submitted acquisition batch")
        self.assertEqual(self.raw(), observed["external"], "claim escaped failed activation batch")
        self.assertIsInstance(error, store.RoomError)
        self.assertEqual(error.code, "not_conformant")
        self.assertIn("T01", str(error))
        self.assertEqual(self.task("T02"), observed["selected"], "rejected acquisition changed the selected task")

    def test_a7_dependency_change_at_commit_is_atomic(self):
        self.dependency_race()

    def test_a7_negative_control_removing_acquisition_activation_is_detected(self):
        # NotImplementedError deliberately escapes: it cannot pass this control.
        with self.assertRaisesRegex(AssertionError, "claim escaped failed activation batch"):
            self.dependency_race(remove_activation=True)

    def report_race(self, *, remove_guard=False):
        self.make_plan()
        self.claim(); self.micro(state="active")
        original = store.post_ops
        observed = {}
        def commit(room, agent, ops, **kw):
            if "external" not in observed:
                self.micro("T01.M02", "done", outcome="Concurrent completion")
                observed["external"] = self.raw()
            if remove_guard:
                ops = [o for o in ops if o.get("kind") != "task.set"]
            return original(room, agent, ops, **kw)
        error = None
        with patch.object(store, "post_ops", side_effect=commit):
            try:
                self.report(op_id="report-revision-race")
            except NotImplementedError:
                raise
            except Exception as caught:
                error = caught
        self.assertIn("external", observed, "handler never submitted report batch")
        self.assertEqual(self.raw(), observed["external"], "stale report appended after concurrent completion")
        self.assertIsInstance(error, store.RoomError)
        self.assertEqual(error.code, "stale_rev")
        self.assertEqual(self.task()["microtasks"][1]["state"], "done")
        self.assertEqual(self.task()["microtasks"][0]["state"], "active")

    def test_a7_concurrent_next_completion_does_not_reactivate(self):
        self.report_race()

    def test_a7_negative_control_removing_report_revision_guard_is_detected(self):
        with self.assertRaisesRegex(AssertionError, "stale report appended after concurrent completion"):
            self.report_race(remove_guard=True)

    def invalid_final(self, *, split=False):
        self.make_plan()
        self.claim(); self.micro(state="active")
        before = self.raw()
        original = store.post_ops
        def commit(room, agent, ops, **kw):
            ops = copy.deepcopy(ops)
            invalid = {"kind": "micro.set", "micro_id": "T40.M12", "state": "done",
                       "claim_lamport": self.task()["claim_lamport"], "outcome": "Invalid final member"}
            ops.append(invalid)
            if split:
                result = []
                for op in ops:
                    result.extend(original(room, agent, [op], **kw))
                return result
            return original(room, agent, ops, **kw)
        error = None
        with patch.object(store, "post_ops", side_effect=commit):
            try:
                self.report(done=[self.completion(), self.completion("T01.M02")])
            except NotImplementedError:
                raise
            except Exception as caught:
                error = caught
        self.assertEqual(self.raw(), before, "invalid final member partially committed")
        self.assertIsInstance(error, store.RoomError)
        self.assertEqual(error.code, "not_found")

    def test_a7_invalid_final_writer_member_has_no_partial_commit(self):
        self.invalid_final()

    def test_a7_negative_control_separate_writes_is_detected(self):
        with self.assertRaisesRegex(AssertionError, "invalid final member partially committed"):
            self.invalid_final(split=True)

    def test_a7_invalid_final_submitted_completion_has_no_partial_commit(self):
        self.make_plan(); self.claim(); self.micro(state="active")
        args = self.report_args(done=[self.completion(), self.completion("T01.M12")])
        self.deny("work_report", args, "not_found")

    def test_m8_acquisition_full_room_and_write_failures_are_not_success(self):
        self.make_plan()
        for target in ("write", "fsync", "full"):
            if target == "full":
                context = patch.object(store, "CAP", len(self.raw()))
            else:
                context = patch.object(store.os, target, side_effect=OSError("injected durable failure"))
            with context:
                self.deny("work_acquire", {"room": "demo", "agent": "alice"},
                          "room_full" if target == "full" else "internal")

    def test_a7_existing_active_still_guards_dependency_readiness(self):
        self.dependency_race(existing_active=True)

    def test_a7_negative_control_omitting_existing_active_guard_is_detected(self):
        with self.assertRaisesRegex(AssertionError, "claim escaped failed activation batch"):
            self.dependency_race(remove_activation=True, existing_active=True)

    def test_m8_tools_use_writer_without_nesting_or_receipt_files(self):
        self.make_plan()
        lock = store._lock.lock_exclusive
        unlock = store._lock.unlock
        held = set()

        def enter(fd):
            self.assertFalse(held, "nested writer lock")
            lock(fd)
            held.add(fd)

        def leave(fd):
            unlock(fd)
            held.discard(fd)

        with patch.object(store._lock, "lock_exclusive", side_effect=enter), \
             patch.object(store._lock, "unlock", side_effect=leave):
            result = self.acquire(op_id="writer-contract-acquire")
            self.assert_acquired(result)
            report = self.report(op_id="writer-contract-report")
            self.assert_reported(report, ["T01.M01"], "T01.M02", result["claim_lamport"])
        self.assertFalse(held, "writer lock leaked")
        expected = {"rooms/demo/events.jsonl", "rooms/demo/events.lock",
                    "templates/" + self.template["id"] + ".json"}
        self.assertEqual({p.relative_to(self.home).as_posix() for p in self.home.rglob("*") if p.is_file()}, expected)

    def partial_write(self, tool):
        self.make_plan()
        if tool == "work_report":
            self.claim(); self.micro(state="active")
            args = self.report_args()
        else:
            args = dict(room="demo", agent="alice")
        original = store.os.write
        calls = []

        def write(fd, data):
            if not calls:
                calls.append(True)
                return original(fd, data[:max(1, len(data) // 2)])
            raise OSError("injected failure after a partial write")

        with patch.object(store.os, "write", side_effect=write):
            self.deny(tool, args, "internal")
        self.assertTrue(calls, "writer was never exercised")

    def test_m8_acquire_partial_write_is_rolled_back(self):
        self.partial_write("work_acquire")

    def test_m8_report_partial_write_is_rolled_back(self):
        self.partial_write("work_report")
