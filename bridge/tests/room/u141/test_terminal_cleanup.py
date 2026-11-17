"""U141 fail-first transport parity, replay, receipts, and safety contracts."""
import copy
import os
from unittest import mock

from bridge.room import app
from .support import TerminalCase, TERMINALS, TRANSPORTS


class TerminalCleanupOracle(TerminalCase):
    def test_negative_lifecycle_only_handler_is_rejected_by_release_oracle(self):
        before = self.seed()
        # Execute the real lifecycle persistence primitive while deliberately omitting cleanup.
        # This mutation is in memory only and is restored before leaving this test.
        from bridge.room.ext import lifecycle

        def lifecycle_only(args):
            op = {k: v for k, v in args.items() if k not in {"room", "agent"}}
            op["kind"] = "agent.lifecycle"
            return lifecycle._commit(args["room"], args["agent"], op)

        with mock.patch.dict(app.V2_DISPATCH, {"agent_lifecycle": lifecycle_only}):
            self.terminal("mcp", "failed")
        with self.assertRaisesRegex(AssertionError, "terminal cleanup left eligible work claimed"):
            self.assert_released(before)


def bootstrap_case(state):
    def test(self):
        outcomes = {}
        for transport in TRANSPORTS:
            fresh = self.home / transport
            fresh.mkdir()
            with mock.patch.dict(os.environ, {"CW_HOME": str(fresh)}):
                result = self.deliver(transport, state, identity="bootstrap-0001")
                events = self.events()
                self.assertFalse(any(e.get("op", {}).get("kind") == "plan.open" for e in events))
                outcomes[transport] = (result.get("ok") is True, self.room.is_dir(),
                    tuple(e.get("op", {}).get("kind") for e in events))
        self.assertEqual(len(set(outcomes.values())), 1,
                         "room bootstrap must use one policy through every transport: " + repr(outcomes))
    return test


def parity_case(transport, state):
    def test(self):
        before = self.seed()
        self.terminal(transport, state)
        after = self.assert_released(before)
        self.assertEqual(after["agent_lifecycle"]["exec-a"]["lifecycle"], state)
        self.assertEqual(after["agent_lifecycle"]["exec-a"]["run_id"], "run-old")
        releases = [e for e in self.events() if e.get("op", {}).get("kind") == "task.release"]
        self.assertEqual({e["op"]["task_id"] for e in releases}, self.eligible)
        self.assertEqual(len(releases), len(self.eligible), "each eligible claim is released once")
    return test


def receipt_case(transport, state):
    def test(self):
        self.seed()
        result = self.terminal(transport, state)
        self.assert_cleanup_receipt(result)
    return test


def replay_case(transport, state):
    def test(self):
        before = self.seed()
        first = self.terminal(transport, state)
        second = self.terminal(transport, state)
        self.assertEqual(second["lamport"], first["lamport"], "exact replay changed lifecycle identity")
        self.assert_released(before)
        stable = self.journal()
        self.terminal(transport, state)
        self.assertEqual(self.journal(), stable, "completed replay appended a new event")
        terminals = [e for e in self.events() if e.get("op", {}).get("kind") == "agent.lifecycle" and e["op"].get("state") == state]
        self.assertEqual(len(terminals), 1)
        releases = [e for e in self.events() if e.get("op", {}).get("kind") == "task.release"]
        self.assertEqual(len(releases), len(self.eligible))
    return test


def stale_run_case(transport, state):
    def test(self):
        self.seed()
        self.terminal(transport, state)
        # Explicit releases make this hostile setup independent of the missing cleanup.
        self.release_remaining()
        self.api("agent_lifecycle", state="deployed", run_id="run-successor")
        self.api("task_claim", task_id=self.ids["active"])
        self.api("task_claim", agent="other", task_id=self.ids["pending"])
        before = copy.deepcopy(self.projection())
        stable = self.journal()
        # Both a late exact retry and a previously unseen stale terminal must be safe.
        self.deliver(transport, state)
        self.deliver(transport, state, identity="late-terminal-0001")
        self.assertEqual(self.projection(), before, "stale terminal event changed successor claims or lifecycle")
        self.assertEqual(self.journal(), stable, "stale terminal event appended a mutation")
    return test


