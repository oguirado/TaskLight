"""Shared, fixed event vectors; also a bounded JSON projection reader for TS."""
import copy
import json
import sys
from pathlib import Path

from bridge.plan.fold import apply_op_event, empty_projection, fold_plan

ROOT = Path(__file__).resolve().parents[4]
BASE_TS = 1_700_000_000_000
TEMPLATE = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
TEMPLATES = {TEMPLATE["id"]: TEMPLATE}
CASES = json.loads((ROOT / "tests/unit/u88/cases.json").read_text())["cases"]


def event(number, op, agent="alice"):
    op = copy.deepcopy(op)
    if op["kind"] == "plan.open":
        op["template_hash"] = TEMPLATE["hash"]
    return {"id": f"e-{number:016x}", "lamport": number,
            "ts": BASE_TS + number, "room": "demo", "agent": agent,
            "act": "op", "text": "", "op": op}


def vector(name):
    return copy.deepcopy(next(c for c in CASES if c["name"] == name))


def events_for(case):
    return [event(i, op) for i, op in enumerate(case["ops"], 1)]


def folded(events):
    return fold_plan(events, templates=TEMPLATES)


def incremental(events):
    projection = empty_projection()
    for item in events:
        projection, _ = apply_op_event(projection, item, templates=TEMPLATES)
    return projection


def canonical(projection):
    return {"tasks": [{key: t[key] for key in ("id", "state", "ready")}
                      for t in sorted(projection["tasks"], key=lambda t: t["id"])],
            "rollup": projection["rollup"]}


if __name__ == "__main__":
    # The TS oracle supplies exactly the same finite event fixtures over stdin.
    batches = json.loads(sys.stdin.read())
    print(json.dumps([canonical(folded(events)) for events in batches]))
