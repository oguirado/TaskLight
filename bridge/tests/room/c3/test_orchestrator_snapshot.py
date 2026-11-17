"""C3 M1-M8, exercised through registered transports with fixed clocks."""
import builtins
import copy
import json
from unittest import mock

from bridge.room import app
from .support import (C2, MARKER, RAW, ROOT, SECRET, SECTIONS, STATES,
                      SnapshotCase, compact, emit, kind, mentions, strings, unwrap)


class TransportOracle(SnapshotCase):
    def test_m1_discovery_exposes_current_request_contract(self):
        reply = self.rpc("tools/list", {})
        self.assertNotIn("error", reply)
        tools = [t for t in reply["result"]["tools"] if t["name"] == "orchestrator_snapshot"]
        self.assertEqual(len(tools), 1, "M1 MCP tools/list must advertise orchestrator_snapshot")
        schema = tools[0]["inputSchema"]
        self.assertEqual(schema["type"], "object")
        self.assertEqual(set(schema["required"]), {"room"})
        self.assertTrue({"room", "now", "since", "max_bytes"} <= schema["properties"].keys())
        # A-C3b: discovery and the handler share the amended byte default.
        self.assertEqual(schema["properties"]["max_bytes"]["default"], 16384)

    def test_m1_cli_and_mcp_json_parity(self):
        self.life(harness="codex")
        args = dict(room="demo", now=self.now, since=0, max_bytes=8192)
        result, expected = self.call(**args)
        self.assertFalse(result.get("isError", False), "M1 valid MCP snapshot must succeed")
        before = self.path.read_bytes()
        rc, out, err = self.run_cli(args)
        self.assertEqual(rc, 0, "M1 existing CLI call must dispatch C3: " + err)
        self.assertEqual(json.loads(out), expected)
        self.assertEqual(self.path.read_bytes(), before)

    def test_m1_optional_clock_uses_the_same_captured_now(self):
        self.life()
        expected, _ = self.snapshot()
        self.contract(expected)
        result, payload = self.call(room="demo")
        self.assertFalse(result.get("isError", False), "M1 now must be optional")
        self.assertEqual(unwrap(payload), expected)

    def test_m1_no_tokenizer_dependency(self):
        self.advertised()
        original = builtins.__import__

        def stdlib_only(name, *args, **kwargs):
            self.assertNotEqual(name.split(".")[0], "tiktoken", "C3 byte budgeting must need no tokenizer")
            return original(name, *args, **kwargs)

        with mock.patch.object(builtins, "__import__", side_effect=stdlib_only):
            self.snapshot()

    def test_m2_empty_existing_journal_is_a_complete_current_snapshot(self):
        data, _ = self.snapshot()
        self.contract(data)
        self.assertEqual(data["head_lamport"], 0)
        self.assertEqual(data["agents"]["totals"]["total"], 0)
        self.assertEqual(data["agents"]["rows"], [])
        self.assertEqual(data["freshness"], "current")
        self.assertTrue(data["complete"])
        self.assertFalse(any(data["omitted"].values()))

    def test_m2_unavailable_storage_never_certifies_a_healthy_empty_room(self):
        self.advertised()
        self.path.unlink()
        result, payload = self.call(room="demo", now=self.now)
        if result.get("isError", False):
            self.assertFalse(unwrap(payload).get("ok", True))
        else:
            data = unwrap(payload)
            self.assertEqual(data["freshness"], "unavailable")
            self.assertFalse(data["complete"])
        self.assertFalse(self.path.exists(), "M7 reads may not create a missing journal")

    def test_m1_hostile_room_and_clock_are_rejected(self):
        self.advertised()
        for args in ({}, {"room": "../escape"}, {"room": 42},
                     {"room": "demo", "now": "tomorrow"},
                     {"room": "demo", "now": True}, {"room": "demo", "now": -1}):
            with self.subTest(args=args):
                self.assert_refusal(args)


class InventoryOracle(SnapshotCase):
    """Reuse C2's admitted histories and expected rows, not a new state reducer."""


