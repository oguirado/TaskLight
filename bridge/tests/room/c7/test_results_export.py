"""M1/M5/M7: result evidence, integration export and the documented loop."""
import re
import unittest

from bridge.room import app, store
from bridge.room.ext.inventory import derive_inventory
from bridge.wall.emit import sanitize_output
from .support import FIXTURE, NOW, ROOT, SECRET, TEMPLATES, RoomCase, clone, decision, event, fold


class InventoryOracle(RoomCase):
    def test_m1_keeps_first_eight_evidence_entries_and_existing_fields(self):
        seed = clone(FIXTURE["seed"])
        items = [{"path": f"artifacts/check-{n}.json", "sha256": f"{n:064x}"} for n in range(32)]
        seed[-1]["op"]["result"].update(summary="s" * 201, evidence=items)
        self.install(seed)
        before = self.raw()
        row = self.inventory()
        self.assertEqual(row["last_result"], {"verdict": "ADMIT", "summary": "s" * 200,
                                            "receipt": "artifacts/result.json", "evidence": items[:8]})
        self.assertEqual(row["state"], "finished")
        self.assertEqual(row["run_id"], "r1")
        self.assertEqual(row["counts"], {"tasks_owned": 1, "micros_done": 0, "micros_total": 2})
        self.assertEqual(self.raw(), before)

    def test_m1_omits_evidence_when_absent_and_preserves_legacy_fields(self):
        seed = clone(FIXTURE["seed"])
        seed[-1]["op"]["result"].pop("evidence")
        self.install(seed)
        self.assertEqual(self.inventory()["last_result"], {
            "verdict": "ADMIT", "summary": "Result summary", "receipt": "artifacts/result.json"})

    def test_m1_verdict_only_result_keeps_optional_summary_and_receipt_null(self):
        seed = clone(FIXTURE["seed"])
        seed[-1]["op"]["result"] = {"verdict": "HOLD"}
        self.install(seed)
        self.assertEqual(self.inventory()["last_result"], {"verdict": "HOLD", "summary": None, "receipt": None})

    def test_m1_failed_result_keeps_evidence(self):
        seed = clone(FIXTURE["seed"])
        seed[-1]["op"].update(state="failed", result={"verdict": "FAIL", "evidence": FIXTURE["evidence"][:1]})
        self.install(seed)
        row = self.inventory()
        self.assertEqual(row["state"], "failed")
        self.assertEqual(row["last_result"].get("evidence"), FIXTURE["evidence"][:1])

    def test_m1_existing_result_hash_case_and_unicode_path_keep_their_bytes(self):
        seed = clone(FIXTURE["seed"])
        evidence = [{"path": "artifacts/évidence.json", "sha256": "A" * 64}]
        seed[-1]["op"]["result"]["evidence"] = evidence
        self.install(seed)
        self.assertEqual(self.inventory()["last_result"].get("evidence"), evidence)

    def test_m1_explicit_empty_evidence_is_not_fabricated_or_dropped(self):
        seed = clone(FIXTURE["seed"])
        seed[-1]["op"]["result"]["evidence"] = []
        self.install(seed)
        self.assertEqual(self.inventory()["last_result"].get("evidence"), [])

    def test_m1_old_run_evidence_does_not_leak_into_redeployment(self):
        seed = clone(FIXTURE["seed"])
        seed.append(event(6, {"kind": "agent.lifecycle", "op_id": "c7-redeploy", "state": "deployed", "run_id": "r2"}, "worker"))
        self.install(seed)
        self.assertIsNone(self.inventory()["last_result"])

    def test_m1_legacy_terminal_without_result_keeps_last_result_null(self):
        seed = clone(FIXTURE["seed"])
        seed[-1]["op"].pop("result")
        self.install(seed)
        self.assertIsNone(self.inventory()["last_result"])

    def test_m1_shared_sanitizer_preserves_evidence_pointer_bytes(self):
        seed = clone(FIXTURE["seed"])
        pointer = {"path": "artifacts/" + "0123456789abcdef" * 4 + ".json", "sha256": "a" * 64}
        seed[-1]["op"]["result"].update(summary=SECRET, evidence=[pointer])
        self.install(seed)
        response, payload = self.mcp_call("agents_list", {"room": "demo", "now": NOW})
        self.assertFalse(response.get("isError", False))
        row = next(item for item in payload["agents"] if item["agent"] == "worker")
        self.assertEqual(row["last_result"].get("evidence"), [pointer])
        self.assertEqual(row["last_result"]["summary"], sanitize_output({"summary": SECRET})["summary"])
        self.assertEqual(self.events()[-1]["op"]["result"]["summary"], SECRET)

    def test_m1_projection_does_not_alias_source_evidence(self):
        seed = clone(FIXTURE["seed"])
        before = clone(seed)
        inventory = derive_inventory("demo", seed, NOW, templates=TEMPLATES)
        row = next(item for item in inventory["agents"] if item["agent"] == "worker")
        self.assertEqual(row["last_result"].get("evidence"), FIXTURE["evidence"])
        row["last_result"]["evidence"][0]["path"] = "artifacts/changed.json"
        self.assertEqual(seed, before)


