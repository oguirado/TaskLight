"""M4/M5 and explicit slice availability; no replacement planning engine."""
import copy
import itertools
from unittest import mock

from bridge.plan import fold_plan
from bridge.room import app, store
from .support import FamilyCase, REAL_DISPATCH, envelope, operation_id


class RoutingOracle(FamilyCase):
    def test_capabilities_uses_required_room_agent_and_enabled_kinds_only(self):
        # Optional run identity is omitted, rather than null, for discovery.
        request = envelope(kind="capabilities")
        request.pop("run_id")
        self.publish(request)
        self.assertEqual(self.invoke(), 0)
        result = self.receipt()["result"]["untrusted"]
        self.assertEqual(result["protocol"], "tasklight.family/1")
        self.assertIn(result["health"], ("ready", "not_ready"))
        self.assertEqual(len(result["kinds"]), len(set(result["kinds"])))
        self.assertIn("capabilities", result["kinds"])
        # A-U143: the default slice retains its legacy capability set.
        self.assertNotIn("agent.activity", result["kinds"], "slice one keeps activity disabled")
        for kind in SLICE_TWO:
            self.assertNotIn(kind, result["kinds"])
        self.assert_no_dispatch()

    def test_capabilities_checks_room_membership(self):
        self.drain_error(envelope(kind="capabilities", room="private"), "bad_room")

    def test_capabilities_checks_source_membership(self):
        self.drain_error(envelope(kind="capabilities", source="other"))

    # A-U143: activity is enabled only in explicit slice two.
    def test_slice_one_keeps_activity_disabled(self):
        self.drain_error(envelope(kind="agent.activity", plan_opened=1,
                        payload={"task_id": "T01", "micro_id": "T01.M01"}))

    def test_slice_two_refuses_startup_without_required_backend(self):
        # A-U143: simulate a missing dependency; the integrated backend is fenced.
        self.tools = [tool for tool in self.tools if tool["name"] != "activity_beat"]
        self.configure(slice=2)
        path = self.publish(envelope(kind="work.acquire", plan_opened=1, payload={}))
        self.assertEqual(self.invoke(), 2)
        self.assertIn("planning delivery awaits atomic backend generation fencing", self.stderr)
        self.assertTrue(path.exists())
        self.assert_no_dispatch()

    def test_exit_lifecycle_does_not_dispatch_planning_completion(self):
        self.publish(envelope(kind="agent.finished", payload={"reason": "process ended"}))
        self.assertEqual(self.invoke(), 0)
        self.assertEqual([name for name, _ in self.backend.calls], ["agent_lifecycle"])
        self.assertEqual(self.backend.calls[0][1]["state"], "finished")
        self.assertTrue(all(e["op"]["kind"] == "agent.lifecycle" for e in self.events()))

    def test_a9_socket_denied_sweep_requires_no_external_process(self):
        self.publish()
        self.assertEqual(self.invoke(), 0)
        self.assertTrue(self.receipt()["result"]["untrusted"]["ok"])
        # FamilyCase installs failing socket and process constructors.

    def test_backend_failure_is_internal_and_remains_retryable(self):
        value = envelope()
        self.backend.error = OSError("transient backend I/O")
        self.publish(value)
        self.assertEqual(self.invoke(), 3)
        receipt = self.spool / "deploy-0001.result.json"
        if receipt.exists():
            self.error_receipt("internal")
            receipt.unlink()
        self.backend.error = None
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        self.assertTrue(self.receipt()["result"]["untrusted"]["ok"])
        self.assertEqual(len(self.events()), 1)


SLICE_TWO = {
    "agent.plan": {"tool": "plan_create", "args": {}},
    "task.claim": {"task_id": "T01"},
    "task.release": {"task_id": "T01", "claim_lamport": 2},
    "task.update": {"task_id": "T01", "base_rev": 2, "state": "blocked"},
    "microtask.update": {"id": "T01.M01", "state": "active", "claim_lamport": 2},
    "plan.phase": {"phase": "build", "base_rev": 2},
    "plan.close": {"base_rev": 2},
    "work.acquire": {},
    "work.report": {},
}


