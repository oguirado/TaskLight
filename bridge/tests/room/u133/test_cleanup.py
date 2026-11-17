"""M4-M5/A2-A3: terminal cleanup, durable replay and claim fences."""
import copy
from contextlib import suppress

from bridge.room.store import RoomError
from .support import Boundary, HookCase, L, digest, payload, success, work_projection


class Interrupted(BaseException):
    """Explicit crash fixture, never a successful negative-control outcome."""


class CleanupOracle(HookCase):
    def terminal(self, boundary, state="failed"):
        request = payload(state)
        request["event_id"] = "terminal-a"
        return self.invoke(request, boundary)

    def test_a2_failed_releases_owned_unfinished_work_and_preserves_payloads(self):
        boundary = Boundary(work_projection())
        for task in boundary.projection["tasks"]:
            task["microtasks"][0]["evidence"] = [{"path": "proof.txt", "sha256": "a" * 64}]
        before = copy.deepcopy(boundary.projection)
        # A-U141: terminal results include a distinct cleanup receipt.
        receipt = self.terminal(boundary)["untrusted"]
        self.assertEqual({key: receipt[key] for key in ("ok", "lamport")}, success()["untrusted"])
        self.assertEqual(receipt["cleanup"]["status"], "complete")
        self.assert_cleaned(boundary.projection)
        self.assertEqual({r["task_id"] for r in boundary.releases()}, {"T01", "T02"})
        self.assertEqual(boundary.projection["tasks"][2:], before["tasks"][2:])
        self.assertEqual(boundary.projection["plan"], before["plan"])
        for old, new in zip(before["tasks"][:2], boundary.projection["tasks"][:2]):
            self.assertEqual(new["microtasks"][1], old["microtasks"][1])
            self.assertEqual(new["microtasks"][0]["evidence"], old["microtasks"][0]["evidence"])
        self.assertEqual(boundary.projection["memory"], before["memory"])
        self.assertEqual(boundary.projection["archived_plans"], before["archived_plans"])

    def test_a2_finished_releases_without_completing_or_cancelling(self):
        boundary = Boundary(work_projection())
        # A-U141: finished has the same separate cleanup receipt as failed.
        receipt = self.terminal(boundary, "finished")["untrusted"]
        self.assertEqual({key: receipt[key] for key in ("ok", "lamport")}, success()["untrusted"])
        self.assertEqual(receipt["cleanup"]["status"], "complete")
        self.assert_cleaned(boundary.projection)
        self.assertEqual({r["task_id"] for r in boundary.releases()}, {"T01", "T02"})
        self.assertTrue(all(t["state"] not in ("done", "cancelled")
                            for t in boundary.projection["tasks"][:2]))

    def test_amendment_b_both_terminal_states_exclude_done_cancelled(self):
        for state in ("failed", "finished"):
            with self.subTest(state=state):
                boundary = Boundary(work_projection())
                before = copy.deepcopy(boundary.projection["tasks"][3:])
                self.terminal(boundary, state)
                self.assertEqual(boundary.projection["tasks"][3:], before)
                self.assertEqual({r["task_id"] for r in boundary.releases()}, {"T01", "T02"})

    def test_m4_current_projection_omits_since_rev_and_uses_subject_slug(self):
        boundary = Boundary(work_projection())
        self.terminal(boundary)
        reads = [args for name, args in boundary.calls if name == "plan_get"]
        self.assertTrue(reads)
        self.assertTrue(all(args == {"room": "demo", "agent": "exec-a"} for args in reads))
        self.assertTrue(all(r["room"] == "demo" and r["agent"] == "exec-a" for r in boundary.releases()))
        self.assertTrue(all(name in ("agent_lifecycle", "plan_get", "task_release") for name, _ in boundary.calls))

    def test_m4_no_plan_does_not_turn_persisted_terminal_into_failure(self):
        boundary = Boundary()
        # A-U141: terminal results include a distinct cleanup receipt.
        receipt = self.terminal(boundary)["untrusted"]
        self.assertEqual({key: receipt[key] for key in ("ok", "lamport")}, success()["untrusted"])
        self.assertEqual(receipt["cleanup"]["status"], "complete")
        self.assertEqual(boundary.releases(), [])

    def test_m4_deployed_alive_do_not_attempt_cleanup(self):
        for state in ("deployed", "alive"):
            with self.subTest(state=state):
                boundary = Boundary(work_projection())
                self.invoke(payload(state), boundary)
                self.assertEqual([name for name, _ in boundary.calls], ["agent_lifecycle"])

    def test_m5_release_id_contains_captured_generation_and_claim(self):
        boundary = Boundary(work_projection())
        opened = boundary.projection["plan"]["opened_lamport"]
        before = {t["id"]: copy.deepcopy(t) for t in boundary.projection["tasks"]}
        self.terminal(boundary)
        for release in boundary.releases():
            task = before[release["task_id"]]
            self.assertEqual(set(release), {"room", "agent", "task_id", "base_rev", "claim_lamport", "op_id"})
            self.assertEqual(release["claim_lamport"], task["claim_lamport"])
            self.assertEqual(release["base_rev"], task["rev"])
            self.assertEqual(release["op_id"], digest(["release", "demo", "exec-a", "r1",
                             "terminal-a", opened, task["id"], task["claim_lamport"]]))

    def test_amendment_c_opened_at_or_after_terminal_blocks_cleanup(self):
        for value in (L, L + 1):
            with self.subTest(opened_lamport=value):
                boundary = Boundary(work_projection())
                boundary.projection["plan"]["opened_lamport"] = value
                self.terminal(boundary)
                self.assertEqual(boundary.releases(), [])

    def test_amendment_c_claim_at_or_after_terminal_blocks_that_task(self):
        for value in (L, L + 1):
            with self.subTest(claim_lamport=value):
                boundary = Boundary(work_projection())
                boundary.projection["tasks"][0]["claim_lamport"] = value
                before = copy.deepcopy(boundary.projection["tasks"][0])
                self.terminal(boundary)
                self.assertEqual(boundary.projection["tasks"][0], before)
                self.assertNotIn("T01", [r["task_id"] for r in boundary.releases()])
                self.assertIn("T02", [r["task_id"] for r in boundary.releases()])

    def test_m5_missing_generation_or_lifecycle_evidence_blocks_cleanup(self):
        for field in ("opened_lamport", "agent_lifecycle", "run_id", "lifecycle"):
            with self.subTest(field=field):
                boundary = Boundary(work_projection())
                def omit(b):
                    if field == "opened_lamport":
                        b.projection["plan"].pop(field, None)
                    elif field == "agent_lifecycle":
                        b.projection.pop(field, None)
                    else:
                        b.projection["agent_lifecycle"]["exec-a"].pop(field, None)
                boundary.on_read = omit
                self.terminal(boundary)
                self.assertEqual(boundary.releases(), [])

    def test_m5_missing_claim_or_revision_never_substitutes_default(self):
        for field in ("claim_lamport", "rev", "assignee"):
            for absent in (True, False):
                with self.subTest(field=field, absent=absent):
                    boundary = Boundary(work_projection())
                    task = boundary.projection["tasks"][0]
                    if absent:
                        task.pop(field)
                    else:
                        task[field] = None
                    self.terminal(boundary)
                    self.assertNotIn("T01", [r["task_id"] for r in boundary.releases()])

    def test_m5_null_bool_or_invalid_fence_evidence_never_passes(self):
        for value in (None, False, True, "1", -1):
            for field in ("opened_lamport", "claim_lamport"):
                with self.subTest(field=field, value=value):
                    boundary = Boundary(work_projection())
                    target = boundary.projection["plan"] if field == "opened_lamport" else boundary.projection["tasks"][0]
                    target[field] = value
                    self.terminal(boundary)
                    self.assertNotIn("T01", [r["task_id"] for r in boundary.releases()])

    def test_a3_successor_run_skips_old_cleanup(self):
        boundary = Boundary(work_projection())
        def successor(b):
            b.projection["agent_lifecycle"]["exec-a"] = {"run_id": "r2", "lifecycle": "deployed"}
        boundary.on_read = successor
        self.terminal(boundary)
        self.assertEqual(boundary.releases(), [])

    def test_m5_same_run_wrong_lifecycle_skips_cleanup(self):
        boundary = Boundary(work_projection())
        def changed(b):
            b.projection["agent_lifecycle"]["exec-a"]["lifecycle"] = "alive"
        boundary.on_read = changed
        self.terminal(boundary)
        self.assertEqual(boundary.releases(), [])

    def test_a3_interrupted_after_commit_replays_cleanup_once(self):
        boundary = Boundary(work_projection())
        def crash(b):
            raise Interrupted()
        boundary.on_read = crash
        with suppress(Interrupted):
            self.terminal(boundary)
        self.assertEqual([e[0] for e in boundary.events], ["agent_lifecycle"])
        boundary.on_read = None
        self.terminal(boundary)
        self.assert_cleaned(boundary.projection)
        self.assertEqual([e[0] for e in boundary.events].count("agent_lifecycle"), 1)
        self.assertEqual([e[0] for e in boundary.events].count("task_release"), 2)

    def test_a3_interrupted_after_one_release_resumes_remaining_only(self):
        boundary = Boundary(work_projection())
        def crash(b, args):
            if any(e[0] == "task_release" for e in b.events):
                raise Interrupted()
        boundary.on_release = crash
        with suppress(Interrupted):
            self.terminal(boundary)
        self.assertEqual([e[0] for e in boundary.events].count("task_release"), 1)
        boundary.on_release = None
        self.terminal(boundary)
        before = copy.deepcopy(boundary.events)
        self.terminal(boundary)
        self.assertEqual(boundary.events, before)
        self.assert_cleaned(boundary.projection)
        self.assertEqual([e[0] for e in boundary.events].count("agent_lifecycle"), 1)
        self.assertEqual([e[0] for e in boundary.events].count("task_release"), 2)

    def test_a3_delayed_replay_does_not_release_reclaimed_work(self):
        boundary = Boundary(work_projection())
        self.terminal(boundary)
        task = boundary.projection["tasks"][0]
        task.update(assignee="exec-a", claim_lamport=L + 10, rev=L + 11)
        before = copy.deepcopy(task)
        self.terminal(boundary)
        self.assertEqual(boundary.projection["tasks"][0], before)

    def test_a3_reopened_plan_reusing_task_ids_is_not_released(self):
        boundary = Boundary(work_projection())
        self.terminal(boundary)
        replacement = work_projection()
        replacement["plan"]["opened_lamport"] = L + 20
        boundary.projection = replacement
        before = copy.deepcopy(boundary.projection["tasks"])
        self.terminal(boundary)
        self.assertEqual(boundary.projection["tasks"], before)

    def test_m5_revalidate_generation_owner_claim_and_run_before_release(self):
        for change in ("generation", "owner", "claim", "run"):
            with self.subTest(change=change):
                boundary = Boundary(work_projection())
                def race(b):
                    if b.reads < 2:
                        return
                    if change == "generation":
                        b.projection["plan"]["opened_lamport"] = L + 1
                    elif change == "owner":
                        b.projection["tasks"][0]["assignee"] = "other"
                    elif change == "claim":
                        b.projection["tasks"][0]["claim_lamport"] += 1
                    else:
                        b.projection["agent_lifecycle"]["exec-a"]["run_id"] = "r2"
                boundary.on_read = race
                self.terminal(boundary)
                self.assertNotIn("T01", [r["task_id"] for r in boundary.releases()])

    def test_m5_race_after_projection_read_is_protected_by_claim_fence(self):
        boundary = Boundary(work_projection())
        old_claim = boundary.projection["tasks"][0]["claim_lamport"]
        def race(b, args):
            if args["task_id"] == "T01":
                b.projection["tasks"][0].update(claim_lamport=L + 1, rev=args["base_rev"])
        boundary.on_release = race
        self.terminal(boundary)
        task = boundary.projection["tasks"][0]
        self.assertEqual(task["assignee"], "exec-a")
        self.assertEqual(task["claim_lamport"], L + 1)
        self.assertTrue(all(r["claim_lamport"] == old_claim
                            for r in boundary.releases() if r["task_id"] == "T01"))

    def test_m5_reopened_plan_after_read_cannot_release_reused_task(self):
        boundary = Boundary(work_projection())
        def race(b, args):
            if args["task_id"] == "T01":
                replacement = work_projection()
                replacement["plan"]["opened_lamport"] = L + 10
                replacement["tasks"][0].update(claim_lamport=L + 12, rev=args["base_rev"])
                b.projection = replacement
        boundary.on_release = race
        self.terminal(boundary)
        self.assertEqual(boundary.projection["tasks"][0]["assignee"], "exec-a")
        self.assertEqual(boundary.projection["plan"]["opened_lamport"], L + 10)

    def test_m5_stale_revision_retries_with_current_rev_and_same_claim(self):
        boundary = Boundary(work_projection())
        tried = []
        def stale_once(b, args):
            if args["task_id"] == "T01":
                tried.append(copy.deepcopy(args))
                if len(tried) == 1:
                    b.projection["tasks"][0]["rev"] += 1
                    raise RoomError("stale_rev", "unrelated update")
        boundary.on_release = stale_once
        self.terminal(boundary)
        self.assert_cleaned(boundary.projection)
        self.assertEqual(len(tried), 2)
        self.assertEqual(tried[1]["base_rev"], tried[0]["base_rev"] + 1)
        self.assertEqual(tried[1]["claim_lamport"], tried[0]["claim_lamport"])
        self.assertEqual(tried[1]["op_id"], tried[0]["op_id"])

    def test_amendment_b_stale_revision_has_at_most_three_retries(self):
        boundary = Boundary(work_projection())
        boundary.projection["tasks"] = boundary.projection["tasks"][:1]
        def stale(b, args):
            b.projection["tasks"][0]["rev"] += 1
            raise RoomError("stale_rev", "concurrent edit")
        boundary.on_release = stale
        self.terminal(boundary)
        self.assertEqual(len(boundary.releases()), 4, "initial attempt plus three retries")

    def test_amendment_b_no_stale_retry_at_or_below_remaining_budget(self):
        for remaining in (0.2, 0.199):
            with self.subTest(remaining=remaining):
                self.now = 10.0
                boundary = Boundary(work_projection())
                boundary.projection["tasks"] = boundary.projection["tasks"][:1]
                def stale(b, args):
                    self.now = 12.0 - remaining
                    raise RoomError("stale_rev", "budget exhausted")
                boundary.on_release = stale
                self.terminal(boundary)
                self.assertEqual(len(boundary.releases()), 1)

    def test_m5_claimed_by_other_is_not_retried(self):
        boundary = Boundary(work_projection())
        def reassigned(b, args):
            if args["task_id"] == "T01":
                b.projection["tasks"][0]["assignee"] = "other"
                raise RoomError("claimed_by_other", "concurrent reassignment")
        boundary.on_release = reassigned
        self.terminal(boundary)
        self.assertEqual(len([r for r in boundary.releases() if r["task_id"] == "T01"]), 1)
        self.assertEqual(boundary.projection["tasks"][0]["assignee"], "other")

    def test_m6_expired_budget_stops_before_next_mutation(self):
        boundary = Boundary(work_projection())
        def expire(b):
            self.now = 12.001
        boundary.on_read = expire
        self.terminal(boundary)
        self.assertEqual(boundary.releases(), [])
