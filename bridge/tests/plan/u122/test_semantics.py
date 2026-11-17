"""U122 M1-M6/A1-A6 and Amendment B preservation assertions."""
import copy
import hashlib
import inspect
import json
import unittest
from unittest import mock

from bridge.plan import fold as reducer
from bridge.plan.errors import PlanError
from bridge.tests.plan.support import empty_expected
from .support import (HERE, BASE_TS, active_history, adding, assert_atomic_fault,
    assert_public_detachment, assert_boolean_revision_rejected, assert_rejection_retry, digest, event, fault_run, mixed_history, opening,
    populated, receipt, replay_key, seeded_history, templates)

REFERENCE_SHA256 = "2efda9f2c6dd8b9bf7d374f06499922498703e40fee42cc305baa2a7924b0210"


class ContractAndReference(unittest.TestCase):
    def test_public_signatures_and_projection_type(self):
        for fn, names in ((reducer.apply_op_event, ("state", "event", "templates", "last_by_agent")),
                          (reducer.fold_plan, ("events", "templates"))):
            signature = inspect.signature(fn)
            # A-C2c: private keyword-only hooks (leading underscore, SPEC_C2 inventory) are not public signature.
            self.assertEqual(tuple(n for n in signature.parameters if not n.startswith("_")), names)
            for name in names:
                if name in ("templates", "last_by_agent"):
                    self.assertIs(signature.parameters[name].kind, inspect.Parameter.KEYWORD_ONLY)
                    self.assertIsNone(signature.parameters[name].default)
        state = reducer.fold_plan([])
        self.assertIsInstance(state, reducer.PlanProjection)
        self.assertEqual(set(state), set(empty_expected()))
        self.assertEqual(state["agent_lifecycle"], {})
        self.assertNotIn("agent_lifecycle", state)
        with self.assertRaises(KeyError):
            state["unknown_projection_field"]

    def test_empty_is_exact_empty_projection(self):
        self.assertEqual(reducer.fold_plan([]), reducer.empty_projection())
        self.assertEqual(reducer.fold_plan(iter(())), empty_expected())
        self.assertEqual(json.loads(json.dumps(reducer.fold_plan([]))), empty_expected())

    def test_frozen_fixture_hashes_and_seed_are_pinned(self):
        raw = (HERE / "reference.json").read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), REFERENCE_SHA256)
        reference = json.loads(raw)
        self.assertEqual(reference["typescript_exit_code"], 0)
        self.assertEqual(reference["templates"], templates())
        mixed, _ = mixed_history()
        for case in reference["cases"]:
            self.assertEqual(digest({"events": case["events"], "templates": reference["templates"]}), case["fixture_sha256"])
            if case["name"] == "mixed":
                self.assertEqual(case["events"], mixed)
            elif case["name"] == "reversed":
                self.assertEqual(case["events"], list(reversed(mixed)))
            else:
                self.assertEqual(case["seed"], 122)
                self.assertEqual(case["events"], seeded_history(122))
        # The integration blocker is data, never an invented integration identity.
        self.assertEqual(reference["status"], "PROVISIONAL")
        self.assertIsNone(reference["integration"])

    def test_every_prefix_matches_full_frozen_and_typescript_projections(self):
        reference = json.loads((HERE / "reference.json").read_text())
        for case in reference["cases"]:
            self.assertEqual(len(case["expected_prefixes"]), len(case["events"]) + 1)
            self.assertEqual(len(case["typescript_prefix_sha256"]), len(case["expected_prefixes"]))
            before = copy.deepcopy((case["events"], reference["templates"]))
            for index, expected in enumerate(case["expected_prefixes"]):
                with self.subTest(history=case["name"], prefix=index):
                    actual = reducer.fold_plan(case["events"][:index], templates=reference["templates"])
                    self.assertEqual(actual, expected)
                    self.assertEqual(digest(actual), case["typescript_prefix_sha256"][index])
            self.assertEqual((case["events"], reference["templates"]), before)

    def test_independent_history_witnesses_include_lifecycle_close_and_reopen(self):
        events, marks = mixed_history()
        def at(name):
            return reducer.fold_plan(events[:marks[name]], templates=templates())
        self.assertIsNone(at("preplan_lifecycle")["plan"])
        self.assertEqual(at("preplan_lifecycle")["agent_lifecycle"]["observer"]["lifecycle"], "deployed")
        self.assertEqual(at("foreign")["rejected"][-1]["code"], "claimed_by_other")
        self.assertEqual(at("self_dep")["tasks"][0]["title"], "Action")
        self.assertEqual(at("repair-key")["tasks"][0]["title"], "Repaired")
        self.assertIsNone(at("release")["tasks"][0]["assignee"])
        self.assertEqual(at("release")["tasks"][0]["microtasks"][0]["state"], "pending")
        self.assertEqual(at("takeover_boundary")["rejected"][-1]["code"], "claimed_by_other")
        self.assertEqual(at("takeover")["tasks"][0]["assignee"], "bob")
        self.assertTrue(at("cancel")["tasks"][1]["ready"])
        closed = at("close")
        self.assertEqual(closed["plan"]["state"], "closed")
        self.assertEqual(closed["archived_plans"][0]["tasks_done"], 1)
        self.assertEqual(closed["rollup"]["tasks_total"], 2)
        self.assertEqual(at("closed_lifecycle")["agent_lifecycle"]["observer"]["lifecycle"], "alive")
        reopened = at("reopen")
        self.assertEqual(reopened["tasks"], [])
        self.assertEqual(reopened["memory"]["notes"]["text"], "Remember")
        self.assertEqual(reopened["archived_plans"], closed["archived_plans"])
        self.assertNotIn("activity.retired", reopened["replayed_ops"])
        self.assertEqual(at("reopened_lifecycle")["agent_lifecycle"]["observer"]["lifecycle"], "finished")
        self.assertEqual([t["title"] for t in at("tie_b")["tasks"]], ["A", "B"])
        self.assertEqual(at("shape_retry")["tasks"][0]["title"], "Good")

    def test_sort_filter_first_event_id_and_equal_lamport_order(self):
        a = event(2, adding(title="A"), id="e-00000000000000aa")
        b = event(2, adding(title="B"), id="e-00000000000000bb")
        open_event = event(1, opening())
        expected = reducer.fold_plan([open_event, a, b], templates=templates())
        events = [None, [], 42, {"id": "bad", "lamport": True}, {"id": 4, "lamport": 5},
                  event(5, opening(), lamport=0), b, a, open_event, copy.deepcopy(a)]
        self.assertEqual(reducer.fold_plan(events, templates=templates()), expected)
        self.assertEqual([t["title"] for t in expected["tasks"]], ["A", "B"])
        self.assertEqual(expected["last_lamport"], 2)

    def test_conflicting_duplicate_preserves_first_sorted_arrival(self):
        first = event(2, adding(title="First"))
        second = copy.deepcopy(first)
        second["op"]["title"] = "Second"
        start = event(1, opening())
        for left, right in ((first, second), (second, first)):
            value = reducer.fold_plan([start, left, right], templates=templates())
            self.assertEqual([t["title"] for t in value["tasks"]], [left["op"]["title"]])
            self.assertEqual(value["rejected"], [])

    def test_full_fold_inputs_and_post_call_payload_mutation_are_detached(self):
        events = active_history()
        tpl = templates()
        before = copy.deepcopy((events, tpl))
        value = reducer.fold_plan(events, templates=tpl)
        self.assertEqual((events, tpl), before)
        expected = copy.deepcopy(value)
        events[2]["op"]["brief"]["goal"] = "caller edit"
        events[3]["op"]["microtasks"][0]["text"] = "caller edit"
        events[0]["op"]["state"] = "caller edit"
        tpl.clear()
        self.assertEqual(value, expected)


