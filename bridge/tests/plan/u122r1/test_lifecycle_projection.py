"""Public lifecycle no-ops must preserve projection type and copy semantics."""
import copy
import json
import unittest

from bridge.plan.fold import PlanProjection, apply_op_event, fold_plan
from bridge.tests.plan.support import event


class LifecycleProjectionRegression(unittest.TestCase):
    def test_plain_dict_noop_returns_detached_plan_projection(self):
        deployed = {"kind": "agent.lifecycle", "state": "deployed",
                    "run_id": "run-1", "op_id": "deploy-0001"}
        alive = dict(deployed, state="alive", op_id="alive-0001")
        state = json.loads(json.dumps(fold_plan([
            event(1, deployed, ts=1000), event(2, alive, ts=2000),
        ])))
        self.assertIs(type(state), dict)
        noop = event(3, dict(alive, op_id="alive-0002"), ts=3000)
        activity = {"alice": 2000}
        before = copy.deepcopy((state, noop, activity))

        projection, receipt = apply_op_event(
            state, noop, last_by_agent=activity)

        self.assertIsInstance(projection, PlanProjection)
        self.assertTrue(receipt["noop"])
        self.assertEqual(receipt["lamport"], 2)
        self.assertEqual(projection["last_lamport"], 3)
        self.assertEqual(projection["agent_lifecycle"], state["agent_lifecycle"])
        self.assertEqual((state, noop, activity), before)
        replay_key = json.dumps(["alice", "alive-0002"], separators=(",", ":"))
        original_receipt = copy.deepcopy(receipt)
        self.assertEqual(projection["replayed_ops"][replay_key], original_receipt)

        # A JSON continuation loses the subclass and must regain it on replay.
        continued = json.loads(json.dumps(projection))
        continuation_before = copy.deepcopy(continued)
        retried, replay = apply_op_event(
            continued, event(4, noop["op"], ts=80000))
        self.assertIsInstance(retried, PlanProjection)
        self.assertEqual(replay, dict(original_receipt, replayed=True))
        self.assertEqual(retried["last_lamport"], 4)
        self.assertEqual(retried["agent_lifecycle"], state["agent_lifecycle"])
        replay["op"]["state"] = "failed"
        retried["agent_lifecycle"]["alice"]["retired_run_ids"].append("caller-run")
        self.assertEqual(continued, continuation_before)
        self.assertEqual(retried["replayed_ops"][replay_key], original_receipt)

        receipt["op"]["state"] = "failed"
        projection["agent_lifecycle"]["alice"]["retired_run_ids"].append("caller-run")
        self.assertEqual(projection["replayed_ops"][replay_key], original_receipt)
        self.assertEqual((state, noop, activity), before)
        state["agent_lifecycle"]["alice"]["run_id"] = "input-edit"
        noop["op"]["run_id"] = "event-edit"
        self.assertEqual(projection["agent_lifecycle"]["alice"]["run_id"], "run-1")
        self.assertEqual(projection["replayed_ops"][replay_key], original_receipt)
