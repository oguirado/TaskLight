"""AC3/AC7: real-backend mailbox progression and activity generation forwarding."""
import itertools

from bridge.plan import fold_plan
from bridge.room import app, store
from .support import NEW, MailboxCase, plan_input, request, task_input


class RealBackendCase(MailboxCase):
    def backend(self, tool, **args):
        return app.dispatch(tool, dict(room="demo", agent="executor-a", **args))["untrusted"]

    def projection(self):
        return self.backend("plan_get")

    def prepare_activity(self):
        self.backend("agent_lifecycle", state="deployed", run_id="run-a", op_id="deploy-activity")
        created = self.backend("plan_create", **plan_input(), op_id="create-activity")
        self.generation = self.projection()["plan"]["opened_lamport"]
        self.acquired = self.backend("work_acquire", prefer_task=created["ids"]["first"],
                                     run_id="run-a", expected_opened_lamport=self.generation,
                                     op_id="acquire-activity")

    def activity_args(self, generation):
        return dict(task_id=self.acquired["task"]["id"],
                    micro_id=self.acquired["items"][0]["id"], run_id="run-a",
                    expected_opened_lamport=generation, op_id="activity-fenced")


class ActivityFenceOracle(RealBackendCase):
    def test_matching_generation_activity_reaches_the_real_writer(self):
        self.prepare_activity()
        before = self.journal_bytes()
        try:
            result = self.backend("activity_beat", **self.activity_args(self.generation))
        except store.RoomError as exc:
            self.fail("activity_beat must accept and forward the generation fence; got %s" % exc.code)
        self.assertTrue(result["ok"])
        self.assertNotEqual(self.journal_bytes(), before)
        events, _ = store.read("demo")
        self.assertEqual(events[-1]["op"]["kind"], "activity.beat")
        self.assertEqual(events[-1]["op"]["op_id"], "activity-fenced")

    def test_stale_generation_activity_is_stale_rev_without_append(self):
        self.prepare_activity()
        before = self.journal_bytes()
        with self.assertRaises(store.RoomError) as raised:
            self.backend("activity_beat", **self.activity_args(self.generation + 1))
        self.assertEqual(raised.exception.code, "stale_rev",
                         "activity must reach the backend generation check, not reject the fence as bad_args")
        self.assertEqual(self.journal_bytes(), before)


class AllMailboxOracle(RealBackendCase):
    def test_all_mailbox_progresses_past_agent_plan_through_all_ten_kinds(self):
        self.configure(slice=2)
        counter = itertools.count(1)
        sent = []
        generation = None

        def deliver(kind, payload):
            value = request(kind, payload, identity="scenario-%04d" % next(counter),
                            generation=generation)
            result = self.success(value)
            sent.append(kind)
            return value, result

        # Only startup availability is supplied. Every mutation below crosses
        # the real mailbox and real dispatcher; observations are read-only.
        deliver("agent.deployed", {"harness": "external", "swarm": "fixture"})
        _, created = deliver("agent.plan", {"tool": "plan_create", "args": plan_input()})
        state = self.projection()
        generation = state["plan"]["opened_lamport"]
        first = created["ids"]["first"]
        deliver("plan.phase", {"phase": "execute", "base_rev": state["plan"]["rev"]})
        deliver("agent.plan", {"tool": "task_add", "args": task_input()})
        second = next(task["id"] for task in self.projection()["tasks"] if task["id"] != first)
        task = next(task for task in self.projection()["tasks"] if task["id"] == second)
        deliver("agent.plan", {"tool": "microtask_add", "args": {
            "task_id": second, "base_rev": task["rev"], "text": "Record verification"}})
        deliver("task.claim", {"task_id": second})
        task = next(task for task in self.projection()["tasks"] if task["id"] == second)
        deliver("task.release", {"task_id": second, "claim_lamport": task["claim_lamport"]})

        _, acquired = deliver("work.acquire", {"prefer_task": first})
        self.assertEqual(acquired["task"]["id"], first)
        deliver("agent.activity", {"task_id": first, "micro_id": acquired["items"][0]["id"]})
        proof = self.home / "proof.txt"
        proof.write_text("Fixture verified\n", encoding="utf-8")
        report, outcome = deliver("work.report", {
            "task_id": first, "claim_lamport": acquired["claim_lamport"],
            "done": [{"id": item["id"], "outcome": "Verified", "evidence": [str(proof)]}
                     for item in acquired["items"]]})
        before = self.journal_bytes()
        self.receipt_path(report).unlink()
        self.assertEqual(self.success(report), outcome)
        self.assertEqual(self.journal_bytes(), before, "exact work report replay appended")

        deliver("task.claim", {"task_id": second})
        task = next(task for task in self.projection()["tasks"] if task["id"] == second)
        claim = task["claim_lamport"]
        deliver("task.update", {"task_id": second, "base_rev": task["rev"], "title": "Verified task"})
        for item in task["microtasks"]:
            deliver("microtask.update", {"id": item["id"], "state": "active", "claim_lamport": claim})
            deliver("microtask.update", {"id": item["id"], "state": "done", "claim_lamport": claim,
                                          "outcome": "Verified", "evidence": [str(proof)]})
        state = self.projection()
        self.assertTrue(all(task["state"] == "done" for task in state["tasks"]))
        deliver("plan.phase", {"phase": "review", "base_rev": state["plan"]["rev"]})
        deliver("plan.close", {"base_rev": self.projection()["plan"]["rev"], "outcome": "Verified"})
        self.assertTrue(NEW <= set(sent), "scenario did not exercise every new kind")
        events, _ = store.read("demo")
        folded = fold_plan(events)
        self.assertEqual(folded["rejected"], [])
        self.assertEqual(folded["plan"]["state"], "closed")
        self.assertEqual(folded["archived_plans"][-1]["tasks_done"], 2)
