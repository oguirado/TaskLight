"""U145 MUSTs, hostile reports and the mock-only negative control."""
import copy
import io
import json
import os
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from bridge.room import family, store

from .support import ROOM, SEED, ScenarioCase, receipt_gate, semantic_tasks


class TransportOracle(ScenarioCase):
    def test_a1_to_a5_a8_cli_recipe(self):
        self.scenario("cli").run()

    def test_a1_to_a5_a8_mcp_recipe(self):
        self.scenario("mcp").run()

    def test_a1_cli_and_mcp_agree_on_fresh_independent_homes(self):
        cli = self.scenario("cli")
        mcp = self.scenario("mcp")
        self.assertNotEqual(cli.home, mcp.home)
        self.assertEqual(semantic_tasks(cli.run()), semantic_tasks(mcp.run()))

    def test_a6_capsule_recipe_five_agents_thirty_tasks(self):
        scenario = self.scenario("cli", agents=5, tasks=30)
        projection = scenario.run()
        self.assertEqual(len(projection["agent_lifecycle"]), 5)
        self.assertEqual(len(projection["tasks"]), 30)

    def test_a6_capsule_seed_is_delivered(self):
        # The spec names this artifact, but prescribes no callable or CLI flags.
        # Assert its absence before any loading, so baseline failure is never an import error.
        self.assertTrue(SEED.is_file(),
                        "U145 capsule seed is missing: tools/demo/seed_swarm_fixture.py")


def hostile_report(transport, hostile):
    def test(self):
        scenario = self.scenario(transport)
        scenario.seed()
        acquired, _ = scenario.acquire(scenario.agents[0], scenario.ids["k1"])
        self.assertIsNotNone(acquired["task"])
        fields = scenario.report_args(acquired)
        if hostile == "wrong_claim_lamport":
            fields["claim_lamport"] += 1
        elif hostile == "empty_done":
            fields["done"] = []
        else:
            # A valid first member followed by an unreadable path must also be atomic.
            missing = scenario.home / "evidence" / "missing.txt"
            self.assertFalse(missing.exists())
            fields["done"][-1]["evidence"] = [str(missing.resolve())]
        before = scenario.snapshot()
        scenario.tool("work_report", scenario.agents[0], refusal=True, **fields)
        self.assertEqual(scenario.snapshot(), before, "hostile report changed persisted state")
        # Refusal must not poison future valid work or reserve the operation identity.
        repaired = scenario.report_args(acquired)
        repaired["op_id"] = fields["op_id"]
        scenario.tool("work_report", scenario.agents[0], **repaired)
        task = next(t for t in scenario.state()["tasks"] if t["id"] == acquired["task"]["id"])
        self.assertEqual(task["state"], "done")
    return test


class HostileOracle(ScenarioCase):
    pass


for _transport in ("cli", "mcp"):
    for _hostile in ("wrong_claim_lamport", "empty_done", "missing_evidence_path"):
        setattr(HostileOracle, "test_a9_%s_%s" % (_transport, _hostile),
                hostile_report(_transport, _hostile))


class NegativeOracle(ScenarioCase):
    def test_a10_mock_only_all_green_receipts_fail_gate(self):
        scenario = self.scenario()
        # Deliberately supply successful-looking responses without executing a backend.
        view = {"tasks": [{"id": "T01", "state": "done"}]}
        check = {"conformance": {"ok": True, "findings": []}}
        with self.assertRaisesRegex(AssertionError, "real journal is required"):
            receipt_gate(self, scenario.home, view, check, 1)

    def test_a8_a10_existing_journal_does_not_validate_forged_green_view(self):
        scenario = self.scenario()
        scenario.seed()
        view = scenario.state()
        forged = copy.deepcopy(view)
        forged["tasks"][0]["state"] = "done"
        with self.assertRaisesRegex(AssertionError, "plan_get disagrees"):
            receipt_gate(self, scenario.home, forged,
                         {"conformance": {"ok": True, "findings": []}}, 6)

    def test_a8_a10_existing_journal_does_not_validate_forged_check(self):
        scenario = self.scenario()
        scenario.seed()
        with self.assertRaisesRegex(AssertionError, "plan_check disagrees"):
            receipt_gate(self, scenario.home, scenario.state(),
                         {"conformance": {"ok": False, "findings": []}}, 6)


