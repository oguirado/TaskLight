"""A1/A2/A5/A7/A9: durable identities, controlled crash cuts and receipts."""
import copy
import json
import multiprocessing
import os
import unittest
from time import monotonic as watchdog_clock
from unittest import mock

from .support import (Crash, FamilyCase, PROTOCOL, REAL_DISPATCH, assert_committed_receipt,
                      canonical, envelope)
from .test_routing import LiveSliceTwoCase


def crash():
    raise Crash("after committed journal, before return")


class RecoveryOracle(FamilyCase):
    def test_a1_identical_redelivery_has_same_result_event_and_journal(self):
        value = envelope()
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        expected = self.receipt()
        before = self.journal_bytes()
        # The producer consumes its response, then retries the identical request.
        (self.spool / "deploy-0001.result.json").unlink()
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.receipt(), expected)
        self.assertEqual(self.journal_bytes(), before)

    def test_canonical_retry_ignores_json_object_key_order(self):
        value = envelope(payload={"reason": "unchanged", "harness": "director"})
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        expected, before = self.receipt(), self.journal_bytes()
        (self.spool / "deploy-0001.result.json").unlink()
        changed_order = dict(reversed(list(value.items())))
        changed_order["payload"] = dict(reversed(list(value["payload"].items())))
        self.publish(value, raw=json.dumps(changed_order, indent=2).encode("utf-8"))
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.receipt(), expected)
        self.assertEqual(self.journal_bytes(), before)

    def test_a5_changed_content_after_response_consumption_returns_bad_op(self):
        value = envelope()
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        before = self.journal_bytes()
        (self.spool / "deploy-0001.result.json").unlink()
        self.backend.calls.clear()
        self.publish(envelope(payload={"reason": "changed"}))
        self.assertEqual(self.invoke(), 0)
        self.error_receipt("bad_op")
        self.assertEqual(self.backend.calls, [])
        self.assertEqual(self.journal_bytes(), before)

    def test_a5_unread_valid_receipt_is_not_overwritten_on_conflict(self):
        self.publish()
        self.assertEqual(self.invoke(), 0)
        path = self.spool / "deploy-0001.result.json"
        response, before = path.read_bytes(), self.journal_bytes()
        self.backend.calls.clear()
        request = self.publish(envelope(payload={"reason": "changed"}))
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(path.read_bytes(), response)
        self.assertEqual(self.backend.calls, [])
        self.assertEqual(self.journal_bytes(), before)
        self.assertFalse(request.exists())

    def test_pending_identity_is_durable_before_dispatch(self):
        self.backend.check_pending = True
        self.publish()
        self.assertEqual(self.invoke(), 0)
        self.assertTrue(self.receipt()["result"]["untrusted"]["ok"])

    def test_a2_crash_after_commit_before_dispatch_return(self):
        value = envelope()
        self.publish(value)
        self.backend.after_commit = crash
        with self.assertRaises(Crash):
            self.invoke()
        before = self.journal_bytes()
        self.assertTrue(before, "crash cut did not follow a journal commit")
        self.assertFalse((self.spool / "deploy-0001.result.json").exists())
        self.recover_ownership()
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.receipt()["result"], {"untrusted": {"ok": True, "lamport": 1}})
        self.assertEqual(self.journal_bytes(), before)

    def test_a2_throttled_alive_crash_before_receipt_uses_original_noop_result(self):
        self.publish()
        self.assertEqual(self.invoke(), 0)
        self.backend.noop = {"untrusted": {"ok": True, "lamport": 1}}
        expected = copy.deepcopy(self.backend.noop)
        self.publish(envelope(id="alive-0001", kind="agent.alive"))
        self.trace.crash_at = "before_receipt_rename"
        with self.assertRaises(Crash):
            self.invoke()
        before = self.journal_bytes()
        self.assertEqual(len(self.events()), 1, "no-op fixture unexpectedly appended")
        self.recover_ownership()
        # A new backend outcome must not replace the already serialized no-op.
        self.backend.noop = {"untrusted": {"ok": True, "lamport": 999}}
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.receipt("alive-0001")["result"], expected)
        self.assertEqual(self.journal_bytes(), before)

    def test_a7_completed_identity_survives_request_and_response_deletion(self):
        value = envelope()
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        expected, before = self.receipt(), self.journal_bytes()
        request = self.spool / "deploy-0001.json"
        if request.exists():
            request.unlink()
        (self.spool / "deploy-0001.result.json").unlink()
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.receipt(), expected)
        self.assertEqual(self.journal_bytes(), before)

    def test_a7_receipt_publication_is_fsynced_before_request_deletion(self):
        request = self.publish()
        self.assertEqual(self.invoke(), 0)
        response = self.receipt()
        assert_committed_receipt(self, response, self.events())
        self.assertFalse(request.exists())
        final = self.spool / "deploy-0001.result.json"
        renames = [i for i, row in enumerate(self.trace.log) if row[0] == "rename" and row[2] == final]
        self.assertTrue(renames, "receipt was not atomically published")
        self.assertIn(("fsync", self.spool, "directory"), self.trace.log[renames[-1] + 1:])

    def test_a9_success_receipt_has_committed_journal_witness(self):
        self.publish()
        self.assertEqual(self.invoke(), 0)
        assert_committed_receipt(self, self.receipt(), self.events())

    def recover_ownership(self):
        # Explicit operator action after the simulated process is known dead.
        # The adapter is forbidden to perform this recovery automatically.
        lock = self.mailbox / "consumer.lock"
        if lock.exists():
            lock.unlink()



