"""C2 M1-M9: public admission, replay, inventory, transports and docs."""
import contextlib
import copy
import io
import json
import runpy
import sys
from unittest import mock

from bridge.plan.errors import PlanError
from bridge.plan.fold import fold_plan
from bridge.plan.ops import validate_op_shape
from bridge.room import app, hook, store
from bridge.room import __main__ as cli
from bridge.room.ext.lifecycle import agent_lifecycle
from bridge.wall.emit import redact
from .support import (FIXTURE, HERE, ROOT, InventoryCase, NoWaitBudget,
                      fixture_case, unwrap)


class SharedInventoryOracle(InventoryCase):
    pass


def _inventory_test(case):
    def check(self):
        self.assert_case(copy.deepcopy(case))
    check.__doc__ = "M2-M6/M8 shared fixed-clock history: " + case["name"]
    return check


for _case in FIXTURE["cases"]:
    setattr(SharedInventoryOracle, "test_shared_" + _case["name"], _inventory_test(_case))


class ParentAdmissionOracle(InventoryCase):
    def test_m1_discovery_exposes_optional_parent_fields(self):
        schema = next(t for t in app.list_tools() if t["name"] == "agent_lifecycle")["inputSchema"]
        self.assertIn("parent_agent", schema["properties"], "M1 parent agent input absent")
        self.assertIn("parent_run_id", schema["properties"], "M1 parent run input absent")
        self.assertNotIn("parent_agent", schema["required"])
        self.assertNotIn("parent_run_id", schema["required"])

    def test_m1_valid_parent_schema_boundaries(self):
        for fields in ({"parent_agent": "a"}, {"parent_run_id": "R_1-x"},
                       {"parent_agent": "a" * 48, "parent_run_id": "R" * 64}):
            op = dict(kind="agent.lifecycle", state="deployed", run_id="r1", op_id="schema01", **fields)
            try:
                actual = validate_op_shape(op)
            except PlanError as exc:
                self.fail("M1 valid optional parent metadata rejected: " + exc.code)
            self.assertEqual(actual, op)

    def test_m1_parent_survives_persistence_and_replay(self):
        self.life(agent="child", parent_agent="unseen", parent_run_id="parent-r1")
        events = self.events()
        self.assertEqual(events[0]["op"]["parent_agent"], "unseen")
        self.assertEqual(events[0]["op"]["parent_run_id"], "parent-r1")
        projection = fold_plan(events)
        self.assertEqual(projection["rejected"], [])
        record = projection["agent_lifecycle"]["child"]
        parent = record.get("parent") or {}
        self.assertEqual(record.get("parent_agent", parent.get("agent")), "unseen")
        self.assertEqual(record.get("parent_run_id", parent.get("run_id")), "parent-r1")
        self.assertEqual(fold_plan(copy.deepcopy(events)), projection)

    def test_m1_parent_run_only_is_optional_not_a_pair_requirement(self):
        self.life(agent="child", parent_run_id="parent-r1")
        self.assertEqual(self.events()[0]["op"]["parent_run_id"], "parent-r1")

    def test_m1_duplicate_parent_lifecycle_is_idempotent(self):
        args = dict(room="demo", agent="child", state="deployed", run_id="r1",
                    parent_agent="unseen", parent_run_id="p1", op_id="parent01")
        try:
            first = agent_lifecycle(args)
        except store.RoomError as exc:
            self.fail("M1 parent lifecycle rejected: " + exc.code)
        before = self.raw()
        self.now += 1000
        self.assertEqual(agent_lifecycle(copy.deepcopy(args)), first)
        self.assertEqual(self.raw(), before)

    def deny_parent(self, agent, fields, code="bad_args"):
        before = self.raw()
        args = dict(room="demo", agent=agent, state="deployed", run_id="r1", op_id="deny0001", **fields)
        with self.assertRaises(store.RoomError) as caught:
            agent_lifecycle(args)
        if code is not None:
            self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.raw(), before, "M1 failed admission must append nothing")

    def test_m1_self_parent_is_bad_args_without_append(self):
        self.deny_parent("worker", {"parent_agent": "worker", "parent_run_id": "r1"})

    def test_m1_two_agent_cycle_is_bad_args_without_append(self):
        self.life(agent="first", parent_agent="second", parent_run_id="r1")
        self.deny_parent("second", {"parent_agent": "first", "parent_run_id": "r1"})

    def test_m1_transitive_cycle_is_bad_args_without_append(self):
        self.life(agent="first", parent_agent="second", parent_run_id="r1")
        self.life(agent="second", parent_agent="third", parent_run_id="r1")
        self.deny_parent("third", {"parent_agent": "first", "parent_run_id": "r1"})

    def test_m1_parent_graph_is_scoped_to_room(self):
        self.life(agent="first", parent_agent="second", parent_run_id="r1")
        self.life(room="other", agent="second", parent_agent="first", parent_run_id="r1")
        self.assertEqual(len(self.events("other")), 1)

    def test_m1_hostile_parent_agent_is_rejected_without_append(self):
        for value in ("", "UPPER", "../escape", "bad\nagent", "a" * 49, None, 1, {}, []):
            with self.subTest(value=value):
                self.deny_parent("worker", {"parent_agent": value}, code=None)

    def test_m1_hostile_parent_run_is_rejected_without_append(self):
        for value in ("", "../escape", "bad run", "r\n", "r" * 65, None, 1, {}, []):
            with self.subTest(value=value):
                self.deny_parent("worker", {"parent_run_id": value}, code=None)

    def test_m1_parent_survives_mcp_lifecycle_admission(self):
        result, _ = self.mcp_call("agent_lifecycle", dict(room="demo", agent="child", state="deployed",
            run_id="r1", op_id="mcppar01", parent_agent="parent", parent_run_id="p1"))
        self.assertFalse(result.get("isError", False), "M1 MCP parent input rejected")
        self.assertEqual(self.events()[0]["op"]["parent_agent"], "parent")

    def test_m1_generic_hook_bootstraps_and_preserves_parents(self):
        payload = dict(event_id="hook-parent01", room="new-room", agent="child", state="deployed",
                       run_id="r1", parent_agent="parent", parent_run_id="p1")
        with mock.patch.object(hook, "_Deadline", NoWaitBudget):
            result = hook.run_hook_bytes(json.dumps(payload).encode())
        self.assertTrue(unwrap(result).get("ok"), "M1 generic hook rejects parent fields")
        self.assertEqual(self.events("new-room")[0]["op"]["parent_agent"], "parent")
        self.assertEqual(self.events("new-room")[0]["op"]["parent_run_id"], "p1")
        self.assertIsNone(fold_plan(self.events("new-room"))["plan"])

    def test_m1_claude_lifecycle_cli_preserves_parents(self):
        payload = dict(event_id="claude-parent01", room="claude-room", agent="child", state="deployed",
                       run_id="r1", parent_agent="parent", parent_run_id="p1")
        stream = io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode()), encoding="utf-8")
        output = io.StringIO()
        with mock.patch.object(hook, "_Deadline", NoWaitBudget), \
             mock.patch.object(sys, "argv", ["hook_claude", "--lifecycle"]), \
             mock.patch.object(sys, "stdin", stream), contextlib.redirect_stdout(output), \
             contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                runpy.run_module("bridge.room.hook_claude", run_name="__main__")
        self.assertEqual(stopped.exception.code, 0)
        self.assertEqual(output.getvalue(), "")
        events = self.events("claude-room")
        self.assertEqual(len(events), 1, "M1 Claude lifecycle entry discarded parent metadata")
        self.assertEqual(events[0]["op"]["parent_agent"], "parent")
        self.assertEqual(events[0]["op"]["parent_run_id"], "p1")


