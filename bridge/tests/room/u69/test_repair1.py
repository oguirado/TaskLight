"""Regression coverage for script bootstrap precedence and shared dependencies."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from bridge.room import mcp

ROOT = Path(__file__).resolve().parents[4]


class Repair1(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="u69-repair-")
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.env = dict(os.environ, CW_HOME=str(self.tmp / "home"),
                        PYTHONDONTWRITEBYTECODE="1", PYTHONPATH=str(ROOT))
        environment = patch.dict(os.environ, self.env)
        environment.start()
        self.addCleanup(environment.stop)

    def child(self, messages, timeout=10):
        return subprocess.run(
            [sys.executable, str(ROOT / "bridge/room/mcp.py")],
            cwd=self.tmp, env=self.env,
            input=b"".join((json.dumps(message) + "\n").encode("utf-8")
                           for message in messages),
            capture_output=True, timeout=timeout)

    def test_script_moves_existing_root_to_front(self):
        # Observe the actual script's path immediately before its first bridge import.
        # sitecustomize is confined to this child and restores the original importer.
        (self.tmp / "sitecustomize.py").write_text(
            "import builtins, json, sys\n"
            "original = builtins.__import__\n"
            "def observe(name, *args, **kwargs):\n"
            "    if name == 'bridge' or name.startswith('bridge.'):\n"
            "        sys.stderr.write(json.dumps(sys.path) + '\\n')\n"
            "        builtins.__import__ = original\n"
            "    return original(name, *args, **kwargs)\n"
            "builtins.__import__ = observe\n", encoding="utf-8")
        self.env["PYTHONPATH"] = os.pathsep.join(
            [str(self.tmp), str(ROOT), str(ROOT)])
        messages = [dict(jsonrpc="2.0", id=i, method=method)
                    for i, method in enumerate(("initialize", "tools/list"), 1)]
        child = self.child(messages)
        self.assertEqual(child.returncode, 0, child.stderr)
        observed = json.loads(child.stderr.decode("utf-8"))
        self.assertEqual(observed[0], str(ROOT))
        self.assertEqual(observed.count(str(ROOT)), 1)
        replies = [json.loads(line) for line in child.stdout.splitlines()]
        self.assertEqual(replies[0]["result"]["serverInfo"]["name"], "tasklight")
        self.assertEqual(len(replies[1]["result"]["tools"]), 22)

    @staticmethod
    def reference(tasks, agent, limit=None):
        by_id = {task["id"]: task for task in tasks}

        def depth(task):
            return max((1 + depth(by_id[dep]) for dep in task["deps"]), default=0)

        # Readiness and ownership do not depend on depth. Filter first so the
        # deliberately brute-force reference visits only relevant dependency paths.
        eligible = [task for task in tasks
                    if task["ready"]
                    and task["state"] not in ("done", "cancelled", "blocked")
                    and task.get("explicit_state") not in ("cancelled", "blocked")
                    and task.get("assignee") in (None, agent)]
        eligible.sort(key=lambda task: (task.get("assignee") != agent,
                                        depth(task), task["id"]))
        items = [micro for task in eligible for micro in task["microtasks"]
                 if micro["state"] in ("pending", "active")]
        return {"items": items if limit is None else items[:limit]}

    def test_dense_dependencies_complete_with_reference_result(self):
        tasks = [dict(key=f"k{i}", title=f"Task {i}", type="feature",
                      phase="discovery", accept="Verified",
                      deps=[f"k{j}" for j in range(max(0, i - 8), i)],
                      microtasks=[dict(text="Check")]) for i in range(40)]
        mcp._do_plan_create(dict(room="repair", agent="alice",
                                 template_id="web-app", title="Dense dependencies",
                                 brief=dict(goal="Deliver", users="Agents", stack="Python"),
                                 tasks=tasks))
        projection = mcp._do_plan_get(dict(room="repair"))
        expected = self.reference(projection["tasks"], "alice")
        self.assertEqual([item["id"] for item in expected["items"]], ["T01.M01"])
        message = dict(jsonrpc="2.0", id=1, method="tools/call",
                       params=dict(name="next_work",
                                   arguments=dict(room="repair", agent="alice")))
        started = time.monotonic()
        try:
            child = self.child([message], timeout=2)
        except subprocess.TimeoutExpired:
            self.fail("next_work exceeded the two-second dense dependency deadline")
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(child.returncode, 0, child.stderr)
        result = json.loads(child.stdout)["result"]
        self.assertFalse(result["isError"], result)
        self.assertEqual(json.loads(result["content"][0]["text"])["untrusted"], expected)

    def test_reference_preserves_order_ownership_readiness_and_limits(self):
        tasks = [dict(id=f"T{i:02}", deps=[], ready=True, state="pending",
                      assignee=None, microtasks=[dict(id=f"T{i:02}.M01", state="pending")])
                 for i in range(1, 9)]
        tasks[2].update(deps=["T01"], assignee="alice")
        tasks[3]["assignee"] = "bob"
        tasks[4]["ready"] = False
        tasks[5]["state"] = "done"
        tasks[6]["explicit_state"] = "blocked"
        tasks[7]["microtasks"][0]["state"] = "blocked"
        with patch.object(mcp, "_fold", return_value=dict(plan=dict(state="active"), tasks=tasks)):
            for agent in ("alice", "bob"):
                for limit in (None, 0, 1, 2, 20):
                    with self.subTest(agent=agent, limit=limit):
                        args = dict(room="repair", agent=agent)
                        if limit is not None:
                            args["limit"] = limit
                        self.assertEqual(mcp._do_next_work(args),
                                         self.reference(tasks, agent, limit))
