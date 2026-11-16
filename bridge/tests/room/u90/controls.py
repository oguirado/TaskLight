"""Explicit fault-injection controls; production code is never patched."""
import copy
import json
from pathlib import Path

from bridge.plan.errors import PlanError
from bridge.plan.fold import fold_plan


def require_owner_rejection(apply):
    root = Path(__file__).resolve().parents[4]
    fixture = json.loads((root / "tests/unit/u90/fixture.json").read_text(encoding="utf-8"))
    state = fold_plan(fixture["seed"])
    ev = copy.deepcopy(fixture["beat"])
    ev["agent"] = "mallory"
    try:
        apply(state, ev)
    except PlanError as error:
        assert error.code == "claimed_by_other", error.code
    else:
        raise AssertionError("non-owner activity was accepted")