def disabled_case(kind, payload):
    def test(self):
        value = envelope(kind=kind, payload=payload)
        if kind != "agent.plan":
            value["plan_opened"] = 1
        self.drain_error(value)
    return test


for _kind, _payload in SLICE_TWO.items():
    setattr(RoutingOracle, "test_slice_one_disables_" + _kind.replace(".", "_"),
            disabled_case(_kind, _payload))


def lifecycle_case(state):
    def test(self):
        payload = {"swarm": "group-a", "harness": "director", "reason": "passive status"}
        value = envelope(kind="agent." + state, payload=payload)
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        name, args = self.backend.calls[0]
        self.assertEqual(name, "agent_lifecycle")
        self.assertEqual(args, dict(payload, room="demo", agent="executor-a",
                                   run_id="run-a", state=state, op_id=operation_id(value)))
    return test


for _state in ("deployed", "alive", "finished", "failed"):
    setattr(RoutingOracle, "test_fixed_lifecycle_" + _state, lifecycle_case(_state))


def backend_code_case(code):
    def test(self):
        self.backend.error = store.RoomError(code, "backend detail T01")
        self.publish()
        self.assertEqual(self.invoke(), 0)
        result = self.error_receipt(code)
        self.assertIn("T01", result.get("detail", ""))
        self.assertEqual(self.journal_bytes(), b"")
    return test


for _code in ("not_conformant", "claimed_by_other", "stale_rev", "bad_evidence", "room_full", "not_found"):
    setattr(RoutingOracle, "test_a3_preserve_backend_code_" + _code, backend_code_case(_code))


# A-U143: exercise real opt-in startup, independently of the frozen oracle's
# test-only availability seam. Existing slice-one and lifecycle tests stay active.
class SliceTwoRoutingOracle(FamilyCase):
    def test_explicit_slice_two_advertises_all_fixed_routes(self):
        self.configure(slice=2)
        self.publish(envelope(kind="capabilities"))
        self.assertEqual(self.invoke(), 0, self.stderr)
        kinds = set(self.receipt()["result"]["untrusted"]["kinds"])
        self.assertEqual(kinds, {"capabilities", "events.read", "agent.deployed",
                               "agent.alive", "agent.finished", "agent.failed",
                               "agent.activity"} | set(SLICE_TWO))
        self.assert_no_dispatch()

    def test_missing_registered_route_refuses_before_consumption(self):
        self.configure(slice=2)
        original = self.tools
        names = ("activity_beat", "plan_create", "task_add", "microtask_add",
                 "work_acquire", "work_report", "task_claim", "task_release",
                 "task_update", "microtask_set", "plan_phase", "plan_close")
        for name in names:
            with self.subTest(tool=name):
                self.tools = [tool for tool in original if tool["name"] != name]
                path = self.publish(envelope(kind="capabilities"))
                self.assertEqual(self.invoke(), 2)
                self.assertIn("planning delivery awaits atomic backend generation fencing", self.stderr)
                self.assertTrue(path.exists())
                self.assertFalse((self.mailbox / "consumer.lock").exists())
                self.assert_no_dispatch()
        self.tools = original

    def test_missing_handler_generation_argument_refuses_startup(self):
        self.configure(slice=2)
        original = self.tools
        for name in ("activity_beat", "task_add", "microtask_add", "work_acquire",
                     "work_report", "task_claim", "task_release", "task_update",
                     "microtask_set", "plan_phase", "plan_close"):
            with self.subTest(tool=name):
                self.tools = copy.deepcopy(original)
                for tool in self.tools:
                    if tool["name"] == name:
                        tool["inputSchema"]["properties"].pop("expected_opened_lamport")
                self.assertEqual(self.invoke(), 2)
                self.assertIn("planning delivery awaits atomic backend generation fencing", self.stderr)
                self.assert_no_dispatch()
        self.tools = original

    def test_unfenced_backend_writer_refuses_startup(self):
        self.configure(slice=2)
        def unfenced_writer(*args, **kwargs):
            raise AssertionError("unfenced writer must never be called")
        for name in ("post", "post_ops"):
            with self.subTest(writer=name), mock.patch.object(store, name, unfenced_writer):
                self.assertEqual(self.invoke(), 2)
                self.assertIn("planning delivery awaits atomic backend generation fencing", self.stderr)
                self.assert_no_dispatch()

    def test_work_requires_envelope_run_identity_before_dispatch(self):
        self.configure(slice=2)
        for index, kind in enumerate(("work.acquire", "work.report")):
            value = envelope(id="missing-run-%d" % index, kind=kind,
                             plan_opened=1, payload={})
            value.pop("run_id")
            self.drain_error(value)


