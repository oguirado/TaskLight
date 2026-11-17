"""Behavioral U142 oracle against the real dispatcher and room journal."""
import copy
import itertools
import json
import os
from pathlib import Path
import secrets
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from bridge.plan import fold_plan
from bridge.room import _lock, app, store


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
ROOM = "u142"
AGENT = "executor-a"
RUN = "run-a"


class WorkIdentityOracle(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.scratch = Path(temporary.name)
        self.home = self.scratch / "cw"
        environment = {k: v for k, v in os.environ.items() if not k.startswith("CW_")}
        environment.update(CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        self.enterContext(patch.dict(os.environ, environment, clear=True))
        self.now = 1700000000000
        self.enterContext(patch.object(time, "time", side_effect=lambda: self.now / 1000))
        self.enterContext(patch.object(time, "sleep", side_effect=AssertionError("real sleep forbidden")))
        self.enterContext(patch.object(_lock, "time", SimpleNamespace(
            monotonic=lambda: 0.0,
            sleep=lambda delay: self.fail("unexpected lock contention"))))
        counter = itertools.count(1)
        self.enterContext(patch.object(secrets, "token_hex", side_effect=lambda n:
                                      format(next(counter), "0%dx" % (2 * n))))
        for target in ("socket.create_connection", "socket.socket.connect",
                       "socket.socket.connect_ex", "socket.socket.sendto"):
            self.enterContext(patch(target, side_effect=AssertionError("network forbidden")))
        template = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
        self.template = template
        self.templates = {template["id"]: template}
        directory = self.home / "templates"
        directory.mkdir(parents=True)
        (directory / (template["id"] + ".json")).write_text(json.dumps(template))
        self.proof = self.scratch / "proof.txt"
        self.proof.write_text("Verified fixture evidence\n")
        self.open_plan()
        self.add_task()

    def post(self, op, agent=AGENT):
        return store.post(ROOM, agent, "op", "", op=copy.deepcopy(op),
                          clock=lambda: self.now, templates=self.templates)

    def open_plan(self):
        self.post(dict(kind="plan.open", title="Identity fixture",
                       template_id=self.template["id"], template_hash=self.template["hash"],
                       brief={"goal": "Verify work identity"}, phase="start"))

    def add_task(self):
        self.post(dict(kind="task.add", title="Ready work", type="action", phase="start",
                       accept="Evidence verified", microtasks=[{"text": "Execute"}, {"text": "Verify"}]))

    def raw(self):
        return (self.home / "rooms" / ROOM / "events.jsonl").read_bytes()

    def projection(self):
        events = [json.loads(line) for line in self.raw().splitlines()]
        state = fold_plan(events, templates=self.templates)
        self.assertEqual(state["rejected"], [], "fixture or persisted operation rejected")
        return state

    def task(self):
        return self.projection()["tasks"][0]

    @property
    def generation(self):
        return self.projection()["plan"]["opened_lamport"]

    def call(self, tool, **args):
        return app.dispatch(tool, dict(room=ROOM, agent=AGENT, **args))["untrusted"]

    def succeeds(self, tool, **args):
        try:
            result = self.call(tool, **args)
        except store.RoomError as exc:
            self.fail("valid %s request refused: %s: %s" % (tool, exc.code, exc))
        self.assertIsInstance(result, dict)
        self.assertIsNot(result.get("ok"), False, result)
        return result

    def lifecycle(self, state, run_id=RUN):
        return self.succeeds("agent_lifecycle", state=state, run_id=run_id)

    def terminal(self, state):
        self.lifecycle("deployed")
        self.lifecycle(state)
        self.assertEqual(self.projection()["agent_lifecycle"][AGENT]["lifecycle"], state)

    def own_task(self):
        claim = self.post(dict(kind="task.claim", task_id=self.task()["id"]))["lamport"]
        self.post(dict(kind="micro.set", micro_id=self.task()["microtasks"][0]["id"], state="active"))
        return claim

    def report_args(self, **extra):
        task = self.task()
        args = dict(task_id=task["id"], claim_lamport=task["claim_lamport"],
                    done=[dict(id=task["microtasks"][0]["id"], outcome="Verified",
                               evidence=[str(self.proof)])])
        args.update(extra)
        return args

    def assert_acquired(self, result):
        self.assertIsInstance(result.get("task"), dict, "ready work was not acquired")
        self.assertEqual(result["task"]["id"], self.task()["id"])
        self.assertEqual(self.task()["assignee"], AGENT)
        self.assertEqual(result["claim_lamport"], self.task()["claim_lamport"])
        self.assertEqual(self.task()["microtasks"][0]["state"], "active")
        self.assertEqual(self.task()["microtasks"][1]["state"], "pending")

    def assert_reported(self, result, claim):
        self.assertIs(result.get("ok"), True)
        self.assertEqual(self.task()["claim_lamport"], claim)
        self.assertEqual(self.task()["microtasks"][0]["state"], "done")
        self.assertEqual(self.task()["microtasks"][1]["state"], "active")

    def assert_refused(self, tool, **args):
        before, state = self.raw(), copy.deepcopy(self.projection())
        properties = next(t for t in app.list_tools() if t["name"] == tool)["inputSchema"]["properties"]
        for field in ("run_id", "expected_opened_lamport"):
            if field in args:
                self.assertIn(field, properties,
                              "refusal cannot count while the tool lacks this identity field")
        try:
            result = self.call(tool, **args)
        except store.RoomError as exc:
            self.assertIsInstance(exc.code, str)
            self.assertTrue(exc.code, "refusal needs a defined error code")
            self.assertTrue(str(exc), "refusal needs an explanation")
        else:
            # The spec leaves the refusal code and representation open. A
            # structured error or an explicitly explained no-work result works.
            self.assertIsInstance(result, dict)
            denied = result.get("ok") is False or (
                "task" in result and result["task"] is None)
            explanation = any(value not in (None, "", [], {}) for key, value in result.items()
                              if key not in {"ok", "task", "items", "lamport", "beat_ts", "replayed"})
            self.assertTrue(denied and explanation,
                            "expected an explicit domain refusal; got %r" % result)
        self.assertEqual(self.raw(), before, "refused work appended journal bytes")
        self.assertEqual(self.projection(), state, "refused work changed folded state")

    def reopen(self):
        old = self.generation
        task = self.task()
        self.post(dict(kind="task.set", task_id=task["id"], base_rev=task["rev"], state="cancelled"))
        self.post(dict(kind="plan.close", base_rev=self.projection()["plan"]["rev"]))
        self.open_plan()
        self.add_task()
        self.assertGreater(self.generation, old, "fixture did not reopen the plan")
        return old

    # A1: Refusals cannot be masked by unsupported new arguments.
    def test_a01_failed_slug_cannot_acquire_legacy(self):
        self.terminal("failed")
        self.assert_refused("work_acquire", op_id="failed-acquire")

    def test_a01_finished_slug_cannot_acquire_legacy(self):
        self.terminal("finished")
        self.assert_refused("work_acquire", op_id="finished-acquire")

    def test_a01_failed_slug_cannot_report_legacy(self):
        self.terminal("failed")
        self.own_task()
        self.assert_refused("work_report", **self.report_args(op_id="failed-report"))

    def test_a01_finished_slug_cannot_report_legacy(self):
        self.terminal("finished")
        self.own_task()
        self.assert_refused("work_report", **self.report_args(op_id="finished-report"))

    def test_a01_failed_slug_cannot_acquire_with_identity(self):
        self.terminal("failed")
        self.assert_refused("work_acquire", run_id=RUN, expected_opened_lamport=self.generation)

    def test_a01_finished_slug_cannot_report_with_identity(self):
        self.terminal("finished")
        self.own_task()
        self.assert_refused("work_report", **self.report_args(
            run_id=RUN, expected_opened_lamport=self.generation))

    # A2: Accept each field independently as well as together.
    def test_a02_acquire_accepts_run_id(self):
        self.lifecycle("deployed")
        self.assert_acquired(self.succeeds("work_acquire", run_id=RUN))

    def test_a02_acquire_accepts_generation(self):
        self.lifecycle("deployed")
        self.assert_acquired(self.succeeds("work_acquire", expected_opened_lamport=self.generation))

    def test_a02_acquire_accepts_run_id_and_generation(self):
        self.lifecycle("deployed")
        self.assert_acquired(self.succeeds("work_acquire", run_id=RUN,
                                          expected_opened_lamport=self.generation))

    def test_a02_report_accepts_run_id(self):
        self.lifecycle("deployed")
        claim = self.own_task()
        self.assert_reported(self.succeeds("work_report", **self.report_args(run_id=RUN)), claim)

    def test_a02_report_accepts_generation(self):
        self.lifecycle("deployed")
        claim = self.own_task()
        self.assert_reported(self.succeeds("work_report", **self.report_args(
            expected_opened_lamport=self.generation)), claim)

    def test_a02_report_accepts_run_id_and_generation(self):
        self.lifecycle("deployed")
        claim = self.own_task()
        self.assert_reported(self.succeeds("work_report", **self.report_args(
            run_id=RUN, expected_opened_lamport=self.generation)), claim)

    # A3: Discovery must let a schema-following client send the new fields.
    def test_a03_acquire_discovery_declares_identity_fields(self):
        schema = next(t for t in app.list_tools() if t["name"] == "work_acquire")["inputSchema"]
        self.assertIn("run_id", schema["properties"])
        self.assertIn("expected_opened_lamport", schema["properties"])

    def test_a03_report_discovery_declares_identity_fields(self):
        schema = next(t for t in app.list_tools() if t["name"] == "work_report")["inputSchema"]
        self.assertIn("run_id", schema["properties"])
        self.assertIn("expected_opened_lamport", schema["properties"])

    # A4: Changing request text or sending alive cannot revive a terminal slug.
    def test_a04_same_run_deployed_does_not_revive_failed_slug(self):
        self.terminal("failed")
        # The lifecycle API may reject this repeat or acknowledge a no-op;
        # U142 only requires that it cannot reopen work admission.
        try:
            self.call("agent_lifecycle", state="deployed", run_id=RUN)
        except store.RoomError as exc:
            self.assertTrue(exc.code)
        self.assertEqual(self.projection()["agent_lifecycle"][AGENT]["lifecycle"], "failed")
        self.assert_refused("work_acquire")

    def test_a04_alive_does_not_revive_finished_slug(self):
        self.terminal("finished")
        self.lifecycle("alive")
        self.assertEqual(self.projection()["agent_lifecycle"][AGENT]["lifecycle"], "finished")
        self.assert_refused("work_acquire")

    def test_a04_new_request_run_without_deployment_is_refused(self):
        self.terminal("failed")
        self.assert_refused("work_acquire", run_id="run-b", expected_opened_lamport=self.generation)

    def test_a04_fresh_deployment_after_failed_allows_new_work(self):
        self.terminal("failed")
        self.lifecycle("deployed", run_id="run-b")
        record = self.projection()["agent_lifecycle"][AGENT]
        self.assertEqual((record["lifecycle"], record["run_id"]), ("deployed", "run-b"))
        self.assert_acquired(self.succeeds("work_acquire", run_id="run-b",
                                          expected_opened_lamport=self.generation))

    def test_a04_fresh_deployment_after_finished_allows_new_work(self):
        self.terminal("finished")
        self.lifecycle("deployed", run_id="run-b")
        self.assert_acquired(self.succeeds("work_acquire", run_id="run-b",
                                          expected_opened_lamport=self.generation))

    # A5: A correct claim epoch is insufficient when plan generation is stale.
    def test_a05_acquire_rejects_stale_generation_without_appends(self):
        self.lifecycle("deployed")
        stale = self.reopen()
        self.assert_refused("work_acquire", run_id=RUN, expected_opened_lamport=stale)

    def test_a05_report_rejects_stale_generation_with_correct_current_claim(self):
        self.lifecycle("deployed")
        stale = self.reopen()
        claim = self.own_task()
        args = self.report_args(run_id=RUN, expected_opened_lamport=stale)
        self.assertEqual(args["claim_lamport"], claim)
        self.assertEqual(args["claim_lamport"], self.task()["claim_lamport"])
        self.assertNotEqual(stale, self.generation)
        self.assertTrue(self.proof.is_file())
        self.assert_refused("work_report", **args)

    def test_a05_acquire_rejects_forged_future_generation(self):
        self.lifecycle("deployed")
        self.assert_refused("work_acquire", run_id=RUN, expected_opened_lamport=self.generation + 100)

    def test_a05_report_rejects_forged_future_generation(self):
        self.lifecycle("deployed")
        self.own_task()
        self.assert_refused("work_report", **self.report_args(
            run_id=RUN, expected_opened_lamport=self.generation + 100))

    def assert_mismatched_beat_is_explicit(self, mismatched_run):
        # Compare with an actual accepted receipt; do not prescribe new status
        # names, error codes, fold internals, or persistence of ignored beats.
        good = self.succeeds("activity_beat", task_id=self.task()["id"], run_id=RUN,
                             op_id="matching-beat")
        before_tasks = copy.deepcopy(self.projection()["tasks"])
        before_lifecycle = copy.deepcopy(self.projection()["agent_lifecycle"])
        self.now += 1000
        try:
            bad = self.call("activity_beat", task_id=self.task()["id"], run_id=mismatched_run,
                            op_id="mismatched-beat")
        except store.RoomError as exc:
            self.assertIsInstance(exc.code, str)
            self.assertTrue(exc.code)
        else:
            self.assertIsInstance(bad, dict)
            metadata = {"lamport", "beat_ts", "ts", "replayed", "op_id", "id",
                        "run_id", "task_id", "micro_id", "agent", "room"}
            disposition = lambda value: {k: v for k, v in value.items() if k not in metadata}
            self.assertNotEqual(disposition(bad), disposition(good),
                                "mismatched run returned indistinguishable ordinary beat success")
        self.assertEqual(self.projection()["tasks"], before_tasks,
                         "mismatched beat changed task or microtask activity")
        self.assertEqual(self.projection()["agent_lifecycle"], before_lifecycle)

    # A6: A beat ignored by folding must expose its disposition to the caller.
    def test_a06_mismatched_beat_returns_defined_disposition(self):
        self.lifecycle("deployed")
        self.own_task()
        self.assert_mismatched_beat_is_explicit("other-run")

    def test_a06_retired_run_beat_returns_defined_disposition(self):
        self.lifecycle("deployed", run_id="old-run")
        self.lifecycle("deployed")
        self.own_task()
        self.assert_mismatched_beat_is_explicit("old-run")

    def test_a06_matching_beat_still_updates_activity(self):
        self.lifecycle("deployed")
        self.own_task()
        result = self.succeeds("activity_beat", task_id=self.task()["id"], run_id=RUN)
        self.assertIs(result.get("ok"), True)
        live = self.task()["microtasks"][0]["live"]
        self.assertEqual((live["agent"], live["run_id"], live["beat_ts"]), (AGENT, RUN, self.now))

    # A7: Preserve existing callers and their work/claim/replay guarantees.
    def test_a07_unregistered_legacy_acquire_and_report_still_work(self):
        acquired = self.succeeds("work_acquire", op_id="legacy-acquire")
        self.assert_acquired(acquired)
        result = self.succeeds("work_report", **self.report_args(op_id="legacy-report"))
        self.assert_reported(result, acquired["claim_lamport"])

    def test_a07_legacy_acquire_exact_replay_appends_nothing(self):
        original = self.succeeds("work_acquire", op_id="replay-acquire")
        before = self.raw()
        replay = self.succeeds("work_acquire", op_id="replay-acquire")
        self.assertEqual(replay["task"], original["task"])
        self.assertEqual(replay["claim_lamport"], original["claim_lamport"])
        self.assertEqual(self.raw(), before)

    def test_a07_legacy_report_exact_replay_appends_nothing(self):
        self.own_task()
        args = self.report_args(op_id="replay-report")
        first = self.succeeds("work_report", **args)
        before = self.raw()
        replay = self.succeeds("work_report", **args)
        self.assertIs(replay["replayed"], True)
        self.assertEqual(replay["lamport"], first["lamport"])
        self.assertEqual(self.raw(), before)

    def test_a07_wrong_claim_still_refuses_without_appends(self):
        self.own_task()
        self.assert_refused("work_report", **self.report_args(claim_lamport=self.task()["claim_lamport"] + 1))

    def test_a07_registered_live_legacy_work_still_succeeds(self):
        self.lifecycle("deployed")
        self.assert_acquired(self.succeeds("work_acquire"))
        self.assert_reported(self.succeeds("work_report", **self.report_args()), self.task()["claim_lamport"])

    def test_a01_finished_slug_cannot_acquire_with_identity(self):
        self.terminal("finished")
        self.assert_refused("work_acquire", run_id=RUN, expected_opened_lamport=self.generation)

    def test_a01_failed_slug_cannot_report_with_identity(self):
        self.terminal("failed")
        self.own_task()
        self.assert_refused("work_report", **self.report_args(
            run_id=RUN, expected_opened_lamport=self.generation))

    def test_a06_mismatched_beat_preserves_execution_and_lifecycle(self):
        self.lifecycle("deployed")
        self.own_task()
        self.succeeds("activity_beat", task_id=self.task()["id"], run_id=RUN)
        before = self.projection()
        self.now += 1000
        try:
            self.call("activity_beat", task_id=self.task()["id"], run_id="other-run")
        except store.RoomError as exc:
            self.assertTrue(exc.code)
        after = self.projection()
        self.assertEqual(after["tasks"], before["tasks"])
        self.assertEqual(after["agent_lifecycle"], before["agent_lifecycle"])

    def test_a07_identified_acquire_exact_replay_appends_nothing(self):
        self.lifecycle("deployed")
        args = dict(op_id="identified-acquire", run_id=RUN,
                    expected_opened_lamport=self.generation)
        first = self.succeeds("work_acquire", **args)
        before = self.raw()
        replay = self.succeeds("work_acquire", **args)
        self.assertEqual(replay["task"], first["task"])
        self.assertEqual(replay["claim_lamport"], first["claim_lamport"])
        self.assertEqual(self.raw(), before)

    def test_a07_identified_report_exact_replay_appends_nothing(self):
        self.lifecycle("deployed")
        self.own_task()
        args = self.report_args(op_id="identified-report", run_id=RUN,
                                expected_opened_lamport=self.generation)
        first = self.succeeds("work_report", **args)
        before = self.raw()
        replay = self.succeeds("work_report", **args)
        self.assertIs(replay["replayed"], True)
        self.assertEqual(replay["lamport"], first["lamport"])
        self.assertEqual(self.raw(), before)
