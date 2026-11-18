"""R52G completion admission at the tool and journal entry points."""

import hashlib
import json
from pathlib import Path
from unittest import mock

from bridge.room import store
from bridge.tests.room.c7 import support as c7
from bridge.tests.room.c8 import support as c8
from bridge.tests.room.c8.support import ORCHESTRATOR, ROOM, STEPS


HERE = Path(__file__).resolve().parent
STEP = "diagnosis"


class CompletionAdmission(c8.PipelineRoom):
    def setUp(self):
        # The shared fixture's scratch journal must live in this test directory.
        with mock.patch.object(c8, "HERE", HERE):
            super().setUp()

    def board(self):
        return self.call("plan_get", {"room": ROOM})

    def snapshot(self):
        board = self.board()
        return self.raw(), board["last_lamport"], board

    def current_attempt(self):
        step = self.board()["tasks"][0]["pipeline"]["steps"][0]
        attempt = step["attempts"][-1]
        self.assertEqual(step["binding"], attempt["lamport"])
        return attempt

    def bound_result(self, **fence):
        run = self.deploy(STEP)
        self.bind(STEP, run, **fence)
        self.lifecycle(run, "finished", "OK")
        self.assertNotEqual(self.states()[0], "done")
        self.assertNotEqual(self.current_attempt()["state"], "accepted")
        return run

    def micro_done(self, step=STEP):
        return {"kind": "micro.set", "op_id": self.op_id(),
                "micro_id": self.micro_id(step), "state": "done"}

    def task_edit(self, task, **changes):
        return {"kind": "task.set", "op_id": self.op_id(), "task_id": task["id"],
                "base_rev": task["rev"], **changes}

    def post(self, op):
        with c7.bounded():
            return store.post(ROOM, ORCHESTRATOR, "op", "", op=op)

    def batch(self, *ops):
        with c7.bounded():
            return store.post_ops(ROOM, ORCHESTRATOR, list(ops))

    def tool(self, op):
        fields = {key: value for key, value in op.items() if key != "kind"}
        if op["kind"] == "micro.set":
            fields["id"] = fields.pop("micro_id")
            return self.call("microtask_set", dict(fields, room=ROOM, agent=ORCHESTRATOR))
        return self.call("task_update", dict(fields, room=ROOM, agent=ORCHESTRATOR))

    def assert_refused(self, write, description, *, before=None):
        if before is None:
            before = self.snapshot()
        with self.assertRaises(store.RoomError, msg=description):
            write()
        self.assertEqual(self.snapshot(), before, "journal bytes, Lamport or board changed")

    def historical_rows(self, ops):
        start = self.events()[-1]["lamport"] + 1
        return [dict(c7.event(lamport, op, ORCHESTRATOR),
                     id=f"e-cccc{lamport:012x}", ts=self.now)
                for lamport, op in enumerate(ops, start)]

    def legacy_completion(self, *, blocked=False):
        """Install old generic completions as committed rows, independent of admission."""
        self.bound_result()
        ops = [self.micro_done(step) for step in STEPS]
        rows = self.historical_rows(ops)
        if blocked:
            block = dict(self.task_edit(self.task(), state="blocked"),
                         base_rev=rows[-1]["lamport"])
            rows = self.historical_rows([*ops, block])
        self.install(self.events() + rows)
        task = self.board()["tasks"][0]
        self.assertEqual(task["state"], "blocked" if blocked else "done")
        self.assertEqual([micro["state"] for micro in task["microtasks"]], ["done"] * len(STEPS))
        self.assertNotEqual(self.current_attempt()["state"], "accepted")
        return task

    def ordinary_plan(self):
        template = c7.TEMPLATE
        (self.template_path.parent / f'{template["id"]}.json').write_text(
            json.dumps(template), encoding="utf-8"
        )
        ops = [
            {"kind": "plan.open", "op_id": "ordinary-open", "title": "Ordinary plan",
             "template_id": template["id"], "template_hash": template["hash"],
             "phase": "plan", "brief": {"goal": "Complete ordinary work"}},
            {"kind": "task.add", "op_id": "ordinary-task", "type": "task",
             "phase": "plan", "title": "Ordinary task", "assignee": ORCHESTRATOR,
             "microtasks": [{"text": "Complete the work"}]},
        ]
        self.install([dict(c7.event(n, op, ORCHESTRATOR), id=f"e-bbbb{n:012x}")
                      for n, op in enumerate(ops, 1)])

    def assert_final_batch_refused(self, final):
        # This prefix edits a separate task, so the final member's revision
        # stays valid and its refusal cannot come from a stale revision.
        self.call("task_add", {"room": ROOM, "agent": ORCHESTRATOR, "op_id": self.op_id(),
                               "type": "unit", "phase": "plan", "title": "Sibling unit", "accept": ""})
        sibling = self.board()["tasks"][1]
        prefix = self.task_edit(sibling, title="Valid prefix")
        before = self.snapshot()
        self.assert_refused(lambda: self.batch(prefix, final),
                            f"batch admitted protected completion via {final['kind']}", before=before)
        [committed] = self.batch(prefix)
        self.assertEqual(committed["lamport"], before[1] + 1)
        self.assertEqual(self.board()["tasks"][1]["title"], "Valid prefix")

    def assert_uses_locked_plan(self, write):
        pipeline_open, pipeline_add = [row["op"] for row in self.events()]
        self.ordinary_plan()
        ordinary = self.raw()
        board = self.board()
        self.assertEqual(board["tasks"][0]["state"], "pending")
        self.post(self.task_edit(board["tasks"][0], state="cancelled"))
        self.post({"kind": "plan.close", "op_id": self.op_id(), "base_rev": board["plan"]["rev"]})
        opened = self.post(dict(pipeline_open, op_id=self.op_id()))
        self.post(dict(pipeline_add, op_id=self.op_id()))
        self.bound_result(expected_opened_lamport=opened["lamport"])
        current = self.snapshot()
        self.assertTrue(current[0].startswith(ordinary))
        self.path().write_bytes(ordinary)

        acquire = store._lock.lock_exclusive
        advanced = False

        def acquire_after_competing_commit(fd, *args, **kwargs):
            nonlocal advanced
            acquire(fd, *args, **kwargs)
            if not advanced:
                # Publish the competing writer's suffix at the lock boundary.
                with self.path().open("ab") as journal:
                    journal.write(current[0][len(ordinary):])
                advanced = True

        op = self.micro_done()
        with mock.patch.object(store._lock, "lock_exclusive", acquire_after_competing_commit):
            with self.assertRaises(store.RoomError, msg="admitted against the superseded ordinary plan"):
                write(op)
        self.assertTrue(advanced, "completion was refused before obtaining the journal lock")
        self.assertEqual(self.snapshot(), current, "only the competing commit belongs in the journal")

    def test_bound_step_completes_on_matching_admit(self):
        run = self.bound_result()
        args = self.step_args(STEP, run, verdict="ADMIT", reason="Accept the matching result")
        before = self.snapshot()
        decision = self.call("unit_decide", args)
        self.assertEqual(decision["lamport"], before[1] + 1)
        self.assertTrue(self.raw().startswith(before[0]))
        self.assertEqual(self.raw().count(b"\n"), before[0].count(b"\n") + 1)
        self.assertEqual(self.states()[0], "done")
        self.assertEqual(self.current_attempt()["state"], "accepted")

        committed = self.snapshot()
        self.assertEqual(self.call("unit_decide", args), decision)
        self.assertEqual(self.snapshot(), committed)

    def test_microtask_tool_refuses_protected_completion(self):
        self.bound_result()
        op = self.micro_done()
        self.assert_refused(lambda: self.tool(op), "microtask_set marked a bound step done")

    def test_single_journal_post_refuses_protected_micro_set(self):
        self.bound_result()
        op = self.micro_done()
        self.assert_refused(lambda: self.post(op), "single journal admission marked a bound step done")

    def test_single_task_set_refuses_exposing_legacy_completion(self):
        task = self.legacy_completion(blocked=True)
        op = self.task_edit(task, state=None)
        self.assert_refused(lambda: self.tool(op), "task_update exposed an unaccepted unit as done")

    def test_batch_is_atomic_when_final_micro_set_completes_bound_step(self):
        self.bound_result()
        self.assert_final_batch_refused(self.micro_done())

    def test_batch_is_atomic_when_final_task_set_exposes_legacy_completion(self):
        self.assert_final_batch_refused(self.task_edit(self.legacy_completion(blocked=True), state=None))

    def test_single_admission_uses_plan_at_lock_acquisition(self):
        self.assert_uses_locked_plan(self.tool)

    def test_batch_admission_uses_plan_at_lock_acquisition(self):
        self.assert_uses_locked_plan(self.batch)

    def test_ordinary_task_completion_and_unblocking_remain_legal(self):
        self.ordinary_plan()
        task = self.board()["tasks"][0]
        self.assertNotIn("pipeline", task)
        self.tool(self.task_edit(task, state="blocked"))
        self.tool(self.micro_done())
        task = self.board()["tasks"][0]
        self.assertEqual(task["state"], "blocked")
        self.tool(self.task_edit(task, state=None))
        self.assertEqual(self.board()["tasks"][0]["state"], "done")

        task = self.board()["tasks"][0]
        self.batch(self.task_edit(task, state="blocked"))
        self.batch(dict(self.micro_done(), state="pending"), self.micro_done())
        task = self.board()["tasks"][0]
        self.assertEqual(task["state"], "blocked")
        self.batch(self.task_edit(task, state=None))
        self.assertEqual(self.board()["tasks"][0]["state"], "done")

    def test_committed_legacy_generic_completion_replays_as_history(self):
        self.legacy_completion()
        before = self.snapshot()
        with c7.bounded():
            journal, malformed = store.read(ROOM)
        self.assertEqual(malformed, 0)
        self.assertEqual(journal, self.events())
        self.assertEqual(self.board()["rejected"], [])
        self.assertEqual(self.snapshot(), before)

    def test_exact_identified_legacy_single_replays_and_changed_payload_refuses(self):
        self.bound_result()
        op = self.micro_done()
        [row] = self.historical_rows([op])
        self.install(self.events() + [row])
        before = self.snapshot()
        ack = self.tool(op)
        self.assertTrue(ack["replayed"])
        self.assertEqual(ack["rev"], row["lamport"])
        self.assertEqual(ack["microtask"]["state"], "done")
        self.assertEqual(self.post(op), dict(row, replayed=True))
        self.assertEqual(self.snapshot(), before)
        changed = dict(op, outcome="Different payload")
        self.assert_refused(lambda: self.tool(changed), "changed payload reused a single receipt")

    def test_exact_identified_legacy_batch_replays_and_changed_payload_refuses(self):
        self.bound_result()
        prefix = self.task_edit(self.task(), title="Old title edit")
        completion = self.micro_done()
        ops = [prefix, completion]
        rows = self.historical_rows(ops)
        request = json.dumps({"strict": False, "ops": ops}, sort_keys=True,
                             separators=(",", ":")).encode("utf-8")
        receipt = {"op_id": prefix["op_id"], "count": len(rows), "key_map": {},
                   "member_ids": [row["id"] for row in rows],
                   "request_sha256": hashlib.sha256(request).hexdigest()}
        for index, row in enumerate(rows):
            row["batch"] = dict(receipt, seq=index)
        self.install(self.events() + rows)

        before = self.snapshot()
        self.assertEqual(self.batch(*ops), [dict(row, replayed=True) for row in rows])
        self.assertEqual(self.snapshot(), before)
        changed = dict(completion, outcome="Different payload")
        self.assert_refused(lambda: self.batch(prefix, changed), "changed payload reused a batch receipt")
