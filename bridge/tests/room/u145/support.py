"""Real subprocess recipes and a journal-backed acceptance gate.

Only infrastructure clocks, entropy, sockets and alarms are controlled.
All temporary homes and evidence are created beneath this test directory.
"""
import hashlib
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from bridge.plan import check_conformance, fold_plan, load_template
# A-U163: Transport views redact free text while owner replay stays raw.
from bridge.wall.emit import sanitize_output


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
ROOM = "demo"
SEED = ROOT / "tools/demo/seed_swarm_fixture.py"


def templates():
    return {p.stem: load_template(str(p))
            for p in sorted((ROOT / "templates/planning").glob("*.json"))}


def receipt_gate(case, home, view, check, count):
    """No green API response substitutes for persisted, replayable operations."""
    journal = home / "rooms" / ROOM / "events.jsonl"
    case.assertTrue(journal.is_file(), "real journal is required; mock-only run rejected")
    raw = journal.read_bytes()
    case.assertTrue(raw, "empty journal is not an end-to-end receipt")
    events = [json.loads(line) for line in raw.splitlines()]
    catalog = templates()
    projection = fold_plan(events, templates=catalog)
    case.assertEqual(projection["rejected"], [], "journal contains rejected operations")
    # A-U163: Compare the redacted view, preserving the raw evidence checks below.
    case.assertEqual(view, sanitize_output(projection), "plan_get disagrees with journal replay")
    expected_check = check_conformance(projection, catalog[projection["plan"]["template_id"]])
    case.assertEqual(check["conformance"], expected_check,
                     "plan_check disagrees with journal replay")
    case.assertTrue(expected_check["ok"], "final plan is not conformant")
    case.assertEqual(len(projection["tasks"]), count)
    for task in projection["tasks"]:
        case.assertEqual(task["state"], "done", "recipe left unfinished work")
        case.assertTrue(task["microtasks"], "recipe needs verifiable microtasks")
        for micro in task["microtasks"]:
            case.assertEqual(micro["state"], "done")
            case.assertTrue(micro["outcome"])
            case.assertTrue(micro["evidence"], "completion needs readable evidence")
            for proof in micro["evidence"]:
                path = Path(proof["path"])
                case.assertTrue(path.is_file(), "completion evidence is missing")
                case.assertEqual(proof["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
    kinds = {event.get("op", {}).get("kind") for event in events}
    case.assertTrue({"plan.open", "task.add", "task.claim", "task.release", "micro.set",
                     "agent.lifecycle"} <= kinds, "scenario omitted required real operations")
    return projection


class Scenario:
    def __init__(self, case, transport, agents=3, tasks=6):
        self.case = case
        self.transport = transport
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=HERE)
        case.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.sequence = itertools.count(1)
        self.agents = ["exec-" + chr(ord("a") + i) for i in range(agents)]
        self.count = tasks
        self.calls = []
        case.assertEqual(list(self.home.iterdir()), [], "CW_HOME must be fresh")

    def operation_id(self, prefix):
        return "%s-%06d" % (prefix, next(self.sequence))

    def process(self, mode, arguments=(), stdin=""):
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(("CW_", "PYTHON"))}
        environment.update(CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1",
                           TMPDIR=str(self.home))
        seed = self.operation_id("process")
        result = subprocess.run(
            [sys.executable, "-B", "-m", "bridge.tests.room.u145.process", mode, seed,
             *map(str, arguments)], cwd=str(ROOT), env=environment,
            input=stdin, text=True, capture_output=True, timeout=15,
        )
        self.case.assertNotIn("Traceback", result.stderr, "entry point crashed")
        return result

    def tool(self, name, agent="harness", *, refusal=False, **fields):
        arguments = dict(room=ROOM, agent=agent, **fields)
        if self.transport == "cli":
            result = self.process("cli", ("call", name, "--json", json.dumps(arguments)))
            payload = json.loads(result.stdout)
            if refusal:
                self.case.assertEqual(result.returncode, 3, "dispatched CLI failure required")
                self.case.assertIs(payload.get("ok"), False)
                self.case.assertTrue(payload.get("code"))
                return payload
            self.case.assertEqual(result.returncode, 0, "CLI call failed: " + result.stdout)
        else:
            messages = [
                dict(jsonrpc="2.0", id=0, method="initialize", params=dict(
                    protocolVersion="2024-11-05", capabilities={},
                    clientInfo=dict(name="scenario-oracle", version="1"))),
                dict(jsonrpc="2.0", method="notifications/initialized"),
                dict(jsonrpc="2.0", id=1, method="tools/call",
                     params=dict(name=name, arguments=arguments)),
            ]
            result = self.process("mcp", stdin="".join(json.dumps(m) + "\n" for m in messages))
            self.case.assertEqual(result.returncode, 0, "MCP process failed")
            responses = [json.loads(line) for line in result.stdout.splitlines()]
            self.case.assertEqual([r.get("id") for r in responses], [0, 1])
            reply = responses[-1]
            self.case.assertNotIn("error", reply, "valid tool call failed at JSON-RPC layer")
            response = reply["result"]
            self.case.assertIs(bool(response.get("isError")), refusal)
            payload = json.loads(response["content"][0]["text"])
            if refusal:
                self.case.assertIs(payload.get("ok"), False)
                self.case.assertTrue(payload.get("code"))
                return payload
        self.case.assertIsNot(payload.get("ok"), False, "tool failed: " + str(payload))
        self.calls.append(name)
        return payload.get("untrusted", payload)

    def journal(self):
        path = self.home / "rooms" / ROOM / "events.jsonl"
        return path.read_bytes() if path.exists() else b""

    def state(self):
        return self.tool("plan_get")

    def snapshot(self):
        view = self.state()
        check = self.tool("plan_check")
        files = {str(path.relative_to(self.home)): path.read_bytes()
                 for path in self.home.rglob("*") if path.is_file()}
        return files, view, check

    def hook(self, agent, state):
        value = dict(event_id=agent + "-" + state, room=ROOM, agent=agent,
                     state=state, run_id="run-" + agent, harness="external", swarm="fixture")
        result = self.process("hook", stdin=json.dumps(value))
        self.case.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def definition(self):
        catalog = templates()
        if self.count <= catalog["blank"]["granularity"]["tasks_max"]:
            self.template = catalog["blank"]
        else:
            compatible = [t for t in catalog.values()
                          if t["granularity"]["tasks_max"] >= self.count]
            self.case.assertTrue(compatible, "no shipped template can hold capsule recipe")
            self.template = compatible[0]
        dependencies = [[], [], [], ["k1", "k2"], ["k3", "k4"], ["k5"]]
        dependencies.extend([["k%d" % i] for i in range(6, self.count)])
        owners = [self.agents[0], self.agents[1], self.agents[2],
                  self.agents[0], self.agents[1], self.agents[0]]
        survivors = [a for a in self.agents if a != self.agents[2]]
        owners.extend(survivors[i % len(survivors)] for i in range(6, self.count))
        self.dependencies = dependencies
        brief = {field["id"]: "Verify fixture" for field in self.template["brief_fields"]
                 if field.get("required")}
        micro_count = max(2, self.template["granularity"]["micro_min"])
        return dict(
            template_id=self.template["id"], title="Fixture", brief=brief, strict=True,
            tasks=[dict(key="k%d" % (i + 1), title="Fixture %d" % (i + 1),
                        type=self.template["task_types"][0]["id"],
                        phase=self.template["phases"][0]["id"], accept="Fixture verified",
                        assignee=owners[i], deps=dependencies[i],
                        microtasks=[{"text": "Verify outcome %d" % (j + 1)}
                                    for j in range(micro_count)]) for i in range(self.count)],
        )
    def seed(self):
        arguments = self.definition()
        for section in self.template["memory_sections"]:
            if section.get("required"):
                self.tool("memory_set", section=section["id"], text="Scratch fixture only",
                          base_rev=0, op_id=self.operation_id("memory"))
        for agent in self.agents:
            self.hook(agent, "deployed")
        created = self.tool("plan_create", op_id=self.operation_id("plan"), **arguments)
        self.ids = created["ids"]
        self.case.assertEqual(set(self.ids), {"k%d" % i for i in range(1, self.count + 1)})
        view = self.state()
        by_id = {t["id"]: t for t in view["tasks"]}
        for i, deps in enumerate(self.dependencies, 1):
            task = by_id[self.ids["k%d" % i]]
            self.case.assertEqual(task["deps"], [self.ids[key] for key in deps])
            self.case.assertEqual(bool(task["ready"]), not deps)
        for agent in self.agents:
            self.case.assertEqual(view["agent_lifecycle"][agent]["run_id"], "run-" + agent)

    def acquire(self, agent, preferred=None):
        fields = dict(op_id=self.operation_id("acquire"))
        if preferred:
            fields["prefer_task"] = preferred
        before = self.state()
        result = self.tool("work_acquire", agent, **fields)
        if result["task"] is not None:
            task = result["task"]
            states = {t["id"]: t["state"] for t in before["tasks"]}
            self.case.assertTrue(all(states[dep] == "done" for dep in task["deps"]),
                                 "acquired work before its dependencies completed")
            self.case.assertEqual(task["assignee"], agent)
            self.case.assertTrue(result["items"])
            self.case.assertGreater(result["claim_lamport"], 0)
        return result, fields

    def report_args(self, acquired):
        task = acquired["task"]
        directory = self.home / "evidence"
        directory.mkdir(exist_ok=True)
        proof = directory / (task["id"] + ".txt")
        proof.write_text("Scratch fixture verified\n", encoding="utf-8")
        return dict(task_id=task["id"], claim_lamport=acquired["claim_lamport"],
                    op_id=self.operation_id("report"),
                    done=[dict(id=m["id"], outcome="Scratch fixture verified",
                               evidence=[str(proof.resolve())]) for m in acquired["items"]])

    def finish(self, agent, acquired):
        task = acquired["task"]
        self.tool("activity_beat", agent, task_id=task["id"], run_id="run-" + agent,
                  op_id=self.operation_id("beat"))
        fields = self.report_args(acquired)
        result = self.tool("work_report", agent, **fields)
        self.case.assertEqual(set(result["done"]), {m["id"] for m in acquired["items"]})
        before = self.snapshot()
        replay = self.tool("work_report", agent, **fields)
        self.case.assertTrue(replay["replayed"])
        self.case.assertEqual({k: v for k, v in replay.items() if k != "replayed"},
                              {k: v for k, v in result.items() if k != "replayed"},
                              "report replay did not retain its original result")
        self.case.assertEqual(self.snapshot(), before, "report replay changed state")

    def run(self):
        self.seed()
        first = [self.acquire(agent, self.ids["k%d" % (i + 1)])
                 for i, agent in enumerate(self.agents[:3])]
        for i, (result, _) in enumerate(first, 1):
            self.case.assertIsNotNone(result["task"])
            self.case.assertEqual(result["task"]["id"], self.ids["k%d" % i])
        self.finish(self.agents[0], first[0][0])
        self.finish(self.agents[1], first[1][0])
        before = self.snapshot()
        replay = self.tool("work_acquire", self.agents[0], **first[0][1])
        self.case.assertEqual(replay, first[0][0], "acquisition replay lost original result")
        self.case.assertEqual(self.snapshot(), before, "acquisition replay changed state")
        failed = self.agents[2]
        self.hook(failed, "failed")
        after = self.state()
        self.case.assertEqual(after["agent_lifecycle"][failed]["lifecycle"], "failed")
        released = next(t for t in after["tasks"] if t["id"] == self.ids["k3"])
        self.case.assertIsNone(released["assignee"], "failure hook did not release its task")
        self.case.assertNotEqual(released["state"], "done", "process failure completed work")
        # Replay the silent hook, and verify its effects instead of trusting exit zero.
        before = self.snapshot()
        self.hook(failed, "failed")
        self.case.assertEqual(self.snapshot(), before, "failure-hook replay changed state")
        reassigned, _ = self.acquire(self.agents[1], self.ids["k3"])
        self.case.assertEqual(reassigned["task"]["id"], self.ids["k3"])
        self.case.assertNotEqual(reassigned["claim_lamport"], first[2][0]["claim_lamport"])
        self.finish(self.agents[1], reassigned)
        active = [a for a in self.agents if a != failed]
        for _ in range(self.count):
            if all(t["state"] == "done" for t in self.state()["tasks"]):
                break
            progress = False
            for agent in active:
                acquired, _ = self.acquire(agent)
                if acquired["task"] is not None:
                    self.finish(agent, acquired)
                    progress = True
            self.case.assertTrue(progress, "bounded scenario stalled")
        else:
            self.case.fail("bounded recipe exhausted its task budget")
        for agent in active:
            self.hook(agent, "finished")
        view = self.state()
        check = self.tool("plan_check")
        for agent in active:
            self.case.assertEqual(view["agent_lifecycle"][agent]["lifecycle"], "finished")
        for tool in ("plan_create", "plan_get", "plan_check", "work_acquire", "work_report"):
            self.case.assertIn(tool, self.calls)
        return receipt_gate(self.case, self.home, view, check, self.count)


class ScenarioCase(unittest.TestCase):
    def scenario(self, transport="cli", agents=3, tasks=6):
        return Scenario(self, transport, agents, tasks)


def semantic_tasks(projection):
    """Compare transports without depending on generated event IDs or evidence roots."""
    return [(t["id"], t["title"], t["deps"], t["state"], t["assignee"],
             [(m["id"], m["state"], m["outcome"],
               [proof["sha256"] for proof in m["evidence"]]) for m in t["microtasks"]])
            for t in projection["tasks"]]