class ExportOracle(RoomCase):
    def test_m5_empty_room_has_header_and_exact_empty_line(self):
        text = self.integration()
        self.assertRegex(text, r"(?m)^#{1,6}\s+\S")
        self.assertIn("No results or decisions yet.", text.splitlines())
        self.assertEqual(self.raw(), b"")

    def test_m5_terminal_result_and_each_accepted_decision_share_lamport_order(self):
        seed = clone(FIXTURE["seed"])
        first = decision(6, reason="First accepted", micro_id="T01.M01", agent="worker", run_id="r1", evidence=FIXTURE["evidence"][:2])
        second = decision(7, reason="Second accepted", verdict="HOLD")
        seed += [event(6, first), event(7, second)]
        # Physical input order is deliberately different from Lamport order.
        self.install([seed[-1], *reversed(seed[:-1])])
        before = self.raw()
        text = self.integration()
        lines = text.splitlines()
        terminal = [line for line in lines if "Result summary" in line]
        admitted = [line for line in lines if "First accepted" in line]
        held = [line for line in lines if "Second accepted" in line]
        self.assertEqual((len(terminal), len(admitted), len(held)), (1, 1, 1))
        for token in ("worker", "r1", "finished", "ADMIT", "artifacts/result.json"):
            self.assertIn(token, terminal[0])
        for token in ("First task", "First micro", "ADMIT", "worker"):
            self.assertIn(token, admitted[0])
        self.assertRegex(admitted[0], r"\b2\b")
        self.assertIn("First task", held[0])
        self.assertIn("HOLD", held[0])
        self.assertRegex(held[0], r"\b0\b")
        self.assertLess(lines.index(terminal[0]), lines.index(admitted[0]))
        self.assertLess(lines.index(admitted[0]), lines.index(held[0]))
        self.assertEqual(self.raw(), before)

    def test_m5_every_result_event_not_only_latest_run_is_exported(self):
        seed = clone(FIXTURE["seed"])
        seed[-1]["op"]["result"]["summary"] = "Prior run result"
        seed += [event(6, {"kind": "agent.lifecycle", "op_id": "c7-run-two", "state": "deployed", "run_id": "r2"}, "worker"),
                 event(7, {"kind": "agent.lifecycle", "op_id": "c7-failed-two", "state": "failed", "run_id": "r2", "result": {
                     "verdict": "FAIL", "summary": "Later run result", "receipt": "artifacts/later.json"}}, "worker")]
        self.install(seed)
        text = self.integration()
        self.assertLess(text.index("Prior run result"), text.index("Later run result"))
        self.assertEqual(text.count("Prior run result"), 1)
        self.assertEqual(text.count("Later run result"), 1)
        later = next(line for line in text.splitlines() if "Later run result" in line)
        for token in ("worker", "r2", "failed", "FAIL", "artifacts/later.json"):
            self.assertIn(token, later)

    def test_m5_projection_cap_does_not_drop_older_integration_decisions(self):
        history = next(item for item in FIXTURE["histories"] if item["name"] == "bounded_history")
        self.install(history["events"])
        text = self.integration()
        lines = [line for line in text.splitlines() if re.search(r"Decision \d{2}", line)]
        self.assertEqual(len(lines), 20)
        for line, n in zip(lines, range(6, 26)):
            self.assertIn(f"Decision {n:02d}", line)

    def test_m5_rejected_records_and_conflicting_retries_are_excluded(self):
        seed = clone(FIXTURE["seed"])
        good = decision(6, reason="Accepted once")
        seed += [event(6, good), event(7, {**good, "reason": "Rejected conflict marker"}),
                 event(8, decision(8, task_id="T40", reason="Rejected unknown task marker")),
                 event(9, decision(9, micro_id="T02.M01", reason="Rejected micro marker")),
                 event(10, {"kind": "agent.lifecycle", "op_id": "c7-wrong-run", "state": "finished", "run_id": "missing", "result": {
                     "verdict": "OK", "summary": "Rejected lifecycle marker"}}, "worker")]
        self.assertEqual(fold(seed[:6])["rejected"], [], "valid decision must precede rejection filtering")
        projected = fold(seed)
        self.assertEqual(len(projected["rejected"]), 4)
        self.install(seed)
        text = self.integration()
        self.assertEqual(text.count("Accepted once"), 1)
        for token in ("Rejected conflict marker", "Rejected unknown task marker", "Rejected micro marker", "Rejected lifecycle marker"):
            self.assertNotIn(token, text)

    def test_m5_duplicate_event_and_identical_op_retry_emit_one_line(self):
        seed = clone(FIXTURE["seed"])
        op = decision(6, reason="Unique decision line")
        seed += [event(6, op), event(7, op), event(6, op)]
        self.install(seed)
        text = self.integration()
        self.assertEqual(text.count("Unique decision line"), 1)
        self.assertEqual(text.count("Result summary"), 1)

    def test_m5_reject_verdict_is_an_accepted_decision_not_a_rejected_record(self):
        seed = clone(FIXTURE["seed"])
        seed.append(event(6, decision(6, verdict="REJECT", reason="Unit rejected deliberately")))
        self.install(seed)
        text = self.integration()
        row = next((line for line in text.splitlines() if "Unit rejected deliberately" in line), "")
        self.assertIn("REJECT", row)
        self.assertIn("First task", row)

    def test_m5_summary_truncated_to_200_and_optional_fields_supported(self):
        seed = clone(FIXTURE["seed"])
        summary = "summary-word " * 20
        seed[-1]["op"]["result"]["summary"] = summary
        seed += [event(6, {"kind": "agent.lifecycle", "op_id": "c7-other-deploy", "state": "deployed", "run_id": "other"}, "other"),
                 event(7, {"kind": "agent.lifecycle", "op_id": "c7-other-result", "state": "failed", "run_id": "other", "result": {"verdict": "NO_PUDE"}}, "other")]
        self.install(seed)
        text = self.integration()
        self.assertIn(summary[:200], text)
        self.assertNotIn(summary[:201], text)
        row = next(line for line in text.splitlines() if "NO_PUDE" in line)
        for token in ("other", "failed", "NO_PUDE"):
            self.assertIn(token, row)

    def test_m5_sanitized_text_preserves_receipt_bytes_and_owner_journal(self):
        seed = clone(FIXTURE["seed"])
        pointer = "artifacts/" + "0123456789abcdef" * 4 + ".json"
        seed[-1]["op"]["result"].update(summary=SECRET, receipt=pointer)
        seed.append(event(6, decision(6, reason=SECRET)))
        self.install(seed)
        before = self.raw()
        text = self.integration()
        self.assertNotIn(SECRET, text)
        self.assertIn(sanitize_output({"summary": SECRET})["summary"], text)
        self.assertIn(pointer, text)
        self.assertEqual(self.raw(), before)

    def test_m5_multiline_content_stays_on_one_line_per_record(self):
        seed = clone(FIXTURE["seed"])
        seed[-1]["op"]["result"]["summary"] = "Summary first\nSummary second"
        seed.append(event(6, decision(6, reason="Reason first\nReason second")))
        self.install(seed)
        text = self.integration()
        self.assertTrue(any("Summary first" in line and "Summary second" in line for line in text.splitlines()))
        self.assertTrue(any("Reason first" in line and "Reason second" in line for line in text.splitlines()))

    def test_m5_nonterminal_and_legacy_terminal_events_add_no_rows(self):
        seed = clone(FIXTURE["seed"])
        seed[-1]["op"].pop("result")
        self.install(seed)
        text = self.integration()
        self.assertIn("No results or decisions yet.", text.splitlines())

    def test_m5_export_mcp_and_cli_have_identical_output(self):
        self.install()
        args = {"room": "demo", "agent": "reviewer", "what": "integration"}
        response, mcp_payload = self.mcp_call("room_export", args)
        self.assertFalse(response.get("isError", False), mcp_payload)
        rc, cli_payload, _ = self.cli_call("room_export", args)
        self.assertEqual(rc, 0, cli_payload)
        self.assertEqual(cli_payload, mcp_payload)

    def test_m5_sanitizer_failure_has_no_unsanitized_fallback(self):
        self.install()
        # First prove that integration is a supported export kind.
        self.integration()
        self.assert_redaction_stops_output("room_export", {
            "room": "demo", "agent": "reviewer", "what": "integration"}, "Result summary")


class DocumentationOracle(unittest.TestCase):
    def test_m7_results_document_contains_the_ordered_orchestrator_loop(self):
        path = ROOT / "docs" / "RESULTS.md"
        self.assertTrue(path.is_file(), "M7 docs/RESULTS.md is required")
        text = path.read_text(encoding="utf-8")
        # Accept shell examples, prose or arrows; no specific Markdown layout.
        pattern = r"tasklight\s+run\b[\s\S]*?--result-file[\s\S]*?wait_agents[\s\S]*?unit_decide[\s\S]*?room_export[\s\S]*?(?:what\s*=\s*integration|[\"']what[\"']\s*:\s*[\"']integration[\"'])"
        self.assertRegex(text, pattern)
