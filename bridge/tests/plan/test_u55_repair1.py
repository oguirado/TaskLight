import copy
import json
from bridge.plan.fold import fold_plan, apply_op_event, empty_projection
from bridge.plan.ops import validate_op_shape, is_valid_op_shape
from bridge.plan.template import validate_template, template_hash, canonical_template_json
from bridge.plan.errors import PlanError
from .support import OracleCase, BASE_TS, event, opening, templates, template

class RepairOracle(OracleCase):
    def test_R1_huge_lamport_no_overflow(self):
        # huge int must be discarded, not crash with OverflowError
        s = fold_plan([{"id":"huge","act":"op","lamport":10**400}], templates=templates())
        self.assertIs(s["plan"], None)
        self.assertEqual(s["last_lamport"], 0)

    def test_R2_micro_set_state_type_error(self):
        op = {"kind":"micro.set","micro_id":"T01.M01","state":[]}
        self.assertCode("bad_op", validate_op_shape, op)
        self.assertIs(is_valid_op_shape(op), False)

    def test_R3_oversize_returns_limit(self):
        op = {"kind":"task.add","title":"x"*8193,"type":"action","phase":"start"}
        self.assertCode("limit_exceeded", validate_op_shape, op)
        self.assertIs(is_valid_op_shape(op), False)

    def test_R4_archive_timestamp_survives_fold(self):
        open_ev = event(1, opening(), ts=100)
        close_ev = event(2, {"kind":"plan.close","base_rev":1,"outcome":"done"}, ts=200)
        s = fold_plan([open_ev, close_ev], templates=templates())
        self.assertNotIn("_closed_ts", s)
        self.assertNotIn("_closed_ts", s["plan"] if isinstance(s.get("plan"), dict) else {})
        reopen_ev = event(3, opening(), ts=300)
        s2, _ = apply_op_event(s, reopen_ev, templates=templates())
        self.assertEqual(len(s2["archived_plans"]), 1)
        self.assertEqual(s2["archived_plans"][0]["closed_ts"], 200)
        self.assertNotIn("_closed_ts", s2)
        # direct close must not expose key either
        s0 = empty_projection()
        s0, _ = apply_op_event(s0, open_ev, templates=templates())
        s0, _ = apply_op_event(s0, close_ev, templates=templates())
        self.assertNotIn("_closed_ts", s0)

    def test_R5_template_surrogate_bad_template(self):
        raw = template()
        raw.pop("hash", None)
        raw["name"] = "\ud800"
        self.assertCode("bad_template", validate_template, raw)
        self.assertCode("bad_template", canonical_template_json, raw)
        self.assertCode("bad_template", template_hash, raw)
