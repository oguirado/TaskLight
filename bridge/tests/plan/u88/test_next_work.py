"""Exercise the real in-process MCP dispatcher against an isolated CW_HOME."""
import copy
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from bridge.room import mcp, store
from .fixtures import BASE_TS, TEMPLATE


def task(key, **changes):
    return {"key": key, "title": "Action", "type": "action", "phase": "start",
            "accept": "Verified", "microtasks": [{"text": "Step", "accept": "Verified"}],
            **changes}


class NextWorkOracle(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".cw-", dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / "home"
        self.enterContext(patch.dict(os.environ, {"CW_HOME": str(self.home)}))
        self.enterContext(patch.object(store.time, "time", return_value=BASE_TS / 1000))
        directory = self.home / "templates"
        directory.mkdir(parents=True)
        (directory / (TEMPLATE["id"] + ".json")).write_text(json.dumps(TEMPLATE))

    def tool(self, name, **arguments):
        output = io.StringIO()
        with redirect_stdout(output):
            mcp._handle(1, "tools/call", {"name": name, "arguments": arguments})
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        reply = json.loads(lines[0])
        self.assertEqual((reply["jsonrpc"], reply["id"]), ("2.0", 1))
        self.assertNotIn("error", reply)
        result = reply["result"]
        self.assertIs(result.get("isError"), False, result)
        self.assertEqual(result["content"][0]["type"], "text")
        payload = json.loads(result["content"][0]["text"])
        self.assertEqual(set(payload), {"untrusted"})
        return payload["untrusted"]

    def create(self, tasks):
        self.tool("plan_create", room="demo", agent="owner", template_id=TEMPLATE["id"],
                  title="Dependency plan", brief={"goal": "Verify dependencies"}, tasks=tasks)

    def projection(self):
        return self.tool("plan_get", room="demo")

    def update(self, task_id, **changes):
        current = next(t for t in self.projection()["tasks"] if t["id"] == task_id)
        return self.tool("task_update", room="demo", agent="owner", task_id=task_id,
                         base_rev=current["rev"], **changes)

    def pair(self):
        self.create([task("prerequisite"), task("dependant", deps=["prerequisite"])])
        self.tool("task_claim", room="demo", agent="owner", task_id="T01")

    def next_work(self, **options):
        data = self.tool("next_work", room="demo", agent="worker", **options)
        self.assertEqual(set(data), {"items"})
        return data["items"]

    def test_A5_cancellation_exposes_exactly_the_dependant_microtask(self):
        self.pair()
        self.assertEqual(self.next_work(), [])
        self.update("T01", state="cancelled")
        expected = self.projection()["tasks"][1]["microtasks"]
        self.assertEqual([m["id"] for m in expected], ["T02.M01"])
        self.assertEqual(self.next_work(), expected)

    def test_A5_blocked_dependant_is_excluded_after_cancellation(self):
        self.pair()
        self.update("T01", state="cancelled")
        self.update("T02", state="blocked")
        self.assertEqual(self.next_work(), [])

    def test_M3_cancellation_exposes_active_dependant_microtasks(self):
        self.pair()
        # A-U109c: (a) claim first, then satisfy dependencies before activation, M3.
        self.tool("task_claim", room="demo", agent="worker", task_id="T02")
        self.assertEqual(self.next_work(), [])
        self.update("T01", state="cancelled")
        self.assertEqual(self.next_work(), self.projection()["tasks"][1]["microtasks"])
        self.tool("microtask_set", room="demo", agent="worker", id="T02.M01", state="active")
        self.assertEqual(self.next_work(), self.projection()["tasks"][1]["microtasks"])
        self.assertEqual(self.next_work()[0]["state"], "active")

    def test_A5_other_owned_dependant_is_excluded_after_cancellation(self):
        self.pair()
        self.update("T01", state="cancelled")
        self.tool("task_claim", room="demo", agent="other", task_id="T02")
        self.assertEqual(self.next_work(), [])

    def test_A4_cancellation_appends_only_the_requested_event(self):
        self.pair()
        before = copy.deepcopy(self.projection())
        log = self.home / "rooms/demo/events.jsonl"
        events_before = log.read_text().splitlines()
        self.update("T01", state="cancelled")
        after = self.projection()
        events_after = log.read_text().splitlines()
        self.assertEqual(len(events_after), len(events_before) + 1)
        operation = json.loads(events_after[-1])["op"]
        self.assertEqual(operation["kind"], "task.set")
        self.assertEqual(operation["state"], "cancelled")
        self.assertEqual(after["tasks"][0]["microtasks"], before["tasks"][0]["microtasks"])
        for key in ("tasks_done", "micro_done", "progress", "progress_pct"):
            self.assertEqual(after["rollup"][key], before["rollup"][key])

    def test_M3_owned_before_free_order_limits_and_active_microtasks(self):
        micros = [{"text": "First"}, {"text": "Second"}]
        self.create([task("free", microtasks=micros), task("own", microtasks=micros),
                     task("other"), task("blocked"), task("done"), task("cancelled")])
        self.tool("task_claim", room="demo", agent="worker", task_id="T02")
        self.tool("task_claim", room="demo", agent="other", task_id="T03")
        self.update("T04", state="blocked")
        # A-U109c: (a) only the assignee may complete a microtask, M3.
        self.tool("task_claim", room="demo", agent="owner", task_id="T05")
        self.tool("microtask_set", room="demo", agent="owner", id="T05.M01", state="done")
        self.update("T06", state="cancelled")
        # A-U109c: (a) active work belongs to the querying owner; release resets it, M3/M5.
        self.tool("microtask_set", room="demo", agent="worker", id="T02.M02", state="active")
        self.assertEqual(self.next_work()[1]["state"], "active")
        expected = ["T02.M01", "T02.M02", "T01.M01", "T01.M02"]
        self.assertEqual([m["id"] for m in self.next_work()], expected)
        for limit in (0, 1, 3):
            self.assertEqual([m["id"] for m in self.next_work(limit=limit)], expected[:limit])

    def test_M3_dependency_depth_precedes_task_id_order(self):
        self.create([task("downstream", deps=["prerequisite"]), task("free"), task("prerequisite")])
        # A-U109c: (a) completing the prerequisite requires a legitimate claim, M3.
        self.tool("task_claim", room="demo", agent="owner", task_id="T03")
        self.tool("microtask_set", room="demo", agent="owner", id="T03.M01", state="done")
        self.assertEqual([m["id"] for m in self.next_work()], ["T02.M01", "T01.M01"])