class MailboxStopOracle(ScenarioCase):
    def configure(self, scenario, selected_slice=1):
        endpoint = scenario.home / "family" / "board"
        spool = endpoint / "spool"
        spool.mkdir(parents=True)
        config = dict(endpoint="board", rooms=[ROOM], sources=["harness"], slice=selected_slice)
        (endpoint / "config.json").write_text(json.dumps(config), encoding="utf-8")
        return spool

    def publish(self, spool, request):
        # Real fsync and atomic rename; no running consumer, ports, or polling.
        temporary = spool / (request["id"] + ".tmp")
        with temporary.open("w", encoding="utf-8") as output:
            json.dump(request, output)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(spool / (request["id"] + ".json"))
        descriptor = os.open(spool, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def envelope(self, identifier, kind, agent="exec-a", payload=None):
        return dict(schema="tasklight.family/1", id=identifier, source="harness",
                    target="board", kind=kind, room=ROOM, agent=agent,
                    run_id="run-" + agent, payload={} if payload is None else payload)

    def test_a7_default_slice_one_stops_at_agent_plan(self):
        scenario = self.scenario()
        spool = self.configure(scenario)
        for agent in scenario.agents:
            identifier = "deploy-" + agent
            self.publish(spool, self.envelope(identifier, "agent.deployed", agent,
                                             dict(harness="external", swarm="fixture")))
            result = scenario.process("family", ("drain", "--endpoint", "board"))
            self.assertEqual(result.returncode, 0)
            path = spool / (identifier + ".result.json")
            self.assertTrue(path.is_file(), "mailbox deployment receipt is missing")
            receipt = json.loads(path.read_text())
            self.assertTrue(receipt["result"]["untrusted"]["ok"])
        events = [json.loads(line) for line in scenario.journal().splitlines()]
        self.assertEqual(len(events), len(scenario.agents))
        self.assertTrue(all(e["op"]["kind"] == "agent.lifecycle" for e in events))
        before = scenario.journal()
        for index, (kind, payload) in enumerate((
                ("agent.plan", {"tool": "plan_create", "args": scenario.definition()}),
                ("agent.activity", {"task_id": "T01"}),
                ("work.acquire", {}), ("work.report", {}))):
            identifier = "held-%04d" % index
            request = self.envelope(identifier, kind, payload=payload)
            if kind != "agent.plan":
                request["plan_opened"] = 1
            self.publish(spool, request)
            result = scenario.process("family", ("drain", "--endpoint", "board"))
            # A successful drain can carry an individual rejected request.
            self.assertEqual(result.returncode, 0)
            path = spool / (identifier + ".result.json")
            self.assertTrue(path.is_file(), "held request receipt is missing")
            receipt = json.loads(path.read_text())
            self.assertEqual(receipt["result"].get("code"), "bad_args")
            self.assertIs(receipt["result"].get("ok"), False)
            self.assertEqual(scenario.journal(), before, "held mailbox kind mutated the room")

    def test_a7_unadmitted_slice_two_stops_before_delivery(self):
        scenario = self.scenario()
        spool = self.configure(scenario, selected_slice=2)
        self.publish(spool, self.envelope("held-planning", "agent.plan",
                                         payload={"tool": "plan_create", "args": {}}))
        # A-U143a: preserve startup refusal only for a missing runtime fence.
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {"CW_HOME": str(scenario.home)}), \
                patch.object(store, "post", lambda *args, **kwargs: self.fail("unfenced write")), \
                patch.object(family.app, "dispatch") as dispatch, \
                redirect_stdout(stdout), redirect_stderr(stderr):
            code = family.main(["drain", "--endpoint", "board"])
        self.assertEqual(code, 2)
        self.assertIn("planning delivery awaits atomic backend generation fencing", stderr.getvalue())
        dispatch.assert_not_called()
        self.assertEqual(scenario.journal(), b"")
        self.assertFalse((spool / "held-planning.result.json").exists())

        # A-U143a: the admitted runtime delivers through the real shared handler.
        arguments = scenario.definition()
        for section in scenario.template["memory_sections"]:
            if section.get("required"):
                scenario.tool("memory_set", section=section["id"], text="Scratch fixture only",
                              base_rev=0, op_id=scenario.operation_id("memory"))
        for agent in scenario.agents:
            scenario.hook(agent, "deployed")
        self.publish(spool, self.envelope("held-planning", "agent.plan",
                                         payload={"tool": "plan_create", "args": arguments}))
        result = scenario.process("family", ("drain", "--endpoint", "board"))
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads((spool / "held-planning.result.json").read_text())
        self.assertIn("untrusted", receipt["result"], receipt)
        delivered = receipt["result"]["untrusted"]
        self.assertEqual(len(delivered["ids"]), scenario.count)
        self.assertEqual(len(scenario.state()["tasks"]), scenario.count)
        events = [json.loads(line) for line in scenario.journal().splitlines()]
        self.assertTrue(any(event["op"]["kind"] == "plan.open" for event in events))