def inventory_test(case):
    def check(self):
        self.fixture(case["name"])
        before = self.path.read_bytes()
        data, _ = self.snapshot(max_bytes=65536)
        self.contract(data)
        expected = case["expected"]
        # A-C3o: partial C2 cases have placeholder rows/totals; match C2's gate.
        if "membership_only" in case:
            self.assertEqual(sorted(r["agent"] for r in data["agents"]["rows"]),
                             sorted(case["membership_only"]))
        elif "state_only" in case:
            by_agent = {r["agent"]: r for r in data["agents"]["rows"]}
            for agent, fields in case["state_only"].items():
                self.assertIn(agent, by_agent)
                self.assertEqual(by_agent[agent]["state"], fields["state"])
        else:
            self.assertEqual(data["agents"]["totals"], expected["totals"])
            required = ("agent", "state", "parent", "harness", "current", "last_seen_lamport")
            self.assertEqual([{k: r[k] for k in required} for r in data["agents"]["rows"]],
                             [{k: r[k] for k in required} for r in expected["agents"]])
        self.assertEqual(data["head_lamport"], max((e["lamport"] for e in self.events), default=0))
        self.assertEqual(self.path.read_bytes(), before, "M7 C3 must not write back inventory")
    check.__doc__ = "M2/M5/M7 current C2 inventory: " + case["name"]
    return check


for _case in C2["cases"]:
    if "expected" in _case:
        setattr(InventoryOracle, "test_m2_c2_" + _case["name"], inventory_test(_case))