def rename_crash_case(boundary):
    def test(self):
        self.publish()
        self.trace.crash_at = boundary
        with self.assertRaises(Crash):
            self.invoke()
        before = self.journal_bytes()
        self.assertEqual(len(self.events()), 1)
        self.recover_ownership()
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.receipt()["result"], {"untrusted": {"ok": True, "lamport": 1}})
        self.assertEqual(self.journal_bytes(), before)
    return test


for _cut in ("before_receipt_rename", "after_receipt_rename"):
    setattr(RecoveryOracle, "test_a2_crash_" + _cut, rename_crash_case(_cut))


def fsync_failure_case(directory):
    def test(self):
        request = self.publish()
        def fail(path, is_dir):
            return path is not None and ((directory and is_dir and path == self.spool)
                    or (not directory and not is_dir and path.parent == self.spool))
        self.trace.fail_sync = fail
        self.assertEqual(self.invoke(), 3)
        self.assertIsNone(self.trace.fail_sync, "durability fault was not reached")
        self.assertTrue(request.exists(), "failed publication lost the request")
        before = self.journal_bytes()
        self.recover_ownership()
        self.assertEqual(self.invoke(), 0)
        self.assertTrue(self.receipt()["result"]["untrusted"]["ok"])
        self.assertEqual(self.journal_bytes(), before)
    return test


for _name, _directory in (("file", False), ("directory", True)):
    setattr(RecoveryOracle, "test_a7_receipt_" + _name + "_fsync_failure", fsync_failure_case(_directory))


class OracleCalibration(unittest.TestCase):
    """A9's negative control tests the oracle itself, independently of U134."""
    def test_a9_premature_success_is_rejected(self):
        bad = {"schema": PROTOCOL, "id": "deploy-0001",
               "result": {"untrusted": {"ok": True, "lamport": 1}}}
        with self.assertRaisesRegex(AssertionError, "no committed journal witness"):
            assert_committed_receipt(self, bad, [])

    def test_a9_wrong_lamport_is_rejected(self):
        bad = {"result": {"untrusted": {"ok": True, "lamport": 2}}}
        with self.assertRaisesRegex(AssertionError, "no committed journal witness"):
            assert_committed_receipt(self, bad, [{"lamport": 1}])


def changed_pending(self):
    self.publish()
    self.backend.error = Crash("after pending, before commit")
    with self.assertRaises(Crash):
        self.invoke()
    self.assertEqual(self.journal_bytes(), b"")
    self.recover_ownership()
    self.backend.error = None
    self.backend.calls.clear()
    self.publish(envelope(payload={"reason": "changed while pending"}))
    self.assertEqual(self.invoke(), 0)
    self.error_receipt("bad_op")
    self.assert_no_dispatch()


RecoveryOracle.test_a5_changed_pending_identity_is_bad_op_without_journal = changed_pending


def pending_fsync_failure(self):
    request = self.publish()
    self.trace.fail_sync = lambda path, is_dir: path is not None and "dedup" in path.parts
    self.assertEqual(self.invoke(), 3)
    self.assertIsNone(self.trace.fail_sync, "pending durability fault was not reached")
    self.assertTrue(request.exists())
    self.assert_no_dispatch()


RecoveryOracle.test_pending_fsync_failure_stops_before_dispatch = pending_fsync_failure


def published_success_then_crash(self):
    import tempfile
    from pathlib import Path
    from .support import HERE
    bad = {"schema": PROTOCOL, "id": "deploy-0001",
           "result": {"untrusted": {"ok": True, "lamport": 1}}}
    with tempfile.TemporaryDirectory(prefix=".negative-", dir=HERE) as directory:
        path = Path(directory) / "deploy-0001.result.json"
        with self.assertRaises(Crash):
            path.write_bytes(canonical(bad))
            raise Crash("published before commit")
        with self.assertRaisesRegex(AssertionError, "no committed journal witness"):
            assert_committed_receipt(self, json.loads(path.read_text()), [])


OracleCalibration.test_a9_published_success_then_crash_is_rejected = published_success_then_crash


