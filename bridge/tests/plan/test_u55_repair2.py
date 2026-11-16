"""Serialization parity and hostile nesting regression oracles."""
import json
import unittest

from bridge.plan.errors import PlanError
from bridge.plan.fold import apply_op_event, empty_projection, fold_plan
from bridge.plan.ops import is_valid_op_shape, validate_op_shape


def event(n, ts, op):
    return dict(id=str(n), act="op", lamport=n, ts=ts, agent="a", op=op)


def opening():
    return dict(kind="plan.open", title="P", template_id="generic",
                template_hash="0" * 64)


class Repair2Tests(unittest.TestCase):
    def test_closed_projection_json_round_trip(self):
        state = fold_plan([
            event(1, 100, opening()),
            event(2, 200, dict(kind="plan.close", base_rev=1)),
        ])
        restored = json.loads(json.dumps(state))
        original_out, _ = apply_op_event(state, event(3, 300, opening()))
        restored_out, _ = apply_op_event(restored, event(3, 300, opening()))
        self.assertEqual(original_out, restored_out)
        self.assertEqual(restored_out["archived_plans"][0]["closed_ts"], 200)
        self.assertEqual(len(restored_out["archived_plans"]), 1)

    def test_deep_malformed_json(self):
        for depth in (600, 5000):
            # Construct the larger JSON-compatible value iteratively: decoding it
            # with the stdlib decoder would itself hit the interpreter limit.
            if depth == 600:
                op = json.loads(
                    '{"kind":"memory.set","section":"notes","text":"",'
                    '"base_rev":0,"extra":' + '[' * depth + '0' + ']' * depth + '}')
            else:
                nested = 0
                for _ in range(depth):
                    nested = [nested]
                op = dict(kind="memory.set", section="notes", text="",
                          base_rev=0, extra=nested)
            with self.subTest(depth=depth, api="apply"):
                with self.assertRaises(PlanError) as raised:
                    apply_op_event(empty_projection(), event(1, 100, op))
                self.assertEqual(raised.exception.code, "bad_op")
            with self.subTest(depth=depth, api="validate"):
                with self.assertRaises(PlanError) as raised:
                    validate_op_shape(op)
                self.assertEqual(raised.exception.code, "bad_op")
                self.assertFalse(is_valid_op_shape(op))
            with self.subTest(depth=depth, api="fold"):
                state = fold_plan([
                    event(1, 100, op),
                    event(2, 200, dict(kind="memory.set", section="notes",
                                       text="survived", base_rev=0)),
                ])
                self.assertEqual(state["rejected"], [dict(
                    id="1", lamport=1, op_id=None, code="bad_op")])
                self.assertEqual(state["memory"]["notes"]["text"], "survived")