class AttentionOracle(SnapshotCase):
    def test_m2_failed_and_blocked_report_entities_and_blocker_owners(self):
        self.life(agent="upstream")
        self.life(agent="downstream")
        self.plan()
        upstream = self.task(owner="upstream")
        downstream = self.task(owner="downstream", deps=[upstream])
        self.life(agent="failed-worker", state="failed", reason="Synthetic failure")
        self.projection()
        data, _ = self.snapshot()
        self.assertEqual(kind(data["attention"][0]), "failed")
        self.assertTrue(mentions(data["attention"][0], "failed-worker"))
        blocked = [r for r in data["attention"] if kind(r) == "blocked" and mentions(r, downstream)]
        self.assertTrue(blocked, "M2 unmet dependency must be attention even while task is pending")
        self.assertTrue(mentions(blocked, upstream), "M2 blocker task ID absent")
        self.assertTrue(mentions(blocked, "upstream"), "M2 blocker owner absent")
        self.assertTrue(mentions(blocked, "downstream"), "M2 blocked task owner absent")

    def test_m2_explicit_task_and_microtask_blocks_are_in_attention(self):
        self.plan()
        first = self.task(owner="worker")
        rev = self.projection()["tasks"][0]["rev"]
        self.op("task.set", task_id=first, base_rev=rev, state="blocked", reason="Needs review")
        second = self.task(owner="worker")
        self.op("micro.set", agent="worker", micro_id=second + ".M01", state="blocked")
        self.projection()
        data, _ = self.snapshot()
        blocked = [r for r in data["attention"] if kind(r) == "blocked"]
        self.assertTrue(mentions(blocked, first))
        self.assertTrue(mentions(blocked, second))
        self.assertTrue(mentions(blocked, "worker"))

    def test_m2_stale_or_unknown_with_work_needs_attention(self):
        self.fixture("working_becomes_unknown_not_finished")
        data, _ = self.snapshot()
        rows = [r for r in data["attention"] if kind(r) in ("stale", "unknown")]
        self.assertTrue(mentions(rows, "worker"), "M2 stale owner must remain visible")
        self.assertEqual(data["agents"]["rows"][0]["state"], "unknown")
        self.assertEqual(data["freshness"], "stale")

    def test_m2_unknown_without_work_does_not_create_work_attention(self):
        self.fixture("stale_alive_is_unknown")
        data, _ = self.snapshot()
        self.assertFalse([r for r in data["attention"] if kind(r) in ("stale", "unknown")])

    def test_m2_unaddressed_and_unanswered_questions_but_not_answered(self):
        unaddressed = self.event(agent="asker", act="question", text="Who owns this?")
        acked = self.event(agent="asker", act="question", text="Please review", to="worker")
        self.event(agent="worker", act="ack", re=acked["id"], text="Seen")
        answered = self.event(agent="asker", act="question", text="Resolved?", to="worker")
        ack = self.event(agent="worker", act="ack", re=answered["id"], text="Seen")
        self.event(agent="worker", act="answer", re=ack["id"], text="Resolved")
        self.projection()
        data, _ = self.snapshot()
        questions = [r for r in data["attention"] if kind(r) in ("question", "open_question")]
        self.assertTrue(mentions(questions, unaddressed["id"]))
        self.assertTrue(mentions(questions, acked["id"]), "M2 acknowledgement alone is not an answer")
        self.assertFalse(mentions(questions, answered["id"]), "answered chain must leave attention")

    def test_m2_missing_evidence_in_a_partially_completed_task(self):
        self.template["task_types"][0]["evidence_required"] = True
        self.install_template(self.template)
        self.plan()
        task = self.task(owner="worker", micros=2)
        self.op("micro.set", agent="worker", micro_id=task + ".M01", state="done", outcome="Checked")
        self.assertEqual(self.projection()["tasks"][0]["state"], "active")
        data, _ = self.snapshot()
        missing = [r for r in data["attention"] if kind(r) in ("evidence_missing", "missing_evidence")]
        self.assertTrue(mentions(missing, task + ".M01"))
        self.assertTrue(mentions(missing, "worker"))

    def test_m2_optional_evidence_does_not_create_false_attention(self):
        self.plan()
        task = self.task(owner="worker")
        self.op("micro.set", agent="worker", micro_id=task + ".M01", state="done")
        self.projection()
        data, _ = self.snapshot()
        self.assertFalse([r for r in data["attention"] if kind(r) in ("evidence_missing", "missing_evidence")])

    def test_m2_available_work_is_ready_and_stably_sorted(self):
        self.plan()
        ready = self.task()
        blocked_dep = self.task(deps=[ready])
        explicit = self.task()
        rev = self.projection()["tasks"][-1]["rev"]
        self.op("task.set", task_id=explicit, base_rev=rev, state="blocked", reason="Review")
        finished = self.task(owner="worker")
        self.op("micro.set", agent="worker", micro_id=finished + ".M01", state="done")
        ready2 = self.task()
        cancelled = self.task()
        rev = self.projection()["tasks"][-1]["rev"]
        self.op("task.set", task_id=cancelled, base_rev=rev, state="cancelled")
        self.projection()
        data, _ = self.snapshot()
        work = data["available_work"]
        self.assertEqual(len(work), 2)
        self.assertTrue(mentions(work[0], ready))
        self.assertTrue(mentions(work[1], ready2))
        for excluded in (blocked_dep, explicit, finished, cancelled):
            self.assertFalse(mentions(work, excluded))

    def test_m5_attention_order_is_urgency_then_lamport(self):
        self.plan()
        self.template["task_types"][0]["evidence_required"] = True
        self.install_template(self.template)
        # Reopen the fixture from scratch with the generation's matching hash.
        self.events = []
        self.plan()
        task = self.task(owner="worker", micros=2)
        self.op("micro.set", agent="worker", micro_id=task + ".M01", state="done")
        question = self.event(agent="asker", act="question", text="Question")
        blocked = self.task(deps=[task])
        self.life(agent="zeta", state="failed", reason="First failure")
        self.life(agent="alpha", state="failed", reason="Second failure")
        self.projection()
        data, _ = self.snapshot()
        attention = data["attention"]
        ranks = {"failed": 0, "blocked": 1, "stale": 2, "unknown": 2,
                 "question": 3, "open_question": 3, "evidence_missing": 4, "missing_evidence": 4}
        values = [ranks[kind(row)] for row in attention]
        self.assertEqual(values, sorted(values))
        failed = [r for r in attention if kind(r) == "failed"]
        self.assertEqual(len(failed), 2)
        self.assertTrue(mentions(failed[0], "zeta"), "Lamport takes precedence over alphabetical agent order")
        self.assertTrue(mentions(failed[1], "alpha"))
        self.assertTrue(mentions(attention, blocked))
        self.assertTrue(mentions(attention, question["id"]))


