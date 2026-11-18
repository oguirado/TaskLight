"""Drive the room handlers with a contract template and an isolated journal."""

import itertools
import json
from pathlib import Path
from unittest import mock

from bridge.plan.fold import fold_plan
from bridge.plan.template import validate_template
from bridge.room import app, store
from bridge.room.ext import pipeline
from bridge.tests.room.c7 import support as c7

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
STEPS = ("diagnosis", "spec", "oracle", "author", "verify", "review", "import")
TEMPLATE_ID = "unit-pipeline-v1"
TITLE = "Unit <img src=x onerror=alert(1)>"
ORCHESTRATOR = "orchestrator"
TASK = "T01"
ROOM = "demo"


def contract_template():
    template = c7.clone(c7.TEMPLATE)
    template.update(id=TEMPLATE_ID, name="Unit pipeline")
    template["task_types"] = [{
        "id": "unit", "label": "Unit", "accept_required": False,
        "evidence_required": False, "micro_hints": list(STEPS),
    }]
    template["granularity"].update(micro_min=len(STEPS), micro_max=len(STEPS))
    return validate_template(template)


class PipelineRoom(c7.RoomCase):
    def setUp(self):
        # Reuse the established fake clocks, transport guards and trace budget.
        with mock.patch.object(c7, "HERE", HERE):
            super().setUp()
        self.enterContext(mock.patch.object(store._lock.time, "monotonic", lambda: 0.0))
        self.enterContext(mock.patch.object(
            store._lock.time, "sleep", side_effect=c7.StopRule("lock would wait"),
        ))
        self.ids = itertools.count(1)
        self.template = contract_template()
        self.template_path = self.home / "templates" / f"{TEMPLATE_ID}.json"
        self.template_path.parent.mkdir()
        self.template_path.write_text(json.dumps(self.template), encoding="utf-8")

        # Seed already-expanded plan operations to exercise the pipeline gates
        # independently of whether the starter and creation tools have shipped.
        seed = [
            {"kind": "plan.open", "op_id": "c8-open-seed", "title": "Pipeline test",
             "template_id": TEMPLATE_ID, "template_hash": self.template["hash"],
             "phase": "plan", "brief": {"goal": "Verify the pipeline"}},
            {"kind": "task.add", "op_id": "c8-add-seed", "type": "unit",
             "phase": "plan", "title": TITLE, "assignee": ORCHESTRATOR,
             "microtasks": [{"text": step} for step in STEPS]},
        ]
        self.install([
            dict(c7.event(n, op, ORCHESTRATOR), id=f"e-ffff{n:012x}")
            for n, op in enumerate(seed, 1)
        ])

    def op_id(self):
        return f"c8-oracle-{next(self.ids):04d}"

    @staticmethod
    def micro_id(step):
        return f"{TASK}.M{STEPS.index(step) + 1:02d}"

    def projection(self, events=None):
        with c7.bounded():
            return fold_plan(self.events() if events is None else events,
                             templates={TEMPLATE_ID: self.template})

    def task(self):
        return self.projection()["tasks"][0]

    def states(self):
        return tuple(micro["state"] for micro in self.task()["microtasks"])

    def call(self, name, args):
        with c7.bounded():
            return c7.unwrap(app.dispatch(name, args))

    def lifecycle(self, run, state, verdict=None, **fields):
        agent, run_id = run
        args = dict(room=ROOM, agent=agent, run_id=run_id, state=state, op_id=self.op_id(), **fields)
        if verdict is not None:
            args["result"] = {"verdict": verdict}
        return self.call("agent_lifecycle", args)

    def deploy(self, label, **fields):
        run = (f"worker-{label}", f"run-{label}")
        self.lifecycle(run, "deployed", **fields)
        return run

    def unit_args(self, **fields):
        return dict(room=ROOM, agent=ORCHESTRATOR, op_id=self.op_id(), task_id=TASK,
                    expected_opened_lamport=1) | fields

    def step_args(self, step, run, **fields):
        return self.unit_args(micro_id=self.micro_id(step), result_agent=run[0],
                              result_run_id=run[1], **fields)

    def bind(self, step, run, **fields):
        with c7.bounded():
            return pipeline.unit_bind(self.step_args(step, run, **fields))

    def decide(self, step, run, verdict="ADMIT", **fields):
        args = self.step_args(step, run)
        args.update({"verdict": verdict, "reason": "Check the bound result"} | fields)
        return self.call("unit_decide", args)

    def repair(self, reason="Rework the candidate", **fields):
        with c7.bounded():
            return pipeline.unit_repair(self.unit_args(reason=reason, **fields))

    def accepted(self, step, label, verdict="OK"):
        run = self.deploy(label)
        self.bind(step, run)
        self.lifecycle(run, "finished", verdict)
        before = self.events()
        index = STEPS.index(step)
        self.assertNotEqual(self.states()[index], "done", "lifecycle alone never accepts a step")
        self.decide(step, run, reason=f"Accept {step} for {label}")
        after = self.events()
        self.assertEqual(after[:-1], before, "acceptance appends exactly one event")
        self.assertEqual(after[-1]["op"]["kind"], "unit.decision")
        self.assertEqual(self.states()[index], "done")
        return run

    def prefix(self, length):
        for index, step in enumerate(STEPS[:length]):
            self.accepted(step, f"first-{step}", "OK" if index % 2 == 0 else "ADMIT")

    def assert_stops(self, operation, code=None, detail=None):
        before = self.raw()
        with self.assertRaises(store.RoomError) as failure:
            operation()
        self.assertEqual(self.raw(), before, "a rejected operation must leave the journal intact")
        if code is not None:
            self.assertEqual(failure.exception.code, code)
        if detail is not None:
            self.assertRegex(str(failure.exception), detail)


def attempt_rows(value):
    """Find the specified attempts lists without fixing their location in the projection."""
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "attempts" and isinstance(child, list):
                yield from child
            else:
                yield from attempt_rows(child)
    elif isinstance(value, list):
        for child in value:
            yield from attempt_rows(child)


def history_values(value):
    """History may store fields inline or nest the binding and decision."""
    if isinstance(value, dict):
        for child in value.values():
            yield from history_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from history_values(child)
    else:
        yield value
