"""Exercise real journal admission and export without changing frozen oracles."""
from pathlib import Path
import unittest
from unittest import mock

from bridge.plan.errors import PlanError
from bridge.plan.ops import validate_op_shape
from bridge.room import app, store
from bridge.wall.emit import sanitize_output
from bridge.tests.room.c7 import support


def seed():
    events = support.clone(support.FIXTURE["seed"])
    for event in events:
        if event["agent"] == "worker":
            event["agent"] = "worker-1"
        if event["op"].get("assignee") == "worker":
            event["op"]["assignee"] = "worker-1"
    return events


def reference(**fields):
    return {"room": "demo", "agent": "orchestrator", "op_id": "c7r1-decision",
            "task_id": "T01", "verdict": "ADMIT", "reason": "Verified worker result",
            "result_agent": "worker-1", "result_run_id": "r1", **fields}


def cells(line):
    """Decode escaped Markdown separators independently of the exporter."""
    values = [""]
    escaped = False
    for char in line[2:]:
        if escaped:
            values[-1] += char
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == "|":
            values.append("")
        else:
            values[-1] += char
    return [value.strip() for value in values]


class RegressionCase(support.RoomCase):
    def setUp(self):
        self.enterContext(mock.patch.object(support, "HERE", Path(__file__).resolve().parent))
        super().setUp()
        self.install(seed())


class DecisionReferences(RegressionCase):
    def test_orchestrator_references_worker_result_and_export_names_worker(self):
        args = reference(micro_id="T01.M01", evidence=support.FIXTURE["evidence"][:1])
        before = support.clone(args)
        reply = self.call_decision(args)
        self.assertEqual(args, before)
        self.assertTrue(reply["ok"])
        event = self.events()[-1]
        self.assertEqual(event["agent"], "orchestrator")
        self.assertEqual(event["op"]["result_agent"], "worker-1")
        self.assertEqual(event["op"]["result_run_id"], "r1")
        self.assertNotIn("agent", event["op"])
        self.assertNotIn("run_id", event["op"])
        self.assertEqual(self.task()["last_decision"]["result_agent"], "worker-1")
        line = next(line for line in self.integration().splitlines() if line.startswith("- Decision"))
        self.assertEqual(cells(line)[-2:], ["worker-1", "r1"])

    def test_mcp_cli_and_retry_preserve_reference_and_authorship(self):
        args = reference()
        response, first = self.mcp_call("unit_decide", args)
        self.assertFalse(response.get("isError", False))
        before = self.raw()
        rc, second, _ = self.cli_call("unit_decide", args)
        self.assertEqual(rc, 0)
        self.assertEqual(second, first)
        self.assertEqual(self.raw(), before)
        self.assertEqual(first["op"]["result_agent"], "worker-1")
        self.assert_bad_decision(reference(result_run_id="missing"))

    def test_missing_agent_or_run_rejects_without_append(self):
        for fields in ({"result_agent": "absent"}, {"result_run_id": "missing"}):
            with self.subTest(fields=fields):
                self.assert_bad_decision(reference(**fields))

    def test_live_run_and_terminal_without_result_reject_without_append(self):
        for terminal in (False, True):
            events = seed()
            if terminal:
                events[-1]["op"].pop("result")
            else:
                events.pop()
            self.install(events)
            with self.subTest(terminal=terminal):
                self.assert_bad_decision(reference())

    def test_result_must_come_from_this_room(self):
        self.install(seed()[:3])
        other = self.path("other")
        other.parent.mkdir(parents=True)
        import json
        other.write_text("".join(json.dumps({**event, "room": "other"}) + "\n" for event in seed()))
        self.assert_bad_decision(reference())

    def test_each_reference_pair_is_complete_and_forms_cannot_mix(self):
        for removed in ("result_agent", "result_run_id"):
            args = reference()
            args.pop(removed)
            self.assert_bad_decision(args)
        self.assert_bad_decision(reference(run_id="r1"))

    def test_reference_slug_and_run_limits_reject_without_append(self):
        for key, values in {"result_agent": [None, 1, "", "Bad slug", "a" * 49],
                            "result_run_id": [None, 1, "", "bad/run", "r" * 65]}.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    self.assert_bad_decision(reference(**{key: value}))

    def test_shape_accepts_new_pair_and_rejects_ambiguous_raw_reference(self):
        op = {key: value for key, value in reference().items() if key not in ("room", "agent")}
        op["kind"] = "unit.decision"
        self.assertEqual(validate_op_shape(op), op)
        with self.assertRaises(PlanError) as caught:
            validate_op_shape({**op, "agent": "worker-1", "run_id": "r1"})
        self.assertEqual(caught.exception.code, "bad_op")

    def test_failed_result_and_historical_run_remain_referenceable(self):
        events = seed()
        events[-1]["op"]["state"] = "failed"
        events.append(support.event(6, {"kind": "agent.lifecycle", "op_id": "c7r1-new-deploy",
                                       "state": "deployed", "run_id": "r2"}, "worker-1"))
        self.install(events)
        self.call_decision(reference(verdict="HOLD"))
        self.assertEqual(self.task()["last_decision"]["result_run_id"], "r1")


