"""Caller-visible regression gates; rejected input must never reach the journal."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bridge.plan.errors import PlanError
from bridge.plan.ops import validate_op_shape, validate_result
from bridge.room import app, store
from bridge.tests.room.u87.support import call, create_args, write_template

HERE = Path(__file__).resolve().parent
PRIVATE = "private-value/should-never-appear"
OP_RULE = "op_id must be 8-64 chars of A-Z a-z 0-9 _ -"


class ActionableErrors(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        env = dict(os.environ, CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        env.pop("CW_PIN_AGENT", None)
        env.pop("CW_PIN_ROLE", None)
        self.enterContext(patch.dict(os.environ, env, clear=True))
        write_template(self.home)

    def journal(self):
        return {str(p.relative_to(self.home)): p.read_bytes()
                for p in self.home.rglob("events.jsonl")}

    def reject(self, tool, args, code, *fragments):
        before = self.journal()
        payloads = []
        for adapter in ("cli", "mcp"):
            rc, payload = call(adapter, tool, args)
            self.assertEqual(rc, 3, (tool, adapter, payload))
            self.assertEqual(payload["code"], code)
            detail = payload.get("detail", "")
            self.assertTrue(detail, (tool, payload))
            self.assertLess(len(detail), 200)
            self.assertNotIn(PRIVATE, detail)
            for fragment in fragments:
                self.assertIn(fragment, detail)
            payloads.append(payload)
        self.assertEqual(payloads[0], payloads[1])
        self.assertEqual(self.journal(), before)
        return payloads[0]

    @staticmethod
    def decision(**changes):
        return dict(room="demo", agent="leader", op_id="decision-001", task_id="T01",
                    verdict="ADMIT", reason="Verified", **changes)

    def test_decision_reason_reports_name_and_limit(self):
        for value in ("", PRIVATE * 20, False, None):
            args = self.decision()
            args["reason"] = value
            with self.subTest(type=type(value).__name__):
                self.reject("unit_decide", args, "bad_op", "reason", "1-240")

    def test_decision_missing_required_and_unknown_arguments(self):
        args = self.decision()
        del args["reason"]
        self.reject("unit_decide", args, "bad_op", "reason", "required")
        self.reject("unit_decide", dict(self.decision(), x=PRIVATE), "bad_op", "unknown arg", "x")
        self.reject("unit_decide", dict(self.decision(), **{PRIVATE: PRIVATE}), "bad_op", "unknown arg")

    def test_decision_references_name_both_arguments(self):
        for field, value in (("result_agent", "worker"), ("result_run_id", "worker-run")):
            self.reject("unit_decide", dict(self.decision(), **{field: value}),
                        "bad_op", "result_agent", "result_run_id", "together")
        self.reject("unit_decide", dict(self.decision(), run_id="old", result_agent="worker",
                                       result_run_id="new"), "bad_op", "run_id", "result_agent")

    def test_decision_field_rules_and_evidence_indices(self):
        cases = [("verdict", PRIVATE, ("verdict", "ADMIT", "HOLD", "REJECT")),
                 ("task_id", PRIVATE, ("task_id", "T01", "T40")),
                 ("micro_id", PRIVATE, ("micro_id", "M01", "M12")),
                 ("evidence", [], ("evidence", "1-8")),
                 ("evidence", [{"path": PRIVATE * 30, "sha256": "a" * 64}],
                  ("evidence[0].path", "1-512")),
                 ("evidence", [{"path": "artifact.json", "sha256": PRIVATE}],
                  ("evidence[0].sha256", "64", "lowercase"))]
        for key, value, fragments in cases:
            args = self.decision()
            args[key] = value
            with self.subTest(key=key, fragments=fragments):
                self.reject("unit_decide", args, "bad_op", *fragments)

    def test_decision_domain_bindings_name_arguments(self):
        app.dispatch("plan_create", create_args())
        for changes, fields in (({"task_id": "T02"}, ("task_id", "existing task")),
                                ({"micro_id": "T02.M01"}, ("micro_id", "task_id")),
                                ({"result_agent": "worker", "result_run_id": "unseen"},
                                 ("result_agent", "result_run_id", "terminal result"))):
            args = self.decision()
            args.update(changes)
            with self.subTest(fields=fields):
                self.reject("unit_decide", args, "bad_op", *fields)

    def test_op_id_rule_at_shared_and_tool_boundaries(self):
        for value in ("dec-1", PRIVATE, True, "a" * 65):
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaises(PlanError) as error:
                    validate_op_shape(dict(kind="unit.decision", op_id=value))
                self.assertEqual(error.exception.code, "bad_op")
                self.assertEqual(str(error.exception), OP_RULE)
                self.reject("unit_decide", dict(self.decision(), op_id=value), "bad_op", OP_RULE)
                self.reject("plan_create", create_args(op_id=value), "bad_op", OP_RULE)

    def test_all_extension_envelopes_identify_missing_or_unknown_argument(self):
        required = [("unit_decide", "bad_op", "room"), ("agent_lifecycle", "bad_args", "room"),
                    ("activity_beat", "bad_args", "room"), ("wait_agents", "bad_args", "room"),
                    ("agents_list", "bad_args", "room"), ("orchestrator_snapshot", "bad_args", "room"),
                    ("room_send", "bad_args", "room"), ("work_acquire", "bad_args", "room"),
                    ("work_report", "bad_args", "room"), ("room_export", "bad_args", "room"),
                    ("memory_history", "bad_args", "room")]
        for tool, code, field in required:
            with self.subTest(tool=tool):
                self.reject(tool, {}, code, field, "required")
        cases = [("agents_list", {"room": "demo"}),
                 ("orchestrator_snapshot", {"room": "demo"}),
                 ("wait_agents", {"room": "demo"}),
                 ("room_events", {"room": "demo", "agent": "leader", "after_lamport": 0}),
                 ("room_send", dict(room="demo", agent="leader", to="worker", act="ack", text="ok")),
                 ("agent_lifecycle", dict(room="demo", agent="leader", state="alive", run_id="run")),
                 ("activity_beat", dict(room="demo", agent="leader")),
                 ("work_acquire", dict(room="demo", agent="leader", run_id="run")),
                 ("work_report", dict(room="demo", agent="leader", task_id="T01", claim_lamport=1, done=[])),
                 ("room_export", dict(room="demo", agent="leader", what="integration")),
                 ("memory_history", dict(room="demo", agent="leader", section="notes"))]
        for tool, args in cases:
            with self.subTest(tool=tool):
                self.reject(tool, dict(args, **{PRIVATE: PRIVATE}), "bad_args", "unknown arg")

    def test_events_never_echo_invalid_values(self):
        base = dict(room="demo", agent="leader", after_lamport=0)
        for key, rule in (("after_lamport", "integer >= 0"), ("limit", "1-500"),
                          ("wait_ms", "0-30000"), ("acts", "array of strings"),
                          ("ops", "array of strings")):
            with self.subTest(key=key):
                self.reject("room_events", dict(base, **{key: PRIVATE}), "bad_args", key, rule)

    def test_snapshot_bad_args_are_actionable(self):
        app.dispatch("plan_create", create_args())
        for key, value, rule in (("now", PRIVATE, "finite"), ("since", -1, "0-9007199254740991"),
                                 ("max_bytes", True, "1024-65536"), ("since", 999, "head")):
            self.reject("orchestrator_snapshot", {"room": "demo", key: value}, "bad_args", key, rule)

    def test_wait_filters_name_the_rule(self):
        for key, value, fragments in (("agents", [PRIVATE], ("agents", "1-48")),
                                      ("parent", PRIVATE, ("parent", "1-48")),
                                      ("states", [PRIVATE], ("states", "finished", "failed")),
                                      ("since_lamport", True, ("since_lamport", "0-9007199254740991")),
                                      ("timeout_s", 0, ("timeout_s", "1-600"))):
            self.reject("wait_agents", {"room": "demo", key: value}, "bad_args", *fragments)

    def test_lifecycle_result_field_details(self):
        cases = [(dict(summary=PRIVATE), ("result.verdict", "required")),
                 (dict(verdict=PRIVATE), ("result.verdict", "OK", "FAIL")),
                 (dict(verdict="OK", summary=PRIVATE * 100), ("result.summary", "2000")),
                 (dict(verdict="OK", receipt=PRIVATE * 20), ("result.receipt", "512")),
                 (dict(verdict="OK", evidence=[{}] * 33), ("result.evidence", "0-32")),
                 (dict(verdict="OK", evidence=[dict(path=PRIVATE, sha256=PRIVATE)]),
                  ("result.evidence[0].sha256", "64"))]
        for value, fragments in cases:
            self.reject("agent_lifecycle", dict(room="demo", agent="leader", run_id="run",
                                               state="finished", result=value), "bad_args", *fragments)
        with self.assertRaises(PlanError) as error:
            validate_result({"verdict": "OK", PRIVATE: PRIVATE})
        self.assertIn("unknown", str(error.exception))
        self.assertNotIn(PRIVATE, str(error.exception))

    def test_common_bad_args_limits(self):
        self.reject("next_work", dict(room="demo", agent="leader", limit=-1), "bad_args",
                    "limit", "0-9007199254740991")
        self.reject("memory_history", dict(room="demo", agent="leader", section="notes", limit=501),
                    "bad_args", "limit", "1-500")
        self.reject("room_export", dict(room="demo", agent="leader", what=PRIVATE),
                    "bad_args", "what", "plan", "memory", "integration")
        self.reject("room_send", dict(room="demo", agent="leader", to="worker", act="ack", text="ok", re=None),
                    "bad_args", "re", "null")

    def test_task_missing_keys_report_index_and_all_required_fields(self):
        self.reject("plan_create", create_args(tasks=[{}]), "bad_op",
                    "tasks[0]", "key", "title", "type", "phase", "required")
        args = create_args()
        args["tasks"].append(dict(title="Second", type="action", phase="start"))
        self.reject("plan_create", args, "bad_op", "tasks[1]", "key", "required")

    def test_task_field_and_dependency_errors_keep_index(self):
        for field, value in (("title", 9), ("title", "z" * 121), ("phase", PRIVATE),
                             ("type", PRIVATE), ("deps", [PRIVATE])):
            args = create_args()
            args["tasks"][0][field] = value
            code = "limit_exceeded" if field == "title" and isinstance(value, str) else (
                "not_found" if field == "deps" else "bad_op")
            self.reject("plan_create", args, code, "tasks[0]", field)

    def test_conformance_findings_explicitly_created_and_retry_is_noop(self):
        args = create_args(op_id="create-c9-plan")
        args["tasks"][0]["microtasks"] = []
        result = app.dispatch("plan_create", args)["untrusted"]
        self.assertTrue(result.get("created"), result)
        self.assertTrue(result["conformance"])
        self.assertEqual(result["plan_id"], "p1")
        projection = app.dispatch("plan_get", {"room": "demo"})["untrusted"]
        self.assertEqual(result["opened_lamport"], projection["plan"]["opened_lamport"])
        self.assertIsInstance(projection["tasks"], list)
        self.assertEqual([task["id"] for task in projection["tasks"]], ["T01"])
        before = self.journal()
        replay = app.dispatch("plan_create", args)["untrusted"]
        self.assertTrue(replay["created"])
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["opened_lamport"], result["opened_lamport"])
        self.assertEqual(self.journal(), before)

    def test_strict_findings_preserve_failure_and_explicitly_not_created(self):
        args = create_args(strict=True)
        args["tasks"][0]["microtasks"] = []
        self.reject("plan_create", args, "not_conformant", "created: false", "conformance")
        self.assertFalse(self.journal())

    def test_template_common_envelope_is_ignored_but_unknown_still_rejected(self):
        for tool, args in (("list_templates", {}), ("get_template", {"template_id": "neutral"})):
            before = self.journal()
            normal = app.dispatch(tool, args)
            for adapter in ("cli", "mcp"):
                rc, value = call(adapter, tool, dict(args, room="demo", agent="leader"))
                self.assertEqual(rc, 0, value)
                self.assertEqual(value, normal)
            self.reject(tool, dict(args, x=PRIVATE), "bad_op", "unknown arg", "x")
            self.assertEqual(self.journal(), before)

    def test_descriptions_and_template_schemas_explain_actual_shapes(self):
        descriptors = {item["name"]: item for item in app.list_tools()}
        for name in ("list_templates", "get_template"):
            properties = descriptors[name]["inputSchema"]["properties"]
            self.assertTrue({"room", "agent"} <= properties.keys())
        for name in ("plan_create", "plan_get"):
            description = descriptors[name]["description"]
            self.assertIn("list", description)
            self.assertIn("key", description)
            self.assertIn("task id", description)
        description = descriptors["plan_create"]["description"]
        for fragment in ("created", "opened_lamport", "strict", "false"):
            self.assertIn(fragment, description)