class PublicCopySemantics(unittest.TestCase):
    def test_accepted_public_application_detaches_all_nested_inputs(self):
        assert_public_detachment(self)

    def test_replay_returns_original_result_and_only_advances_cursor(self):
        before = populated()
        original = copy.deepcopy(before)
        e = event(20, {"kind": "task.claim", "task_id": "T01", "op_id": "claim-first"})
        value, result = reducer.apply_op_event(before, e, templates=templates())
        expected = copy.deepcopy(before)
        expected["last_lamport"] = 20
        self.assertEqual(value, expected)
        cached = original["replayed_ops"][replay_key("claim-first")]
        self.assertEqual(result, dict(cached, replayed=True))
        self.assertEqual(before, original)
        value["tasks"][0]["microtasks"][0]["live"]["run_id"] = "caller edit"
        value["memory"]["notes"]["text"] = "caller edit"
        value["replayed_ops"][replay_key("observer-start", "observer")]["op"]["state"] = "caller edit"
        result["kind"] = "caller edit"
        self.assertEqual(before, original)
        self.assertEqual(before["replayed_ops"][replay_key("claim-first")], cached)

    def test_post_call_source_state_event_template_and_activity_mutations(self):
        state = populated()
        tpl = templates()
        activity = {"alice": BASE_TS + 8}
        e = event(20, {"kind": "micro.set", "micro_id": "T01.M01", "state": "done", "evidence": [{"path": "evidence/check.txt", "sha256": "c" * 64}], "op_id": "done-once"})
        value, result = reducer.apply_op_event(state, e, templates=tpl, last_by_agent=activity)
        frozen = copy.deepcopy((value, result))
        state["tasks"][0]["microtasks"][0]["live"]["run_id"] = "input edit"
        state["memory"]["notes"]["text"] = "input edit"
        state["replayed_ops"][replay_key("observer-start", "observer")]["op"]["state"] = "input edit"
        e["op"]["evidence"][0]["path"] = "input edit"
        tpl.clear()
        activity["alice"] = 0
        self.assertEqual((value, result), frozen)
        replay, replay_result = reducer.apply_op_event(value, event(21, {"kind": "micro.set", "micro_id": "T01.M01", "state": "done", "op_id": "done-once"}))
        replay_frozen = copy.deepcopy((replay, replay_result))
        value["tasks"][0]["microtasks"][0]["evidence"][0]["path"] = "later input edit"
        value["memory"].clear()
        self.assertEqual((replay, replay_result), replay_frozen)

    def test_rejecting_public_call_retains_every_input_and_error(self):
        state, tpl, activity = populated(), templates(), {"alice": BASE_TS + 8}
        e = event(20, {"kind": "task.set", "task_id": "T01", "base_rev": 6, "title": "overwrite", "deps": ["T01"], "op_id": "not-reserved"})
        before = copy.deepcopy((state, e, tpl, activity))
        with self.assertRaises(PlanError) as caught:
            reducer.apply_op_event(state, e, templates=tpl, last_by_agent=activity)
        self.assertIs(type(caught.exception), PlanError)
        self.assertEqual((caught.exception.code, str(caught.exception)), ("dep_cycle", "self dep"))
        self.assertEqual((state, e, tpl, activity), before)
        self.assertNotIn(replay_key("not-reserved"), state["replayed_ops"])

    def test_nested_lifecycle_result_receipt_and_source_are_independent(self):
        state = populated()
        e = event(20, {"kind": "agent.lifecycle", "run_id": "new-run", "state": "deployed", "op_id": "new-life"}, agent="observer")
        before = copy.deepcopy((state, e))
        value, result = reducer.apply_op_event(state, e)
        frozen_receipt = copy.deepcopy(value["replayed_ops"][replay_key("new-life", "observer")])
        result["op"]["state"] = "caller edit"
        self.assertEqual(value["replayed_ops"][replay_key("new-life", "observer")], frozen_receipt)
        value["agent_lifecycle"]["observer"]["retired_run_ids"].append("caller edit")
        self.assertEqual((state, e), before)
        replay, replay_result = reducer.apply_op_event(value, event(21, e["op"], agent="observer"))
        replay_result["op"]["state"] = "replay edit"
        self.assertEqual(value["replayed_ops"][replay_key("new-life", "observer")], frozen_receipt)
        self.assertEqual(replay["replayed_ops"][replay_key("new-life", "observer")], frozen_receipt)


