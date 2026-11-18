"""Emit a bounded real journal and Python checkpoints for the browser oracle."""

import json

from bridge.wall.room_relay import sanitize_event

from .support import ORCHESTRATOR, STEPS, TITLE, PipelineRoom


def trace():
    room = PipelineRoom()
    try:
        room.setUp()
        parent_run = "orchestrator-run"
        room.lifecycle((ORCHESTRATOR, parent_run), "deployed")
        marks = {"pending": len(room.events())}

        diagnose = room.deploy("diagnose", parent_agent=ORCHESTRATOR, parent_run_id=parent_run)
        room.bind("diagnosis", diagnose)
        marks["bound"] = len(room.events())
        room.lifecycle(diagnose, "finished", "OK")
        marks["finished"] = len(room.events())
        room.decide("diagnosis", diagnose)
        marks["accepted"] = len(room.events())

        failed = room.deploy("failed-spec")
        room.bind("spec", failed)
        room.lifecycle(failed, "failed", "FAIL")
        marks["failed"] = len(room.events())

        held = room.deploy("held-spec")
        room.bind("spec", held)
        room.lifecycle(held, "finished", "HOLD")
        room.decide("spec", held, "HOLD", reason=TITLE)
        marks["held"] = len(room.events())

        for step in STEPS[1:]:
            room.accepted(step, f"complete-{step}", "ADMIT")
        marks["complete"] = len(room.events())
        room.repair()
        marks["repaired"] = len(room.events())
        room.accepted("author", "reworked")
        marks["reworked"] = len(room.events())

        events = room.events()
        assert len(events) <= 64, "bounded C8 fixture"
        relayed = [sanitize_event(event) for event in events]
        assert all(event is not None for event in relayed), "the relay must carry the fixture"
        return {
            "events": events, "relayed": relayed, "template": room.template,
            "title": TITLE, "steps": STEPS, "marks": marks,
            "checkpoints": {name: room.projection(events[:end]) for name, end in marks.items()},
        }
    finally:
        room.doCleanups()


if __name__ == "__main__":
    print(json.dumps(trace()))
