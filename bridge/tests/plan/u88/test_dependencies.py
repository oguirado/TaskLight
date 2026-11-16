"""Fail-first U88 folding contract; no implementation or network writes."""
import copy
import unittest

from bridge.plan.errors import PlanError
from bridge.plan.fold import _derived, apply_op_event
from .fixtures import (CASES, TEMPLATES, canonical, event, events_for, folded,
                       incremental, vector)


def prerequisite_probe(state):
    target = {"id": "T01", "state": state}
    dependant = {"id": "T02", "deps": ["T01"],
                 "microtasks": [{"id": "T02.M01", "state": "pending"}]}
    by_id = {} if state == "missing" else {"T01": target}
    return dependant, by_id


class DependencyOracle(unittest.TestCase):
    def test_A2_incremental_cancellation_recomputes_immediately(self):
        events = events_for(vector("A1_pending"))
        before = folded(events)
        original = copy.deepcopy(before)
        cancellation = event(4, {"kind": "task.set", "task_id": "T01",
                                 "base_rev": before["tasks"][0]["rev"],
                                 "state": "cancelled"})
        after, _ = apply_op_event(before, cancellation, templates=TEMPLATES)
        self.assertEqual(before, original, "accepted operations must not mutate the input")
        self.assertEqual(after, folded(events + [cancellation]))
        self.assertEqual(canonical(after), vector("A1_cancelled")["expected"])

    def test_A2_clear_override_recomputes_from_pending_with_latest_revision(self):
        events = events_for(vector("A1_cancelled"))
        cancelled = folded(events)
        reversal = event(5, {"kind": "task.set", "task_id": "T01",
                             "base_rev": cancelled["tasks"][0]["rev"], "state": None})
        after, _ = apply_op_event(cancelled, reversal, templates=TEMPLATES)
        self.assertEqual(after, folded(events + [reversal]))
        self.assertEqual(canonical(after), vector("A2_reversed")["expected"])
        self.assertIsNone(after["tasks"][0]["explicit_state"])

    def test_A2_op_id_replay_preserves_cancellation_without_extra_revision(self):
        events = events_for(vector("A1_pending"))
        cancellation = event(4, {"kind": "task.set", "task_id": "T01", "base_rev": 2,
                                 "state": "cancelled", "op_id": "cancel-once"})
        after, _ = apply_op_event(folded(events), cancellation, templates=TEMPLATES)
        duplicate = event(5, cancellation["op"])
        replayed, result = apply_op_event(after, duplicate, templates=TEMPLATES)
        self.assertTrue(result["replayed"])
        self.assertEqual(replayed["tasks"], after["tasks"])
        self.assertEqual(replayed["rollup"], after["rollup"])
        self.assertEqual(replayed, folded(events + [cancellation, duplicate]))

    def test_A4_cancellation_preserves_microdata_ownership_revisions_and_progress(self):
        case = vector("A1_pending")
        case["ops"][1]["microtasks"] *= 3
        events = events_for(case)
        events += [event(4, {"kind": "task.claim", "task_id": "T01", "base_rev": 2}),
                   event(5, {"kind": "micro.set", "micro_id": "T01.M01", "state": "done",
                             "outcome": "Verified", "took": "1m",
                             "evidence": [{"path": "proof.txt", "sha256": "a" * 64}]}),
                   event(6, {"kind": "micro.set", "micro_id": "T01.M02", "state": "active"})]
        before = incremental(events)
        snapshot = copy.deepcopy(before)
        cancellation = event(7, {"kind": "task.set", "task_id": "T01",
                                 "base_rev": before["tasks"][0]["rev"], "state": "cancelled"})
        after, _ = apply_op_event(before, cancellation, templates=TEMPLATES)
        self.assertEqual(before, snapshot)
        self.assertEqual(after["tasks"][0]["microtasks"], before["tasks"][0]["microtasks"])
        expected_task = {**before["tasks"][0], "explicit_state": "cancelled",
                         "state": "cancelled", "ready": False, "rev": 7}
        self.assertEqual(after["tasks"][0], expected_task)
        expected_dependant = {**before["tasks"][1], "ready": True}
        # Assert preservation independently of the missing readiness behavior below.
        for key in before["tasks"][1]:
            if key != "ready":
                self.assertEqual(after["tasks"][1][key], expected_dependant[key])
        for key in ("tasks_done", "micro_done", "progress", "progress_pct"):
            self.assertEqual(after["rollup"][key], before["rollup"][key])
        for key in ("plan", "memory", "archived_plans"):
            self.assertEqual(after[key], before[key])
        self.assertEqual(after, folded(events + [cancellation]))

    def test_A4_unlocking_never_activates_or_manufactures_liveness(self):
        after = folded(events_for(vector("A1_cancelled")))
        dependant = after["tasks"][1]
        self.assertEqual(dependant["state"], "pending")
        self.assertEqual(dependant["microtasks"][0]["state"], "pending")
        self.assertNotIn("live", dependant["microtasks"][0])
        self.assertTrue(dependant["ready"], "unlocked work stays pending")

    def test_A4_terminal_dependants_and_empty_dependencies(self):
        for name in ("A4_terminal_done", "A4_terminal_cancelled"):
            projection = folded(events_for(vector(name)))
            by_id = {t["id"]: t for t in projection["tasks"]}
            self.assertEqual(_derived(projection["tasks"][1], by_id)[1], False)
        pending = folded(events_for(vector("A1_pending")))
        self.assertTrue(_derived(pending["tasks"][0], {})[1])


