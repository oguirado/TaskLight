"""Bounded event data and observational probes; no replacement reducer."""
import copy
from collections import Counter
import hashlib
import json
from pathlib import Path
import random
import sys
from unittest import mock

from bridge.plan import fold as reducer
from bridge.plan.errors import PlanError
from bridge.tests.plan.support import BASE_TS, adding, event, opening, templates

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
FIELDS = ("tasks", "memory", "replayed_ops", "archived_plans")
FULL_KEYS = frozenset(("plan", "tasks", "memory", "archived_plans", "rollup", "replayed_ops", "rejected", "last_lamport"))


def digest(value):
    # JSON adapters serialize integral floats differently (0.0 versus 0).
    # Preserve all keys, nulls and array order; compare the same numeric value.
    def numeric_json(item):
        if isinstance(item, float) and item.is_integer():
            return int(item)
        if isinstance(item, dict):
            return {key: numeric_json(part) for key, part in item.items()}
        if isinstance(item, list):
            return [numeric_json(part) for part in item]
        return item
    return hashlib.sha256(json.dumps(numeric_json(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def replay_key(op_id, agent="alice"):
    return json.dumps([agent, op_id], separators=(",", ":"))


def receipt(e, code):
    return {"id": e["id"], "lamport": e["lamport"], "op_id": e.get("op", {}).get("op_id"), "code": code}


def active_history():
    return [
        event(1, {"kind": "agent.lifecycle", "run_id": "observer-1", "state": "deployed", "op_id": "observer-start"}, agent="observer"),
        event(2, {"kind": "memory.set", "section": "notes", "text": "Remember", "base_rev": 0, "op_id": "notes-first"}),
        event(3, opening()),
        event(4, adding(microtasks=[{"text": "Step"}, {"text": "Second"}], op_id="add-first")),
        event(5, {"kind": "task.claim", "task_id": "T01", "op_id": "claim-first"}),
        event(6, {"kind": "micro.set", "micro_id": "T01.M01", "state": "active"}),
        event(7, {"kind": "activity.beat", "task_id": "T01", "run_id": "r1", "op_id": "beat-first"}),
        event(8, {"kind": "activity.beat", "task_id": "T01", "run_id": "r2", "op_id": "beat-second"}),
    ]


def mixed_history():
    """Seeded arrivals with a fixed semantic spine, including integrated lifecycle."""
    events = active_history()
    marks = {"preplan_lifecycle": 1, "active": len(events)}
    def put(name, op=None, **kw):
        e = event(len(events) + 1, op, **kw)
        events.append(e)
        marks[name] = len(events)
        return e
    put("dependency", adding(deps=["T01"], microtasks=[{"text": "Dependent"}]))
    put("foreign", {"kind": "micro.set", "micro_id": "T01.M01", "state": "done"}, agent="bob")
    put("self_dep", {"kind": "task.set", "task_id": "T01", "base_rev": 6, "title": "overwrite", "deps": ["T01"], "op_id": "repairable"})
    repaired = put("repair-key", {"kind": "task.set", "task_id": "T01", "base_rev": 6, "title": "Repaired", "op_id": "repairable"})
    put("premature_close", {"kind": "plan.close", "base_rev": 3, "op_id": "close-too-early"})
    put("release", {"kind": "task.release", "task_id": "T01", "base_rev": repaired["lamport"]})
    put("reclaim", {"kind": "task.claim", "task_id": "T01"})
    put("retry", {"kind": "task.claim", "task_id": "T01", "op_id": "claim-first"})
    prior = put("traffic", None, act="question", text="Passive room data")
    put("takeover_boundary", {"kind": "task.claim", "task_id": "T01", "takeover": True}, agent="bob", ts=prior["ts"] + 600000)
    taken = put("takeover", {"kind": "task.claim", "task_id": "T01", "takeover": True}, agent="bob", ts=prior["ts"] + 600001)
    put("cancel", {"kind": "task.set", "task_id": "T01", "base_rev": taken["lamport"], "state": "cancelled"}, agent="bob")
    put("claim_dependent", {"kind": "task.claim", "task_id": "T02"})
    put("activate_dependent", {"kind": "micro.set", "micro_id": "T02.M01", "state": "active"})
    put("complete", {"kind": "micro.set", "micro_id": "T02.M01", "state": "done", "evidence": [{"path": "bridge/tests/plan/u122/ORACLE.md", "sha256": "a" * 64}]})
    put("close", {"kind": "plan.close", "base_rev": 3, "outcome": "Verified"})
    put("closed_lifecycle", {"kind": "agent.lifecycle", "run_id": "observer-1", "state": "alive", "op_id": "observer-alive"}, agent="observer", ts=BASE_TS + 40000)
    put("reopen", opening())
    put("reopened_lifecycle", {"kind": "agent.lifecycle", "run_id": "observer-1", "state": "finished", "op_id": "observer-finish"}, agent="observer", ts=BASE_TS + 50000)
    a = put("tie_a", adding(title="A"), id="e-0000000000000aa1", lamport=28)
    b = put("tie_b", adding(title="B"), id="e-0000000000000aa2", lamport=28)
    events[-2:] = [b, a]
    events.append(copy.deepcopy(a))
    marks["duplicate"] = len(events)
    put("unknown", {"kind": "task.set", "task_id": "T01", "base_rev": 28, "title": "Bad", "unknown": 1, "op_id": "retry-shape"})
    put("shape_retry", {"kind": "task.set", "task_id": "T01", "base_rev": 28, "title": "Good", "op_id": "retry-shape"})
    put("boolean_lamport", opening(), lamport=True)
    return events, marks


def seeded_history(seed):
    events, _ = mixed_history()
    random.Random(seed).shuffle(events)
    return events


def populated():
    return reducer.fold_plan(active_history(), templates=templates())


def assert_public_detachment(case, apply=reducer.apply_op_event):
    state = populated()
    e = event(20, {"kind": "micro.set", "micro_id": "T01.M01", "state": "done", "evidence": [{"path": "evidence/check.txt", "sha256": "b" * 64}], "op_id": "finish-once"})
    tpl = templates()
    activity = {"alice": BASE_TS + 8}
    before = copy.deepcopy((state, e, tpl, activity))
    new, result = apply(state, e, templates=tpl, last_by_agent=activity)
    case.assertEqual((state, e, tpl, activity), before, "public call changed an input")
    cached = copy.deepcopy(new["replayed_ops"][replay_key("finish-once")])
    result["kind"] = "caller edit"
    case.assertEqual(new["replayed_ops"][replay_key("finish-once")], cached)
    new["tasks"][0]["title"] = "caller edit"
    new["tasks"][0]["microtasks"][0]["evidence"][0]["path"] = "caller edit"
    new["memory"]["notes"]["text"] = "caller edit"
    new["replayed_ops"][replay_key("observer-start", "observer")]["op"]["state"] = "caller edit"
    new["replayed_ops"]["activity.retired"]["T01.M01"].append("caller-run")
    case.assertEqual((state, e, tpl, activity), before, "returned containers alias retained inputs")


def fault_run(scope="task", error_code=None, leak=False):
    """A6 hook: _recompute, after real derivation/retirement, before commit.

    One fault fires on a sentinel semantic write. Later recomputations run the
    original function. The negative control reinstates that tentative write at
    final recomputation; neither control edits a source file.
    """
    prefix = active_history()
    if scope == "task":
        bad_op = {"kind": "task.set", "task_id": "T01", "base_rev": 6, "title": "tentative-fault", "state": "blocked", "reason": "tentative", "op_id": "retry-fault"}
        good_op = {"kind": "task.set", "task_id": "T01", "base_rev": 6, "title": "Recovered", "op_id": "retry-fault"}
    else:
        bad_op = {"kind": "memory.set", "section": "notes", "base_rev": 2, "text": "tentative-fault", "op_id": "retry-fault"}
        good_op = {"kind": "memory.set", "section": "notes", "base_rev": 2, "text": "Recovered", "op_id": "retry-fault"}
    bad = event(9, bad_op)
    good = event(10, good_op)
    expected = reducer.fold_plan(prefix + [good], templates=templates())
    expected["rejected"].append(receipt(bad, error_code or "bad_op"))
    real = reducer._recompute
    witness = {"injected": 0, "after_fault_recomputations": 0, "leaked": 0, "tentative": None}
    def hook(state):
        real(state)
        value = state["tasks"][0]["title"] if scope == "task" and state["tasks"] else state["memory"].get("notes", {}).get("text")
        if witness["injected"] == 0 and value == "tentative-fault":
            witness["injected"] += 1
            witness["tentative"] = copy.deepcopy(state)
            if error_code is not None:
                raise PlanError(error_code, "one-shot after tentative mutation")
            raise RuntimeError("one-shot after tentative mutation")
        if witness["injected"]:
            witness["after_fault_recomputations"] += 1
            if leak:
                if scope == "task":
                    state["tasks"][0]["title"] = witness["tentative"]["tasks"][0]["title"]
                else:
                    state["memory"]["notes"] = copy.deepcopy(witness["tentative"]["memory"]["notes"])
                witness["leaked"] += 1
    inputs = copy.deepcopy(prefix + [bad, good])
    before = copy.deepcopy(inputs)
    with mock.patch.object(reducer, "_recompute", hook):
        actual = reducer.fold_plan(inputs, templates=templates())
    return actual, expected, witness, inputs == before


def assert_atomic_fault(case, run):
    actual, expected, witness, unchanged = run
    case.assertEqual(witness["injected"], 1, "fault hook did not activate")
    case.assertGreater(witness["after_fault_recomputations"], 0, "final recomputation did not run")
    case.assertTrue(unchanged, "fold changed event payloads")
    case.assertEqual(actual, expected, "rejected tentative write, revision, retirement, rollup or receipt leaked")
    case.assertEqual(actual["last_lamport"], 10)
    case.assertEqual(actual["replayed_ops"][replay_key("retry-fault")]["kind"], expected["replayed_ops"][replay_key("retry-fault")]["kind"])
    case.assertNotIn("tentative-fault", json.dumps(actual))


def budget_history(suffix=1, size=8):
    """All four projection containers are populated before the measured suffix."""
    events = []
    def put(op):
        e = event(len(events) + 1, op)
        events.append(e)
        return e
    for _ in range(size):
        opened = put(opening())
        put({"kind": "plan.close", "base_rev": opened["lamport"]})
    put(opening())
    for index in range(size):
        put(adding(title="Task %d" % index, op_id="add-key-%d" % index))
        put({"kind": "memory.set", "section": "memo-%d" % index, "text": "Seed", "base_rev": 0, "op_id": "memo-key-%d" % index})
    revision = 0
    for index in range(suffix):
        update = put({"kind": "memory.set", "section": "notes", "text": "Suffix %d" % index, "base_rev": revision, "op_id": "suffix-%d" % index})
        revision = update["lamport"]
    return events


class ProjectionCopyMeter:
    """Count deepcopy calls and observed container copies, never elapsed time.

    The trace observes projection-valued locals and bounded same-type alias
    copies. A container with at least three shared entries is a container-wide
    copy candidate; tiny touched-key rollback records are intentionally ignored.
    Deepcopy is counted independently, so new leaf identities cannot hide it.
    References stay alive to prevent object-id reuse from confusing the probe.
    """
    def __init__(self, extra_codes=()):
        self.full = 0
        self.payload = 0
        self.work = Counter({field: 0 for field in FIELDS})
        self.sources = {field: {} for field in FIELDS}
        self.extra_codes = set(extra_codes)
        self.real_deepcopy = copy.deepcopy

    @staticmethod
    def is_projection(value):
        return isinstance(value, dict) and FULL_KEYS <= value.keys()

    @staticmethod
    def fingerprint(value):
        if isinstance(value, dict):
            return frozenset((key, id(item)) for key, item in value.items())
        return frozenset((index, id(item)) for index, item in enumerate(value))

    def observe(self, state):
        for field in FIELDS:
            value = state[field]
            if not isinstance(value, (dict, list)):
                continue
            known = self.sources[field]
            if id(value) in known:
                continue
            fingerprint = self.fingerprint(value)
            overlap = max((len(fingerprint & old_print) for old, old_print in known.values()
                           if isinstance(old, dict) == isinstance(value, dict)), default=0)
            if overlap >= 3:
                self.work[field] += overlap
            known[id(value)] = (value, fingerprint)

    def trace(self, frame, event_kind, arg):
        # Observe the actual stdlib function, including recursive/default-bound
        # calls and imported aliases; patching only copy.deepcopy misses these.
        if event_kind == "call" and frame.f_code is self.real_deepcopy.__code__:
            value = frame.f_locals.get("x")
            if self.is_projection(value):
                self.full += 1
                self.observe(value)
            else:
                matched = False
                for field in FIELDS:
                    if id(value) in self.sources[field]:
                        self.work[field] += len(value)
                        matched = True
                if not matched:
                    self.payload += 1
            return None
        module = frame.f_globals.get("__name__", "")
        if module.startswith("bridge.plan.") or frame.f_code in self.extra_codes:
            for value in tuple(frame.f_locals.values()):
                if self.is_projection(value):
                    self.observe(value)
            return self.trace
        return None

    def run(self, events):
        old_trace = sys.gettrace()
        try:
            sys.settrace(self.trace)
            projection = reducer.fold_plan(events, templates=templates())
        finally:
            sys.settrace(old_trace)
        return projection


def assert_no_container_growth(case, short, long):
    case.assertEqual(dict(long.work), dict(short.work), "valid suffix increased projection-container copy work (payload copies are separate)")


def assert_boolean_revision_rejected(case, apply=reducer.apply_op_event):
    state = reducer.empty_projection()
    e = event(1, {"kind": "memory.set", "section": "notes", "base_rev": False, "text": "Boolean is not revision zero"})
    before = copy.deepcopy((state, e))
    with case.assertRaises(PlanError) as caught:
        apply(state, e)
    case.assertEqual(caught.exception.code, "bad_op")
    case.assertEqual((state, e), before)


def assert_rejection_retry(case, apply=reducer.apply_op_event):
    state = populated()
    op_id = "rejected-retry"
    bad = event(20, {"kind": "task.set", "task_id": "T01", "base_rev": 6, "title": "overwrite", "deps": ["T01"], "op_id": op_id})
    with case.assertRaises(PlanError) as caught:
        apply(state, bad)
    case.assertEqual(caught.exception.code, "dep_cycle")
    case.assertNotIn(replay_key(op_id), state["replayed_ops"], "rejection reserved op_id")
    good = event(21, {"kind": "task.set", "task_id": "T01", "base_rev": 6, "title": "Repaired", "op_id": op_id})
    value, result = apply(state, good)
    case.assertEqual(value["tasks"][0]["title"], "Repaired")
    case.assertEqual(value["tasks"][0]["rev"], 21)
    case.assertNotIn("replayed", result)