class ValidationAndRejection(unittest.TestCase):
    def assert_rejects_unchanged(self, state, e, code, message=None):
        before = copy.deepcopy((state, e))
        with self.assertRaises(PlanError) as caught:
            reducer.apply_op_event(state, e, templates=templates())
        self.assertEqual(caught.exception.code, code)
        if message is not None:
            self.assertIn(message, str(caught.exception))
        self.assertEqual((state, e), before)
        return caught.exception

    def test_hostile_self_dependency_rolls_back_and_same_op_id_can_succeed(self):
        assert_rejection_retry(self)
        prefix = active_history()
        before = reducer.fold_plan(prefix, templates=templates())
        bad = event(9, {"kind": "task.set", "task_id": "T01", "base_rev": 6, "title": "overwrite", "deps": ["T01"], "op_id": "repair-key"})
        actual = reducer.fold_plan(prefix + [bad], templates=templates())
        expected = copy.deepcopy(before)
        expected["rejected"] = [receipt(bad, "dep_cycle")]
        expected["last_lamport"] = 9
        self.assertEqual(actual, expected)
        self.assertNotIn(replay_key("repair-key"), actual["replayed_ops"])
        good = event(10, {"kind": "task.set", "task_id": "T01", "base_rev": 6, "title": "Repaired", "op_id": "repair-key"})
        value = reducer.fold_plan(prefix + [bad, good], templates=templates())
        self.assertEqual(value["tasks"][0]["title"], "Repaired")
        self.assertEqual(value["tasks"][0]["rev"], 10)
        self.assertEqual(value["rejected"], [receipt(bad, "dep_cycle")])
        self.assertIn(replay_key("repair-key"), value["replayed_ops"])

    def test_transitive_dependency_cycle_preserves_revisions_and_dependencies(self):
        prefix = [event(1, opening()), event(2, adding()), event(3, adding(deps=["T01"]))]
        state = reducer.fold_plan(prefix, templates=templates())
        self.assert_rejects_unchanged(state, event(4, {"kind": "task.set", "task_id": "T01", "base_rev": 2, "title": "overwrite", "deps": ["T02"]}), "dep_cycle")

    def test_micro_dependency_ownership_and_fence_error_precedence(self):
        prefix = [event(1, opening()), event(2, adding()), event(3, adding(deps=["T01"], microtasks=[{"text": "Dependent"}])), event(4, {"kind": "task.claim", "task_id": "T02"})]
        state = reducer.fold_plan(prefix, templates=templates())
        op = {"kind": "micro.set", "micro_id": "T02.M01", "state": "active", "op_id": "blocked-attempt"}
        for agent, overrides, code, message in (
            ("alice", {}, "not_conformant", "T01"),
            ("bob", {}, "claimed_by_other", None),
            ("alice", {"claim_lamport": 3}, "stale_rev", "stale claim lamport"),
            ("bob", {"claim_lamport": 3}, "claimed_by_other", None),
        ):
            with self.subTest(agent=agent, code=code):
                self.assert_rejects_unchanged(state, event(5, dict(op, **overrides), agent=agent), code, message)
        unassigned = reducer.fold_plan(prefix[:-1], templates=templates())
        self.assert_rejects_unchanged(unassigned, event(5, op), "not_conformant", "claim task T02")
        self.assertNotIn(replay_key("blocked-attempt"), state["replayed_ops"])
        rejected = event(5, op)
        expected = copy.deepcopy(state)
        expected.update(rejected=[receipt(rejected, "not_conformant")], last_lamport=5)
        self.assertEqual(reducer.fold_plan(prefix + [rejected], templates=templates()), expected)

    def test_unknown_operation_fields_precede_domain_and_replay_checks(self):
        state = populated()
        for op in (
            {"kind": "micro.set", "micro_id": "T99.M01", "state": "active", "unknown": 1},
            {"kind": "task.claim", "task_id": "T01", "op_id": "claim-first", "unknown": 1},
        ):
            with self.subTest(kind=op["kind"]):
                self.assert_rejects_unchanged(state, event(20, op), "bad_op", "unknown key")

    def test_boolean_integer_traps_are_bad_op_before_domain_checks(self):
        assert_boolean_revision_rejected(self)
        state = populated()
        operations = [
            {"kind": "task.set", "task_id": "T01", "base_rev": True, "title": "overwrite"},
            {"kind": "task.claim", "task_id": "T01", "base_rev": True},
            {"kind": "task.claim", "task_id": "T01", "takeover": 1},
            {"kind": "task.release", "task_id": "T01", "base_rev": True},
            {"kind": "task.release", "task_id": "T01", "claim_lamport": True},
            {"kind": "micro.add", "task_id": "T01", "base_rev": True, "text": "Bad"},
            {"kind": "micro.set", "micro_id": "T01.M01", "state": "active", "claim_lamport": True},
            {"kind": "memory.set", "section": "notes", "text": "Bad", "base_rev": False},
            {"kind": "plan.close", "base_rev": True},
            {"kind": "plan.phase", "base_rev": True, "phase": "start"},
        ]
        for op in operations:
            with self.subTest(op=op):
                self.assert_rejects_unchanged(state, event(20, op), "bad_op")

    def test_boolean_envelope_integers_filter_or_reject_without_reserving_ids(self):
        state = populated()
        op = {"kind": "task.claim", "task_id": "T01", "op_id": "bool-attempt"}
        for key in ("lamport", "ts"):
            for value in (True, False):
                with self.subTest(key=key, value=value):
                    bad = event(20, op, **{key: value})
                    self.assert_rejects_unchanged(state, bad, "bad_op", "event " + key)
                    expected = copy.deepcopy(state)
                    if key == "ts":
                        expected.update(rejected=[receipt(bad, "bad_op")], last_lamport=20)
                    self.assertEqual(reducer.fold_plan(active_history() + [bad], templates=templates()), expected)
                    self.assertNotIn(replay_key("bool-attempt"), expected["replayed_ops"])

    def test_release_resets_active_microtasks_fences_and_retires_live_runs(self):
        before = populated()
        e = event(20, {"kind": "task.release", "task_id": "T01", "base_rev": 6, "claim_lamport": 5})
        value, _ = reducer.apply_op_event(before, e)
        task = value["tasks"][0]
        for key in ("assignee", "claim_lamport", "claim_ts"):
            self.assertIsNone(task[key])
        self.assertEqual((task["state"], task["rev"]), ("pending", 20))
        self.assertEqual(task["microtasks"][0]["state"], "pending")
        self.assertEqual(task["microtasks"][0]["rev"], 20)
        self.assertEqual(task["microtasks"][1]["rev"], 4)
        self.assertNotIn("live", task["microtasks"][0])
        self.assertEqual(value["replayed_ops"]["activity.retired"], {"T01": ["r1", "r2"], "T01.M01": ["r1", "r2"]})
        self.assertEqual(before["tasks"][0]["microtasks"][0]["live"]["run_id"], "r2")

    def test_release_owner_and_fence_errors_do_not_retire_live_activity(self):
        state = populated()
        for agent, overrides, code in (("bob", {}, "claimed_by_other"),
                ("alice", {"claim_lamport": 4}, "stale_rev"),
                ("alice", {"base_rev": 5}, "stale_rev")):
            with self.subTest(agent=agent, code=code):
                op = dict({"kind": "task.release", "task_id": "T01", "base_rev": 6, "claim_lamport": 5, "op_id": "release-denied"}, **overrides)
                self.assert_rejects_unchanged(state, event(20, op, agent=agent), code)
                self.assertEqual(state["tasks"][0]["microtasks"][0]["live"]["run_id"], "r2")
                self.assertNotIn(replay_key("release-denied", agent), state["replayed_ops"])

    def test_premature_close_and_completed_or_cancelled_closure(self):
        for terminal in ("done", "cancelled"):
            with self.subTest(terminal=terminal):
                events = [event(1, {"kind": "memory.set", "section": "notes", "text": "Room memory", "base_rev": 0}), event(2, opening()), event(3, adding(microtasks=[{"text": "Step"}])), event(4, {"kind": "task.claim", "task_id": "T01"})]
                before = reducer.fold_plan(events, templates=templates())
                self.assert_rejects_unchanged(before, event(5, {"kind": "plan.close", "base_rev": 2}), "not_conformant", "T01")
                finish = {"kind": "micro.set", "micro_id": "T01.M01", "state": "done"} if terminal == "done" else {"kind": "task.set", "task_id": "T01", "base_rev": 4, "state": "cancelled"}
                events += [event(5, finish), event(6, {"kind": "plan.close", "base_rev": 2}), event(7, opening())]
                value = reducer.fold_plan(events, templates=templates())
                self.assertEqual(value["rejected"], [])
                self.assertEqual(value["tasks"], [])
                self.assertEqual(value["plan"]["state"], "active")
                self.assertEqual(value["archived_plans"][0]["tasks_done"], int(terminal == "done"))
                self.assertEqual(value["memory"], before["memory"])

    def test_rejected_event_updates_activity_only_after_its_attempt(self):
        prefix = [event(1, opening()), event(2, adding()), event(3, {"kind": "task.claim", "task_id": "T01"})]
        # Alice's rejected event still counts as prior activity for Bob's next attempt.
        bad = event(4, {"kind": "task.set", "task_id": "T01", "base_rev": 1, "title": "Bad"}, ts=BASE_TS + 600004)
        takeover = event(5, {"kind": "task.claim", "task_id": "T01", "takeover": True}, agent="bob", ts=BASE_TS + 600005)
        value = reducer.fold_plan(prefix + [bad, takeover], templates=templates())
        self.assertEqual(value["tasks"][0]["assignee"], "alice")
        self.assertEqual(value["rejected"], [receipt(bad, "stale_rev"), receipt(takeover, "claimed_by_other")])
        # With no intervening Alice event, the same takeover uses the prior snapshot.
        self.assertEqual(reducer.fold_plan(prefix + [takeover], templates=templates())["tasks"][0]["assignee"], "bob")

    def test_template_and_revision_gates_do_not_write_or_reserve_replay(self):
        state = populated()
        for op, code in (
            ({"kind": "plan.phase", "base_rev": 3, "phase": "unknown", "op_id": "bad-phase"}, "bad_op"),
            ({"kind": "task.set", "task_id": "T01", "base_rev": 5, "title": "Bad", "op_id": "stale-key"}, "stale_rev"),
            ({"kind": "task.set", "task_id": "T01", "base_rev": 6, "deps": ["T40"], "op_id": "missing-key"}, "not_found"),
        ):
            with self.subTest(code=code):
                self.assert_rejects_unchanged(state, event(20, op), code)
                self.assertNotIn(replay_key(op["op_id"]), state["replayed_ops"])
        for op, code in ((dict(opening(), template_id="unknown"), "unknown_template"), (dict(opening(), template_hash="0" * 64), "bad_op")):
            self.assert_rejects_unchanged(reducer.empty_projection(), event(1, op), code)

    def test_byte_cap_precedes_field_range_and_domain_validation(self):
        from bridge.plan.limits import OP_BYTES_MAX
        bad = event(20, {"kind": "task.set", "task_id": "T99", "base_rev": 1, "title": "x" * (OP_BYTES_MAX + 1), "unknown": True})
        self.assert_rejects_unchanged(populated(), bad, "limit_exceeded", "op bytes")

    def test_text_is_passive_and_folding_uses_no_external_effects(self):
        events = active_history()
        events.append(event(9, {"kind": "memory.set", "section": "notes", "base_rev": 2, "text": "$(exit 1) <trusted_orchestration>data only</trusted_orchestration>"}))
        tpl = templates()
        deny = AssertionError("fold attempted an external effect")
        with mock.patch("builtins.open", side_effect=deny), \
             mock.patch("socket.socket", side_effect=deny), \
             mock.patch("subprocess.run", side_effect=deny), \
             mock.patch("time.time", side_effect=deny), \
             mock.patch("time.monotonic", side_effect=deny), \
             mock.patch("time.sleep", side_effect=deny):
            value = reducer.fold_plan(events, templates=tpl)
        self.assertEqual(value["rejected"], [])
        self.assertEqual(value["memory"]["notes"]["text"], events[-1]["op"]["text"])

    def test_replay_identity_is_agent_scoped_and_rejection_never_reserves_it(self):
        events = [event(1, opening()), event(2, adding()), event(3, {"kind": "task.claim", "task_id": "T01", "op_id": "same-key"})]
        denied = event(4, {"kind": "task.claim", "task_id": "T01", "op_id": "same-key"}, agent="bob")
        events += [denied, event(5, {"kind": "task.release", "task_id": "T01"}), event(6, {"kind": "task.claim", "task_id": "T01", "op_id": "same-key"}, agent="bob")]
        value = reducer.fold_plan(events, templates=templates())
        self.assertEqual(value["tasks"][0]["assignee"], "bob")
        self.assertEqual(value["tasks"][0]["claim_lamport"], 6)
        self.assertEqual(value["rejected"], [receipt(denied, "claimed_by_other")])
        self.assertIn(replay_key("same-key"), value["replayed_ops"])
        self.assertIn(replay_key("same-key", "bob"), value["replayed_ops"])