class LegacyOracle(InventoryCase):
    def test_m1_all_existing_histories_fold_byte_identically(self):
        fixture = json.loads((HERE / "fixtures/legacy_fold.json").read_text())
        for history in fixture["histories"]:
            with self.subTest(history=history["name"]):
                actual = fold_plan(history["events"], templates={"blank": fixture["template"]})
                self.assertEqual(json.dumps(actual, sort_keys=True, separators=(",", ":"), ensure_ascii=False),
                                 history["expected_json"])

    def test_m1_legacy_hook_still_bootstraps_without_parent_fields(self):
        payload = dict(event_id="legacy-hook01", room="legacy-room", agent="worker", state="deployed", run_id="r1")
        with mock.patch.object(hook, "_Deadline", NoWaitBudget):
            result = hook.run_hook_bytes(json.dumps(payload).encode())
        self.assertTrue(unwrap(result).get("ok"))
        self.assertEqual(len(self.events("legacy-room")), 1)


class TransportAndReplayOracle(InventoryCase):
    def test_m7_tool_discovery_room_and_optional_now(self):
        schema = self.advertised()["inputSchema"]
        self.assertEqual(schema["type"], "object")
        self.assertEqual(set(schema.get("required", [])), {"room"})
        self.assertIn("now", schema["properties"])

    def test_m7_cli_call_and_mcp_return_identical_json(self):
        self.install(fixture_case("fresh_alive"))
        args = {"room": "demo", "now": self.now}
        mcp_result, mcp_payload = self.mcp_call("agents_list", args)
        self.assertFalse(mcp_result.get("isError", False))
        before = self.raw()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            rc = cli.main(["call", "agents_list", "--json", json.dumps(args)])
        self.assertEqual(rc, 0, "M7 CLI call agents_list must succeed")
        self.assertEqual(json.loads(output.getvalue()), mcp_payload)
        self.assertEqual(self.raw(), before)

    def test_m7_now_omitted_uses_controlled_server_clock(self):
        self.install(fixture_case("fresh_alive"))
        result, payload = self.mcp_call("agents_list", {"room": "demo"})
        self.assertFalse(result.get("isError", False))
        self.assertEqual(unwrap(payload)["agents"][0]["state"], "idle")

    def test_m7_hostile_arguments_fail_without_mutating_journal(self):
        self.advertised()  # Unknown-tool errors must never masquerade as input validation.
        before = self.raw()
        for args in ({}, {"room": "../escape"}, {"room": 42},
                     {"room": "demo", "now": "tomorrow"}, {"room": "demo", "now": True},
                     {"room": "demo", "unexpected": "field"}):
            with self.subTest(args=args):
                result, payload = self.mcp_call("agents_list", args)
                self.assertTrue(result.get("isError", False))
                self.assertFalse(unwrap(payload).get("ok", True))
                self.assertEqual(self.raw(), before)

    def test_m7_inventory_text_uses_wall_redaction_rules_without_write_redaction(self):
        secret = "password=hunter2-SYNTHETIC"
        self.life(harness=secret)
        before = self.raw()
        self.assertIn(secret.encode(), before)
        expected = redact(secret)[0]
        result, payload = self.mcp_call("agents_list", {"room": "demo", "now": self.now})
        self.assertFalse(result.get("isError", False))
        serialized = json.dumps(payload)
        self.assertNotIn(secret, serialized)
        self.assertIn(expected, serialized)
        self.assertEqual(self.raw(), before)

    def test_m6_replay_is_stable_after_reloading_and_reordering_input(self):
        case = fixture_case("tree_first_seen_order")
        first = self.assert_case(case)
        case["events"].reverse()
        self.install(case)
        self.assertEqual(self.inventory(), first)
        self.assertEqual(self.inventory(), first)

    def test_m2_rejected_call_does_not_register_an_agent(self):
        self.life(agent="known")
        with self.assertRaises(store.RoomError):
            agent_lifecycle(dict(room="demo", agent="intruder", state="nonsense", run_id="r1"))
        self.assertEqual([r["agent"] for r in self.inventory()["agents"]], ["known"])

    # A-C2a: authors without lifecycle or assignment are not inventory members.
    def test_m2_journal_authors_of_nonplanning_acts_are_absent(self):
        for index, act in enumerate(("open", "heartbeat", "question", "handoff", "verdict", "close")):
            store.post("demo", "author-" + act, act, "Public test message", clock=lambda: 100000 + index)
        self.assertEqual(self.inventory()["agents"], [])  # A-C2a

    # A-C2a: planning/message authors do not register agents by themselves.
    def test_m2_plan_step_answer_and_ack_authors_are_absent(self):
        question = store.post("demo", "author-question", "question", "Ready?", to="author-answer", clock=lambda: 100000)
        store.post("demo", "author-answer", "answer", "Ready", re=question["id"], clock=lambda: 100001)
        handoff = store.post("demo", "author-handoff", "handoff", "Please review", to="author-ack", clock=lambda: 100002)
        store.post("demo", "author-ack", "ack", "Accepted", re=handoff["id"], clock=lambda: 100003)
        plan = store.post("demo", "author-plan", "plan", "Plan", plan={"title": "Public plan", "steps": [{"text": "Verify", "accept": "Recorded"}]}, clock=lambda: 100004)
        store.post("demo", "author-step", "step", "Step", re=plan["id"], step={"index": 0, "state": "done", "outcome": "Recorded"}, clock=lambda: 100005)
        self.assertEqual(self.inventory()["agents"], [])  # A-C2a

    def test_m2_claimant_remains_a_member_after_releasing_work(self):
        case = fixture_case("working_current_and_counts")
        self.install(case)
        store.post("demo", "worker", "op", "", op={"kind": "task.release", "task_id": "T01"},
                   clock=lambda: self.now, templates={"blank": FIXTURE["template"]})
        worker = next(r for r in self.inventory()["agents"] if r["agent"] == "worker")
        self.assertIsNone(worker["current"])
        self.assertEqual(worker["counts"], {"tasks_owned": 0, "micros_done": 0, "micros_total": 0})

    def test_m4_terminal_precedes_owned_work_and_ignored_beats(self):
        case = fixture_case("working_current_and_counts")
        n = len(case["events"]) + 1
        terminal = dict(id=f"e-{n:016x}", room="demo", agent="worker", act="op", text="", lamport=n,
                        ts=110000, op=dict(kind="agent.lifecycle", state="failed", run_id="r1", op_id="terminal1"))
        beat = copy.deepcopy(case["events"][-1]); beat.update(id="e-0000000000000009", lamport=9, ts=200000)
        beat["op"]["op_id"] = "terminalbeat"
        case["events"] += [terminal, beat]; case["now"] = 200001
        self.install(case)
        worker = next(r for r in self.inventory()["agents"] if r["agent"] == "worker")
        self.assertEqual(worker["state"], "failed")

    def test_m9_mcp_documents_agents_list(self):
        text = (ROOT / "docs/MCP.md").read_text()
        self.assertTrue("agents_list" in text, "M9 MCP inventory documentation absent")

    def test_m9_hooks_document_both_parent_fields(self):
        text = (ROOT / "docs/HARNESS_HOOKS.md").read_text()
        self.assertTrue("parent_agent" in text, "M9 parent_agent documentation absent")
        self.assertTrue("parent_run_id" in text, "M9 parent_run_id documentation absent")

    def test_m9_hooks_remove_stale_bootstrap_claim(self):
        text = " ".join((ROOT / "docs/HARNESS_HOOKS.md").read_text().split())
        self.assertFalse("a lifecycle invocation never creates a room" in text, "M9 stale bootstrap note remains")
        self.assertFalse("room must already exist" in text, "M9 stale bootstrap precondition remains")
