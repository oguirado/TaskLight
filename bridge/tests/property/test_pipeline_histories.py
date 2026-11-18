"""Independent R52H checkpoints and an isolated shrink witness."""
import copy
import json
from pathlib import Path
import unittest

from bridge.plan.fold import fold_plan
from bridge.plan.template import validate_template
from bridge.room.store import _parse_events_bytes

from .support import ROOT, shrink


FIXTURE = json.loads(Path(__file__).with_name("pipeline_histories.json").read_text())
EVENTS = FIXTURE["events"]
ARRIVAL = [EVENTS[lamport - 1] for lamport in FIXTURE["arrivalOrder"]]
CHECKPOINTS = FIXTURE["checkpoints"]
TEMPLATE = validate_template(json.loads(
    (ROOT / "templates/planning/unit-pipeline-v1.json").read_text()
))
LATE = CHECKPOINTS["late_old_admit"]["after"]


def fold(events):
    return fold_plan(events, templates={TEMPLATE["id"]: TEMPLATE})


def attempt_rows(step):
    return [
        [attempt["lamport"], attempt["result_run_id"], attempt["state"],
         attempt.get("terminal", {}).get("lamport"),
         attempt.get("terminal", {}).get("verdict"),
         attempt.get("decision", {}).get("lamport")]
        for attempt in step.get("attempts", [])
    ]


def observe(projection):
    task = next((task for task in projection["tasks"] if task["id"] == "T02"), {})
    steps = task.get("pipeline", {}).get("steps", [])
    return {
        "generation": (projection["plan"] or {}).get("opened_lamport"),
        "tasks": [task["id"] for task in projection["tasks"]],
        "deps": task.get("deps", []),
        "states": [micro["state"] for micro in task.get("microtasks", [])],
        "bindings": [step["binding"] for step in steps],
        "acceptedPrefix": [
            [row[0], row[5]]
            for step in steps[:3]
            for row in attempt_rows(step)
            if row[2] == "accepted"
        ],
        "author": attempt_rows(steps[3]) if len(steps) > 3 else [],
        "verify": attempt_rows(steps[4]) if len(steps) > 4 else [],
        "decisions": [[row["lamport"], row["verdict"]] for row in task.get("decisions", [])],
        "rejected": [[row["lamport"], row["code"]] for row in projection["rejected"]],
    }


def through(events, lamport):
    return [event for event in events if event["lamport"] <= lamport]


def has_late_admit(events):
    """An event-local failure predicate that cannot certify replay context."""
    target = EVENTS[LATE - 1]
    return any(event["id"] == target["id"] for event in events)


def shrink_witness():
    return shrink(ARRIVAL, has_late_admit)


def witness_observation(events):
    observation = observe(fold(through(events, LATE)))
    # The earlier hostile ADMIT is a separate control and may be removed.
    observation["rejected"] = [row for row in observation["rejected"] if row != [23, "bad_op"]]
    return observation


def reference_fields(event):
    op = event.get("op", {})
    return (
        event["id"], event["room"], event["agent"], event["act"], event["lamport"], event["ts"],
        {key: op[key] for key in ("kind", "op_id", "expected_opened_lamport", "deps",
                                  "task_id", "micro_id", "result_agent", "result_run_id",
                                  "run_id", "binding_lamport") if key in op},
    )


class PipelineHistories(unittest.TestCase):
    def test_hand_derived_transition_checkpoints(self):
        for label, checkpoint in CHECKPOINTS.items():
            with self.subTest(checkpoint=label):
                events = through(EVENTS, checkpoint["after"])
                original = copy.deepcopy(events)
                self.assertEqual(observe(fold(events)), checkpoint["expected"])
                self.assertEqual(events, original)

    def test_reordered_duplicates_replay_at_each_checkpoint(self):
        for label, checkpoint in CHECKPOINTS.items():
            with self.subTest(checkpoint=label):
                position = checkpoint["after"]
                canonical = fold(through(EVENTS, position))
                perturbed = fold(through(ARRIVAL, position))
                self.assertEqual(perturbed, canonical)
                self.assertEqual(observe(perturbed), checkpoint["expected"])

    def test_negative_controls_reach_and_fail_the_checkpoint_oracle(self):
        # Model two faults at the journal/fold boundary. A stale-reference
        # resolver incorrectly selects the new run, or replay drops the HOLD.
        late = CHECKPOINTS["late_old_admit"]["expected"]
        retargeted = copy.deepcopy(through(EVENTS, LATE))
        retargeted[-1]["op"]["result_run_id"] = "run-new"
        misadmitted = observe(fold(retargeted))
        self.assertEqual(misadmitted["decisions"][-1:], [[LATE, "ADMIT"]])
        self.assertEqual(misadmitted["states"][3], "done")
        self.assertNotIn([LATE, "bad_op"], misadmitted["rejected"])
        with self.assertRaises(AssertionError):
            self.assertEqual(misadmitted, late)

        legacy = CHECKPOINTS["legacy_resultless_hold"]
        dropped_hold = [event for event in through(EVENTS, legacy["after"])
                        if event["op"]["op_id"] != "r52h-case-33"]
        missing = observe(fold(dropped_hold))
        self.assertEqual(missing["decisions"][-1:], [[32, "HOLD"]])
        self.assertEqual(missing["rejected"], legacy["expected"]["rejected"])
        with self.assertRaises(AssertionError):
            self.assertEqual(missing, legacy["expected"])

    def test_shrink_preserves_a_minimal_replayable_late_admit_witness(self):
        original = copy.deepcopy(ARRIVAL)
        witness = shrink_witness()
        self.assertEqual(ARRIVAL, original)
        self.assertEqual(witness, shrink_witness(), "shrink must reproduce its witness")
        self.assertTrue(has_late_admit(witness))
        self.assertLess(len(witness), len(original))

        expected = {**CHECKPOINTS["late_old_admit"]["expected"], "rejected": [[LATE, "bad_op"]]}
        self.assertEqual(
            witness_observation(witness), expected,
            "shrink must keep the opening, task/dependency parents, run bindings and accepted prefix",
        )
        original_references = {event["id"]: reference_fields(event) for event in original}
        for event in witness:
            self.assertIn(event["id"], original_references)
            self.assertEqual(reference_fields(event), original_references[event["id"]])
        journal = b"".join((json.dumps(event) + "\n").encode() for event in witness)
        replay, malformed = _parse_events_bytes(journal)
        self.assertEqual(malformed, 0, "every retained event must parse as a journal record")
        self.assertEqual(replay, witness)
        self.assertEqual(witness_observation(replay), expected)
        for index in range(len(replay)):
            trial = replay[:index] + replay[index + 1:]
            self.assertNotEqual(witness_observation(trial), expected,
                                f'redundant event in minimal witness: {replay[index]["id"]}')

    def test_shrink_stops_without_a_witnessed_failure(self):
        self.assertFalse(has_late_admit(through(ARRIVAL, LATE - 1)))
        with self.assertRaises(AssertionError):
            shrink(through(ARRIVAL, LATE - 1), has_late_admit)

