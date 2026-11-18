"""Check pipeline admission independently of ordinary task state."""

import random
import string

from bridge.room import store
from bridge.wall.room_relay import sanitize_event
from bridge.tests.room.c7.support import event
from bridge.tests.room.c8.support import ORCHESTRATOR, ROOM, STEPS, PipelineRoom


class PipelineNegativeControls(PipelineRoom):
    def test_generic_completion_and_task_level_decision_do_not_unlock_spec(self):
        # A-R52G: Seed committed history so generic completion reaches the predecessor check.
        events = self.events()
        completion = {"kind": "micro.set", "op_id": self.op_id(),
                      "micro_id": self.micro_id("diagnosis"), "state": "done"}
        self.install([*events, event(events[-1]["lamport"] + 1, completion, ORCHESTRATOR)])
        self.call("unit_decide", self.unit_args(verdict="ADMIT", reason="Task-level observation"))
        run = self.deploy("ordinary")
        self.assert_stops(lambda: self.bind("spec", run), "not_conformant")
        self.bind("diagnosis", run)

    def test_only_unit_owner_can_decide_even_after_ordinary_release(self):
        run = self.deploy("foreign-decision")
        self.bind("diagnosis", run)
        self.call("task_release", self.unit_args())
        self.call("task_claim", self.unit_args(agent=run[0]))
        self.lifecycle(run, "finished", "OK")
        self.assert_stops(lambda: self.decide("diagnosis", run, agent=run[0]), "claimed_by_other")
        self.decide("diagnosis", run)

    def test_wrong_recipe_and_foreign_owner_are_atomic(self):
        base = self.unit_args(type="unit", phase="plan", title="Another unit", accept="")
        del base["task_id"]
        for micros in ([{"text": "diagnosis"}], [{"text": step} for step in reversed(STEPS)]):
            self.assert_stops(lambda: self.call("task_add", dict(base, microtasks=micros)), "bad_op")
        self.assert_stops(lambda: self.call("task_add", dict(base, assignee="someone-else")), "bad_op")
        self.call("task_add", base)
        unit = self.projection()["tasks"][-1]
        self.assertEqual(unit["assignee"], ORCHESTRATOR)
        self.assertEqual([micro["text"] for micro in unit["microtasks"]], list(STEPS))

    def test_exact_retries_do_not_replace_attempts_and_changed_requests_conflict(self):
        run = self.deploy("retry")
        args = self.step_args("diagnosis", run)
        bind = self.call("unit_bind", args)
        self.lifecycle(run, "finished")
        decision_args = self.step_args("diagnosis", run, verdict="HOLD", reason="Resultless run")
        decision = self.call("unit_decide", decision_args)
        replacement = self.deploy("fresh")
        self.bind("diagnosis", replacement)
        before = self.raw()
        self.assertEqual(self.call("unit_bind", args), bind)
        self.assertEqual(self.call("unit_decide", decision_args), decision)
        self.assertEqual(self.raw(), before)
        self.assert_stops(lambda: self.call("unit_decide", dict(decision_args, reason="Changed")),
                          "bad_op", "op_id conflict")

    def test_a_batch_cannot_skip_the_predecessor_gate(self):
        run = self.deploy("batch")
        bind = self.step_args("spec", run)
        op = {"kind": "unit.bind", **{key: value for key, value in bind.items()
                                     if key not in ("room", "agent")}}
        # A-R52G: Use an admissible progress edit so the batch reaches the predecessor check.
        ordinary = {"kind": "micro.set", "op_id": self.op_id(),
                    "micro_id": self.micro_id("diagnosis"), "state": "active"}
        self.assert_stops(lambda: store.post_ops(ROOM, ORCHESTRATOR, [ordinary, op]), "not_conformant")
        self.assertEqual(self.states(), ("pending",) * len(STEPS))

    def test_late_failure_after_repair_is_history_only(self):
        self.prefix(3)
        run = self.deploy("late-author")
        self.bind("author", run)
        self.repair()
        self.lifecycle(run, "failed", "FAIL")
        author = self.task()["pipeline"]["steps"][3]
        self.assertIsNone(author["binding"])
        self.assertEqual(author["attempts"][0]["state"], "failed")
        self.assertEqual(self.states(), ("done",) * 3 + ("pending",) * 4)
        self.bind("author", self.deploy("replacement"))

    def test_relay_masking_keeps_registration_and_binding_coordinates(self):
        generated = random.Random(27).choices(string.ascii_letters + string.digits, k=48)
        run = ("worker-relay", "".join(generated))
        self.lifecycle(run, "deployed")
        self.bind("diagnosis", run)
        self.lifecycle(run, "finished", "OK")
        self.decide("diagnosis", run)
        deploy, bind, terminal, decision = [sanitize_event(event) for event in self.events()[-4:]]
        self.assertEqual(deploy["op"]["run_id"], terminal["op"]["run_id"])
        self.assertNotEqual(deploy["op"]["run_id"], run[1])
        self.assertEqual(bind["op"]["result_run_id"], "[REDACTED:HIGH_ENTROPY]")
        self.assertEqual(decision["op"]["result_run_id"], "[REDACTED:HIGH_ENTROPY]")
        self.assertEqual(bind["op"]["registration_lamport"], deploy["lamport"])
        self.assertEqual(decision["op"]["binding_lamport"], bind["lamport"])
        self.assertEqual(self.states()[0], "done")