class SinceOracle(SnapshotCase):
    def test_m3_completions_are_strictly_after_since_and_inventory_is_current(self):
        self.life(agent="worker")
        self.plan()
        task = self.task(owner="worker", micros=2)
        first = self.op("micro.set", agent="worker", micro_id=task + ".M01", state="done")
        boundary = first["lamport"]
        second = self.op("micro.set", agent="worker", micro_id=task + ".M02", state="done")
        self.life(agent="new-agent", parent_agent="worker", parent_run_id="r1", harness="codex")
        self.projection()
        data, _ = self.snapshot(since=boundary)
        self.contract(data)
        self.assertFalse(mentions(data["completed_since"], task + ".M01"), "M3 since is exclusive")
        self.assertTrue(mentions(data["completed_since"], task + ".M02"))
        self.assertTrue(mentions(data["completed_since"], task), "M2 derived task completion absent")
        self.assertEqual(len(data["completed_since"]), 2)
        full, _ = self.snapshot()
        self.assertEqual(data["agents"], full["agents"], "M3 inventory is never a historical projection")
        self.assertEqual(data["head_lamport"], len(self.events))
        self.assertGreater(data["cursor"], second["lamport"])

    def test_m3_since_head_has_no_completions_or_old_attention(self):
        self.life(agent="worker", state="failed", reason="Already observed")
        self.event(agent="asker", act="question", text="Already observed")
        data, _ = self.snapshot(since=len(self.events))
        self.assertEqual(data["completed_since"], [])
        self.assertEqual(data["attention"], [])
        self.assertEqual(data["agents"]["totals"]["failed"], 1)

    def test_m3_attention_changes_exclude_old_failures_and_include_new_blocks(self):
        self.life(agent="old-failure", state="failed", reason="Old")
        self.plan()
        task = self.task()
        boundary = len(self.events)
        rev = self.projection()["tasks"][0]["rev"]
        self.op("task.set", task_id=task, base_rev=rev, state="blocked", reason="New block")
        data, _ = self.snapshot(since=boundary)
        self.assertFalse(mentions(data["attention"], "old-failure"))
        self.assertTrue(mentions(data["attention"], task))
        self.assertEqual(data["agents"]["totals"]["failed"], 1)

    def test_m3_repeated_done_and_idempotent_operations_are_not_new_completions(self):
        self.plan()
        task = self.task(owner="worker")
        self.op("micro.set", agent="worker", micro_id=task + ".M01", state="done", op_id="finish-once")
        self.op("micro.set", agent="worker", micro_id=task + ".M01", state="done", op_id="finish-once")
        self.op("micro.set", agent="worker", micro_id=task + ".M01", state="done", op_id="finish-twice")
        self.projection()
        data, _ = self.snapshot(since=0)
        self.assertEqual(len(data["completed_since"]), 2, "M2 only transitions into done are completions")
        data, _ = self.snapshot(since=3)
        self.assertEqual(data["completed_since"], [])

    def test_m3_completion_survives_later_reopening(self):
        self.plan()
        task = self.task(owner="worker")
        done = self.op("micro.set", agent="worker", micro_id=task + ".M01", state="done")
        self.op("micro.set", agent="worker", micro_id=task + ".M01", state="pending")
        self.projection()
        data, _ = self.snapshot(since=done["lamport"] - 1)
        self.assertTrue(mentions(data["completed_since"], task + ".M01"))
        self.assertTrue(mentions(data["completed_since"], task))
        self.assertEqual(len(data["completed_since"]), 2)

    def test_m3_invalid_since_types_do_not_coerce(self):
        self.advertised()
        for since in (-1, True, 1.5, "0", [], {}):
            with self.subTest(since=since):
                self.assert_refusal(dict(room="demo", since=since))


