"""A8 activated semantic mutants; infrastructure failures never count."""
from collections import Counter
import copy
from types import SimpleNamespace
import unittest
from unittest import mock

from bridge.plan import fold as reducer
from .support import (FIELDS, ProjectionCopyMeter, assert_atomic_fault,
    assert_no_container_growth, assert_public_detachment, assert_boolean_revision_rejected,
    assert_rejection_retry, budget_history, event, fault_run, populated, replay_key)

CONTROL_RECORDS = {}


def assess(action, oracle):
    record = {"activated": 0, "detected": 0, "infrastructure_failures": []}
    try:
        value, activated = action()
        record["activated"] = int(bool(activated))
        if not activated:
            record["infrastructure_failures"].append("inactive mutant")
            return record
    except Exception as error:
        record["infrastructure_failures"].append(type(error).__name__)
        return record
    try:
        oracle(value)
    except AssertionError:
        record["detected"] = 1
    except Exception as error:
        record["infrastructure_failures"].append(type(error).__name__)
    return record


class NegativeControls(unittest.TestCase):
    def test_public_input_reuse_is_detected_by_a2_assertions(self):
        activation = []
        def reuse(state, e, **kwargs):
            value, result = reducer.apply_op_event(state, e, **kwargs)
            # Explicit reuse mutant, independent of how production clones.
            state.clear()
            state.update(value)
            activation.append(True)
            return state, result
        record = assess(lambda: (reuse, True), lambda apply: assert_public_detachment(self, apply))
        self.assertTrue(activation, "reuse mutant was not executed")
        self.assertEqual(record, {"activated": 1, "detected": 1, "infrastructure_failures": []})
        CONTROL_RECORDS["public-input-reuse"] = record

    def test_tentative_task_and_memory_leaks_are_detected_by_a6_assertions(self):
        for scope in ("task", "memory"):
            with self.subTest(scope=scope):
                run = fault_run(scope, leak=True)
                self.assertEqual(run[2]["injected"], 1)
                self.assertGreater(run[2]["leaked"], 0)
                record = assess(lambda: (run, run[2]["leaked"] > 0), lambda value: assert_atomic_fault(self, value))
                self.assertEqual(record, {"activated": 1, "detected": 1, "infrastructure_failures": []})
                CONTROL_RECORDS["tentative-" + scope + "-leak"] = record

    def test_manual_linear_container_copies_are_detected_separately_from_deepcopy(self):
        real = reducer._recompute
        activation = []
        def manual_copy(state):
            # O(N) shallow copies, with no use of copy.copy/deepcopy for them.
            state["tasks"] = [item for item in state["tasks"]]
            state["memory"] = {key: value for key, value in state["memory"].items()}
            state["replayed_ops"] = {key: value for key, value in state["replayed_ops"].items()}
            state["archived_plans"] = [item for item in state["archived_plans"]]
            activation.append(True)
            real(state)
        baseline, mutants = [], []
        for suffix in (1, 5):
            events = budget_history(suffix)
            original = ProjectionCopyMeter()
            expected = original.run(events)
            mutant = ProjectionCopyMeter(extra_codes=(manual_copy.__code__,))
            with mock.patch.object(reducer, "_recompute", manual_copy):
                actual = mutant.run(events)
            self.assertEqual(actual, expected, "copy-only mutant changed semantics")
            self.assertEqual(actual["rejected"], [])
            baseline.append(original)
            mutants.append(mutant)
        delta = [SimpleNamespace(work=Counter({field: changed.work[field] - original.work[field] for field in FIELDS}))
                 for original, changed in zip(baseline, mutants)]
        self.assertTrue(activation)
        for field in FIELDS:
            self.assertGreater(delta[1].work[field], delta[0].work[field], "manual copy probe missed " + field)
        record = assess(lambda: (delta, True), lambda values: assert_no_container_growth(self, *values))
        self.assertEqual(record, {"activated": 1, "detected": 1, "infrastructure_failures": []})
        CONTROL_RECORDS["manual-linear-container-copy"] = record

    def test_boolean_as_integer_mutant_is_detected(self):
        activation = []
        def accept_boolean(state, e, **kwargs):
            value = copy.deepcopy(e)
            if value.get("op", {}).get("base_rev") is False:
                value["op"]["base_rev"] = 0
                activation.append(True)
            return reducer.apply_op_event(state, value, **kwargs)
        record = assess(lambda: (accept_boolean, True), lambda apply: assert_boolean_revision_rejected(self, apply))
        self.assertTrue(activation)
        self.assertEqual(record, {"activated": 1, "detected": 1, "infrastructure_failures": []})
        CONTROL_RECORDS["boolean-as-integer"] = record

    def test_rejection_reserving_op_id_is_detected(self):
        activation = []
        def reserve_rejection(state, e, **kwargs):
            try:
                return reducer.apply_op_event(state, e, **kwargs)
            except reducer.PlanError:
                op = e.get("op", {})
                if "op_id" in op:
                    state["replayed_ops"][replay_key(op["op_id"], e["agent"])] = {"kind": op["kind"], "op_id": op["op_id"]}
                    activation.append(True)
                raise
        record = assess(lambda: (reserve_rejection, True), lambda apply: assert_rejection_retry(self, apply))
        self.assertTrue(activation)
        self.assertEqual(record, {"activated": 1, "detected": 1, "infrastructure_failures": []})
        CONTROL_RECORDS["rejection-reserves-op-id"] = record

    def test_post_call_input_alias_is_detected(self):
        activation = []
        def alias_memory(state, e, **kwargs):
            value, result = reducer.apply_op_event(state, e, **kwargs)
            value["memory"] = state["memory"]
            activation.append(True)
            return value, result
        def oracle(apply):
            state = populated()
            value, result = apply(state, event(20, {"kind": "task.set", "task_id": "T01", "base_rev": 6, "title": "Updated"}))
            frozen = copy.deepcopy((value, result))
            state["memory"]["notes"]["text"] = "post-call input edit"
            self.assertEqual((value, result), frozen, "post-call input mutation reached returned projection")
        record = assess(lambda: (alias_memory, True), oracle)
        self.assertTrue(activation)
        self.assertEqual(record, {"activated": 1, "detected": 1, "infrastructure_failures": []})
        CONTROL_RECORDS["post-call-input-alias"] = record

    def test_import_crashes_inactive_mutants_and_oracle_crashes_are_not_detection(self):
        def crash():
            raise ImportError("deliberate infrastructure control")
        def oracle_crash(_):
            raise RuntimeError("deliberate oracle crash")
        records = [assess(crash, lambda _: None),
                   assess(lambda: ({}, False), lambda _: self.fail("inactive mutant")),
                   assess(lambda: ({}, True), oracle_crash)]
        for record in records:
            self.assertEqual(record["detected"], 0)
            self.assertTrue(record["infrastructure_failures"])
        CONTROL_RECORDS["infrastructure-controls"] = records
