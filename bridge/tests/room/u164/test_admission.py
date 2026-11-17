"""M1-M7: new writes are checked; existing journals retain their meaning."""
import copy
from unittest.mock import patch

from bridge.plan import apply_op_event, fold_plan
from bridge.plan.conformance import check_conformance
from bridge.room import store
from .support import EvidenceCase, BASE_TS, MID, MESSAGE


class AdmissionOracle(EvidenceCase):
    def test_m1_strict_batch_uses_missing_evidence_not_generic_conformance(self):
        self.start()
        self.refuse(lambda: self.batch([self.complete()], strict=True))

    def test_m1_nonstrict_batch_rolls_back_valid_prefix(self):
        self.start()
        ops = [dict(kind="memory.set", section="notes", base_rev=0, text="Do not persist"), self.complete()]
        self.refuse(lambda: self.batch(ops, strict=False))

    def test_m1_new_plan_batch_cannot_complete_local_task_without_evidence(self):
        ops = [dict(kind="plan.open", template_id=self.template["id"], template_hash=self.template["hash"],
                    title="Batch", brief={"goal": "Verify"}, phase="start"),
               dict(kind="task.add", key="new", title="Task", type="action", phase="start",
                    accept="Verified", microtasks=[{"text": "Check"}]),
               dict(kind="task.claim", task_id="new"),
               dict(kind="micro.set", micro_id="new.M01", state="done")]
        before = self.raw()
        with self.assertRaises(store.RoomError, msg="local-key batch bypassed required evidence") as caught:
            self.batch(ops)
        self.assertEqual(caught.exception.code, "missing_evidence")
        self.assertEqual(str(caught.exception).split(": ", 1)[-1], MESSAGE)
        self.assertEqual(self.raw(), before)

    def test_m2_batch_can_use_evidence_stored_by_earlier_member(self):
        self.start()
        self.batch([dict(kind="micro.set", micro_id=MID, state="active", evidence=self.evidence), self.complete()])
        self.assertEqual(self.task()["state"], "done")
        self.assertEqual(self.task()["microtasks"][0]["evidence"], self.evidence)

    def test_m2_outcome_text_does_not_substitute_for_evidence(self):
        self.start()
        self.refuse(lambda: self.write(self.complete(outcome="All tests passed; evidence attached elsewhere")))

    def test_m3_batch_cannot_clear_valid_evidence_after_completion(self):
        self.start()
        self.refuse(lambda: self.batch([self.complete(evidence=self.evidence), self.complete(evidence=[])]))

    def test_m3_retype_partial_completion_requires_evidence(self):
        self.start(optional=True, micros=2)
        self.write(self.complete())
        self.assertEqual(self.task()["state"], "active")
        self.refuse(lambda: self.write(self.edit(type="action")))

    def test_m3_valid_evidence_allows_retyping_and_unblocking(self):
        self.start(optional=True)
        self.write(self.complete(evidence=self.evidence))
        self.write(self.edit(state="blocked", reason="Review"))
        self.write(self.edit(type="action", state=None))
        self.assertEqual(self.task()["state"], "done")

    def test_m4_missing_template_retyping_completion_fails_closed(self):
        self.start(optional=True)
        self.write(self.complete())
        self.template_path.unlink()
        self.refuse(lambda: self.write(self.edit(type="action")), "template_unavailable", None)

    def test_m5_legacy_single_receipt_replays_before_evidence_and_template_checks(self):
        self.start()
        op = self.complete(op_id="legacy-single-0001")
        original = self.append_legacy(op, identified=True)
        before = self.snapshot()
        self.template_path.unlink()
        retry = self.write(op)
        self.assertEqual(retry, dict(original, replayed=True))
        self.assertEqual(self.snapshot(), before)

    def test_m5_legacy_admission_receipt_replays_before_evidence_and_template_checks(self):
        self.start()
        op = self.complete(op_id="legacy-admission-0001")
        original = self.append_legacy(op, identified=True)
        before = self.snapshot()
        self.template_path.unlink()
        retry = self.write(op, "admission")
        self.assertEqual(retry, dict(original, replayed=True))
        self.assertEqual(self.snapshot(), before)

    def test_m5_batch_receipts_survive_retype_and_template_loss(self):
        self.start(optional=True)
        ops = [self.complete(op_id="legacy-batch-0001")]
        original = self.batch(ops)
        self.append_legacy(self.edit(type="action"))
        before = self.snapshot()
        self.template_path.unlink()
        retry = self.batch(ops)
        self.assertEqual(retry, [dict(event, replayed=True) for event in original])
        self.assertEqual(self.snapshot(), before)

    def test_m6_legacy_fold_progress_receipts_and_plan_check_are_preserved(self):
        self.start()
        self.append_legacy(self.complete(op_id="historic-invalid-0001"), identified=True)
        before = self.snapshot()
        projection = self.state()
        self.assertEqual(projection["tasks"][0]["state"], "done")
        self.assertEqual(projection["tasks"][0]["microtasks"][0]["state"], "done")
        self.assertEqual(projection["rollup"], dict(tasks_total=1, tasks_done=1, tasks_blocked=0,
                         tasks_ready=0, micro_total=1, micro_done=1, progress=1.0, progress_pct=100))
        incremental = fold_plan([], templates=self.templates)
        for event in self.events():
            incremental, _ = apply_op_event(incremental, event, templates=self.templates)
        self.assertEqual(incremental, projection)
        self.assertTrue(projection["replayed_ops"], "legacy receipt disappeared")
        self.assertEqual(fold_plan(copy.deepcopy(self.events()), templates=self.templates), projection)
        report = self.transport("plan_check", {})["conformance"]
        self.assertEqual([f["path"] for f in report["findings"] if f["code"] == "missing_evidence"],
                         ["tasks.T01.microtasks.T01.M01.evidence"])
        self.assertEqual(self.snapshot(), before)

    def test_m6_unrelated_writes_do_not_reject_legacy_missing_evidence(self):
        self.start()
        self.append_legacy(self.complete())
        self.write(self.edit(title="Historical task"))
        self.write(dict(kind="memory.set", section="notes", base_rev=0, text="Repair later"))
        self.assertEqual(self.task()["state"], "done")
        self.assertEqual(self.task()["title"], "Historical task")
        self.assertEqual(self.state()["memory"]["notes"]["text"], "Repair later")
        self.assertTrue(any(f["code"] == "missing_evidence" for f in check_conformance(self.state(), self.template)["findings"]))

    def test_m6_repairing_legacy_completion_with_evidence_is_allowed(self):
        self.start()
        self.append_legacy(self.complete())
        self.write(self.complete(evidence=self.evidence))
        self.assertFalse(any(f["code"] == "missing_evidence" for f in check_conformance(self.state(), self.template)["findings"]))

    def test_m7_optional_strict_batch_still_completes_without_evidence(self):
        self.start(optional=True)
        self.batch([self.complete(evidence=[])], strict=True)
        self.assertEqual(self.task()["state"], "done")

    def test_stop_rule_foreign_owner_is_still_rejected_atomically(self):
        self.start()
        before = self.snapshot()
        with self.assertRaises(store.RoomError) as caught:
            store.post("oracle", "bob", "op", "", op=self.complete(evidence=self.evidence), clock=lambda: BASE_TS)
        self.assertEqual(caught.exception.code, "claimed_by_other")
        self.assertEqual(self.snapshot(), before)

    def test_stop_rule_malformed_raw_evidence_is_not_admitted(self):
        self.start()
        for evidence in ("", " ", [""], [{"path": "", "sha256": "a" * 64}]):
            with self.subTest(evidence=evidence):
                self.refuse(lambda: self.write(self.complete(evidence=evidence)), "bad_op", None)


