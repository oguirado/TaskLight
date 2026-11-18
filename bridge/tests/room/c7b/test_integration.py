"""C7b MCP workflow, plan generation export and resultless decisions."""
from contextlib import redirect_stderr, redirect_stdout
import io
import re
from unittest import mock

from bridge.room import __main__ as cli
from bridge.room import mcp
from bridge.tests.room.c7.support import SECRET, bounded
from bridge.wall.emit import sanitize_output

from .support import ARTIFACT, REVIEWER, ROOM, ROOT, WORKER, ProjectCase, RoomCase

EXPORT_ARGS = {**REVIEWER, "what": "integration"}


def decision_args(verdict, reason, op_id, **fields):
    return {**REVIEWER, "task_id": "T01", "op_id": op_id,
            "verdict": verdict, "reason": reason, **fields}


class WorkflowOracle(ProjectCase):
    def test_mcp_reviews_a_worker_artifact_before_admitting(self):
        opening = self.open_plan()
        owner_text = "Build report\n" + SECRET
        actual = self.write_artifact(owner_text.encode())
        self.mcp_ok("agent_lifecycle", {**WORKER, "state": "deployed",
                                       "parent_agent": REVIEWER["agent"]})
        self.mcp_ok("agent_lifecycle", {
            **WORKER, "state": "finished", "result": {
                "verdict": "OK", "summary": "Worker verified the build",
                "receipt": ARTIFACT, "evidence": [{"path": ARTIFACT, "sha256": actual}],
            },
        })
        waited = self.mcp_ok("wait_agents", {
            "room": ROOM, "parent": REVIEWER["agent"], "since_lamport": opening,
        })
        self.assertEqual(len(waited["events"]), 1)
        result = waited["events"][0]
        pointer = result["result"]["evidence"][0]
        self.assertEqual(pointer, {"path": ARTIFACT, "sha256": actual})
        read_args = {**REVIEWER, **pointer}
        reply = self.mcp_ok("artifact_read", read_args)
        self.assertEqual(reply["text"], sanitize_output({"text": owner_text})["text"])
        self.assertEqual(reply["sha256"], actual)
        self.assertNotIn(SECRET.split()[-1], reply["text"])

        reason = "Reviewed report and verified integrity"
        decided = self.mcp_ok("unit_decide", decision_args(
            "ADMIT", reason, "review-report", result_agent=result["agent"],
            result_run_id=result["run_id"], expected_opened_lamport=opening,
        ))
        self.assertTrue(decided["ok"])
        exported = self.mcp_ok("room_export", {**EXPORT_ARGS, "opened_lamport": opening})
        self.assertLess(exported["text"].index("Worker verified the build"),
                        exported["text"].index(reason))

        self.write_artifact((owner_text + "\nchanged after verification").encode())
        response, error = self.mcp_call("artifact_read", {**read_args, "limit": 1})
        self.assertTrue(response["isError"])
        self.assertEqual(error["code"], "bad_op")
        self.assertEqual(error["detail"].removeprefix("bad_op: "), "sha256 mismatch")
        self.assertFalse(error.get("text"))