class IntegrationSafety(RegressionCase):
    def test_legacy_nonstring_summary_is_absent_without_hiding_result(self):
        for summary in (None, False, 7, [], {}):
            events = seed()
            events[-1]["op"]["result"]["summary"] = summary
            self.install(events)
            before = self.raw()
            with self.subTest(summary=summary):
                lines = [line for line in self.integration().splitlines() if line.startswith("- Result")]
                self.assertEqual(len(lines), 1)
                self.assertEqual(cells(lines[0])[6], "")
                self.assertEqual(cells(lines[0])[5], "ADMIT")
                self.assertEqual(self.raw(), before)

    def test_legacy_summary_compatibility_does_not_admit_other_invalid_fields(self):
        events = seed()
        events[-1]["op"]["result"].update(summary=None, verdict="INVALID")
        self.install(events)
        self.assertNotIn("- Result", self.integration())

    def test_every_markdown_value_escapes_pipes_and_backslashes(self):
        events = seed()
        title, micro = r"First | task\path", r"First | micro\path"
        summary, receipt = r"summary | notes\done", r"artifacts/a|b\c.json"
        events[1]["op"]["title"] = title
        events[1]["op"]["microtasks"][0]["text"] = micro
        events[-1]["op"]["result"].update(summary=summary, receipt=receipt)
        events.append(support.event(6, support.decision(6, micro_id="T01.M01",
                                                      reason=r"review | ok\done")))
        self.install(events)
        lines = [line for line in self.integration().splitlines() if line.startswith("- ")]
        self.assertEqual(len(lines), 2)
        result, decision = map(cells, lines)
        self.assertEqual(len(result), 8)
        self.assertEqual(result[6:], [summary, receipt])
        self.assertEqual(len(decision), 9)
        self.assertEqual(decision[2:4], [title, micro])
        self.assertEqual(decision[5], r"review | ok\done")
        self.assertIn(r"\|", lines[0])
        self.assertIn(r"\\", lines[0])

    def test_full_summary_is_sanitized_before_character_limit(self):
        events = seed()
        summary = "x " * 85 + support.SECRET
        events[-1]["op"]["result"]["summary"] = summary
        self.install(events)
        before = self.raw()
        text = self.integration()
        line = next(line for line in text.splitlines() if line.startswith("- Result"))
        expected = sanitize_output({"summary": summary})["summary"][:200]
        self.assertEqual(cells(line)[6], expected.strip())
        self.assertNotIn("aBcD0123", text)
        self.assertEqual(self.raw(), before)

    def test_complete_token_straddling_limit_is_redacted_before_truncation(self):
        events = seed()
        straddler = "aBcD" "0123456789" * 3  # synthetic; split so the repo secret scan does not flag it
        summary = "safe " * 38 + straddler
        events[-1]["op"]["result"]["summary"] = summary
        self.install(events)
        line = next(line for line in self.integration().splitlines() if line.startswith("- Result"))
        expected = sanitize_output({"summary": summary})["summary"][:200]
        self.assertEqual(cells(line)[6], expected.strip())
        self.assertNotIn(straddler[:10], line)

    def test_sanitizer_failure_stops_export(self):
        self.assert_redaction_stops_output("room_export", {
            "room": "demo", "agent": "orchestrator", "what": "integration"}, "Result summary")


if __name__ == "__main__":
    unittest.main()
