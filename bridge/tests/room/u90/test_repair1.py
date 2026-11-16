"""Repair regressions for task-scoped activity retirement and hostile notes."""
import copy
import json
import unittest

from bridge.plan.errors import PlanError
from bridge.plan.fold import apply_op_event, fold_plan
from bridge.plan.ops import validate_op_shape
from bridge.tests.room.u90.test_activity import FIXTURE, beat, event


class RepairActivityTests(unittest.TestCase):
    def setUp(self):
        self.state = fold_plan(FIXTURE["seed"])
        self.events = copy.deepcopy(FIXTURE["seed"])

    def apply(self, ev):
        self.state, _ = apply_op_event(json.loads(json.dumps(self.state)), ev)
        self.events.append(ev)

    def activate_sibling(self, n, agent="alice"):
        self.apply(event(n, dict(kind="micro.set", micro_id="T01.M02", state="active"), agent))

    def test_superseded_run_cannot_poison_new_sibling(self):
        for ev in (beat(10), beat(11, "run_B")):
            self.apply(ev)
        self.activate_sibling(12)
        current = beat(13, "run_B")
        del current["op"]["micro_id"]
        self.apply(current)
        late = beat(14)
        del late["op"]["micro_id"]
        self.apply(late)
        self.assertEqual([m["live"]["run_id"] for m in self.state["tasks"][0]["microtasks"][:2]], ["run_B", "run_B"])
        self.assertEqual(self.state, fold_plan(self.events))

    def test_supersession_retires_live_on_untargeted_sibling(self):
        self.apply(beat(10))
        self.activate_sibling(11)
        self.apply(beat(12, "run_B", micro_id="T01.M02"))
        self.assertNotIn("live", self.state["tasks"][0]["microtasks"][0])
        self.apply(beat(13))
        self.assertNotIn("live", self.state["tasks"][0]["microtasks"][0])

    def test_task_lifecycle_retires_runs_for_future_siblings(self):
        for transition in ("blocked", "cancelled", "release", "reassign"):
            with self.subTest(transition=transition):
                self.setUp()
                self.apply(beat(10))
                owner = "alice"
                if transition in ("blocked", "cancelled"):
                    self.apply(event(11, dict(kind="task.set", task_id="T01", base_rev=5, state=transition)))
                    self.apply(event(12, dict(kind="task.set", task_id="T01", base_rev=11, state=None)))
                elif transition == "release":
                    self.apply(event(11, dict(kind="task.release", task_id="T01")))
                    self.apply(event(12, dict(kind="task.claim", task_id="T01")))
                else:
                    owner = "mallory"
                    self.apply(event(11, dict(kind="task.claim", task_id="T01", takeover=True), owner, 700001))
                self.activate_sibling(13, owner)
                late = beat(14, micro_id="T01.M02")
                late["agent"] = owner
                self.apply(late)
                self.assertNotIn("live", self.state["tasks"][0]["microtasks"][1])
                self.assertEqual(self.state, fold_plan(self.events))

    def test_close_retires_at_task_scope(self):
        self.apply(beat(10))
        self.apply(event(11, dict(kind="plan.close", base_rev=1)))
        self.assertIn("run_A", self.state["replayed_ops"]["activity.retired"]["T01"])
        self.assertNotIn("live", self.state["tasks"][0]["microtasks"][0])

    def test_release_retires_run_even_after_microtask_left_active(self):
        self.apply(beat(10))
        self.apply(event(11, dict(kind="micro.set", micro_id="T01.M01", state="pending")))
        self.apply(event(12, dict(kind="task.release", task_id="T01")))
        self.apply(event(13, dict(kind="task.claim", task_id="T01")))
        self.activate_sibling(14)
        self.apply(beat(15, micro_id="T01.M02"))
        self.assertNotIn("live", self.state["tasks"][0]["microtasks"][1])

    def test_retirement_is_bounded_without_readmitting_evicted_runs(self):
        for n in range(10, 280):
            self.apply(beat(n, f"run_{n}"))
        retired = self.state["replayed_ops"]["activity.retired"]
        self.assertTrue(all(len(runs) <= 256 for runs in retired.values()))
        self.activate_sibling(280)
        self.apply(beat(281, "run_10", micro_id="T01.M02"))
        self.assertNotIn("live", self.state["tasks"][0]["microtasks"][1])

    def test_malformed_receipt_times_do_not_crash_takeover(self):
        for receipt in ({}, {"beat_ts": None}, {"beat_ts": "recent"}, {"beat_ts": {}}, {"beat_ts": 2**53}):
            with self.subTest(receipt=receipt):
                self.setUp()
                self.apply(event(10, dict(kind="task.claim", task_id="T01")))
                self.state["replayed_ops"]["corrupt"] = dict(kind="activity.beat", agent="alice", **receipt)
                self.apply(event(11, dict(kind="task.claim", task_id="T01", takeover=True), "mallory", 700001))
                self.assertEqual(self.state["tasks"][0]["assignee"], "mallory")

    def test_authority_precedes_microtask_lookup(self):
        ev = beat(10, micro_id="T01.M12")
        ev["agent"] = "mallory"
        with self.assertRaises(PlanError) as caught:
            apply_op_event(self.state, ev)
        self.assertEqual(caught.exception.code, "claimed_by_other")

    def test_notes_reject_c0_del_and_c1_controls(self):
        for control in ("\x00", "\t", "\n", "\x1b", "\x7f", "\x85", "\x9f"):
            with self.subTest(control=repr(control)):
                with self.assertRaises(PlanError) as caught:
                    validate_op_shape(dict(FIXTURE["beat"]["op"], note=f"passive{control}text"))
                self.assertEqual(caught.exception.code, "bad_op")


if __name__ == "__main__":
    unittest.main()
