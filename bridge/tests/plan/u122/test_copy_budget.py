"""A7: structural copy work, independent of clock speed and payload copies."""
import copy
import unittest

from bridge.plan import fold as reducer
from .support import (FIELDS, ProjectionCopyMeter, assert_no_container_growth,
                      budget_history, event, populated, templates)


class CopyBudget(unittest.TestCase):
    def test_valid_suffix_does_not_add_full_projection_deepcopies(self):
        short, long = ProjectionCopyMeter(), ProjectionCopyMeter()
        a, b = short.run(budget_history(1)), long.run(budget_history(5))
        self.assertEqual(a["rejected"], [])
        self.assertEqual(b["rejected"], [])
        self.assertGreater(short.payload, 0, "payload copying must be measured separately")
        self.assertEqual(long.full, short.full, "each extra folded operation still deep-copies the full projection")

    def test_valid_suffix_does_not_add_projection_container_copy_work(self):
        short, long = ProjectionCopyMeter(), ProjectionCopyMeter()
        a, b = short.run(budget_history(1)), long.run(budget_history(5))
        self.assertEqual(a["rejected"], [])
        self.assertEqual(b["rejected"], [])
        for field in FIELDS:
            self.assertGreaterEqual(len(a[field]), 8, "copy gate requires populated containers")
        assert_no_container_growth(self, short, long)

    def test_public_application_still_detaches_when_fold_copy_budget_changes(self):
        state = populated()
        before = copy.deepcopy(state)
        value, _ = reducer.apply_op_event(state, event(20, {"kind": "task.set", "task_id": "T01", "base_rev": 6, "title": "Updated"}), templates=templates())
        value["tasks"][0]["microtasks"][0]["live"]["run_id"] = "caller edit"
        value["memory"]["notes"]["text"] = "caller edit"
        self.assertEqual(state, before)
