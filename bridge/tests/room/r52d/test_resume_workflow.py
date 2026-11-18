"""Check the R52D resume and decision workflow at the public dispatch boundary."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import unittest
from unittest import mock

from bridge.room import app, store
from bridge.tests.room.c6 import support


HERE = Path(__file__).resolve().parent
ROOM = "demo"
LEADER = "leader"
PARENT_RUN = "leader-run"
WORKER = "worker"
RETRY = "retry-run"


class ResumeWorkflowTests(support.RoomCase):
    def setUp(self):
        self.enterContext(mock.patch.object(support, "HERE", HERE))
        super().setUp()
        self.enterContext(mock.patch.object(
            subprocess, "Popen", side_effect=support.VirtualBound("process launch forbidden"),
        ))
        self.project = self.home / "project"
        self.project.mkdir()
        self.addCleanup(os.chdir, Path.cwd())
        os.chdir(self.project)

    def call(self, name, **args):
        with support.operation_budget():
            return support.unwrap(app.dispatch(name, {"room": ROOM, **args}))

    def snapshot(self, since=None, max_bytes=65536):
        args = {} if since is None else {"since": since}
        return self.call("orchestrator_snapshot", max_bytes=max_bytes, **args)

    def wait(self, since, *agents):
        return self.call("wait_agents", parent=LEADER, agents=list(agents),
                         since_lamport=since, timeout_s=1)

    def open_plan(self, title, *, micros=0):
        task = {"key": "review", "title": title, "type": "task", "phase": "plan",
                "accept": "Review the result"}
        if micros:
            task.update(assignee=WORKER, microtasks=[
                {"text": f"Check {index}"} for index in range(micros)
            ])
        created = self.call("plan_create", agent=LEADER, template_id="blank",
                            title=title, brief={"goal": title}, tasks=[task])
        self.assertTrue(created["created"])
        return created["opened_lamport"], self.call("plan_get")["tasks"][0]

    def deploy(self, agent, run):
        return self.life(agent=agent, run=run, parent_agent=LEADER, parent_run_id=PARENT_RUN)

    def terminal(self, agent, run, state="finished", **fields):
        self.deploy(agent, run)
        return self.life(agent=agent, run=run, state=state, **fields)

    def decide(self, opening, task_id, terminal, verdict, reason, **fields):
        return self.call(
            "unit_decide", agent=LEADER,
            op_id=f"decide-{terminal['agent']}-{terminal['run_id']}-{verdict}",
            task_id=task_id, expected_opened_lamport=opening,
            result_agent=terminal["agent"], result_run_id=terminal["run_id"],
            verdict=verdict, reason=reason, **fields,
        )

    def test_resume_replays_clipped_completions_and_matches_retry(self):
        opening, task = self.open_plan("Resume plan", micros=2)
        self.life(agent=LEADER, run=PARENT_RUN)
        # The waiter starts before any child could report a terminal.
        start = self.snapshot()["head_lamport"]
        for micro in task["microtasks"]:
            self.call("microtask_set", agent=WORKER, id=micro["id"], state="done")

        old = self.terminal(WORKER, "old-run", "failed")
        other = self.terminal("other", RETRY)
        retry = self.terminal(WORKER, RETRY)
        # Keep the capture large enough to clip a whole Lamport group at a legal budget.
        for index in range(6):
            self.call("task_add", agent=LEADER, phase="plan", type="task",
                      title=f"Ready follow-up {index} for an available worker",
                      accept="Record the review")

        whole = self.snapshot(since=start)
        all_rows = whole["completed_since"]
        self.assertEqual(len(all_rows), 3)
        self.assertLess(all_rows[0]["lamport"], all_rows[1]["lamport"])
        self.assertEqual(all_rows[1]["lamport"], all_rows[2]["lamport"])
        budget = len(json.dumps({"untrusted": whole}, ensure_ascii=False,
                                separators=(",", ":")).encode("utf-8")) - 1
        self.assertGreaterEqual(budget, 1024)
        page = self.snapshot(since=start, max_bytes=budget)
        self.assertFalse(page["complete"])
        self.assertEqual(page["completed_since"], all_rows[:1])
        self.assertEqual(page["omitted"]["completed_since"], 2)
        self.assertEqual(page["cursor"], all_rows[0]["lamport"])
        self.assertGreater(page["head_lamport"], page["cursor"])

        # The caller saves dispositions and expected identities together with its cursors.
        checkpoint = self.project / "checkpoint.json"
        checkpoint.write_text(json.dumps({
            "room": ROOM, "opening": opening,
            "snapshot_cursor": page["cursor"], "waiter_cursor": start,
            "processed_completions": [row["id"] for row in page["completed_since"]],
            "pending_retry": [WORKER, RETRY], "parent_run": PARENT_RUN,
        }), encoding="utf-8")
        recovered = json.loads(checkpoint.read_text(encoding="utf-8"))
        self.assertEqual(recovered["room"], ROOM)
        self.assertEqual(self.call("plan_get")["plan"]["opened_lamport"], recovered["opening"])

        resumed = self.snapshot(since=recovered["snapshot_cursor"])
        self.assertTrue(resumed["complete"])
        recovered["processed_completions"].extend(row["id"] for row in resumed["completed_since"])
        self.assertEqual(recovered["processed_completions"], [row["id"] for row in all_rows])
        recovered["snapshot_cursor"] = resumed["cursor"]

        waited = self.wait(recovered["waiter_cursor"], WORKER, "other")
        self.assertEqual([row["lamport"] for row in waited["events"]],
                         [old["lamport"], other["lamport"], retry["lamport"]])
        expected = tuple(recovered["pending_retry"])
        dispositions = {}
        for row in waited["events"]:
            identity = (row["agent"], row["run_id"])
            matches = identity == expected and row["parent"] == {
                "agent": LEADER, "run_id": recovered["parent_run"],
            }
            dispositions[row["lamport"]] = "matched" if matches else "different attempt"
        self.assertEqual(dispositions, {
            old["lamport"]: "different attempt", other["lamport"]: "different attempt",
            retry["lamport"]: "matched",
        })
        recovered["terminal_dispositions"] = dispositions
        recovered["pending_retry"] = None
        recovered["waiter_cursor"] = waited["cursor"]
        checkpoint.write_text(json.dumps(recovered), encoding="utf-8")
        saved = json.loads(checkpoint.read_text(encoding="utf-8"))
        self.assertEqual(saved["snapshot_cursor"], resumed["cursor"])
        self.assertEqual(saved["waiter_cursor"], whole["head_lamport"])
        self.assertEqual(saved["terminal_dispositions"][str(retry["lamport"])], "matched")

        head = page["head_lamport"]
        self.assertEqual(self.snapshot(since=head)["completed_since"], [])
        skipped = self.wait(head, WORKER)
        self.assertTrue(skipped["timed_out"])
        self.assertEqual(skipped["events"], [])
        by_agent = next(row for row in waited["events"] if row["agent"] == WORKER)
        self.assertEqual(by_agent["lamport"], old["lamport"])
        self.assertNotEqual(by_agent["run_id"], RETRY)
        by_run = next(row for row in waited["events"] if row["run_id"] == RETRY)
        self.assertEqual(by_run["lamport"], other["lamport"])
        self.assertNotEqual(by_run["agent"], WORKER)

    def test_recorded_evidence_controls_decisions_and_export_opening(self):
        prior, old_task = self.open_plan("Prior generation")
        self.life(agent=LEADER, run=PARENT_RUN)
        self.terminal(WORKER, "prior-run", result={"verdict": "OK", "summary": "Prior result"})
        prior_run = {"agent": WORKER, "run_id": "prior-run"}
        self.assertTrue(self.decide(prior, old_task["id"], prior_run, "ADMIT", "Prior decision")["ok"])
        self.call("task_update", agent=LEADER, task_id=old_task["id"],
                  base_rev=old_task["rev"], state="cancelled")
        plan = self.call("plan_get")["plan"]
        self.call("plan_close", agent=LEADER, base_rev=plan["rev"])

        opening, task = self.open_plan("Current generation")
        self.assertEqual(task["id"], old_task["id"])
        start = self.snapshot()["head_lamport"]

        data = b"Reviewed report\n"
        digest = hashlib.sha256(data).hexdigest()
        valid = {"path": "verified.txt", "sha256": digest}
        tampered = {"path": "tampered.txt", "sha256": digest}
        missing = {"path": "missing.txt", "sha256": digest}
        (self.project / valid["path"]).write_bytes(data)
        (self.project / tampered["path"]).write_bytes(data)
        pointers = {"verified": valid, "tampered": tampered, "missing-file": missing}
        for agent, pointer in pointers.items():
            self.terminal(agent, "current-run", result={
                "verdict": "OK", "summary": f"Output from {agent}", "evidence": [pointer],
            })
        self.terminal("no-result", "current-run")
        (self.project / tampered["path"]).write_bytes(data[:-1] + b"!")

        dispositions = {
            ("verified", "current-run"): ("ADMIT", "Digest verified"),
            ("tampered", "current-run"): ("HOLD", "Digest mismatch"),
            ("missing-file", "current-run"): ("HOLD", "Evidence file missing"),
            ("no-result", "current-run"): ("HOLD", "Terminal output missing"),
        }
        watched_agents = tuple(agent for agent, _ in dispositions)
        rows = self.wait(start, *watched_agents)["events"]
        self.assertEqual(len(rows), len(dispositions))
        self.assertEqual({(row["agent"], row["run_id"]) for row in rows}, set(dispositions))
        for row in rows:
            agent = row["agent"]
            verdict, reason = dispositions[(agent, row["run_id"])]
            with self.subTest(agent=agent):
                evidence = row.get("result", {}).get("evidence", [])
                if agent == "no-result":
                    self.assertNotIn("result", row)
                    before = self.raw()
                    with self.assertRaisesRegex(store.RoomError, "ADMIT needs a recorded result"):
                        self.decide(opening, task["id"], row, "ADMIT", "Attempt without output")
                    self.assertEqual(self.raw(), before)
                else:
                    self.assertEqual(evidence, [pointers[agent]])
                    if verdict == "ADMIT":
                        artifact = self.call("artifact_read", agent=LEADER, **evidence[0])
                        self.assertEqual(artifact["sha256"], digest)
                        self.assertEqual(artifact["text"], data.decode("utf-8"))
                    else:
                        with self.assertRaises(store.RoomError) as caught:
                            self.call("artifact_read", agent=LEADER, limit=1, **evidence[0])
                        if agent == "tampered":
                            self.assertIn("sha256 mismatch", str(caught.exception))
                checked = {"evidence": evidence} if verdict == "ADMIT" else {}
                reply = self.decide(opening, task["id"], row, verdict, reason, **checked)
                self.assertTrue(reply["ok"])

        export = self.call("room_export", agent=LEADER, what="integration", opened_lamport=opening)
        self.assertEqual(export["format"], "markdown")
        scoped = export["text"]
        for verdict, reason in dispositions.values():
            with self.subTest(reason=reason):
                matches = [line for line in scoped.splitlines() if reason in line]
                self.assertEqual(len(matches), 1)
                self.assertIn(verdict, matches[0])
        self.assertIn("Output from verified", scoped)
        prior_export = self.call("room_export", agent=LEADER, what="integration",
                                 opened_lamport=prior)["text"]
        for marker in ("Prior result", "Prior decision"):
            self.assertIn(marker, prior_export)
            self.assertNotIn(marker, scoped)
        for _, reason in dispositions.values():
            self.assertNotIn(reason, prior_export)

    def test_timeout_leaves_missing_terminal_pending(self):
        opening, _ = self.open_plan("Missing terminal")
        self.life(agent=LEADER, run=PARENT_RUN)
        start = self.snapshot()["head_lamport"]
        deployment = self.deploy(WORKER, RETRY)
        before = self.raw()

        waited = self.wait(start, WORKER)
        self.assertTrue(waited["timed_out"])
        self.assertEqual(waited["events"], [])
        self.assertEqual(waited["cursor"], deployment["lamport"])
        self.assertEqual(self.raw(), before)
        scoped = self.call("room_export", agent=LEADER, what="integration",
                           opened_lamport=opening)["text"]
        self.assertNotIn(RETRY, scoped)

        # A real terminal arriving after the timeout is still observable.
        terminal = self.life(agent=WORKER, run=RETRY, state="finished")
        resumed = self.wait(waited["cursor"], WORKER)
        self.assertEqual([row["lamport"] for row in resumed["events"]], [terminal["lamport"]])
        self.assertEqual((resumed["events"][0]["agent"], resumed["events"][0]["run_id"]),
                         (WORKER, RETRY))


class DocumentationTests(unittest.TestCase):
    def test_orchestrator_guide_documents_public_resume_and_decide_transcript(self):
        guide = (support.ROOT / "docs/ORCHESTRATOR.md").read_text(encoding="utf-8")
        text = guide.lower()
        required = {
            "clipped snapshot cursor": (
                r"\borchestrator_snapshot\b", r"\bcompleted_since\b", r"\bhead_lamport\b",
                r"\b(?:clipp|truncat|omit)\w*\b", r"\bcursor\b",
            ),
            "independent waiter cursor": (r"\bwait_agents\b", r"\bsince_lamport\b"),
            "persisted obligations": (
                r"\b(?:persist|sav|checkpoint)\w*\b",
                r"\b(?:obligation\w*|disposition\w*|pending|remaining|processed|outstanding)\b",
            ),
            "attempt identity": (r"\bagent\b", r"\brun_id\b"),
            "recorded evidence check": (r"\bartifact_read\b", r"\bsha256\b"),
            "decision on invalid or missing output": (
                r"\bunit_decide\b", r"\bhold\b", r"\bmissing\b",
                r"\b(?:mismatch\w*|tamper\w*|differ\w*|invalid|altered)\b",
            ),
            "scoped integration export": (
                r"\broom_export\b", r"\bintegration\b", r"\bopened_lamport\b",
            ),
        }
        missing = [clause for clause, patterns in required.items()
                   if any(re.search(pattern, text) is None for pattern in patterns)]
        self.assertFalse(missing, "Public resume transcript is missing: " + ", ".join(missing))