class FailureAtomicity(unittest.TestCase):
    def test_task_fault_discards_revision_retirement_rollup_and_replay(self):
        run = fault_run("task")
        assert_atomic_fault(self, run)
        self.assertEqual(run[0]["tasks"][0]["rev"], 10)
        self.assertEqual(run[0]["tasks"][0]["state"], "active")
        self.assertEqual(run[0]["tasks"][0]["microtasks"][0]["live"]["run_id"], "r2")
        self.assertEqual(run[0]["rollup"]["tasks_blocked"], 0)

    def test_memory_fault_discards_write_revision_and_replay(self):
        run = fault_run("memory")
        assert_atomic_fault(self, run)
        self.assertEqual(run[0]["memory"]["notes"]["text"], "Recovered")
        self.assertEqual(run[0]["memory"]["notes"]["rev"], 10)

    def test_injected_plan_error_keeps_its_code_for_task_and_memory(self):
        for scope in ("task", "memory"):
            with self.subTest(scope=scope):
                run = fault_run(scope, "stale_rev")
                assert_atomic_fault(self, run)
                self.assertEqual(run[0]["rejected"][0]["code"], "stale_rev")

    def test_public_fault_keeps_original_plan_error_message_and_inputs(self):
        state = populated()
        before = copy.deepcopy(state)
        e = event(20, {"kind": "task.set", "task_id": "T01", "base_rev": 6, "title": "tentative-fault"})
        real = reducer._recompute
        def hook(value):
            real(value)
            if value["tasks"][0]["title"] == "tentative-fault":
                raise PlanError("not_conformant", "one-shot public failure")
        with mock.patch.object(reducer, "_recompute", hook):
            with self.assertRaises(PlanError) as caught:
                reducer.apply_op_event(state, e)
        self.assertIs(type(caught.exception), PlanError)
        self.assertEqual((caught.exception.code, str(caught.exception)), ("not_conformant", "one-shot public failure"))
        self.assertEqual(state, before)
