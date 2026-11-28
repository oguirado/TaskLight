"""M2-M4: selection, fresh claim epochs and bounded atomic acquisition."""
import copy
import multiprocessing
from unittest.mock import patch

from bridge.plan.limits import TASKS_MAX
from bridge.room import store
from bridge.room.ext import acquire
from .support import WorkCase, acquire_worker


class AcquireOracle(WorkCase):
    def test_a2_fresh_claim_activates_first_pending_in_one_group(self):
        self.make_plan()
        before = len(self.events())
        with patch.object(store, "post_ops", wraps=store.post_ops) as commit:
            result = self.acquire(op_id="acquire-fresh")
        self.assert_acquired(result)
        self.assertEqual([m["state"] for m in result["items"]], ["active", "pending", "pending"])
        self.assert_one_group(before, first_kind="task.claim")
        self.assertEqual(commit.call_count, 1)
        self.assertLess(result["claim_lamport"], self.events()[-1]["lamport"], "claim fence is not batch head")
        claim = self.events()[before]["op"]
        self.assertIn("base_rev", claim)
        self.assertFalse(claim.get("takeover", False))
        self.assertEqual([e["op"]["kind"] for e in self.events()[before:]], ["task.claim", "micro.set"])

    def test_a2_caller_owned_precedes_preferred_free_task(self):
        self.make_plan(count=2)
        self.claim("T02")
        self.assert_acquired(self.acquire(prefer_task="T01"), "T02")

    def test_a2_preference_wins_within_ownership_tier(self):
        self.make_plan(count=3)
        self.assert_acquired(self.acquire(prefer_task="T03"), "T03")

    def test_a2_owned_preference_wins_within_owned_tier(self):
        self.make_plan(count=2)
        self.claim("T01"); self.claim("T02")
        self.assert_acquired(self.acquire(prefer_task="T02"), "T02")

    def test_a2_unavailable_preference_falls_back(self):
        self.make_plan(count=2)
        self.assert_acquired(self.acquire(prefer_task="T40"))

    def test_a2_blocked_preference_is_skipped(self):
        self.make_plan(count=2)
        self.edit("T01", state="blocked", reason="Hold")
        self.assert_acquired(self.acquire(prefer_task="T01"), "T02")

    def test_a2_foreign_preference_is_never_taken_even_if_silent(self):
        self.make_plan(count=2)
        self.claim("T01", "bob")
        before = copy.deepcopy(self.task())
        with patch.object(store.time, "time", return_value=9999999999):
            self.assert_acquired(self.acquire(prefer_task="T01"), "T02")
        self.assertEqual(self.task(), before)
        self.assertFalse(any(e.get("op", {}).get("takeover") for e in self.events()))

    def test_a2_depth_precedes_task_id(self):
        self.make_plan(count=3)
        self.claim("T03")
        for i in range(1, 4):
            self.micro("T03.M%02d" % i, "done")
        self.edit("T01", deps=["T03"])
        self.assert_acquired(self.acquire(), "T02")

    def test_a2_equal_depth_uses_task_id(self):
        self.make_plan(count=3)
        self.assert_acquired(self.acquire())

    def test_a2_unsatisfied_dependency_preference_is_skipped(self):
        self.make_plan(count=2, deps={"T02": ["T01"]})
        self.assert_acquired(self.acquire(prefer_task="T02"))

    def test_a2_repeated_fresh_acquisition_renews_epoch(self):
        self.make_plan(count=2)
        first = self.acquire(op_id="epoch-first")
        second = self.acquire(op_id="epoch-second")
        self.assert_acquired(second)
        self.assertGreater(second["claim_lamport"], first["claim_lamport"])
        self.assertEqual([m["state"] for m in self.task()["microtasks"]], ["active", "pending", "pending"])

    def test_a2_existing_active_prevents_pending_activation(self):
        self.make_plan()
        self.claim(); self.micro("T01.M03", "active")
        result = self.acquire()
        self.assert_acquired(result)
        self.assertEqual([m["state"] for m in result["items"]], ["pending", "pending", "active"])
        self.assertEqual([m["id"] for m in result["items"]], ["T01.M01", "T01.M02", "T01.M03"])

    def test_a2_eight_barrier_processes_acquire_distinct_tasks(self):
        # Reach the actual stub before launching any processes in the red phase.
        self.make_plan(count=1, room="probe")
        self.acquire(room="probe")
        self.make_plan(count=8)
        method = "fork" if "fork" in multiprocessing.get_all_start_methods() else "spawn"
        context = multiprocessing.get_context(method)
        barrier = context.Barrier(8)
        processes, pipes = [], []
        try:
            for index in range(8):
                receive, send = context.Pipe(duplex=False)
                process = context.Process(target=acquire_worker,
                    args=(str(self.home), "worker-%02d" % index, barrier, send))
                processes.append(process); pipes.append(receive)
                process.start(); send.close()
            results = []
            for pipe in pipes:
                self.assertTrue(pipe.poll(20), "bounded process did not return")
                value = pipe.recv()
                self.assertNotIn("error", value, value)
                results.append(value["result"])
            self.assertEqual(len({r["task"]["id"] for r in results}), 8)
            self.assertEqual(len({r["claim_lamport"] for r in results}), 8)
            for index, result in enumerate(results):
                self.assert_acquired(result, result["task"]["id"], "worker-%02d" % index)
            for process in processes:
                process.join(10)
                self.assertFalse(process.is_alive())
                self.assertEqual(process.exitcode, 0)
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                process.join(5)
            for pipe in pipes:
                pipe.close()

    def test_a3_empty_eligible_pool_is_exact_and_read_only(self):
        self.make_plan()
        self.claim(agent="bob")
        before = self.raw()
        files = {p.relative_to(self.home): p.read_bytes() for p in self.home.rglob("*") if p.is_file()}
        self.assertEqual(self.acquire(op_id="empty-observation"), {"task": None, "items": []})
        self.assertEqual(self.raw(), before)
        self.assertEqual({p.relative_to(self.home): p.read_bytes() for p in self.home.rglob("*") if p.is_file()}, files,
                         "empty observation created a durable receipt")
        self.post({"kind": "task.release", "task_id": "T01"}, agent="bob")
        self.assert_acquired(self.acquire(op_id="empty-observation"))

    def test_a3_active_plan_without_tasks_is_transient_empty(self):
        self.make_plan(count=0)
        before = self.raw()
        self.assertEqual(self.acquire(), {"task": None, "items": []})
        self.assertEqual(self.raw(), before)

    def test_a2_omitted_identity_is_a_fresh_acquisition_each_time(self):
        self.make_plan()
        first = self.acquire()
        second = self.acquire()
        self.assert_acquired(second)
        self.assertGreater(second["claim_lamport"], first["claim_lamport"])

    def test_a3_missing_plan_is_no_plan(self):
        self.deny("work_acquire", {"room": "demo", "agent": "alice"}, "no_plan")

    def test_a3_closed_plan_is_no_plan(self):
        self.make_plan(count=0)
        self.post({"kind": "plan.close", "base_rev": self.projection()["plan"]["rev"]})
        self.deny("work_acquire", {"room": "demo", "agent": "alice"}, "no_plan")

    def test_a3_terminal_and_no_micro_tasks_are_excluded(self):
        self.make_plan(count=2, micros=0)
        self.edit("T01", state="cancelled", reason="Cancelled")
        before = self.raw()
        self.assertEqual(self.acquire(), {"task": None, "items": []})
        self.assertEqual(self.raw(), before)

    def test_a3_all_done_task_is_excluded(self):
        self.make_plan(micros=1)
        self.claim(); self.micro(state="done")
        before = self.raw()
        self.assertEqual(self.acquire(), {"task": None, "items": []})
        self.assertEqual(self.raw(), before)

    def test_a3_micro_blocked_task_is_excluded(self):
        self.make_plan(count=2)
        self.claim(); self.micro(state="blocked")
        self.assert_acquired(self.acquire(prefer_task="T01"), "T02")

    def test_a3_conflict_refolds_reselects_and_preserves_identity(self):
        self.make_plan(count=2)
        original = store.post_ops
        calls = []
        def race(room, agent, ops, **kw):
            calls.append(copy.deepcopy(ops))
            if len(calls) == 1:
                self.claim("T01", "bob")
            return original(room, agent, ops, **kw)
        with patch.object(store, "post_ops", side_effect=race):
            result = self.acquire(op_id="acquire-conflict")
        self.assert_acquired(result, "T02")
        self.assertGreaterEqual(len(calls), 2)
        self.assertLessEqual(len(calls), TASKS_MAX)
        self.assertEqual(calls[0][0]["op_id"], calls[1][0]["op_id"])
        self.assertEqual(self.task()["assignee"], "bob")
        self.assertEqual(sum(e.get("op", {}).get("kind") == "task.claim" and e["agent"] == "alice" for e in self.events()), 1)

    def conflict_exhaustion(self, code):
        self.make_plan()
        with patch.object(store, "post_ops", side_effect=store.RoomError(code, "forced selection conflict")) as commit:
            error = self.deny("work_acquire", dict(room="demo", agent="alice", op_id="exhaust-conflict"), "stale_rev")
        self.assertTrue(str(error).removeprefix("stale_rev:").strip())
        self.assertGreaterEqual(commit.call_count, 1)
        self.assertLessEqual(commit.call_count, TASKS_MAX)

    def test_a3_stale_revision_exhaustion_is_bounded(self):
        self.conflict_exhaustion("stale_rev")

    def test_a3_foreign_claim_exhaustion_is_bounded(self):
        self.conflict_exhaustion("claimed_by_other")

    def test_a3_conflict_consuming_last_task_is_not_empty_success(self):
        self.make_plan()
        original = store.post_ops
        external = []

        def race(room, agent, ops, **kw):
            if not external:
                self.claim(agent="bob")
                external.append(self.raw())
            return original(room, agent, ops, **kw)

        with patch.object(store, "post_ops", side_effect=race) as commit:
            with self.assertRaises(store.RoomError) as caught:
                self.acquire(op_id="last-task-conflict")
        self.assertEqual(caught.exception.code, "stale_rev")
        self.assertTrue(str(caught.exception).removeprefix("stale_rev:").strip())
        self.assertLessEqual(commit.call_count, TASKS_MAX)
        self.assertEqual(self.raw(), external[0], "failed selection appended after the competing claim")

    def test_a2_first_stored_active_is_the_readiness_guard(self):
        self.make_plan(micros=4)
        self.claim()
        self.micro("T01.M02", "active"); self.micro("T01.M04", "active")
        before = len(self.events())
        result = self.acquire()
        self.assert_acquired(result)
        self.assertEqual([m["state"] for m in result["items"]], ["pending", "active", "pending", "active"])
        active_ops = [e["op"] for e in self.events()[before:]
                      if e["op"].get("kind") == "micro.set" and e["op"].get("state") == "active"]
        self.assertEqual([o["micro_id"] for o in active_ops], ["T01.M02"])

    def test_m2_items_exclude_completed_microtasks_in_stored_order(self):
        self.make_plan()
        self.claim(); self.micro(state="done"); self.micro("T01.M02", "active")
        result = self.acquire()
        self.assert_acquired(result)
        self.assertEqual([m["id"] for m in result["items"]], ["T01.M02", "T01.M03"])