def truth_test(state, expected):
    def test(self):
        task, by_id = prerequisite_probe(state)
        self.assertEqual(_derived(task, by_id), ("pending", expected))
    return test


for _state, _expected in (("done", True), ("cancelled", True), ("pending", False),
                          ("active", False), ("blocked", False), ("missing", False)):
    setattr(DependencyOracle, f"test_A1_derived_{_state}", truth_test(_state, _expected))


def folding_test(case):
    def test(self):
        events = events_for(case)
        replay = folded(events)
        applied = incremental(events)
        self.assertEqual(replay["rejected"], [], "fixture must contain only valid operations")
        self.assertEqual(applied, replay)
        self.assertEqual(canonical(replay), case["expected"])
    return test


for _case in CASES:
    setattr(DependencyOracle, f"test_{_case['name']}_fold", folding_test(_case))


def reverse_test(name):
    def test(self):
        case = vector(name)
        events = events_for(case)
        before = incremental(events[:-1])
        before["tasks"].reverse()
        after, _ = apply_op_event(before, events[-1], templates=TEMPLATES)
        self.assertEqual(canonical(after), case["expected"])
    return test


for _name in ("A3_conjunction_wait", "A3_conjunction_done", "A3_conjunction_cancelled", "A3_chain"):
    setattr(DependencyOracle, f"test_{_name}_reversed_array", reverse_test(_name))


def rejection_test(changes, code):
    def test(self):
        events = events_for(vector("A1_pending"))
        before = folded(events)
        snapshot = copy.deepcopy(before)
        op = {"kind": "task.set", "task_id": "T02",
              "base_rev": before["tasks"][1]["rev"], **changes}
        hostile = event(4, op)
        with self.assertRaises(PlanError) as raised:
            apply_op_event(before, hostile, templates=TEMPLATES)
        self.assertEqual(raised.exception.code, code)
        self.assertEqual(before, snapshot)
        replay = folded(events + [hostile])
        self.assertEqual([r["code"] for r in replay["rejected"]], [code])
        for key in ("plan", "tasks", "memory", "archived_plans", "rollup"):
            self.assertEqual(replay[key], before[key])
    return test


for _name, _changes, _code in (
    ("missing_dependency", {"deps": ["T40"]}, "not_found"),
    ("self_dependency", {"deps": ["T02"]}, "dep_cycle"),
    ("forged_state", {"state": "cancelled<script>"}, "bad_op"),
    ("stale_revision", {"base_rev": 2, "state": "cancelled"}, "stale_rev"),
    ("missing_task", {"task_id": "T40", "state": "cancelled"}, "not_found"),
    ("transitive_cycle", {"task_id": "T01", "base_rev": 2, "deps": ["T02"]}, "dep_cycle"),
):
    setattr(DependencyOracle, f"test_A6_{_name}", rejection_test(_changes, _code))
