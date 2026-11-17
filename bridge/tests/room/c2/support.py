"""Adapters to existing transports; no replacement inventory implementation."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest import mock

from bridge.plan.fold import fold_plan
from bridge.room import app, mcp, store
from bridge.room import __main__ as cli
from bridge.room.ext.lifecycle import agent_lifecycle

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
FIXTURE = json.loads((HERE / "fixtures/inventories.json").read_text())
FIELDS = ("agent", "state", "run_id", "harness", "parent", "children",
          "last_seen_lamport", "last_seen_ts", "current", "counts")
STATES = ("working", "waiting", "idle", "registered", "finished", "failed", "unknown")


def unwrap(payload):
    return payload.get("untrusted", payload)


def canonical(payload):
    data = unwrap(payload)
    if not isinstance(data, dict) or not isinstance(data.get("agents"), list):
        raise AssertionError("M3 agents_list must return an agents array")
    for row in data["agents"]:
        missing = set(FIELDS) - row.keys()
        if missing:
            raise AssertionError("M3 missing agent fields: " + ", ".join(sorted(missing)))
    if "totals" not in data:
        raise AssertionError("M5 inventory totals missing")
    return {"agents": [{key: row[key] for key in FIELDS} for row in data["agents"]],
            "totals": data["totals"]}


class InventoryCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="runtime-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.now = 150000
        self.enterContext(mock.patch.dict(os.environ, {"CW_HOME": str(self.home),
            "CW_AGENT": "", "CW_ROLE": "", "CW_SESSION_AGENT": "", "CW_SESSION_ROLE": "",
            "PYTHONDONTWRITEBYTECODE": "1"}))
        self.enterContext(mock.patch.object(store.time, "time", side_effect=lambda: self.now / 1000))
        self.enterContext(mock.patch.object(socket, "socket", side_effect=AssertionError("network forbidden")))
        self.enterContext(mock.patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")))
        self.enterContext(mock.patch.object(store.time, "monotonic", return_value=10.0))
        self.enterContext(mock.patch.object(store.time, "sleep", side_effect=AssertionError("real waits forbidden")))
        (self.home / "rooms/demo").mkdir(parents=True)
        self.seq = 0

    def path(self, room="demo"):
        return self.home / "rooms" / room / "events.jsonl"

    def raw(self, room="demo"):
        path = self.path(room)
        return path.read_bytes() if path.exists() else b""

    def events(self, room="demo"):
        return [json.loads(line) for line in self.raw(room).splitlines() if line]

    def install(self, case):
        self.now = case["now"]
        path = self.path(case["room"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(e, ensure_ascii=True) + "\n" for e in case["events"]))

    def life(self, agent="worker", state="deployed", run="r1", room="demo", **fields):
        self.seq += 1
        args = dict(room=room, agent=agent, state=state, run_id=run,
                    op_id=f"c2-life-{self.seq:04d}", **fields)
        try:
            return agent_lifecycle(args)
        except store.RoomError as exc:
            self.fail("M1 valid lifecycle must be admitted: " + exc.code)

    def advertised(self):
        tools = [tool for tool in app.list_tools() if tool["name"] == "agents_list"]
        self.assertEqual(len(tools), 1, "M7 agents_list is missing from tool discovery")
        return tools[0]

    def mcp_call(self, name, args):
        sent = []
        with mock.patch.object(mcp, "_send", side_effect=sent.append):
            mcp._handle(17, "tools/call", {"name": name, "arguments": args})
        self.assertEqual(len(sent), 1, "one MCP response required")
        self.assertNotIn("error", sent[0], "M7 agents_list unavailable: " + str(sent[0].get("error")))
        result = sent[0]["result"]
        payload = json.loads(result["content"][0]["text"])
        return result, payload

    def inventory(self, room="demo", now=None):
        result, payload = self.mcp_call("agents_list", {"room": room, "now": self.now if now is None else now})
        self.assertFalse(result.get("isError", False), "M7 inventory read failed: " + str(payload))
        return canonical(payload)

    def assert_contract(self, inventory):
        rows, totals = inventory["agents"], inventory["totals"]
        self.assertEqual(set(totals), set(STATES) | {"total"})
        self.assertEqual(totals["total"], len(rows))
        self.assertEqual(sum(totals[state] for state in STATES), totals["total"])
        self.assertEqual(len({r["agent"] for r in rows}), len(rows))
        for state in STATES:
            self.assertEqual(totals[state], sum(r["state"] == state for r in rows))
        for row in rows:
            self.assertIn(row["state"], STATES)
            self.assertEqual(row["children"], sorted(row["children"]))
            self.assertEqual(set(row["counts"]), {"tasks_owned", "micros_done", "micros_total"})
            self.assertTrue(all(type(n) is int and n >= 0 for n in row["counts"].values()))
            self.assertLessEqual(row["counts"]["micros_done"], row["counts"]["micros_total"])
            if row["parent"] is not None:
                self.assertEqual(set(row["parent"]), {"agent", "run_id"})
            if row["current"] is not None:
                self.assertEqual(set(row["current"]), {"task_id", "micro_id"})

    def assert_case(self, case):
        self.install(case)
        before = self.raw()
        inventory = self.inventory()
        self.assert_contract(inventory)
        self.assertEqual(self.raw(), before, "M7 inventory reads must not modify the journal")
        if "membership_only" in case:
            self.assertEqual(sorted(r["agent"] for r in inventory["agents"]), sorted(case["membership_only"]))
        elif "state_only" in case:
            by_agent = {r["agent"]: r for r in inventory["agents"]}
            for agent, expected in case["state_only"].items():
                self.assertIn(agent, by_agent)
                for key, value in expected.items():
                    self.assertEqual(by_agent[agent][key], value)
        else:
            self.assertEqual(inventory, case["expected"])
        return inventory


def fixture_case(name):
    return copy.deepcopy(next(c for c in FIXTURE["cases"] if c["name"] == name))


class NoWaitBudget:
    """Fake only the hook budget: persistence, validation and folding stay real."""
    expiration = TimeoutError
    def __init__(self, *args, **kwargs): pass
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def check(self): pass
    def guard_locks(self, module): pass
    def wait(self): return contextlib.nullcontext()
