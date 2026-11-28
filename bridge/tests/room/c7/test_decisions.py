"""M2-M4: decision admission, immutable history and real transport contracts."""
import json
import unittest

from bridge.plan.errors import PlanError
from bridge.plan import ops
from bridge.room import app, store
from bridge.wall.emit import sanitize_output
from .support import FIXTURE, SECRET, RoomCase, clone, decision, event, fold


class ShapeOracle(unittest.TestCase):
    def test_m2_negative_control_has_valid_positive_twin(self):
        self.assertEqual(ops.validate_op_shape(clone(FIXTURE["base"])), FIXTURE["base"])
        for fields in ({"reason": "x" * 241}, {"unexpected": True}):
            with self.subTest(fields=fields), self.assertRaises(PlanError) as caught:
                ops.validate_op_shape({**FIXTURE["base"], **fields})
            self.assertEqual(caught.exception.code, "bad_op")


def shape_test(vector):
    def test(self):
        op = clone(vector["op"])
        before = clone(op)
        if vector["valid"]:
            self.assertEqual(ops.validate_op_shape(op), before)
        else:
            with self.assertRaises(PlanError) as caught:
                ops.validate_op_shape(op)
            self.assertEqual(caught.exception.code, "bad_op")
        self.assertEqual(op, before, "shape validation must not mutate input")
    return test


for _vector in FIXTURE["cases"]:
    setattr(ShapeOracle, "test_m2_shape_" + _vector["name"], shape_test(_vector))