class BudgetOracle(SnapshotCase):
    def seed_pressure(self):
        for index in range(12):
            self.life(agent=f"worker-{index:02d}", state="finished" if index < 6 else "deployed",
                      harness="codex")
        self.life(agent="urgent-failure", state="failed", reason="Needs operator")
        self.plan()
        for index in range(5):
            task = self.task(owner="worker-06", title="Work " + str(index))
            if index < 3:
                self.op("micro.set", agent="worker-06", micro_id=task + ".M01", state="done")
        blocked = self.task(owner="worker-07")
        rev = self.projection()["tasks"][-1]["rev"]
        self.op("task.set", task_id=blocked, base_rev=rev, state="blocked", reason="Review")
        for index in range(8):
            self.event(agent="asker", act="question", text="Question " + str(index) + " café 漢字 " * 5)
        self.projection()

    def assert_budget(self, data, payload, budget):
        self.contract(data)
        self.assertLessEqual(len(compact(payload).encode("utf-8")), budget, "M4 count compact UTF-8 bytes including envelope")

    def test_m4_default_budget_is_16384_bytes(self):
        # A-C3b: the default request must equal an explicit amended budget.
        self.seed_pressure()
        for index in range(13, 50):
            self.life(agent=f"worker-{index:02d}", harness="codex")
        default, payload = self.snapshot()
        explicit, _ = self.snapshot(max_bytes=16384)
        self.assertEqual(default, explicit)
        self.assertEqual(default["agents"]["totals"]["total"], 50)
        self.assertGreater(len(compact(payload).encode("utf-8")), 8192)
        self.assertTrue(default["complete"])
        self.assertFalse(any(default["omitted"].values()))
        self.assert_budget(default, payload, 16384)

    def test_m4_minimum_and_maximum_budgets_are_accepted(self):
        self.advertised()
        for budget in (1024, 65536):
            with self.subTest(budget=budget):
                data, payload = self.snapshot(max_bytes=budget)
                self.assert_budget(data, payload, budget)

    def test_m4_out_of_range_or_noninteger_budgets_are_rejected(self):
        self.advertised()
        for budget in (1023, 65537, 0, -1, True, 1024.5, "8192", None):
            with self.subTest(budget=budget):
                self.assert_refusal(dict(room="demo", max_bytes=budget))

    def test_m4_first_trim_is_completions_and_omissions_are_exact(self):
        self.seed_pressure()
        full, payload = self.snapshot(max_bytes=65536)
        self.assertTrue(full["completed_since"], "pressure fixture must include completion rows")
        budget = len(compact(payload).encode("utf-8")) - 1
        self.assertGreaterEqual(budget, 1024)
        data, packed = self.snapshot(max_bytes=budget)
        self.assert_budget(data, packed, budget)
        self.assertGreater(data["omitted"]["completed_since"], 0)
        for section in ("available_work", "attention", "agents"):
            self.assertEqual(data["omitted"][section], 0)
        self.assertEqual(data["omitted"]["completed_since"], len(full["completed_since"]) - len(data["completed_since"]))
        self.assertEqual(data["agents"], full["agents"])
        self.assertEqual(data["attention"], full["attention"])
        self.assertEqual(data["available_work"], full["available_work"])

    def test_m4_all_trim_stages_preserve_totals_and_urgent_attention(self):
        self.seed_pressure()
        full, payload = self.snapshot(max_bytes=65536)
        urgent = [r for r in full["attention"] if kind(r) in ("failed", "blocked")]
        self.assertEqual(len(urgent), 2, "pressure fixture must exercise both protected classes")
        candidate = copy.deepcopy(payload)
        reference = unwrap(candidate)
        budgets = []
        # Expected retained sets specify the observable priority contract.
        for section in ("completed_since", "available_work", "attention", "agents"):
            if section == "attention":
                removed = len(reference[section]) - len(urgent)
                reference[section] = urgent
            elif section == "agents":
                rows = reference["agents"]["rows"]
                removed = sum(r["state"] == "finished" for r in rows)
                reference["agents"]["rows"] = [r for r in rows if r["state"] != "finished"]
            else:
                removed = len(reference[section])
                reference[section] = []
            reference["omitted"][section] = removed
            reference["complete"] = False
            budgets.append(max(1024, len(compact(candidate).encode("utf-8"))))
        seen = set()
        for budget in budgets:
            with self.subTest(budget=budget):
                data, packed = self.snapshot(max_bytes=budget)
                self.assert_budget(data, packed, budget)
                self.assertEqual(data["agents"]["totals"], full["agents"]["totals"])
                self.assertEqual([r for r in data["attention"] if kind(r) in ("failed", "blocked")], urgent)
                for section in ("completed_since", "available_work", "attention"):
                    self.assertEqual(data["omitted"][section], len(full[section]) - len(data[section]))
                    if data["omitted"][section]:
                        seen.add(section)
                removed_agents = [r for r in full["agents"]["rows"] if r not in data["agents"]["rows"]]
                self.assertEqual(data["omitted"]["agents"], len(removed_agents))
                self.assertTrue(all(r["state"] == "finished" for r in removed_agents))
                if removed_agents:
                    seen.add("agents")
                    self.assertEqual([r for r in data["attention"] if kind(r) not in ("failed", "blocked")], [])
                if data["omitted"]["attention"]:
                    self.assertEqual(data["available_work"], [])
                if data["omitted"]["available_work"]:
                    self.assertEqual(data["completed_since"], [])
        self.assertEqual(seen, set(SECTIONS), "pressure must actually exercise every trimming stage")

    def test_m4_utf8_multibyte_payload_obeys_byte_budget(self):
        for index in range(10):
            self.event(agent="asker", act="question", text="Question " + str(index) + " 漢字 café " * 16)
        data, payload = self.snapshot(max_bytes=1024)
        self.assert_budget(data, payload, 1024)
        self.assertGreater(data["omitted"]["attention"], 0)
        self.assertFalse(data["complete"])

    def test_m4_impossible_urgent_budget_refuses_without_trimming_urgent_rows(self):
        self.advertised()
        for index in range(12):
            self.life(agent=f"failed-{index:02d}", state="failed", reason="Requires review " * 5)
        full, _ = self.snapshot(max_bytes=65536)
        self.assertEqual(len([r for r in full["attention"] if kind(r) == "failed"]), 12)
        self.assertGreater(len(compact(full).encode("utf-8")), 1024)
        before = self.path.read_bytes()
        result, payload = self.call(room="demo", now=self.now, max_bytes=1024)
        self.assertTrue(result.get("isError", False), "M4 impossible protected set must fail, not drop failures or totals")
        self.assertFalse(unwrap(payload).get("ok", True))
        self.assertEqual(self.path.read_bytes(), before)