class IntegrationExportOracle(RoomCase):
    OLD_ROWS = ("Previous worker finished", "Previous review decision")
    NEW_ROWS = ("Current worker finished", "Current review decision")

    def write_generation(self, slug, rows):
        opening = self.open_plan(slug + " generation")
        result_summary, reason = rows
        self.terminal(run_id=slug + "-run", result={"verdict": "OK", "summary": result_summary})
        self.dispatch("unit_decide", decision_args(
            "ADMIT", reason, slug + "-decision", result_agent=WORKER["agent"],
            result_run_id=slug + "-run", expected_opened_lamport=opening,
        ))
        return opening

    def close_plan(self):
        plan = self.dispatch("plan_get", REVIEWER)
        self.dispatch("task_update", {
            **REVIEWER, "task_id": plan["tasks"][0]["id"], "base_rev": plan["tasks"][0]["rev"],
            "state": "cancelled",
        })
        closed = self.dispatch("plan_get", REVIEWER)
        self.dispatch("plan_close", {**REVIEWER, "base_rev": closed["plan"]["rev"]})

    def two_generations(self):
        first = self.write_generation("previous", self.OLD_ROWS)
        self.close_plan()
        second = self.write_generation("current", self.NEW_ROWS)
        unfiltered = self.integration()
        self.assertLess(unfiltered.index(self.OLD_ROWS[1]), unfiltered.index(self.NEW_ROWS[0]))
        return first, second

    def assert_generation(self, opening, included, excluded):
        before = self.raw()
        scoped = self.mcp_ok("room_export", {**EXPORT_ARGS, "opened_lamport": opening})
        self.assertEqual(scoped["format"], "markdown")
        result, decision = included
        self.assertLess(scoped["text"].index(result), scoped["text"].index(decision))
        for marker in excluded:
            self.assertNotIn(marker, scoped["text"])
        self.assertEqual(self.raw(), before)

    def test_m4_current_opening_excludes_prior_rows_with_reused_task_id(self):
        _, second = self.two_generations()
        self.assert_generation(second, self.NEW_ROWS, self.OLD_ROWS)

    def test_m4_historical_opening_excludes_later_rows(self):
        first, _ = self.two_generations()
        self.assert_generation(first, self.OLD_ROWS, self.NEW_ROWS)
        for invalid in (True, str(first), float(first)):
            self.assert_room_error(
                lambda: self.dispatch("room_export", {**EXPORT_ARGS, "opened_lamport": invalid}),
            )

    def test_m4_mcp_export_schema_advertises_integration_and_optional_integer(self):
        sent = []
        with mock.patch.object(mcp, "_send", side_effect=sent.append), bounded():
            mcp._handle(42, "tools/list", {})
        self.assertEqual(len(sent), 1)
        schema, = [tool["inputSchema"] for tool in sent[0]["result"]["tools"]
                   if tool["name"] == "room_export"]
        self.assertIn("integration", schema["properties"]["what"]["enum"])
        self.assertEqual(schema["properties"].get("opened_lamport", {}).get("type"), "integer")
        self.assertNotIn("opened_lamport", schema.get("required", ()))

    def test_m4_mcp_docs_list_integration_as_a_room_export_value(self):
        docs = (ROOT / "docs/MCP.md").read_text(encoding="utf-8")
        entry = re.search(
            r"(?ms)^- \x60room_export\x60:.*?(?=^- \x60|^#{1,6} |\Z)", docs
        )
        self.assertIsNotNone(entry, "MCP docs must describe room_export")
        self.assertRegex(entry.group(), r"\bintegration\b")

    def test_m5_cli_writes_unfiltered_integration_beside_existing_outputs(self):
        self.two_generations()
        expected = self.mcp_ok("room_export", EXPORT_ARGS)["text"]
        out = self.home / "exports"
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr), bounded():
            rc = cli.main(["export", "--room", ROOM, "--out", str(out)])
        self.assertEqual(rc, 0, stderr.getvalue() or stdout.getvalue())
        for name in ("PLAN.md", "MEMORY.md"):
            self.assertTrue((out / name).is_file(), name)
        integration = out / "INTEGRATION.md"
        self.assertTrue(integration.is_file(), "CLI must also write INTEGRATION.md")
        self.assertEqual(integration.read_bytes(), expected.encode("utf-8"))


class ResultlessDecisionOracle(RoomCase):
    def resultless(self, verdict):
        return decision_args(
            verdict, "Cannot verify without a worker result", "review-resultless",
            result_agent=WORKER["agent"], result_run_id=WORKER["run_id"],
        )

    def assert_rejected(self, args, detail=None):
        before = self.raw()
        self.assert_room_error(lambda: self.dispatch("unit_decide", args), "bad_op", detail)
        self.assertEqual(self.raw(), before)

    def assert_resultless_verdict(self, verdict):
        for state in ("finished", "failed"):
            self.install([])
            self.open_plan()
            self.lifecycle("deployed")
            args = self.resultless(verdict)
            self.assert_rejected(args)  # The same reference cannot name a live run.
            self.lifecycle(state)
            self.assert_rejected({key: value for key, value in args.items() if key != "reason"})
            self.assert_rejected({**args, "reason": ""})
            before = self.events()
            reply = self.mcp_ok("unit_decide", args)
            self.assertTrue(reply["ok"])
            after = self.events()
            self.assertEqual(after[:-1], before)
            self.assertEqual(after[-1]["op"]["kind"], "unit.decision")
            for field in ("verdict", "result_agent", "result_run_id", "reason"):
                self.assertEqual(after[-1]["op"][field], args[field])

    def test_m6_hold_accepts_finished_and_failed_resultless_runs_with_reason(self):
        self.assert_resultless_verdict("HOLD")

    def test_m6_reject_accepts_finished_and_failed_resultless_runs_with_reason(self):
        self.assert_resultless_verdict("REJECT")

    def test_m6_admit_refuses_a_terminal_run_without_result_with_required_detail(self):
        self.open_plan()
        for state in ("failed", "finished"):
            run_id = state + "-run"
            self.terminal(state=state, run_id=run_id)
            args = {**self.resultless("ADMIT"), "result_run_id": run_id}
            self.assert_rejected(args, "ADMIT needs a recorded result")