class DecisionOracle(RoomCase):
    def setUp(self):
        super().setUp()
        self.install()

    def test_m2_valid_tool_appends_exactly_one_decision(self):
        before = self.events()
        args = self.args(micro_id="T01.M01", evidence=FIXTURE["evidence"])
        untouched = clone(args)
        self.call_decision(args)
        self.assertEqual(args, untouched)
        after = self.events()
        self.assertEqual(len(after), len(before) + 1)
        op = after[-1]["op"]
        self.assertEqual(op["kind"], "unit.decision")
        for key in ("op_id", "task_id", "micro_id", "verdict", "reason", "evidence", "agent", "run_id"):
            self.assertEqual(op.get(key), args[key])
        self.assertEqual(self.task()["last_decision"]["reason"], args["reason"])

    def test_decision_appends_utf8_in_binary_mode(self):
        before = self.raw()
        self.call_decision(self.args(reason="café"))
        after = self.raw()
        self.assertTrue(after.startswith(before))
        written = after[len(before):]
        self.assertIn("café".encode("utf-8"), written)
        self.assertEqual(written.count(b"\n"), 1)
        self.assertNotIn(b"\r", written)

    def test_m2_op_without_optional_source_or_evidence_is_accepted(self):
        self.post_decision(decision())
        self.assertEqual(self.events()[-1]["op"], decision())
        self.assertEqual(self.task()["last_decision"]["verdict"], "ADMIT")

    def test_m2_identical_retry_does_not_append_or_change_decisions(self):
        args = self.args()
        self.call_decision(args)
        before, projected = self.raw(), clone(self.task()["decisions"])
        self.call_decision(clone(args))
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.task()["decisions"], projected)

    def test_m2_reordered_object_keys_are_an_identical_retry(self):
        args = self.args(evidence=FIXTURE["evidence"][:1])
        self.call_decision(args)
        before = self.raw()
        reverse = dict(reversed(list(args.items())))
        reverse["evidence"] = [dict(reversed(list(args["evidence"][0].items())))]
        self.call_decision(reverse)
        self.assertEqual(self.raw(), before)

    def test_m2_conflicting_retry_uses_existing_conflict_error(self):
        args = self.args()
        self.call_decision(args)
        self.assert_bad_decision({**args, "reason": "Changed content"})

    def test_m2_reason_241_negative_control_does_not_append(self):
        self.assert_bad_decision(self.args(reason="x" * 241))

    def test_m2_unknown_task_negative_control_does_not_append(self):
        self.assert_bad_decision(self.args(task_id="T40"))

    def test_m2_unknown_micro_does_not_append(self):
        self.assert_bad_decision(self.args(micro_id="T01.M12"))

    def test_m2_micro_of_another_task_does_not_append(self):
        self.assert_bad_decision(self.args(micro_id="T02.M01"))

    def test_m2_unknown_result_agent_does_not_append(self):
        self.assert_bad_decision(self.args(agent="absent"))

    def test_m2_unknown_result_run_does_not_append(self):
        self.assert_bad_decision(self.args(run_id="absent-run"))

    def test_m2_live_run_without_result_is_not_a_result_reference(self):
        deployed = clone(FIXTURE["seed"][:4])
        self.install(deployed)
        self.assert_bad_decision(self.args())

    def test_m2_terminal_without_result_is_not_a_result_reference(self):
        seed = clone(FIXTURE["seed"])
        seed[-1]["op"].pop("result")
        self.install(seed)
        self.assert_bad_decision(self.args())

    def test_m2_no_open_plan_stops_without_append(self):
        self.install([])
        self.assert_bad_decision(self.args(), "no_plan")

    def test_m2_existing_plan_fence_accepts_the_current_generation(self):
        self.call_decision(self.args(expected_opened_lamport=1))
        self.assertEqual(self.events()[-1]["op"]["kind"], "unit.decision")

    def test_m2_existing_plan_fence_rejects_a_stale_generation(self):
        self.assert_bad_decision(self.args(expected_opened_lamport=99), "stale_rev")

    def test_m2_post_admission_rejection_preserves_journal_bytes(self):
        self.post_decision(decision())
        before = self.raw()
        with self.assertRaises(store.RoomError) as caught:
            self.post_decision(decision(7, task_id="T40"))
        self.assertEqual(caught.exception.code, "bad_op")
        self.assertEqual(self.raw(), before)

    def test_m2_all_rejected_shape_vectors_leave_journal_unchanged(self):
        self.post_decision(decision())  # Positive twin rules out an unknown-kind-only gate.
        for vector in FIXTURE["cases"]:
            if vector["valid"]:
                continue
            with self.subTest(vector=vector["name"]):
                before = self.raw()
                with self.assertRaises(store.RoomError) as caught:
                    self.post_decision(vector["op"])
                self.assertEqual(caught.exception.code, "bad_op")
                self.assertEqual(self.raw(), before)

    def test_m3_rejection_cannot_replace_a_prior_valid_decision(self):
        first = event(6, decision())
        bad = event(7, decision(7, reason="x" * 241))
        projection = fold(FIXTURE["seed"] + [first, bad])
        self.assertEqual(projection["rejected"], [
            {"id": bad["id"], "lamport": 7, "op_id": bad["op"]["op_id"], "code": "bad_op"}])
        self.assertEqual(projection["tasks"][0]["last_decision"]["reason"], "Checks passed")

    def test_m3_new_plan_does_not_inherit_an_old_task_decision(self):
        history = clone(FIXTURE["seed"])
        history.append(event(6, decision()))
        old = fold(history)
        self.assertEqual(old["rejected"], [], "valid C7 decisions must be accepted before testing plan reset")
        self.assertEqual(old["tasks"][0]["last_decision"]["verdict"], "ADMIT")
        for n, task in enumerate(old["tasks"], 7):
            history.append(event(n, {"kind": "task.set", "task_id": task["id"],
                                    "base_rev": task["rev"], "state": "cancelled"}))
        projected = fold(history)
        history.append(event(9, {"kind": "plan.close", "base_rev": projected["plan"]["rev"]}))
        opened = clone(FIXTURE["seed"][0]["op"])
        opened["op_id"] = "c7-next-plan"
        history.append(event(10, opened))
        added = clone(FIXTURE["seed"][1]["op"])
        added["op_id"] = "c7-next-task"
        history.append(event(11, added))
        current = fold(history)
        self.assertEqual(current["rejected"], [])
        task = current["tasks"][0]
        self.assertFalse(task.get("decisions"))
        self.assertIsNone(task.get("last_decision"))

    def test_m4_registered_mcp_and_cli_preserve_idempotence_and_op_bytes(self):
        args = self.args(evidence=FIXTURE["evidence"][:1])
        self.call_decision(args)  # Establish the handler before testing adapters.
        tools = [tool for tool in app.list_tools() if tool["name"] == "unit_decide"]
        self.assertEqual(len(tools), 1)
        before = self.raw()
        response, mcp_payload = self.mcp_call("unit_decide", args)
        self.assertFalse(response.get("isError", False), mcp_payload)
        rc, cli_payload, _ = self.cli_call("unit_decide", args)
        self.assertEqual(rc, 0, cli_payload)
        self.assertEqual(cli_payload, mcp_payload)
        self.assertEqual(self.raw(), before)

    def test_m4_sanitizes_free_text_but_preserves_evidence_pointers(self):
        pointer = {"path": "artifacts/" + "0123456789abcdef" * 4 + ".json", "sha256": "a" * 64}
        args = self.args(reason=SECRET, evidence=[pointer])
        self.call_decision(args)
        response, payload = self.mcp_call("unit_decide", args)
        self.assertFalse(response.get("isError", False))
        self.assertEqual(sanitize_output(payload), payload)
        self.assertNotIn(SECRET, json.dumps(payload))
        pointers = []

        def walk(value):
            if isinstance(value, dict):
                if isinstance(value.get("evidence"), list):
                    pointers.extend(value["evidence"])
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)
        walk(payload)
        self.assertIn(pointer, pointers, "tool response retains dereferenceable evidence")
        self.assertEqual(self.events()[-1]["op"]["reason"], SECRET,
                         "sanitizing a response cannot rewrite owner storage")

    def test_m4_sanitizer_failure_stops_output_without_raw_fallback(self):
        self.call_decision(self.args())
        self.assert_redaction_stops_output("unit_decide", self.args(), "Checks passed")


def history_test(vector):
    def test(self):
        events = clone(vector["events"])
        original = clone(events)
        projection = fold(events)
        self.assertEqual([row["id"] for row in projection["rejected"]], vector["rejected_ids"])
        task = projection["tasks"][0]
        self.assertIsInstance(task.get("decisions"), list, "M3 decision history required")
        self.assertEqual([row["reason"] for row in task["decisions"]], vector["reasons"])
        self.assertEqual(task.get("last_decision"), task["decisions"][-1])
        self.assertLessEqual(len(task["decisions"]), 16)
        for row in task["decisions"]:
            self.assertIn(row["verdict"], ("ADMIT", "HOLD", "REJECT"))
        self.assertEqual(fold(list(reversed(events)) + events), projection,
                         "Lamport order and duplicate event replay are deterministic")
        self.assertEqual(events, original, "fold must never trim the source journal")
    return test


class HistoryOracle(unittest.TestCase):
    pass


for _history in FIXTURE["histories"]:
    setattr(HistoryOracle, "test_m3_history_" + _history["name"], history_test(_history))
