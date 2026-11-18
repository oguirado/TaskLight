"""Check lifecycle histories against the hand-written R52E projection."""
import json
from pathlib import Path
import unittest

from bridge.plan.fold import fold_plan


GOLDEN = json.loads(Path(__file__).with_name("lifecycle_cycle.json").read_text(encoding="utf-8"))
PARENT_FIELDS = ("lifecycle", "run_id", "parent_agent", "parent_run_id", "lamport")


class LifecycleCycleTests(unittest.TestCase):
    def assert_history(self, history):
        projection = fold_plan(history["events"])
        parents = {
            agent: {field: record[field] for field in PARENT_FIELDS if field in record}
            for agent, record in projection.get("agent_lifecycle", {}).items()
        }
        self.assertEqual(parents, history["expected"]["parents"])
        self.assertEqual(projection["rejected"], history["expected"]["rejected"])

    def test_rejects_parent_cycle_with_server_receipt(self):
        self.assert_history(GOLDEN["cycle"])

    def test_accepts_valid_parent_chain(self):
        self.assert_history(GOLDEN["valid_chain"])
