"""Shared event-ID histories and a frozen, independent projection oracle."""
import copy
import json
import sys
import unittest
from pathlib import Path

from bridge.plan.errors import PlanError
from bridge.plan.fold import apply_op_event, empty_projection, fold_plan
from bridge.tests.plan.support import empty_expected


def cases():
    root = Path(__file__).resolve().parents[4]
    vectors = json.loads((root / "tests/property/vectors.baseline.json").read_text())
    frozen = next(c for c in vectors["cases"]
                  if c["id"] == "literal_equal_lamport_reverse_id")
    add, opening = frozen["events"]
    result = []
    pairs = [(value, value + "-task") for value in
             ("e-a", "e-b", "e-0000000000000001", "x", "123", " ",
              "__proto__", "constructor")]
    pairs += [("e-a", "e-b"), ("123", "2"), ("\ue000", "\U00010000")]
    for index, (open_id, add_id) in enumerate(pairs):
        opened, added = copy.deepcopy((opening, add))
        opened["id"], added["id"] = open_id, add_id
        for order, events in (("reverse", [added, opened]),
                              ("duplicates", [added, opened, added, opened])):
            result.append(dict(id=f"valid-{index}-{order}", events=events,
                               templates=frozen["templates"],
                               expected=frozen["expected_projection"], code=None))
    for index, value in enumerate(("", None, True, False, 0, 123, [], {})):
        event = copy.deepcopy(opening)
        event["id"] = value
        expected = empty_expected()
        if value == "":
            expected["last_lamport"] = 1
            expected["rejected"] = [dict(id="", lamport=1, op_id=None, code="bad_op")]
        result.append(dict(id=f"invalid-{index}", events=[event],
                           templates=frozen["templates"], expected=expected,
                           code="bad_op"))
    event = copy.deepcopy(opening)
    del event["id"]
    result.append(dict(id="missing", events=[event], templates=frozen["templates"],
                       expected=empty_expected(), code="bad_op"))
    return result


def envelope_code(event, templates):
    try:
        apply_op_event(empty_projection(), event, templates=templates)
    except PlanError as error:
        return error.code
    return None


class EventIdParity(unittest.TestCase):
    def test_shared_histories_match_frozen_expectations(self):
        for case in cases():
            with self.subTest(case=case["id"]):
                before = copy.deepcopy(case)
                actual = fold_plan(case["events"], templates=case["templates"])
                self.assertEqual(actual, case["expected"])
                opening = next((e for e in case["events"]
                                if e["op"]["kind"] == "plan.open"))
                self.assertEqual(envelope_code(opening, case["templates"]), case["code"])
                if case["code"] is None:
                    self.assertEqual([t["id"] for t in actual["tasks"]], ["T01"])
                    self.assertEqual(actual["rejected"], [])
                self.assertEqual(case, before)


def main():
    if sys.argv[1:] == ["--json"]:
        bundle = cases()
        for case in bundle:
            before = copy.deepcopy(case)
            case["prefixes"] = [fold_plan(case["events"][:i], templates=case["templates"])
                                for i in range(len(case["events"]) + 1)]
            assert case["events"] == before["events"]
            assert case["templates"] == before["templates"]
        json.dump(bundle, sys.stdout)
    else:
        unittest.main()


if __name__ == "__main__":
    main()
