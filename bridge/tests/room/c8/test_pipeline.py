"""Fail-first acceptance for the first C8 slice."""

from bridge.plan.template import load_template

from .support import (
    ORCHESTRATOR, ROOT, STEPS, TASK, TEMPLATE_ID, PipelineRoom,
    attempt_rows, history_values,
)


BINDING_DETAIL = (
    r"(?is)(?:current.*bind|bind.*current|(?:result|reference|match).*bound|"
    r"bound.*(?:result|reference|match|step)|step.*binding)"
)


class PipelineOracle(PipelineRoom):
    def test_m1_m7_published_starter_and_documented_loop(self):
        # Establish the documented gated workflow on the contract fixture
        # before checking that the shipped starter drives the same workflow.
        self.accepted("diagnosis", "documented-diagnosis")
        self.template_path.unlink()
        starter = load_template(str(ROOT / "templates/planning" / f"{TEMPLATE_ID}.json"))
        self.assertEqual(starter["id"], TEMPLATE_ID)
        self.assertEqual([task["id"] for task in starter["task_types"]], ["unit"])
        self.assertEqual(tuple(starter["task_types"][0]["micro_hints"]), STEPS)
        phase = starter["phases"][0]["id"]
        base = dict(room="published", agent=ORCHESTRATOR)
        brief = {field["id"]: "Verify unit creation" for field in starter["brief_fields"]
                 if field["required"]}
        self.call("plan_create", dict(
            base, op_id=self.op_id(), template_id=TEMPLATE_ID, title="Pipeline", brief=brief,
            tasks=[{"key": "first", "title": "First unit", "type": "unit", "phase": phase}],
        ))
        self.call("task_add", dict(
            base, op_id=self.op_id(), agent="other-orchestrator", title="Second unit",
            type="unit", phase=phase, accept="",
        ))
        tasks = self.call("plan_get", {"room": base["room"]})["tasks"]
        self.assertEqual([task["title"] for task in tasks], ["First unit", "Second unit"])
        for task, owner in zip(tasks, (ORCHESTRATOR, "other-orchestrator"), strict=True):
            self.assertEqual(task["type"], "unit")
            self.assertEqual(task["assignee"], owner)
            self.assertEqual(tuple(m["text"] for m in task["microtasks"]), STEPS)
            self.assertEqual({m["state"] for m in task["microtasks"]}, {"pending"})

        docs = (ROOT / "docs/PIPELINE.md").read_text(encoding="utf-8")
        self.assertRegex(docs, r"(?is)plan_create.*?(?:tasklight\s+run|\bwave\b)"
                              r".*?unit_bind.*?wait_agents.*?unit_decide")
        self.assertRegex(docs, r"(?is)(?:unit_repair.{0,500}\bhold\b|\bhold\b.{0,500}unit_repair)")
        self.assertRegex(docs, r"(?is)\b(?:verify.*?review|review.*?verify)\b")

    def test_m1_legacy_template_preserves_explicit_microtasks_and_assignment(self):
        room = "legacy"
        base = dict(room=room, agent=ORCHESTRATOR, type="task", phase="plan")
        self.call("plan_create", dict(
            room=room, agent=ORCHESTRATOR, template_id="blank", title="Legacy plan",
            brief={"goal": "Keep ordinary tasks unchanged"},
            tasks=[{"key": "legacy", "title": "Legacy task", "type": "task", "phase": "plan",
                    "assignee": "legacy-worker", "microtasks": [{"text": "Explicit work"}]}],
        ))
        self.call("task_add", dict(base, title="Ordinary add", accept=""))
        first, second = self.call("plan_get", {"room": room})["tasks"]
        self.assertEqual(first["assignee"], "legacy-worker")
        self.assertEqual([(m["text"], m["state"]) for m in first["microtasks"]],
                         [("Explicit work", "pending")])
        self.assertIsNone(second["assignee"])
        self.assertEqual(second["microtasks"], [])

    def test_m2_bind_through_registered_tool_and_attempt_uses_bind_lamport(self):
        run = self.deploy("first")
        self.lifecycle(run, "alive")
        before = self.events()
        self.bind("diagnosis", run)
        after = self.events()
        self.assertEqual(after[:-1], before)
        self.assertNotEqual(self.states()[0], "done")
        self.lifecycle(run, "finished", "OK")
        self.decide("diagnosis", run)
        next_run = self.deploy("next")
        self.call("unit_bind", self.step_args("spec", next_run))

        lamport = after[-1]["lamport"]
        rows = list(attempt_rows(self.projection()))
        self.assertTrue(any(lamport in list(history_values(row)) and run[1] in list(history_values(row))
                            for row in rows), "attempt history identifies the binding by its Lamport")

    def test_m2_out_of_order_step_stops_then_binds_after_predecessor(self):
        self.accepted("diagnosis", "diagnosis")
        oracle = self.deploy("oracle")
        self.assert_stops(lambda: self.bind("oracle", oracle))
        self.accepted("spec", "spec")
        self.bind("oracle", oracle)

    def test_m2_owner_registration_and_opening_fence_stop_invalid_binds(self):
        self.accepted("diagnosis", "owner-control")
        run = self.deploy("ready")
        elsewhere = ("elsewhere-worker", "elsewhere-run")
        self.call("agent_lifecycle", {
            "room": "elsewhere", "agent": elsewhere[0], "run_id": elsewhere[1],
            "state": "deployed", "op_id": self.op_id(),
        })
        terminal = self.deploy("done")
        self.lifecycle(terminal, "finished", "OK")
        for label, candidate, patch in (
            ("foreign orchestrator", run, {"agent": run[0]}),
            ("invalid actor syntax", run, {"agent": "<img src=x onerror=alert(1)>"}),
            ("unregistered run", (run[0], "unregistered"), {}),
            ("registered only in another room", elsewhere, {}),
            ("terminal run", terminal, {}),
            ("stale opening", run, {"expected_opened_lamport": 2}),
        ):
            with self.subTest(label=label):
                self.assert_stops(lambda: self.bind("spec", candidate, **patch))
        self.bind("spec", run)

    def test_m2_live_finished_undecided_and_accepted_bindings_cannot_be_replaced(self):
        original = self.deploy("original")
        replacement = self.deploy("replacement")
        self.bind("diagnosis", original)
        self.assert_stops(lambda: self.bind("diagnosis", replacement))
        self.lifecycle(original, "finished", "ADMIT")
        self.assert_stops(lambda: self.bind("diagnosis", replacement))
        self.decide("diagnosis", original)
        self.assert_stops(lambda: self.bind("diagnosis", replacement))
        self.bind("spec", replacement)

    def test_m2_run_is_consumed_once_even_if_repair_clears_its_live_binding(self):
        self.prefix(3)
        original = self.deploy("original-author")
        self.bind("author", original)
        self.repair()
        self.assert_stops(lambda: self.bind("author", original))
        self.accepted("author", "new-author")
        self.assert_stops(lambda: self.bind("verify", original))
        self.bind("verify", self.deploy("fresh-verifier"))

    def test_m3_finished_ok_and_admit_complete_only_on_the_single_decision_append(self):
        self.prefix(len(STEPS))
        self.assertEqual(self.states(), ("done",) * len(STEPS))

    def test_m3_failed_hold_missing_or_live_result_cannot_admit(self):
        self.accepted("diagnosis", "positive")
        seed = self.events()
        for index, (state, verdict) in enumerate((
            ("failed", "OK"), ("finished", "HOLD"), ("finished", "NO_PUDE"),
            ("finished", "FAIL"), ("finished", None), (None, None),
        )):
            with self.subTest(state=state, verdict=verdict):
                # A fresh seed avoids turning a rejected result into a test of
                # the preceding attempt's replacement conditions.
                self.install(seed)
                run = self.deploy(f"case-{index}")
                self.bind("spec", run)
                if state is not None:
                    self.lifecycle(run, state, verdict)
                self.assert_stops(lambda: self.decide("spec", run))
                self.assertNotEqual(self.states()[1], "done")
        self.install(seed)
        self.accepted("spec", "positive-spec")

    def test_m2_m3_failed_and_hold_reject_attempts_require_fresh_bindings(self):
        failed = self.deploy("failed")
        self.bind("diagnosis", failed)
        self.lifecycle(failed, "failed", "FAIL")
        for verdict in ("HOLD", "REJECT"):
            run = self.deploy(verdict.lower())
            self.bind("diagnosis", run)
            self.lifecycle(run, "finished", "OK")
            self.decide("diagnosis", run, verdict)
            self.assertNotEqual(self.states()[0], "done")
            self.assert_stops(lambda: self.decide("diagnosis", run))
        self.accepted("diagnosis", "retry")

    def test_m3_wrong_or_superseded_source_is_bad_op_with_binding_detail(self):
        original = self.deploy("superseded")
        self.bind("diagnosis", original)
        self.lifecycle(original, "finished", "OK")
        self.decide("diagnosis", original, "HOLD")
        current = self.deploy("current")
        self.bind("diagnosis", current)
        self.assert_stops(lambda: self.decide("diagnosis", original), "bad_op", BINDING_DETAIL)
        self.assert_stops(lambda: self.decide("diagnosis", (original[0], current[1])),
                          "bad_op", BINDING_DETAIL)
        self.assert_stops(lambda: self.decide("diagnosis", (current[0], original[1])),
                          "bad_op", BINDING_DETAIL)
        self.lifecycle(current, "finished", "OK")
        self.decide("diagnosis", current)
        self.assertEqual(self.states()[0], "done")

    def test_m4_repair_stops_before_author_or_with_foreign_actor_and_invalid_reason(self):
        self.assert_stops(self.repair)
        self.prefix(3)
        self.bind("author", self.deploy("author"))
        for label, reason, patch in (
            ("foreign", "Valid reason", {"agent": "another-agent"}),
            ("stale", "Valid reason", {"expected_opened_lamport": 2}),
            ("empty", "", {}),
            ("oversized", "x" * 241, {}),
        ):
            with self.subTest(label=label):
                self.assert_stops(lambda: self.repair(reason, **patch))
        self.repair("x")
        self.call("unit_repair", self.unit_args(reason="x" * 240))

    def test_m4_repair_rolls_back_suffix_preserves_attempts_and_can_repeat(self):
        self.prefix(len(STEPS))
        old_events = self.events()
        decisions = [event for event in old_events if event["op"]["kind"] == "unit.decision"]
        self.assertEqual(len(decisions), len(STEPS))
        self.assert_historical_decisions(decisions)

        worker = self.deploy("waiting-review")
        self.repair()
        self.assertEqual(self.states(), ("done",) * 3 + ("pending",) * 4)
        self.assertEqual(self.events()[:len(old_events)], old_events)
        self.assert_stops(lambda: self.bind("review", worker))
        stale_author = ("worker-first-author", "run-first-author")
        self.assert_stops(lambda: self.decide("author", stale_author), "bad_op",
                          BINDING_DETAIL)
        self.accepted("author", "second-author")
        self.repair()
        self.assertEqual(self.states(), ("done",) * 3 + ("pending",) * 4)
        self.assert_historical_decisions(decisions)
        self.bind("author", self.deploy("third-author"))
        self.assertEqual(self.task()["id"], TASK)

    def assert_historical_decisions(self, decisions):
        rows = [list(history_values(row)) for row in attempt_rows(self.projection())]
        self.assertGreaterEqual(len(rows), len(decisions))
        for event in decisions:
            op = event["op"]
            self.assertTrue(any(
                op["result_run_id"] in row and any(
                    identity in row for identity in (event["lamport"], op["op_id"], op["reason"])
                ) for row in rows
            ), f"the binding and decision for {op['micro_id']} survive in attempt history")