def crash_case(transport, state, after_release):
    def test(self):
        before = self.seed()
        self.interrupted_delivery(transport, state, after_release=after_release)
        prefix = self.journal()
        first = self.terminal(transport, state)
        self.assertTrue(self.journal().startswith(prefix), "recovery rewrote the committed prefix")
        self.assert_released(before)
        stable = self.journal()
        again = self.terminal(transport, state)
        self.assertEqual(again["lamport"], first["lamport"])
        self.assertEqual(self.journal(), stable, "replay duplicated cleanup after crash recovery")
        terminals = [e for e in self.events() if e.get("op", {}).get("kind") == "agent.lifecycle" and e["op"].get("state") == state]
        releases = [e for e in self.events() if e.get("op", {}).get("kind") == "task.release"]
        self.assertEqual(len(terminals), 1)
        self.assertEqual(len(releases), len(self.eligible))
    return test


def no_plan_case(transport, state):
    def test(self):
        self.room.mkdir(parents=True)
        self.api("agent_lifecycle", state="deployed", run_id="run-old")
        self.terminal(transport, state)
        self.assertFalse(any(e.get("op", {}).get("kind") in {"plan.open", "task.release"} for e in self.events()))
        stable = self.journal()
        self.terminal(transport, state)
        self.assertEqual(self.journal(), stable, "no-plan replay must stay harmless")
    return test


def nonterminal_case(transport, state):
    def test(self):
        before = self.seed()
        self.terminal(transport, state, identity="nonterminal-0001")
        self.assertEqual(self.projection()["tasks"], before["tasks"], "nonterminal event performed cleanup")
        self.assertFalse(any(e.get("op", {}).get("kind") == "task.release" for e in self.events()))
    return test


def newer_plan_case(transport, state):
    def test(self):
        self.seed()
        self.terminal(transport, state)
        for task in self.projection()["tasks"]:
            if task["state"] not in ("done", "cancelled"):
                self.api("task_update", agent=task["assignee"] or "exec-a", task_id=task["id"], base_rev=task["rev"], state="cancelled")
        self.api("plan_close", base_rev=self.projection()["plan"]["rev"], outcome="Replace fixture")
        self.api("plan_create", template_id="blank", title="New generation", brief={"goal": "Preserve successor work"}, strict=False,
                 tasks=[dict(key="replacement", title="Replacement", type="task", phase="execute", accept="Keep", deps=[], microtasks=[{"text": "Keep"}])])
        # A-U158: successor work needs a new deployed run after a terminal event.
        self.api("agent_lifecycle", state="deployed", run_id="run-successor")
        self.api("task_claim", task_id="T01")
        before = self.projection()
        stable = self.journal()
        self.deliver(transport, state)
        self.assertEqual(self.projection(), before, "old cleanup crossed the plan-generation boundary")
        self.assertEqual(self.journal(), stable)
    return test


for _transport in TRANSPORTS:
    for _state in TERMINALS:
        for _name, _factory in (
            ("releases_eligible", parity_case),
            ("distinct_cleanup_receipt", receipt_case),
            ("exact_replay", replay_case),
            ("stale_run_preserves_successor", stale_run_case),
            ("no_plan_stop", no_plan_case),
            ("newer_plan_stop", newer_plan_case),
        ):
            setattr(TerminalCleanupOracle, "test_" + _name + "_" + _transport + "_" + _state, _factory(_transport, _state))
        for _after in (False, True):
            _name = "crash_after_release" if _after else "crash_after_lifecycle"
            setattr(TerminalCleanupOracle, "test_" + _name + "_" + _transport + "_" + _state, crash_case(_transport, _state, _after))
    for _state in ("deployed", "alive"):
        setattr(TerminalCleanupOracle, "test_nonterminal_preserves_work_" + _transport + "_" + _state, nonterminal_case(_transport, _state))

for _state in ("deployed", "alive", "failed", "finished"):
    setattr(TerminalCleanupOracle, "test_bootstrap_policy_" + _state, bootstrap_case(_state))