class SafetyAndDocsOracle(SnapshotCase):
    def test_m5_identical_requests_are_byte_identical(self):
        self.fixture("tree_first_seen_order")
        first = self.rpc("tools/call", dict(name="orchestrator_snapshot", arguments=dict(room="demo", now=self.now)))
        self.assertNotIn("error", first)
        self.assertFalse(first["result"].get("isError", False), "M1 valid snapshot must dispatch")
        for _ in range(3):
            self.assertEqual(self.rpc("tools/call", dict(name="orchestrator_snapshot", arguments=dict(room="demo", now=self.now))), first)

    def test_m5_replay_iteration_order_does_not_change_snapshot(self):
        self.fixture("tree_first_seen_order")
        first, _ = self.snapshot()
        self.events.reverse()
        self.flush()
        self.assertEqual(self.snapshot()[0], first)

    def test_m6_free_text_is_redacted_on_both_transports(self):
        self.life(harness=SECRET)
        self.life(agent="failed-agent", state="failed", reason=SECRET)
        self.plan()
        task = self.task(title=SECRET)
        rev = self.projection()["tasks"][0]["rev"]
        self.op("task.set", task_id=task, base_rev=rev, state="blocked", reason=SECRET)
        self.event(agent="asker", act="question", text=SECRET)
        self.projection()
        before = self.path.read_bytes()
        self.assertIn(RAW.encode(), before)
        for since in (None, 0):
            args = dict(room="demo", now=self.now)
            if since is not None:
                args["since"] = since
            result, payload = self.call(**args)
            self.assertFalse(result.get("isError", False), "M6 valid redacted read must succeed")
            wire = compact(payload)
            self.assertNotIn(RAW, wire)
            self.assertIn(MARKER, wire, "M6 use the exact shared sanitizer marker")
            rc, out, err = self.run_cli(args)
            self.assertEqual(rc, 0)
            self.assertNotIn(RAW, out + err)
            self.assertEqual(json.loads(out), payload)
        self.assertEqual(self.path.read_bytes(), before)

    def test_m6_clean_text_and_structural_agent_ids_keep_bytes(self):
        agent = "abcdefghijklmnop0123456789qrstuvwx"
        harness = "Clean café 漢字"
        self.life(agent=agent, harness=harness, parent_agent="parent", parent_run_id="p1")
        data, _ = self.snapshot()
        self.assertEqual(data["agents"]["rows"][0]["agent"], agent)
        self.assertEqual(data["agents"]["rows"][0]["harness"], harness)
        self.assertEqual(data["agents"]["rows"][0]["parent"], {"agent": "parent", "run_id": "p1"})

    def test_m6_sanitizer_exception_refuses_mcp_and_cli_without_raw_fallback(self):
        self.life(harness=SECRET)
        before = self.path.read_bytes()
        with self.broken_sanitizer():
            result, payload = self.call(room="demo", now=self.now)
            self.assertTrue(result.get("isError", False), "M6 sanitizer failure must stop serialization")
            self.assertNotIn(RAW, compact(payload))
            rc, out, err = self.run_cli(dict(room="demo", now=self.now))
            self.assertNotEqual(rc, 0, "M6 sanitizer failure must make CLI fail")
            self.assertNotIn(RAW, out + err)
        self.assertEqual(self.path.read_bytes(), before)

    def test_m7_full_delta_and_trimmed_reads_leave_journal_bytes_identical(self):
        self.fixture("working_current_and_counts")
        before = self.path.read_bytes()
        for args in ({}, {"since": 0}, {"since": len(self.events)}, {"max_bytes": 65536}):
            self.snapshot(**args)
            self.assertEqual(self.path.read_bytes(), before)
        self.assert_refusal(dict(room="demo", max_bytes=1023))

    def test_m8_documented_call_fields_budget_since_loop_and_example(self):
        path = ROOT / "docs/ORCHESTRATOR.md"
        self.assertTrue(path.is_file(), "M8 docs/ORCHESTRATOR.md is missing")
        text = path.read_text(encoding="utf-8")
        self.assertLessEqual(len(text.splitlines()), 120)
        for term in ("orchestrator_snapshot", "call", "max_bytes", "since", "cursor",
                     "head_lamport", "generated_at", "freshness", "complete", "agents",
                     "attention", "available_work", "completed_since", "omitted"):
            self.assertIn(term, text, "M8 missing documented contract term: " + term)
        normalized = text.lower().replace(",", "").replace("_", "")
        # A-C3b: document the amended default and unchanged legal bounds.
        for decimal, kib in (("16384", "16 kib"), ("1024", "1 kib"), ("65536", "64 kib")):
            self.assertTrue(decimal in normalized or kib in normalized,
                            "M8 budget limits must be documented in bytes or KiB")
        self.assertRegex(text, r"call\s+orchestrator_snapshot", "M8 call example is required")

    def test_legacy_shared_sanitizer_preserves_safe_ids_hashes_and_evidence(self):
        identity = "abcdefghijklmnop0123456789qrstuvwx"
        pointer = "evidence/project-name-long-abcdefghijklmnop0123456789qrstuvwx/proof.txt"
        digest = "a" * 64
        output = emit.sanitize_output(dict(agent=identity, hash=digest,
                                          evidence=[dict(path=pointer, sha256=digest)], text=SECRET))
        self.assertEqual(output["agent"], identity)
        self.assertEqual(output["hash"], digest)
        self.assertEqual(output["evidence"], [dict(path=pointer, sha256=digest)])
        self.assertEqual(output["text"], MARKER)