class LiveSliceTwoCase(FamilyCase):
    """Real dispatcher/writers with the existing filesystem fault observer."""
    def setUp(self):
        handlers = dict(app.V2_DISPATCH)
        super().setUp()
        self.stack.enter_context(mock.patch.object(app, "dispatch", REAL_DISPATCH))
        self.stack.enter_context(mock.patch.dict(app.V2_DISPATCH, handlers, clear=True))
        self.configure(slice=2)
        self.sequence = itertools.count(1)

    def deliver(self, kind, payload, generation=None):
        value = envelope(id="slice-two-%04d" % next(self.sequence), kind=kind, payload=payload)
        if generation is not None:
            value["plan_opened"] = generation
        self.publish(value)
        self.assertEqual(self.invoke(), 0, self.stderr)
        result = self.receipt(value["id"])["result"]
        self.assertIn("untrusted", result, result)
        self.assertIsNot(result["untrusted"].get("ok"), False)
        return value, result["untrusted"]

    def projection(self):
        return REAL_DISPATCH("plan_get", {"room": "demo", "agent": "executor-a"})["untrusted"]

    def prepare_work(self):
        self.deliver("agent.deployed", {"harness": "external", "swarm": "fixture"})
        self.deliver("agent.plan", {"tool": "plan_create", "args": {
            "template_id": "blank", "title": "Slice two work", "strict": False,
            "brief": {"goal": "Verify mailbox delivery"}, "tasks": [{
                "key": "first", "title": "Produce evidence", "type": "task", "phase": "execute",
                "accept": "Verified", "microtasks": [{"text": "Produce"}, {"text": "Verify"}]}]}})
        generation = self.projection()["plan"]["opened_lamport"]
        self.deliver("plan.phase", {"phase": "execute", "base_rev": self.projection()["plan"]["rev"]},
                     generation)
        _, acquired = self.deliver("work.acquire", {}, generation)
        proof = self.tmp / "proof.txt"
        proof.write_text("Verified\n", encoding="utf-8")
        report = {"task_id": acquired["task"]["id"], "claim_lamport": acquired["claim_lamport"],
                  "done": [{"id": item["id"], "outcome": "Verified", "evidence": [str(proof.resolve())]}
                           for item in acquired["items"]]}
        return generation, acquired, report


class LiveSliceTwoRoutingOracle(LiveSliceTwoCase):
    def test_real_mailbox_work_loop_without_availability_replacement(self):
        generation, acquired, report = self.prepare_work()
        self.deliver("agent.activity", {"task_id": acquired["task"]["id"],
                                      "micro_id": acquired["items"][0]["id"]}, generation)
        self.deliver("work.report", report, generation)
        self.assertTrue(all(task["state"] == "done" for task in self.projection()["tasks"]))
        self.deliver("plan.phase", {"phase": "review", "base_rev": self.projection()["plan"]["rev"]},
                     generation)
        self.deliver("plan.close", {"base_rev": self.projection()["plan"]["rev"], "outcome": "Verified"},
                     generation)
        events, _ = store.read("demo")
        self.assertEqual(fold_plan(events)["plan"]["state"], "closed")

    def test_mailbox_stale_activity_preserves_journal(self):
        generation, acquired, _ = self.prepare_work()
        before = self.journal_bytes()
        value = envelope(id="stale-activity", kind="agent.activity", plan_opened=generation + 1,
                         payload={"task_id": acquired["task"]["id"]})
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        self.error_receipt("stale_rev", value["id"])
        self.assertEqual(self.journal_bytes(), before)
