"""M1 strict result admission and preserved legacy replay; M6 current-run result."""
import copy
import json

from bridge.plan.fold import fold_plan
from bridge.room import app, store
from .support import ROOT, RESULT, VECTORS, RoomCase, unwrap


class ResultOracle(RoomCase):
    def test_m1_unknown_key_negative_control_has_valid_positive_twin(self):
        self.life(state="finished", result=copy.deepcopy(RESULT))
        before = self.raw()
        with self.assertRaises(store.RoomError) as caught:
            app.dispatch("agent_lifecycle", dict(room="demo", agent="other", run_id="r1", state="failed",
                op_id="unknown-result-key", result=dict(RESULT, injected=True)))
        self.assertEqual(caught.exception.code, "bad_args")
        self.assertEqual(self.raw(), before)

    def test_m1_exact_result_retry_is_idempotent(self):
        args = dict(room="demo", agent="worker", state="finished", run_id="r1", op_id="retry-result-01",
                    result=copy.deepcopy(RESULT))
        self.life()
        try:
            first = app.dispatch("agent_lifecycle", args)
        except store.RoomError as exc:
            self.fail("M1 valid terminal result rejected: " + exc.code)
        before = self.raw()
        self.assertEqual(app.dispatch("agent_lifecycle", copy.deepcopy(args)), first)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.events()[-1]["op"]["result"], RESULT)

    def test_m1_legacy_events_still_admit_without_result(self):
        self.life()
        self.life(state="alive")
        self.life(state="finished")
        self.assertTrue(all("result" not in event["op"] for event in self.events()))
        projection = fold_plan(self.events())
        self.assertEqual(projection["rejected"], [])
        self.assertEqual(fold_plan(copy.deepcopy(self.events())), projection)

    def test_m1_legacy_fixture_fold_is_byte_identical(self):
        legacy = json.loads((ROOT / "bridge/tests/room/c2/fixtures/legacy_fold.json").read_text())
        for history in legacy["histories"]:
            with self.subTest(history=history["name"]):
                projection = fold_plan(copy.deepcopy(history["events"]), templates={legacy["template"]["id"]: legacy["template"]})
                encoded = json.dumps(projection, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                self.assertEqual(encoded, history["expected_json"])

    def test_m6_no_terminal_result_is_explicit_null(self):
        self.life()
        self.assertIsNone(self.inventory_row()["last_result"])
        self.life(state="finished")
        self.assertIsNone(self.inventory_row()["last_result"])

    def test_m6_finished_result_summary_has_at_most_two_hundred_characters(self):
        result = dict(RESULT, summary="s" * 201)
        self.life(state="finished", result=result)
        last = self.inventory_row()["last_result"]
        self.assertEqual(set(last) - {"evidence"}, {"verdict", "summary", "receipt"})  # A-C7: C7 M1 adds bounded evidence
        self.assertEqual((last["verdict"], last["receipt"]), (result["verdict"], result["receipt"]))
        self.assertLessEqual(len(last["summary"]), 200)
        self.assertTrue(last["summary"].startswith("s" * 190), "M6 truncation must retain summary text")

    def test_m6_failed_result_short_summary_is_unchanged(self):
        result = dict(RESULT, verdict="HOLD", summary="a" * 200)
        self.life(state="failed", result=result)
        last = {k: v for k, v in self.inventory_row()["last_result"].items() if k != "evidence"}  # A-C7: C7 M1 adds bounded evidence
        self.assertEqual(last, {key: result[key] for key in ("verdict", "summary", "receipt")})

    def test_m6_result_does_not_leak_to_a_redeployed_run(self):
        self.life(state="finished", result=RESULT)
        self.assertIsNotNone(self.inventory_row()["last_result"])
        self.life(run="r2")
        row = self.inventory_row()
        self.assertEqual(row["run_id"], "r2")
        self.assertIsNone(row["last_result"])
        self.life(run="r2", state="finished")
        self.assertIsNone(self.inventory_row()["last_result"])

    def test_m6_result_is_scoped_to_each_agent(self):
        self.life(state="failed", result=RESULT)
        self.life(agent="other")
        self.assertIsNone(self.inventory_row("other")["last_result"])
        self.assertEqual(self.inventory_row()["last_result"]["verdict"], "ADMIT")

    def test_m6_inventory_mcp_and_cli_expose_the_same_last_result(self):
        self.life(state="finished", result=RESULT)
        args = {"room": "demo", "now": 1800000000000}
        before = self.raw()
        response, data = self.mcp_call("agents_list", args)
        code, cli_data, _ = self.cli_call("agents_list", args)
        self.assertFalse(response.get("isError", False))
        self.assertEqual(code, 0)
        self.assertEqual(data, cli_data)
        last = {k: v for k, v in data["agents"][0].get("last_result").items() if k != "evidence"}  # A-C7: C7 M1 adds bounded evidence
        self.assertEqual(last, {key: RESULT[key] for key in ("verdict", "summary", "receipt")})
        self.assertEqual(self.raw(), before)


def vector_test(vector):
    def test(self):
        value = copy.deepcopy(vector["result"])
        if vector["valid"]:
            before = copy.deepcopy(value)
            self.life(state=vector["state"], result=value)
            event = self.events()[-1]
            self.assertEqual(event["op"].get("result"), before, "M1 persist result bytes and structure")
            self.assertEqual(value, before, "admission must not mutate caller data")
            self.assertEqual(fold_plan(self.events())["rejected"], [], "M1 admitted results must survive replay")
        else:
            before = self.raw()
            with self.assertRaises(store.RoomError) as caught:
                app.dispatch("agent_lifecycle", dict(room="demo", agent="worker", run_id="r1",
                    state=vector["state"], op_id="invalid-result-01", result=value))
            self.assertEqual(caught.exception.code, "bad_args", "M1 invalid results use bad_args")
            self.assertEqual(self.raw(), before, "M1 invalid result appends nothing")
    return test


for _case in VECTORS["cases"]:
    setattr(ResultOracle, "test_m1_shape_" + _case["name"], vector_test(_case))
