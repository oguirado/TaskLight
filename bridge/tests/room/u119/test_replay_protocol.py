"""M1/M8 and A1/A6: real adapters and restart-safe content-bound replay."""
import copy
from unittest.mock import patch
from bridge.plan.limits import OP_ID_RE
from bridge.room import app, ext, store
from bridge.room.ext import acquire
from .support import WorkCase


class ReplayOracle(WorkCase):
    def test_a6_acquire_restart_lost_reply_after_progress_returns_original(self):
        self.make_plan()
        args = dict(room="demo", agent="alice", op_id="acquire-restart")
        original = acquire.work_acquire(args)
        before = self.raw()
        self.assertEqual(self.restart("work_acquire", args), original)
        self.assertEqual(self.raw(), before)
        self.micro(state="done", outcome="Later progress")
        self.claim()
        before = self.raw()
        self.assertEqual(self.restart("work_acquire", args), original)
        self.assertEqual(self.raw(), before)

    def test_a6_report_restart_after_progress_and_evidence_deletion(self):
        self.make_plan(); self.claim(); self.micro(state="active")
        args = self.report_args(op_id="report-restart")
        original = acquire.work_report(args)
        expected = dict(original, replayed=True)
        before = self.raw()
        self.assertEqual(self.restart("work_report", args), expected)
        self.assertEqual(self.raw(), before)
        self.micro("T01.M02", "done", outcome="Later progress")
        self.claim()
        self.proof.unlink()
        before = self.raw()
        self.assertEqual(self.restart("work_report", args), expected)
        self.assertEqual(self.raw(), before)

    def test_a6_acquire_changed_prefer_task_is_bad_op(self):
        self.make_plan(count=2)
        args = dict(room="demo", agent="alice", op_id="acquire-input", prefer_task="T01")
        acquire.work_acquire(args)
        self.deny("work_acquire", dict(args, prefer_task="T02"), "bad_op")

    def test_a6_report_changed_payload_is_bad_op_before_evidence_hashing(self):
        self.make_plan(); self.claim()
        args = self.report_args(op_id="report-input")
        acquire.work_report(args)
        self.proof.unlink()
        changed = copy.deepcopy(args); changed["done"][0]["outcome"] = "Different"
        self.deny("work_report", changed, "bad_op")

    def test_a6_report_changed_completion_order_is_bad_op(self):
        self.make_plan(); self.claim()
        args = self.report_args(op_id="report-order", done=[self.completion(), self.completion("T01.M02")])
        acquire.work_report(args)
        self.deny("work_report", dict(args, done=list(reversed(args["done"]))), "bad_op")

    def test_a6_canonical_key_order_does_not_change_request_identity(self):
        self.make_plan(); self.claim()
        args = self.report_args(op_id="canonical-input")
        original = acquire.work_report(args)
        reordered = dict(reversed(list(args.items())))
        reordered["done"] = [dict(reversed(list(args["done"][0].items())))]
        before = self.raw()
        self.assertEqual(self.restart("work_report", reordered), dict(original, replayed=True))
        self.assertEqual(self.raw(), before)

    def test_a6_historical_acquire_replay_does_not_renew_authority(self):
        self.make_plan()
        args = dict(room="demo", agent="alice", op_id="historical-claim")
        first = acquire.work_acquire(args)
        current = self.acquire(op_id="current-claim")
        self.assertGreater(current["claim_lamport"], first["claim_lamport"])
        before = self.raw()
        self.assertEqual(self.restart("work_acquire", args), first)
        self.assertEqual(self.raw(), before)
        self.deny("work_report", self.report_args(claim_lamport=first["claim_lamport"]), "stale_rev")

    def test_a6_replay_precedes_evidence_validation_and_batch_construction(self):
        self.make_plan(); self.claim()
        args = self.report_args(op_id="replay-before-hash")
        original = acquire.work_report(args)
        self.proof.unlink()
        before = self.raw()
        # The evidence validator is specified as the shared hashing interface.
        with patch.object(store, "_validate_evidence", side_effect=AssertionError("replay hashed evidence")):
            replayed = acquire.work_report(args)
        self.assertEqual(replayed, dict(original, replayed=True))
        self.assertEqual(self.raw(), before)

    def test_a6_acquire_replay_uses_committed_prefix_after_plan_close(self):
        self.make_plan(micros=1)
        args = dict(room="demo", agent="alice", op_id="acquire-closed-plan")
        original = acquire.work_acquire(args)
        self.micro(state="done")
        self.post({"kind": "plan.close", "base_rev": self.projection()["plan"]["rev"]})
        before = self.raw()
        self.assertEqual(self.restart("work_acquire", args), original)
        self.assertEqual(self.raw(), before)

    def test_a6_report_replay_survives_release_and_foreign_reclaim(self):
        self.make_plan(); self.claim()
        args = self.report_args(op_id="report-new-owner")
        original = acquire.work_report(args)
        self.post({"kind": "task.release", "task_id": "T01"})
        self.claim(agent="bob")
        self.proof.unlink()
        before = self.raw()
        self.assertEqual(self.restart("work_report", args), dict(original, replayed=True))
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.task()["assignee"], "bob")

    def test_a6_report_replay_uses_committed_prefix_after_plan_close(self):
        self.make_plan(micros=1); self.claim()
        args = self.report_args(op_id="report-closed-plan")
        original = acquire.work_report(args)
        self.post({"kind": "plan.close", "base_rev": self.projection()["plan"]["rev"]})
        self.proof.unlink()
        before = self.raw()
        self.assertEqual(self.restart("work_report", args), dict(original, replayed=True))
        self.assertEqual(self.raw(), before)

    def test_a6_reusing_acquire_identity_for_report_is_bad_op(self):
        self.make_plan()
        self.acquire(op_id="cross-tool-identity")
        self.deny("work_report", self.report_args(op_id="cross-tool-identity"), "bad_op")

    def test_a6_maximum_length_id_derives_valid_stable_member_ids(self):
        self.make_plan()
        args = dict(room="demo", agent="alice", op_id="a" * 64)
        result = acquire.work_acquire(args)
        self.assert_acquired(result)
        report_args = self.report_args(op_id="r" * 64)
        reported = acquire.work_report(report_args)
        for event in self.events():
            if event.get("batch"):
                self.assertRegex(event["op"]["op_id"], "^" + OP_ID_RE.pattern + "$")
        before = self.raw()
        self.assertEqual(self.restart("work_acquire", args), result)
        self.assertEqual(self.restart("work_report", report_args), dict(reported, replayed=True))
        self.assertEqual(self.raw(), before)

    def test_a6_acquire_replay_survives_foreign_reclaim_without_renewal(self):
        self.make_plan()
        args = dict(room="demo", agent="alice", op_id="acquire-new-owner")
        original = acquire.work_acquire(args)
        self.post({"kind": "task.release", "task_id": "T01"})
        self.claim(agent="bob")
        before = self.raw()
        self.assertEqual(self.restart("work_acquire", args), original)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.task()["assignee"], "bob")
        self.deny("work_report", self.report_args(claim_lamport=original["claim_lamport"]), "claimed_by_other")

    def test_a6_report_changed_claim_fence_is_bad_op(self):
        self.make_plan(); self.claim()
        args = self.report_args(op_id="report-fence-input")
        acquire.work_report(args)
        self.deny("work_report", dict(args, claim_lamport=args["claim_lamport"] + 1), "bad_op")

    def test_a6_report_changed_evidence_path_is_bad_op(self):
        self.make_plan(); self.claim()
        args = self.report_args(op_id="report-evidence-input")
        acquire.work_report(args)
        self.proof.unlink()
        changed = copy.deepcopy(args)
        changed["done"][0]["evidence"] = [str(self.tmp / "missing-replacement.txt")]
        self.deny("work_report", changed, "bad_op")

    def test_a6_replay_needs_no_append_capacity(self):
        self.make_plan()
        args = dict(room="demo", agent="alice", op_id="capacity-replay-acquire")
        acquired = acquire.work_acquire(args)
        report_args = self.report_args(op_id="capacity-replay-report")
        reported = acquire.work_report(report_args)
        self.proof.unlink()
        before = self.raw()
        with patch.object(store, "CAP", len(before)):
            self.assertEqual(acquire.work_acquire(args), acquired)
            self.assertEqual(acquire.work_report(report_args), dict(reported, replayed=True))
        self.assertEqual(self.raw(), before)


