"""Protect unbound and repaired pipeline steps at journal admission."""

from pathlib import Path
from unittest import mock

from bridge.room import store
from bridge.tests.room.c7 import support as c7
from bridge.tests.room.c8 import support as c8


HERE = Path(__file__).resolve().parent


class MixedCompletionAdmission(c8.PipelineRoom):
    def setUp(self):
        with mock.patch.object(c8, "HERE", HERE):
            super().setUp()

    def board(self):
        return self.call("plan_get", {"room": c8.ROOM})

    def snapshot(self):
        return self.raw(), self.board()

    def post(self, op):
        with c7.bounded():
            return store.post(c8.ROOM, c8.ORCHESTRATOR, "op", "", op=op)

    def batch(self, *ops):
        with c7.bounded():
            return store.post_ops(c8.ROOM, c8.ORCHESTRATOR, list(ops))

    def micro_done(self, step):
        return {"kind": "micro.set", "op_id": self.op_id(),
                "micro_id": self.micro_id(step), "state": "done"}

    def task_edit(self, base_rev, **changes):
        return {"kind": "task.set", "op_id": self.op_id(), "task_id": c8.TASK,
                "base_rev": base_rev, **changes}

    def assert_refused(self, write, message):
        raw, board = self.snapshot()
        with self.assertRaises(store.RoomError, msg=message):
            write()
        self.assertEqual(self.raw(), raw, "refused write changed journal bytes")
        after = self.board()
        self.assertEqual(after["last_lamport"], board["last_lamport"],
                         "refused write advanced Lamport")
        self.assertEqual(after, board, "refused write changed the board")

    def step_on_board(self, name):
        task = self.board()["tasks"][0]
        index = c8.STEPS.index(name)
        return task["microtasks"][index], task["pipeline"]["steps"][index]

    def assert_pending_unbound(self, name):
        micro, step = self.step_on_board(name)
        self.assertEqual(micro["state"], "pending")
        self.assertIsNone(step["binding"])
        return step["attempts"]

    def repair_accepted_author(self):
        self.prefix(c8.STEPS.index("author") + 1)
        _, author = self.step_on_board("author")
        self.assertEqual(author["attempts"][-1]["state"], "accepted")
        self.repair()
        self.assertEqual(self.assert_pending_unbound("author"), author["attempts"])

    def assert_mixed_batch_refused(self, step):
        board = self.board()
        head = board["last_lamport"]
        prefix = self.task_edit(board["tasks"][0]["rev"], title="Edited title")
        middle = self.micro_done(step)
        # Any micro.set on this task advances its revision to the middle event.
        suffix = self.task_edit(head + 2, title="Final title")
        self.assert_refused(lambda: self.batch(prefix, middle, suffix),
                            f"mixed batch admitted completion of {middle['micro_id']}")

        # Keep both edits, operation IDs and revision checks. Only the
        # completion changes, so the control proves the whole batch is legal.
        control = self.batch(prefix, dict(middle, state="active"), suffix)
        self.assertEqual([event["lamport"] for event in control],
                         [head + 1, head + 2, head + 3])
        self.assertEqual([event["op"]["op_id"] for event in control],
                         [op["op_id"] for op in (prefix, middle, suffix)])
        self.assertEqual(self.board()["tasks"][0]["title"], suffix["title"])
        micro, pipeline_step = self.step_on_board(step)
        self.assertEqual(micro["state"], "active")
        self.assertIsNone(pipeline_step["binding"])

    def test_single_refuses_unbound_micro_completion(self):
        self.assertEqual(self.assert_pending_unbound("diagnosis"), [])
        self.assert_refused(lambda: self.post(self.micro_done("diagnosis")),
                            "single post admitted completion of an unbound step")

    def test_single_refuses_repaired_micro_completion(self):
        self.repair_accepted_author()
        self.assert_refused(lambda: self.post(self.micro_done("author")),
                            "single post admitted completion of a repaired step")

    def test_mixed_batch_refuses_unbound_middle_without_committing_edits(self):
        self.assertEqual(self.assert_pending_unbound("diagnosis"), [])
        self.assert_mixed_batch_refused("diagnosis")

    def test_mixed_batch_refuses_repaired_middle_without_committing_edits(self):
        self.repair_accepted_author()
        self.assert_mixed_batch_refused("author")

    def test_task_set_cannot_mark_a_unit_done_with_no_completed_steps(self):
        self.assertEqual(self.states(), ("pending",) * len(c8.STEPS))
        for write in (self.post, self.batch):
            with self.subTest(writer=write.__name__):
                op = self.task_edit(self.board()["tasks"][0]["rev"], state="done")
                self.assert_refused(lambda: write(op),
                                    "task.set marked a unit done directly")

    def test_bound_admit_advances_a_repaired_step(self):
        self.repair_accepted_author()
        run = self.deploy("replacement-author")
        self.bind("author", run)
        self.lifecycle(run, "finished", "OK")
        micro, step = self.step_on_board("author")
        self.assertEqual(micro["state"], "active")
        self.assertEqual(step["attempts"][-1]["state"], "bound")
        events = self.events()
        head = self.board()["last_lamport"]

        self.decide("author", run)

        committed = self.events()
        self.assertEqual(committed[:-1], events)
        self.assertEqual(committed[-1]["op"]["kind"], "unit.decision")
        self.assertEqual(committed[-1]["lamport"], head + 1)
        self.assertEqual(self.board()["last_lamport"], head + 1)
        micro, step = self.step_on_board("author")
        self.assertEqual(micro["state"], "done")
        self.assertEqual(step["attempts"][-1]["state"], "accepted")
