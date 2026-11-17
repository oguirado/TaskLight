"""Acceptance oracle for optional, atomic plan-generation fencing."""
import copy
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from bridge.plan import fold_plan
from bridge.room import app, family, store
from bridge.tests.room.u140.support import AGENT, MISSING, ROOM, RoomCase


class BackendFencing(RoomCase):
    def matching_generation(self, batch):
        expected = self.generation
        self.post(dict(kind="plan.phase", phase="finish",
                       base_rev=self.projection()["plan"]["rev"]))
        self.assertNotEqual(self.projection()["plan"]["rev"], expected,
                            "fixture must distinguish plan rev from generation")
        before = len(self.events())
        self.succeeds(lambda: self.backend(batch, expected))
        self.assertEqual(len(self.events()) - before, 2 if batch else 1)
        self.assertEqual(self.generation, expected)
        self.assertEqual(self.projection()["rejected"], [])

    def stale_generation(self, batch):
        expected = self.generation
        self.succeeds(lambda: self.backend(batch, expected, title="Positive control"))
        self.reopen()
        self.refusal(lambda: self.backend(batch, expected))
        self.succeeds(lambda: self.backend(batch, self.generation, title="Fresh generation"))

    def future_generation(self, batch):
        self.succeeds(lambda: self.backend(batch, self.generation, title="Positive control"))
        self.refusal(lambda: self.backend(batch, self.generation + 100))
        self.succeeds(lambda: self.backend(batch, self.generation, title="After refusal"))

    def reopen_between_preread_and_commit(self, batch):
        expected = self.generation
        self.succeeds(lambda: self.backend(batch, expected, title="Positive control"))
        self.race_at_lock(lambda: self.backend(batch, expected))

    def overlapping_writers(self, batch):
        self.succeeds(lambda: self.backend(batch, self.generation, title="Positive control"))
        self.overlap_at_lock(batch)

    def omitted_preserves_append_and_replay(self, batch):
        # Deliberately carry an old caller observation without sending a fence.
        previous = self.generation
        self.reopen()
        self.assertNotEqual(self.generation, previous)
        op = self.add_op("Legacy identified request")
        op["op_id"] = "u140-legacy-0001"
        ops = [op, self.add_op("Legacy batch member")]

        def call():
            if batch:
                return store.post_ops(ROOM, AGENT, copy.deepcopy(ops), home=self.home,
                                      clock=lambda: 1700000000000, templates=self.templates)
            return self.post(op)

        before = len(self.events())
        first = call()
        first_events = first if batch else [first]
        self.assertEqual(len(self.events()) - before, 2 if batch else 1)
        snapshot = self.snapshot()
        replay = call()
        replay_events = replay if batch else [replay]
        self.assertEqual(self.snapshot(), snapshot, "legacy replay appended")
        self.assertEqual([(e["id"], e["lamport"]) for e in replay_events],
                         [(e["id"], e["lamport"]) for e in first_events])
        self.assertTrue(all(e.get("replayed") for e in replay_events))


def backend_case(method, batch):
    def test(self):
        getattr(self, method)(batch)
    return test


for mode, batch in (("single", False), ("batch", True)):
    for case, method in (
        ("a1_matching_generation_not_plan_rev", "matching_generation"),
        ("a2_stale_generation_zero_appends", "stale_generation"),
        ("a3_forged_future_zero_appends", "future_generation"),
        ("a4_reopen_between_preread_and_commit", "reopen_between_preread_and_commit"),
        ("a5_two_overlapping_writers_and_reopener", "overlapping_writers"),
        ("a6_lock_held_through_commit", "commit_under_lock"),
        ("a7_omitted_preserves_append_and_replay", "omitted_preserves_append_and_replay"),
    ):
        setattr(BackendFencing, "test_" + case + "_" + mode, backend_case(method, batch))


class DispatcherFencing(RoomCase):
    def mutation_matches_then_refuses_old_generation(self, tool):
        expected = self.generation
        args = self.mutation_args(tool)
        self.succeeds(lambda: self.api(tool, expected, **args))
        self.reopen()
        args = self.mutation_args(tool)
        # Current task/plan revisions make the operation otherwise valid.
        self.refusal(lambda: self.api(tool, expected, **args))
        self.succeeds(lambda: self.api(tool, self.generation, **args))

    def test_a4_dispatcher_reopen_between_preread_and_commit(self):
        expected = self.generation
        args = self.mutation_args("task_add")
        self.succeeds(lambda: self.api("task_add", expected, **args))
        self.race_at_lock(lambda: self.api("task_add", expected, **args))

    def test_a7_dispatcher_mutations_without_fence_keep_legacy_behavior(self):
        for tool in ("task_add", "task_update", "task_claim", "task_release",
                     "microtask_add", "microtask_set", "plan_phase", "plan_close"):
            with self.subTest(tool=tool):
                self.reopen()
                args = self.mutation_args(tool)
                self.api(tool, **args)
                self.assertEqual(self.projection()["rejected"], [])

    def test_a7_plan_create_without_fence_keeps_legacy_result(self):
        self.close_plan()
        result = self.api("plan_create", template_id=self.template["id"], title="Legacy plan",
                          brief={"goal": "Keep the existing contract"},
                          tasks=[dict(key="first", title="Task", type="action", phase="start",
                                      accept="Verified", microtasks=[{"text": "Execute"}])],
                          op_id="u140-create-0001")
        self.assertEqual(result["plan_id"], "p1")
        self.assertEqual(result["ids"], {"first": "T01"})
        self.assertFalse(result["replayed"])
        self.assertEqual(self.projection()["rejected"], [])


