#!/usr/bin/env python3
"""Seed a local Wall fixture using the public room CLI or stdio MCP server.

Use --home DIR --variant small|capsule [--transport cli|mcp]. Small completes
its recipe; capsule retains active work and blocked dependencies for inspection.
--complete also finishes the capsule. Each transport needs its own fresh home.
--force permits a populated home without deleting anything: if demo already
exists, a new demo-<run> room is used and reported in the summary.

Mailbox stop point: slice:1 accepts lifecycle delivery, but agent.plan returns
bad_args; activity and work delivery remain HOLD. Slice:2 refuses startup with
"planning delivery awaits atomic backend generation fencing". This seed does
not enable mailbox delivery or launch agents, providers, or a GUI.
"""

import argparse
from collections import Counter
import copy
import hashlib
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


ROOT = Path(__file__).resolve().parents[2]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class Fixture:
    def __init__(self, home, variant, transport):
        self.home = home
        self.variant = variant
        self.transport = transport
        self.run = uuid.uuid4().hex
        self.room = "demo"
        if (home / "rooms" / self.room).exists():
            self.room += "-" + self.run[:12]
        self.agents = ["exec-" + letter for letter in
                       ("abc" if variant == "small" else "abcde")]
        self.count = 6 if variant == "small" else 30
        self.sequence = itertools.count(1)
        # An inherited session pin must not redirect the local fixture.
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("CW_")}
        self.env.update(CW_HOME=str(home), PYTHONDONTWRITEBYTECODE="1")
        self.journal = home / "rooms" / self.room / "events.jsonl"

    def identity(self, prefix):
        return "%s-%s-%06d" % (prefix, self.run, next(self.sequence))

    def process(self, module, arguments=(), stdin=""):
        result = subprocess.run(
            [sys.executable, "-B", "-m", module, *arguments], cwd=ROOT,
            env=self.env, input=stdin, text=True, capture_output=True, timeout=30)
        require(result.returncode in (0, 3),
                "%s failed: %s" % (module, result.stderr or result.stdout))
        return result

    def call(self, name, agent="harness", *, refusal=False, **fields):
        args = fields if name in ("list_templates", "get_template") else dict(
            room=self.room, agent=agent, **fields)
        if self.transport == "cli":
            result = self.process("bridge.room", ["call", name, "--json", json.dumps(args)])
            payload = json.loads(result.stdout)
            require(result.returncode == (3 if refusal else 0),
                    "%s: %s" % (name, payload))
        else:
            messages = [
                dict(jsonrpc="2.0", id=0, method="initialize", params=dict(
                    protocolVersion="2024-11-05", capabilities={},
                    clientInfo=dict(name="swarm-fixture", version="1"))),
                dict(jsonrpc="2.0", method="notifications/initialized"),
                dict(jsonrpc="2.0", id=1, method="tools/call",
                     params=dict(name=name, arguments=args)),
            ]
            result = self.process("bridge.room.mcp", stdin="".join(
                json.dumps(message) + "\n" for message in messages))
            require(result.returncode == 0, "MCP process failed")
            replies = [json.loads(line) for line in result.stdout.splitlines()]
            require([reply.get("id") for reply in replies] == [0, 1],
                    "MCP initialization/call replies missing")
            require("error" not in replies[0] and "error" not in replies[1],
                    "MCP protocol error: %s" % replies)
            response = replies[1]["result"]
            require(bool(response.get("isError")) == refusal,
                    "%s: %s" % (name, response))
            payload = json.loads(response["content"][0]["text"])
        require((payload.get("ok") is False) == refusal,
                "%s returned an unexpected outcome: %s" % (name, payload))
        if refusal:
            require(bool(payload.get("code")), "refusal has no error code")
        return payload.get("untrusted", payload)

    def state(self):
        return self.call("plan_get")

    def snapshot(self):
        return self.journal.read_bytes(), self.state(), self.call("plan_check")

    def hook(self, agent, state):
        value = dict(event_id=self.run + "-" + agent + "-" + state,
                     room=self.room, agent=agent, state=state,
                     run_id=self.run + "-" + agent, harness="external", swarm="fixture")
        result = self.process("bridge.room.hook", stdin=json.dumps(value))
        require((result.returncode, result.stdout, result.stderr) == (0, "", ""),
                "lifecycle hook did not exit silently")
        # A silent exit is not a persistence receipt.
        record = self.state()["agent_lifecycle"].get(agent, {})
        require(record.get("lifecycle") == state and record.get("run_id") == value["run_id"],
                "lifecycle hook did not persist " + state)

    def seed(self):
        catalog = self.call("list_templates")["templates"]
        catalog.sort(key=lambda item: (item["id"] != "blank", item["id"]))
        template = None
        for item in catalog:
            candidate = self.call("get_template", template_id=item["id"])["template"]
            if candidate["granularity"]["tasks_max"] >= self.count:
                template = candidate
                break
        require(template is not None, "no shipped template can hold this fixture")
        self.template = template
        # This also bootstraps the room before the hook's existing-room gate.
        for section in template["memory_sections"]:
            if section.get("required"):
                self.call("memory_set", section=section["id"], text="Local fixture only",
                          base_rev=0, op_id=self.identity("memory"))
        dependencies = [[], [], [], ["k1", "k2"], ["k3", "k4"], ["k5"]]
        owners = ["exec-a", "exec-b", "exec-c", "exec-a", "exec-b", "exec-a"]
        if self.count > 6:
            dependencies.extend([[], [], ["k6", "k7", "k8"]])
            dependencies.extend([["k%d" % i] for i in range(9, self.count)])
            survivors = [a for a in self.agents if a != "exec-c"]
            owners.extend(["exec-d", "exec-e"])
            owners.extend(survivors[i % len(survivors)] for i in range(8, self.count))
        micro_count = max(2, template["granularity"]["micro_min"])
        require(micro_count <= template["granularity"]["micro_max"],
                "template cannot hold production and verification microtasks")
        tasks = [dict(key="k%d" % (i + 1), title="Fixture %d" % (i + 1),
                      type=template["task_types"][0]["id"],
                      phase=template["phases"][0]["id"], accept="Fixture verified",
                      assignee=owners[i], deps=dependencies[i],
                      microtasks=[dict(text="Produce fixture" if j == 0 else
                                       "Verify fixture %d" % j) for j in range(micro_count)])
                 for i in range(self.count)]
        created = self.call("plan_create", template_id=template["id"],
                            title="Swarm fixture", strict=True,
                            brief={f["id"]: "Verify orchestration" for f in
                                   template["brief_fields"] if f.get("required")},
                            tasks=tasks, op_id=self.identity("plan"))
        self.ids = created["ids"]
        by_id = {t["id"]: t for t in self.state()["tasks"]}
        require(len(by_id) == self.count, "task creation was incomplete")
        for i, deps in enumerate(dependencies, 1):
            task = by_id[self.ids["k%d" % i]]
            require(task["deps"] == [self.ids[key] for key in deps],
                    "dependency mapping differs from the recipe")
            require(bool(task["ready"]) == (not deps), "incorrect initial task readiness")
        for agent in self.agents:
            self.hook(agent, "deployed")

    def acquire(self, agent, key=None):
        fields = dict(op_id=self.identity("acquire"))
        if key:
            fields["prefer_task"] = self.ids[key]
        acquired = self.call("work_acquire", agent, **fields)
        task = acquired["task"]
        if task is not None:
            view = {t["id"]: t for t in self.state()["tasks"]}
            require(all(view[dep]["state"] == "done" for dep in task["deps"]),
                    "acquired work before its dependencies completed")
            require(task["assignee"] == agent and acquired["claim_lamport"] > 0,
                    "missing ownership receipt")
            if key:
                require(task["id"] == self.ids[key], "preferred task was not acquired")
            before = self.snapshot()
            require(self.call("work_acquire", agent, **fields) == acquired,
                    "acquisition replay changed its result")
            require(self.snapshot() == before, "acquisition replay changed state")
            self.call("activity_beat", agent, task_id=task["id"],
                      run_id=self.run + "-" + agent, op_id=self.identity("beat"))
        return acquired

    def report(self, agent, acquired, *, hostile=False, partial=False):
        task = acquired["task"]
        directory = self.home / "evidence" / self.run
        directory.mkdir(parents=True, exist_ok=True)
        proof = directory / (task["id"] + ".txt")
        proof.write_text("Fixture verified\n", encoding="utf-8")
        items = acquired["items"][:1] if partial else acquired["items"]
        fields = dict(task_id=task["id"], claim_lamport=acquired["claim_lamport"],
                      op_id=self.identity("report"),
                      done=[dict(id=m["id"], outcome="Fixture verified",
                                 evidence=[str(proof)]) for m in items])
        if hostile:
            for kind in ("wrong_claim", "empty_done", "missing_evidence"):
                bad = copy.deepcopy(fields)
                if kind == "wrong_claim":
                    bad["claim_lamport"] += 1
                elif kind == "empty_done":
                    bad["done"] = []
                else:
                    missing = directory / "missing.txt"
                    require(not missing.exists(), "hostile evidence unexpectedly exists")
                    bad["done"][-1]["evidence"] = [str(missing)]
                before = self.snapshot()
                self.call("work_report", agent, refusal=True, **bad)
                require(self.snapshot() == before, kind + " changed state")
        result = self.call("work_report", agent, **fields)
        require(set(result["done"]) == {m["id"] for m in items}, "report was incomplete")
        before = self.snapshot()
        replay = self.call("work_report", agent, **fields)
        require(replay.get("replayed") is True, "report replay was not recognized")
        require({k: v for k, v in replay.items() if k != "replayed"} ==
                {k: v for k, v in result.items() if k != "replayed"},
                "report replay lost its original result")
        require(self.snapshot() == before, "report replay changed state")

    def verify(self, complete):
        view = self.state()
        check = self.call("plan_check")
        require(check["conformance"]["ok"] is True, "final plan is not conformant")
        require(not view["rejected"], "journal contains rejected operations")
        require(len(view["tasks"]) == self.count, "final task count differs")
        require(view["agent_lifecycle"]["exec-c"]["lifecycle"] == "failed",
                "Failed agent is missing")
        events = [json.loads(line) for line in self.journal.read_bytes().splitlines()]
        kinds = {e.get("op", {}).get("kind") for e in events}
        require({"plan.open", "task.add", "task.claim", "task.release", "micro.set",
                 "agent.lifecycle"} <= kinds, "real journal lacks scenario operations")
        require(events[-1]["lamport"] == view["last_lamport"],
                "journal and plan_get revisions differ")
        for task in view["tasks"]:
            if complete:
                require(task["state"] == "done", "recipe left unfinished work")
            for micro in task["microtasks"]:
                if micro["state"] == "done":
                    require(micro["outcome"] and micro["evidence"], "completion lacks evidence")
                    for evidence in micro["evidence"]:
                        digest = hashlib.sha256(Path(evidence["path"]).read_bytes()).hexdigest()
                        require(digest == evidence["sha256"], "evidence digest differs")
        if not complete:
            require(any(t["state"] != "done" and t["deps"] and not t["ready"]
                        for t in view["tasks"]), "capsule has no waiting-on dependencies")
            require(any(m["state"] == "active" for t in view["tasks"]
                        for m in t["microtasks"]), "capsule has no active microtask")
        return dict(room=self.room, agents=self.agents,
                    tasks=[t["id"] for t in view["tasks"]],
                    task_states=dict(Counter(t["state"] for t in view["tasks"])),
                    transport=self.transport, variant=self.variant, plan_check=check,
                    mailbox=dict(status="HOLD", stop_at="agent.plan", code="bad_args"))

    def run_recipe(self, complete):
        self.seed()
        first = [self.acquire(agent, "k%d" % (i + 1))
                 for i, agent in enumerate(self.agents[:3])]
        require(all(item["task"] is not None for item in first), "initial acquisition failed")
        self.report("exec-a", first[0], hostile=True)
        self.report("exec-b", first[1])
        self.hook("exec-c", "failed")
        released = next(t for t in self.state()["tasks"] if t["id"] == self.ids["k3"])
        require(released["assignee"] is None and released["state"] != "done",
                "failure hook did not release unfinished work")
        before = self.snapshot()
        self.hook("exec-c", "failed")
        require(self.snapshot() == before, "failure-hook replay changed state")
        reassigned = self.acquire("exec-b", "k3")
        require(reassigned["task"] is not None and
                reassigned["claim_lamport"] != first[2]["claim_lamport"],
                "failed task was not reassigned with a new claim")
        self.report("exec-b", reassigned)
        survivors = [a for a in self.agents if a != "exec-c"]
        if complete:
            for _ in range(self.count):
                if all(t["state"] == "done" for t in self.state()["tasks"]):
                    break
                progress = False
                for agent in survivors:
                    acquired = self.acquire(agent)
                    if acquired["task"] is not None:
                        self.report(agent, acquired)
                        progress = True
                require(progress, "bounded recipe stalled")
            require(all(t["state"] == "done" for t in self.state()["tasks"]),
                    "bounded recipe exhausted its task budget")
            for agent in survivors:
                self.hook(agent, "finished")
        else:
            for agent, key in (("exec-a", "k4"), ("exec-d", "k7"), ("exec-e", "k8")):
                acquired = self.acquire(agent, key)
                require(acquired["task"] is not None, "capsule claim is missing")
                self.report(agent, acquired, partial=True)
        return self.verify(complete)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", required=True, type=Path, help="fresh CW_HOME directory")
    parser.add_argument("--variant", choices=("small", "capsule"), default="small")
    parser.add_argument("--transport", choices=("cli", "mcp"), default="cli")
    parser.add_argument("--complete", action="store_true", help="also finish all capsule tasks")
    parser.add_argument("--force", action="store_true", help="allow a populated home; preserve existing rooms")
    args = parser.parse_args(argv)
    try:
        home = args.home.expanduser().resolve()
        if home.exists():
            require(home.is_dir(), "--home must be a directory")
            require(args.force or not any(home.iterdir()),
                    "--home is non-empty; use a fresh directory or --force")
        home.mkdir(parents=True, exist_ok=True)
        result = Fixture(home, args.variant, args.transport).run_recipe(
            args.variant == "small" or args.complete)
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        print(json.dumps(dict(ok=False, error=str(exc))), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