class ProtocolOracle(WorkCase):
    def require_handler(self, tool):
        # Do not let adapter exception conversion hide an unimplemented handler.
        self.make_plan(room="probe")
        if tool == "work_acquire":
            acquire.work_acquire(dict(room="probe", agent="alice"))
        else:
            fence = self.claim(room="probe")
            acquire.work_report(dict(room="probe", agent="alice", task_id="T01", claim_lamport=fence,
                                     done=[self.completion()]))

    def test_a1_descriptors_and_shared_dispatch_after_import_seam(self):
        self.require_handler("work_acquire")
        with self.extension_loaded():
            from bridge.room import mcp
            sent = []
            with patch.object(mcp, "_send", side_effect=sent.append):
                mcp._handle(1, "tools/list", {})
            tools = {t["name"]: t for t in sent[0]["result"]["tools"]}
        # A-U142: C8 §7 / U142 MUST: work tools accept run_id and plan generation.
        expected = {
            "work_acquire": ({"room", "agent", "prefer_task", "op_id", "run_id",
                              "expected_opened_lamport"}, {"room", "agent"}),
            "work_report": ({"room", "agent", "task_id", "claim_lamport", "done", "op_id",
                             "run_id", "expected_opened_lamport"},
                            {"room", "agent", "task_id", "claim_lamport", "done"}),
        }
        for name, (properties, required) in expected.items():
            schema = tools[name]["inputSchema"]
            self.assertEqual(schema["type"], "object")
            self.assertEqual(set(schema["properties"]), properties)
            self.assertEqual(set(schema["required"]), required)
            self.assertIs(schema["additionalProperties"], False)
            self.assertIs(ext.EXT_DISPATCH[name], getattr(acquire, name))
            # A-U142: C8 §7 / U142 identity fields: pin both property schemas exactly.
            for field in properties - {"claim_lamport", "done", "expected_opened_lamport"}:
                self.assertEqual(schema["properties"][field]["type"], "string")
            self.assertEqual(schema["properties"]["run_id"],
                             {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"})
            self.assertEqual(schema["properties"]["expected_opened_lamport"],
                             {"type": "integer", "minimum": 1, "maximum": 9007199254740991})
        schema = tools["work_report"]["inputSchema"]["properties"]
        self.assertEqual(schema["claim_lamport"]["type"], "integer")
        self.assertEqual(schema["done"]["type"], "array")
        member = schema["done"]["items"]
        self.assertEqual(set(member["required"]), {"id", "outcome", "evidence"})
        self.assertEqual(set(member["properties"]), {"id", "outcome", "evidence", "took"})
        self.assertIs(member["additionalProperties"], False)
        for field in ("id", "outcome", "took"):
            self.assertEqual(member["properties"][field]["type"], "string")
        self.assertEqual(member["properties"]["evidence"]["type"], "array")
        self.assertEqual(member["properties"]["evidence"]["items"]["type"], "string")

    def test_a1_acquire_mcp_cli_success_and_failure_parity(self):
        self.require_handler("work_acquire")
        payloads = []
        for adapter in ("mcp", "cli"):
            self.make_plan(room=adapter)
            args = dict(room=adapter, agent="alice", op_id="protocol-acquire")
            result = self.api(adapter, "work_acquire", args)
            self.assertEqual(set(result), {"untrusted"})
            self.assert_acquired(result["untrusted"], room=adapter)
            payloads.append(result)
            before = self.raw(adapter)
            failure = self.api(adapter, "work_acquire", dict(args, takeover=True))
            self.assertEqual(failure["code"], "bad_args")
            self.assertIs(failure["ok"], False)
            self.assertEqual(self.raw(adapter), before)
        self.assertEqual(payloads[0], payloads[1])

    def test_a1_report_mcp_cli_success_and_failure_parity(self):
        self.require_handler("work_report")
        successes, failures = [], []
        for adapter in ("mcp", "cli"):
            self.make_plan(room=adapter)
            fence = self.claim(room=adapter)
            self.micro(room=adapter)
            args = dict(room=adapter, agent="alice", task_id="T01", claim_lamport=fence,
                        done=[self.completion()], op_id="protocol-report")
            before = self.raw(adapter)
            failure = self.api(adapter, "work_report", dict(args, agent="bob"))
            self.assertEqual(failure["code"], "claimed_by_other")
            self.assertEqual(self.raw(adapter), before)
            failures.append(failure)
            result = self.api(adapter, "work_report", args)
            self.assertEqual(set(result), {"untrusted"})
            self.assertIs(result["untrusted"]["ok"], True)
            successes.append(result)
        self.assertEqual(successes[0], successes[1])
        self.assertEqual(failures[0], failures[1])
