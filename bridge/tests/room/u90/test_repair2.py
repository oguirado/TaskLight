"""Plan-scoped retirement reset and rejection atomicity regressions."""
import copy
import json
import unittest

from bridge.plan.errors import PlanError
from bridge.plan.fold import apply_op_event, fold_plan
from bridge.tests.room.u90.test_activity import FIXTURE, beat, event


def saturated_history():
    history = copy.deepcopy(FIXTURE["seed"])
    history.append(event(10, dict(kind="memory.set", section="notes", text="Keep", base_rev=0, op_id="keep-memory")))
    # The next supersession after the bounded retirement set fills seals it.
    history.extend(beat(20 + i, f"run_{i:03d}") for i in range(258))
    return history


def reopen_events(run_id):
    return [
        # A-U109c: (a) close/reopen histories first cancel unfinished tasks, M6.
        event(298, dict(kind="task.set", task_id="T01", base_rev=5, state="cancelled")),
        event(299, dict(kind="task.set", task_id="T02", base_rev=3, state="cancelled")),
        event(300, dict(kind="plan.close", base_rev=1, op_id="close-old")),
        event(301, dict(FIXTURE["seed"][0]["op"], title="New plan", op_id="open-new")),
        event(302, dict(FIXTURE["seed"][1]["op"], op_id="add-next")),
        event(303, dict(kind="micro.set", micro_id="T01.M01", state="active", op_id="active-new")),
        beat(304, run_id),
    ]


class RepairTwoTests(unittest.TestCase):
    def test_saturation_is_reset_only_by_successful_plan_open(self):
        history = saturated_history()
        sealed = fold_plan(history)
        self.assertEqual(sealed["replayed_ops"]["activity.retired"]["T01"], ["*"])
        self.assertNotIn("live", sealed["tasks"][0]["microtasks"][0])
        before = copy.deepcopy(sealed)
        with self.assertRaises(PlanError) as rejected:
            apply_op_event(sealed, event(280, FIXTURE["seed"][0]["op"]))
        self.assertEqual(rejected.exception.code, "plan_exists")
        self.assertEqual(sealed, before)
        for run_id in ("run_000", "fresh_run"):
            with self.subTest(run_id=run_id):
                state = copy.deepcopy(sealed)
                for ev in reopen_events(run_id):
                    state, _ = apply_op_event(json.loads(json.dumps(state)), ev)
                    if ev["op"]["kind"] == "plan.open":
                        self.assertNotIn("activity.retired", state["replayed_ops"])
                self.assertEqual(state, fold_plan(history + reopen_events(run_id)))
                self.assertEqual(state["tasks"][0]["microtasks"][0]["live"], dict(
                    agent="alice", run_id=run_id, beat_ts=30400, beat_lamport=304))
                self.assertEqual(state["memory"], sealed["memory"])
                self.assertEqual(len(state["archived_plans"]), 1)
                for key, receipt in sealed["replayed_ops"].items():
                    if key != "activity.retired":
                        self.assertEqual(state["replayed_ops"][key], receipt)

    def test_unsaturated_retired_run_can_be_reused_in_new_plan(self):
        history = copy.deepcopy(FIXTURE["seed"]) + [beat(10, "run_000"), beat(11, "run_B")]
        self.assertIn("run_000", fold_plan(history)["replayed_ops"]["activity.retired"]["T01"])
        state = fold_plan(history + reopen_events("run_000"))
        self.assertEqual(state["tasks"][0]["microtasks"][0]["live"]["run_id"], "run_000")

    def test_rejection_of_each_kind_preserves_the_input_projection(self):
        state = fold_plan(copy.deepcopy(FIXTURE["seed"]) + [beat(10)])
        cases = [
            (dict(FIXTURE["seed"][0]["op"]), "plan_exists", "alice"),
            (dict(kind="plan.close", base_rev=999), "stale_rev", "alice"),
            (dict(kind="plan.phase", base_rev=999, phase="finish"), "stale_rev", "alice"),
            (dict(FIXTURE["seed"][1]["op"], deps=["T40"]), "not_found", "alice"),
            (dict(kind="task.set", task_id="T01", base_rev=5, title="Changed", deps=["T01"]), "dep_cycle", "alice"),
            (dict(kind="task.claim", task_id="T01"), "claimed_by_other", "mallory"),
            (dict(kind="task.release", task_id="T01"), "claimed_by_other", "mallory"),
            (dict(kind="micro.add", task_id="T01", base_rev=999, text="New"), "stale_rev", "alice"),
            (dict(kind="micro.set", micro_id="T01.M01", state="done"), "claimed_by_other", "mallory"),
            (dict(kind="memory.set", section="notes", base_rev=999, text="Changed"), "stale_rev", "alice"),
            (dict(kind="activity.beat", task_id="T01", run_id="run_B", op_id="reject-beat"), "claimed_by_other", "mallory"),
        ]
        for op, code, agent in cases:
            with self.subTest(kind=op["kind"]):
                before = copy.deepcopy(state)
                with self.assertRaises(PlanError) as rejected:
                    apply_op_event(state, event(100, op, agent))
                self.assertEqual(rejected.exception.code, code)
                self.assertEqual(state, before)


if __name__ == "__main__":
    unittest.main()