def dispatcher_case(tool):
    def test(self):
        self.mutation_matches_then_refuses_old_generation(tool)
    return test


for tool in ("task_add", "task_update", "task_claim", "task_release",
             "microtask_add", "microtask_set", "plan_phase", "plan_close"):
    setattr(DispatcherFencing, "test_a8_dispatcher_" + tool, dispatcher_case(tool))


class MailboxBoundary(RoomCase):
    def configure(self, selected=1):
        directory = self.home / "family" / "board"
        directory.mkdir(parents=True, mode=0o700)
        directory.parent.chmod(0o700)
        incoming = directory / "spool"
        incoming.mkdir(mode=0o700)
        config = dict(endpoint="board", rooms=[ROOM], sources=["harness"], slice=selected)
        (directory / "config.json").write_text(json.dumps(config))
        return incoming

    def invoke(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = family.main(["drain", "--endpoint", "board"])
        return result, stderr.getvalue()

    def test_a9_slice_one_keeps_planning_held(self):
        incoming = self.configure()
        request = dict(schema="tasklight.family/1", id="capabilities-0001", source="harness",
                       target="board", kind="capabilities", room=ROOM, agent=AGENT, payload={})
        (incoming / "capabilities-0001.json").write_text(json.dumps(request))
        before = self.snapshot()
        rc, error = self.invoke()
        self.assertEqual(rc, 0, error)
        result = json.loads((incoming / "capabilities-0001.result.json").read_text())["result"]["untrusted"]
        self.assertIn("capabilities", result["kinds"])
        self.assertTrue({"agent.plan", "agent.activity", "work.acquire", "work.report",
                         "task.claim", "task.release", "task.update", "microtask.update",
                         "plan.phase", "plan.close"}.isdisjoint(result["kinds"]))
        self.assertEqual(self.snapshot(), before)

    def test_a9_slice_two_still_refuses_startup(self):
        self.configure(selected=2)
        before = self.snapshot()
        # A-U143a: admitted slice:2 starts; only a missing runtime fence refuses.
        rc, error = self.invoke()
        self.assertEqual(rc, 0, error)
        self.assertEqual(self.snapshot(), before)
        with patch.object(store, "post", lambda *args, **kwargs: self.fail("unfenced write")):
            rc, error = self.invoke()
        self.assertEqual(rc, 2)
        self.assertIn("planning delivery awaits atomic backend generation fencing", error)
        self.assertEqual(self.snapshot(), before)


class NegativeControlCalibration(RoomCase):
    def preread_only_is_detected(self, batch):
        """A local wrapper deliberately drops the fence before the real writer."""
        real_single, real_batch = store.post, store.post_ops

        def read_generation(home):
            events, malformed = store.read(ROOM, home=home)
            self.assertEqual(malformed, 0)
            return fold_plan(events, templates=self.templates)["plan"]["opened_lamport"]

        def check(expected, home):
            if expected is not MISSING and expected != read_generation(home):
                raise store.RoomError("bad_op", "negative control: mismatched generation")

        def single(*args, expected_opened_lamport=MISSING, **kwargs):
            check(expected_opened_lamport, kwargs.get("home"))
            return real_single(*args, **kwargs)

        def multiple(*args, expected_opened_lamport=MISSING, **kwargs):
            check(expected_opened_lamport, kwargs.get("home"))
            return real_batch(*args, **kwargs)

        expected = self.generation
        with patch.object(store, "post", side_effect=single), patch.object(store, "post_ops", side_effect=multiple):
            # Same request is valid before injection; the mutant cannot win by refusing all writes.
            self.succeeds(lambda: self.backend(batch, expected, title="Mutant positive control"))
            with self.assertRaisesRegex(AssertionError, "stale request appended after the reopener committed"):
                self.race_at_lock(lambda: self.backend(batch, expected))

    def test_a10_preread_only_single_is_detected(self):
        self.preread_only_is_detected(False)

    def test_a10_preread_only_batch_is_detected(self):
        self.preread_only_is_detected(True)
