"""Replay resultless decisions through the plan fold without loading room tools."""
import json
from pathlib import Path
import unittest

from bridge.plan.errors import PlanError
from bridge.plan.fold import apply_op_event, fold_plan


_FIXTURE_PATH = Path(__file__).resolve().parents[1] / "c7" / "fixtures.json"


class ResultlessDecisionTest(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))
        self.events = self.fixture["seed"]
        self.terminal = self.events[-1]
        self.terminal["op"].pop("result")
        self.template = self.fixture["template"]

    def fold(self, events):
        return fold_plan(events, templates={self.template["id"]: self.template})

    def decision(self, verdict, **reference):
        op = dict(self.fixture["base"], verdict=verdict, reason="Worker ended without a result")
        return dict(self.terminal, id="e-0000000000000006", lamport=6, agent="reviewer",
                    op=dict(op, **reference))

    def test_keeps_resultless_decisions_for_finished_and_failed_runs(self):
        for state in ("finished", "failed"):
            self.terminal["op"]["state"] = state
            for verdict in ("HOLD", "REJECT"):
                with self.subTest(state=state, verdict=verdict):
                    decision = self.decision(verdict, result_agent="worker", result_run_id="r1")
                    projection = self.fold([*self.events, decision])
                    self.assertEqual(projection["rejected"], [])
                    self.assertEqual(projection["tasks"][0]["decisions"], [dict(decision["op"], lamport=6)])
                    self.assertEqual(projection["tasks"][0]["last_decision"], projection["tasks"][0]["decisions"][0])
                    key = json.dumps(["worker", self.terminal["op"]["op_id"]], separators=(",", ":"))
                    self.assertEqual(projection["replayed_ops"][key]["op"], self.terminal["op"])

    def test_refuses_admit_with_exact_detail_and_no_decision(self):
        decision = self.decision("ADMIT", result_agent="worker", result_run_id="r1")
        with self.assertRaisesRegex(PlanError, "^ADMIT needs a recorded result$") as caught:
            apply_op_event(self.fold(self.events), decision)
        self.assertEqual(caught.exception.code, "bad_op")
        projection = self.fold([*self.events, decision])
        self.assertEqual([r["code"] for r in projection["rejected"]], ["bad_op"])
        self.assertNotIn("last_decision", projection["tasks"][0])

    def test_legacy_reference_still_requires_a_result(self):
        decision = self.decision("HOLD", agent="worker", run_id="r1")
        with self.assertRaisesRegex(PlanError, "^unknown result reference$") as caught:
            apply_op_event(self.fold(self.events), decision)
        self.assertEqual(caught.exception.code, "bad_op")