def install_route_cases(route):
    def omitted(self):
        self.start()
        self.refuse(lambda: self.write(self.complete(), route))
    def empty(self):
        self.start()
        self.refuse(lambda: self.write(self.complete(evidence=[]), route))
    def whitespace(self):
        self.start()
        self.refuse(lambda: self.write(self.complete(evidence=[{"path": " \t\n", "sha256": "a" * 64}]), route))
    def stored_whitespace(self):
        self.start()
        self.append_legacy(dict(kind="micro.set", micro_id=MID, state="active",
                                evidence=[{"path": " \t\n", "sha256": "a" * 64}]))
        self.refuse(lambda: self.write(self.complete(), route))
    def second_micro(self):
        self.start(micros=2)
        self.write(self.complete(evidence=self.evidence))
        op = dict(kind="micro.set", micro_id="T01.M02", state="done")
        self.refuse(lambda: self.write(op, route), message="Evidence required to complete T01.M02.")
    def corrupt_template(self):
        self.start()
        self.template_path.write_text("{invalid template")
        self.refuse(lambda: self.write(self.complete(evidence=self.evidence), route), "template_unavailable", None)
    def partial(self):
        self.start(micros=2)
        self.refuse(lambda: self.write(self.complete(), route))
    def attached(self):
        self.start()
        self.write(self.complete(evidence=self.evidence), route)
        self.assertEqual(self.task()["state"], "done")
        self.assertEqual(self.task()["microtasks"][0]["evidence"], self.evidence)
    def stored(self):
        self.start()
        self.write(dict(kind="micro.set", micro_id=MID, state="active", evidence=self.evidence))
        self.write(self.complete(), route)
        self.assertEqual(self.task()["state"], "done")
        self.assertEqual(self.task()["microtasks"][0]["evidence"], self.evidence)
    def sibling(self):
        self.start(micros=2)
        self.write(dict(kind="micro.set", micro_id="T01.M02", state="active", evidence=self.evidence))
        self.refuse(lambda: self.write(self.complete(), route))
    def clear(self):
        self.start()
        self.write(self.complete(evidence=self.evidence))
        self.refuse(lambda: self.write(self.complete(evidence=[]), route))
    def reopen(self):
        self.start()
        self.write(self.complete(evidence=self.evidence))
        self.write(dict(kind="micro.set", micro_id=MID, state="pending", evidence=[]), route)
        self.assertEqual(self.task()["microtasks"][0]["state"], "pending")
    def retype(self):
        self.start(optional=True)
        self.write(self.complete())
        self.refuse(lambda: self.write(self.edit(type="action"), route))
    def unblock(self):
        self.start()
        self.write(self.edit(state="blocked", reason="Review"))
        self.append_legacy(self.complete())
        self.refuse(lambda: self.write(self.edit(state=None), route))
    def uncancel(self):
        self.start()
        self.append_legacy(self.complete())
        self.append_legacy(self.edit(state="cancelled"))
        self.refuse(lambda: self.write(self.edit(state=None), route))
    def unavailable(self):
        self.start()
        self.template_path.unlink()
        self.refuse(lambda: self.write(self.complete(evidence=self.evidence), route), "template_unavailable", None)
    def optional(self):
        self.start(optional=True)
        self.write(self.complete(evidence=[]), route)
        self.assertEqual(self.task()["state"], "done")
    def locked(self):
        self.start()
        self.write(dict(kind="micro.set", micro_id=MID, state="active", evidence=self.evidence))
        real_lock = store._lock.lock_exclusive
        captured = []
        def intervening_commit(fd):
            real_lock(fd)
            if not captured:
                self.append_legacy(dict(kind="micro.set", micro_id=MID, state="active", evidence=[]))
                captured.append(self.snapshot())
        with patch.object(store._lock, "lock_exclusive", side_effect=intervening_commit):
            with self.assertRaises(store.RoomError, msg="pre-lock evidence snapshot admitted a stale completion") as caught:
                self.write(self.complete(), route)
        self.assertEqual(caught.exception.code, "missing_evidence")
        self.assertEqual(str(caught.exception).split(": ", 1)[-1], MESSAGE)
        self.assertEqual(len(captured), 1)
        self.assertEqual(self.snapshot(), captured[0], "rejected completion leaked after the intervening commit")
        self.assert_released()
    cases = {"m1_omitted": omitted, "m2_empty": empty, "m2_whitespace": whitespace,
             "m2_stored_whitespace": stored_whitespace, "m1_partial_parent": partial, "m1_second_micro_id": second_micro,
             "m4_corrupt_template": corrupt_template,
             "m2_attached": attached, "m2_stored": stored, "m2_sibling_is_not_evidence": sibling,
             "m3_clear_done": clear, "m3_reopen": reopen, "m3_retype": retype,
             "m3_unblock": unblock, "m3_uncancel": uncancel, "m4_template_unavailable": unavailable,
             "m7_optional": optional, "m5_locked_latest_evidence": locked}
    for suffix, method in cases.items():
        name = "test_" + suffix + "_" + route
        method.__name__ = name
        setattr(AdmissionOracle, name, method)


for _route in ("single", "batch", "admission"):
    install_route_cases(_route)