def unrelated_event(self):
    bad = {"schema": PROTOCOL, "id": "deploy-0001",
           "result": {"untrusted": {"ok": True, "lamport": 1}}}
    unrelated = {"lamport": 1, "room": "demo", "agent": "executor-a",
                 "op": {"op_id": "different-id", "state": "deployed", "run_id": "run-a"}}
    with self.assertRaisesRegex(AssertionError, "no committed journal witness"):
        assert_committed_receipt(self, bad, [unrelated])


OracleCalibration.test_a9_unrelated_event_at_same_lamport_is_rejected = unrelated_event


def process_crash_case(boundary):
    def test(self):
        # Empty CLI preflight gives the same fail-first stub signal as other cases.
        self.assertEqual(self.invoke(), 0)
        if boundary == "noop_before_receipt":
            self.publish()
            self.assertEqual(self.invoke(), 0)
            self.backend.noop = {"untrusted": {"ok": True, "lamport": 1}}
            self.publish(envelope(id="alive-0001", kind="agent.alive"))
            identity = "alive-0001"
            self.trace.crash_at = "before_receipt_rename"
        else:
            identity = "deploy-0001"
            self.publish()
            if boundary == "journal_commit":
                self.backend.after_commit = lambda: os._exit(77)
            else:
                self.trace.crash_at = "after_receipt_rename"
        self.trace.hard_crash = True
        process = multiprocessing.get_context("fork").Process(target=self.invoke)
        process.start()
        try:
            # This is a deadlock watchdog, never a behavioral timing assertion.
            with mock.patch("time.monotonic", watchdog_clock):
                process.join(timeout=5)
            self.assertFalse(process.is_alive(), "crash cut was not reached")
            self.assertEqual(process.exitcode, 77)
        finally:
            if process.is_alive():
                process.kill()
                with mock.patch("time.monotonic", watchdog_clock):
                    process.join(timeout=5)
            process.close()
        before = self.journal_bytes()
        self.assertEqual(len(self.events()), 1)
        self.recover_ownership()
        self.backend.after_commit = None
        self.trace.crash_at = None
        self.trace.hard_crash = False
        if boundary == "noop_before_receipt":
            self.backend.noop = {"untrusted": {"ok": True, "lamport": 999}}
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.receipt(identity)["result"], {"untrusted": {"ok": True, "lamport": 1}})
        self.assertEqual(self.journal_bytes(), before)
    return test


for _boundary in ("journal_commit", "after_receipt_rename", "noop_before_receipt"):
    setattr(RecoveryOracle, "test_a2_process_death_" + _boundary, process_crash_case(_boundary))


# A-U143: planning/work receipts use the same retained identity and durable
# publication pipeline as lifecycle, including a real writer commit crash cut.
class SliceTwoRecoveryOracle(LiveSliceTwoCase):
    def report_request(self, generation, report):
        return envelope(id="recover-report", kind="work.report", plan_opened=generation,
                        payload=report)

    def test_committed_work_report_recovers_without_second_append(self):
        generation, _, report = self.prepare_work()
        value = self.report_request(generation, report)
        self.publish(value)
        def committed_then_crashed(name, args):
            result = REAL_DISPATCH(name, args)
            if name == "work_report":
                raise Crash("committed work report before adapter completion")
            return result
        with mock.patch("bridge.room.app.dispatch", side_effect=committed_then_crashed):
            with self.assertRaises(Crash):
                self.invoke()
        committed = self.journal_bytes()
        self.assertTrue(all(task["state"] == "done" for task in self.projection()["tasks"]))
        self.assertFalse((self.spool / (value["id"] + ".result.json")).exists())
        (self.mailbox / "consumer.lock").unlink()
        self.assertEqual(self.invoke(), 0, self.stderr)
        result = self.receipt(value["id"])
        self.assertTrue(result["result"]["untrusted"]["ok"])
        self.assertEqual(self.journal_bytes(), committed)
        (self.spool / (value["id"] + ".result.json")).unlink()
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.receipt(value["id"]), result)
        self.assertEqual(self.journal_bytes(), committed)

    def test_completed_work_report_survives_receipt_publication_crash(self):
        generation, _, report = self.prepare_work()
        value = self.report_request(generation, report)
        self.publish(value)
        self.trace.crash_at = "before_receipt_rename"
        with self.assertRaises(Crash):
            self.invoke()
        committed = self.journal_bytes()
        (self.mailbox / "consumer.lock").unlink()
        with mock.patch("bridge.room.app.dispatch", side_effect=AssertionError("completed result redispatched")):
            self.assertEqual(self.invoke(), 0)
        self.assertTrue(self.receipt(value["id"])["result"]["untrusted"]["ok"])
        self.assertEqual(self.journal_bytes(), committed)
