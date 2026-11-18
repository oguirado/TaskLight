"""Durable identity, historical replies and read contracts at the new ceiling."""
import hashlib

from bridge.room import store

from .support import JournalCase, NEW_CAP, OLD_CAP, ROOM, invoke, outcome


class Continuity(JournalCase):
    def test_at_capacity_retries_return_original_receipts_and_conflicts_stay_bad_op(self):
        self.plan()
        self.life("deployed", "deploy-current")
        first_alive = self.life("alive", "alive-current")
        before_noop = self.journal.read_bytes()
        noop = self.life("alive", "alive-throttled")
        self.assertEqual(noop, first_alive)
        self.assertTrue(self.journal.read_bytes() == before_noop)
        noop_bytes = self.noops.read_bytes()

        proof = self.root / "report.txt"
        proof.write_bytes(b"Original work evidence\n")
        evidence = [{"path": str(proof), "sha256": hashlib.sha256(proof.read_bytes()).hexdigest()}]
        message = {"agent": "reviewer", "to": "worker", "act": "question",
                   "text": "Inspect this report", "evidence": evidence, "op_id": "ask-evidence"}
        original_message = invoke("room_send", **message)
        legacy_proof = self.root / "legacy-report.txt"
        legacy_proof.write_bytes(proof.read_bytes())
        legacy = {"agent": "reviewer", "act": "question", "text": "Preserve original evidence",
                  "to": "worker", "evidence": [str(legacy_proof)], "op_id": "legacy-evidence"}
        original_legacy = store.post(ROOM, **legacy)
        self.assertEqual(original_legacy["evidence"], [{**evidence[0], "path": str(legacy_proof)}])

        claim = {"agent": "worker", "task_id": "T01", "op_id": "claim-current"}
        original_claim = invoke("task_claim", **claim)
        invoke("microtask_set", agent="worker", id="T01.M01", state="active",
               op_id="activate-work")
        activity = {"agent": "worker", "task_id": "T01", "micro_id": "T01.M01",
                    "run_id": "run-current", "op_id": "beat-current"}
        original_activity = invoke("activity_beat", **activity)
        self.assertNotIn("ignored", original_activity)
        self.life("finished", "finished-current", result={"verdict": "OK"})

        receipt_ops = [
            {"kind": "memory.set", "section": "goal", "text": "before", "base_rev": 0,
             "op_id": "replay-batch"},
            {"kind": "memory.set", "section": "rules", "text": "rules", "base_rev": 0,
             "op_id": "replay-member"},
        ]
        original_batch = self.batch(receipt_ops)
        ids = [e["id"] for e in original_batch]
        digest = original_batch[0]["batch"]["request_sha256"]
        self.assertRegex(digest, r"^[0-9a-f]{64}$")
        self.assertEqual([e["batch"]["seq"] for e in original_batch], [0, 1])
        for event in original_batch:
            self.assertEqual(event["batch"]["member_ids"], ids)
            self.assertEqual(event["batch"]["count"], len(ids))
            self.assertEqual(event["batch"]["request_sha256"], digest)
        self.batch([{"kind": "memory.set", "section": "goal", "text": "after",
                     "base_rev": original_batch[0]["lamport"]}])

        message_event = next(e for e in self.events() if e["id"] == original_message["id"])
        self.assertEqual(message_event["evidence"], evidence)
        self.assertRegex(message_event["request_sha256"], r"^[0-9a-f]{64}$")
        proof.write_bytes(b"The typed evidence file has changed.\n")
        legacy_proof.unlink()
        prefix = self.journal.read_bytes()
        self.pad(prefix, NEW_CAP)
        before = self.journal.read_bytes()
        oldest = invoke("plan_get", since_rev=original_claim["rev"])
        self.assertEqual(oldest["tasks"][0], original_claim["task"])
        self.assertNotEqual(invoke("plan_get")["tasks"][0], original_claim["task"])

        calls = [
            ["room_send", message],
            ["task_claim", claim],
            ["activity_beat", activity],
            ["agent_lifecycle", {"agent": "worker", "state": "alive", "run_id": "run-current",
                                 "op_id": "alive-throttled"}],
            ["batch", {"ops": receipt_ops}],
            ["plan_get", {"since_rev": original_claim["rev"]}],
            ["legacy-evidence", legacy],
            ["room_send", {**message, "text": "Different question"}],
            ["legacy-evidence", {**legacy, "text": "Different evidence request"}],
            ["activity_beat", {**activity, "note": "Different note"}],
            ["batch", {"ops": [{**receipt_ops[0], "text": "different"}, receipt_ops[1]]}],
            ["agent_lifecycle", {"agent": "worker", "state": "alive", "run_id": "run-current",
                                 "op_id": "alive-throttled", "reason": "changed"}],
        ]
        fresh = self.restart(calls)
        replies = fresh["replies"]
        self.assertEqual(replies[:4], [
            {"reply": original_message}, {"reply": {**original_claim, "replayed": True}},
            {"reply": {**original_activity, "replayed": True}}, {"reply": noop},
        ])
        self.assertEqual(replies[4], {"reply": [{**e, "replayed": True} for e in original_batch]})
        self.assertEqual(replies[5], {"reply": oldest})
        self.assertEqual(replies[6], {"reply": {**original_legacy, "replayed": True}})
        self.assertEqual(replies[7:], [{"code": "bad_op"}] * 5)
        by_id = {e["id"]: e for e in fresh["events"]}
        self.assertEqual(by_id[message_event["id"]], message_event)
        self.assertEqual([by_id[i] for i in ids], original_batch)
        self.assertTrue(self.journal.read_bytes() == before)
        self.assertEqual(self.noops.read_bytes(), noop_bytes)
        self.refuses(lambda: self.post("verdict", "No further transaction"))

    def test_wait_inventory_linked_decision_export_and_plan_share_cross_boundary_history(self):
        opening = self.plan()["opened_lamport"]
        parent = {"parent_agent": "reviewer", "parent_run_id": "review-run"}
        retired = {"agent": "worker", "run_id": "run-retired"}
        invoke("agent_lifecycle", **retired, **parent, state="deployed", op_id="deploy-retired")
        invoke("agent_lifecycle", **retired, state="failed", op_id="failed-retired",
               result={"verdict": "FAIL", "summary": "Previous run failed"})
        deployed = self.life("deployed", "deploy-current", **parent)
        self.pad(self.journal.read_bytes(), OLD_CAP)
        result = {"verdict": "OK", "summary": "Cross-boundary result", "receipt": "report.json"}
        terminal = self.succeeds(lambda: self.life("finished", "finished-current", result=result))
        decision_args = {
            "agent": "reviewer", "task_id": "T01", "verdict": "ADMIT",
            "reason": "Reviewed cross-boundary result", "op_id": "decision-current",
            "result_agent": "worker", "result_run_id": "run-current",
            "expected_opened_lamport": opening,
        }
        decision = invoke("unit_decide", **decision_args)
        self.assertEqual(decision["op"]["result_agent"], "worker")
        self.assertEqual(decision["op"]["result_run_id"], "run-current")
        self.assertGreater(decision["lamport"], terminal["lamport"])

        wait_args = {"parent": "reviewer", "since_lamport": deployed["lamport"]}
        wait = invoke("wait_agents", **wait_args)
        self.assertEqual(wait["cursor"], decision["lamport"])
        self.assertEqual([(e["agent"], e["state"], e["run_id"], e["lamport"], e["result"])
                          for e in wait["events"]],
                         [("worker", "finished", "run-current", terminal["lamport"], result)])
        inventory = invoke("agents_list")
        worker = next(e for e in inventory["agents"] if e["agent"] == "worker")
        self.assertEqual((worker["run_id"], worker["state"], worker["last_result"]),
                         ("run-current", "finished", result))
        export_args = {"agent": "reviewer", "what": "integration", "opened_lamport": opening}
        exported = invoke("room_export", **export_args)
        self.assertLess(exported["text"].index("Previous run failed"),
                        exported["text"].index(result["summary"]))
        self.assertLess(exported["text"].index(result["summary"]),
                        exported["text"].index(decision["op"]["reason"]))
        projection = invoke("plan_get")
        self.assertEqual(projection["plan"]["opened_lamport"], opening)
        self.assertEqual(projection["plan"]["title"], "Continuity plan")
        self.assertEqual([t["id"] for t in projection["tasks"]], ["T01"])
        self.assertEqual(projection["last_lamport"], decision["lamport"])

        tools = [["wait_agents", wait_args], ["wait_agents", wait_args], ["agents_list", {}],
                 ["unit_decide", decision_args], ["room_export", export_args], ["plan_get", {}]]
        before = self.journal.read_bytes()
        self.assertEqual(self.restart(tools)["replies"], [{"reply": reply} for reply in
                         (wait, wait, inventory, decision, exported, projection)])
        self.assertTrue(self.journal.read_bytes() == before)

    def test_checked_read_and_required_template_errors_survive_larger_journals(self):
        self.plan()
        prefix = self.journal.read_bytes()
        self.pad(prefix, OLD_CAP + 1)
        self.assertEqual(outcome(lambda: invoke("plan_get"))["reply"]["plan"]["title"],
                         "Continuity plan")

        # A syntactically valid opening still requires its own template.
        changed = prefix.replace(b'"template_id":"blank"', b'"template_id":"unknown-c4m"')
        self.assertNotEqual(changed, prefix)
        self.pad(changed, OLD_CAP + 1)
        self.assertEqual(outcome(lambda: invoke("plan_get")), {"code": "template_unavailable"})

        self.pad(prefix, OLD_CAP + 1)
        with self.journal.open("ab") as stream:
            stream.write(b'{"broken":}\n')
        for tool in ("plan_get", "agents_list"):
            self.assertEqual(outcome(lambda: invoke(tool)), {"code": "room_read_failed"})
        self.journal.unlink()
        for tool in ("plan_get", "agents_list"):
            self.assertEqual(outcome(lambda: invoke(tool)), {"code": "room_read_failed"})
        self.assertFalse(self.journal.exists())
