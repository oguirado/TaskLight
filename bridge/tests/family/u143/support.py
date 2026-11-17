"""Bounded mailbox fixtures; the admission seam is never production evidence."""
import copy
import hashlib
import io
import itertools
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from unittest import mock

from bridge.room import app, family

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
LEGACY = frozenset({"capabilities", "events.read", "agent.deployed", "agent.alive",
                    "agent.finished", "agent.failed"})
NEW = frozenset({"agent.activity", "agent.plan", "work.acquire", "work.report",
                 "task.claim", "task.release", "task.update", "microtask.update",
                 "plan.phase", "plan.close"})


def task_input(key=None):
    value = dict(title="Verify a bounded fixture", type="task", phase="execute",
                 accept="Verified", microtasks=[{"text": "Produce"}, {"text": "Verify"}])
    if key is not None:
        value["key"] = key
    return value


def plan_input():
    return dict(template_id="blank", title="Mailbox oracle",
                brief={"goal": "Verify transport parity"}, strict=False,
                tasks=[task_input("first")])


# Labels become public, independently discoverable unittest names.
ROUTES = (
    ("agent_activity", "agent.activity", "activity_beat",
     {"task_id": "T01", "micro_id": "T01.M01", "note": "Observed"}),
    ("agent_plan", "agent.plan", "plan_create", {"tool": "plan_create", "args": plan_input()}),
    ("work_acquire", "work.acquire", "work_acquire", {"prefer_task": "T01"}),
    ("work_report", "work.report", "work_report",
     {"task_id": "T01", "claim_lamport": 7,
      "done": [{"id": "T01.M01", "outcome": "Verified", "evidence": []}]}),
    ("task_claim", "task.claim", "task_claim", {"task_id": "T01", "base_rev": 7}),
    ("task_release", "task.release", "task_release", {"task_id": "T01", "claim_lamport": 7}),
    ("task_update", "task.update", "task_update",
     {"task_id": "T01", "base_rev": 7, "title": "Revised"}),
    ("microtask_update", "microtask.update", "microtask_set",
     {"id": "T01.M01", "state": "active", "claim_lamport": 7}),
    ("plan_phase", "plan.phase", "plan_phase", {"phase": "execute", "base_rev": 7}),
    ("plan_close", "plan.close", "plan_close", {"base_rev": 7, "outcome": "Verified"}),
)
PLAN_ROUTES = (
    ("agent_plan_task_add", "agent.plan", "task_add", {"tool": "task_add", "args": task_input()}),
    ("agent_plan_microtask_add", "agent.plan", "microtask_add",
     {"tool": "microtask_add", "args": {"task_id": "T01", "base_rev": 7, "text": "Check"}}),
)


def request(kind="agent.plan", payload=None, *, identity="request-0001", generation=11, **changes):
    value = dict(schema="tasklight.family/1", id=identity, source="harness", target="board",
                 room="demo", agent="executor-a", run_id="run-a", kind=kind,
                 payload=copy.deepcopy(payload if payload is not None else
                                       {"tool": "plan_create", "args": plan_input()}))
    if kind in NEW and not (kind == "agent.plan" and value["payload"].get("tool") == "plan_create"):
        value["plan_opened"] = generation
    value.update(changes)
    return value


def op_identity(value):
    raw = "\0".join(value[key] for key in ("source", "target", "id")).encode("utf-8")
    return "fam-" + hashlib.sha256(raw).hexdigest()[:44]


def expected_call(value, tool):
    payload = value["payload"]["args"] if value["kind"] == "agent.plan" else value["payload"]
    args = dict(copy.deepcopy(payload), room=value["room"], agent=value["agent"],
                op_id=op_identity(value))
    if "plan_opened" in value:
        args["expected_opened_lamport"] = value["plan_opened"]
    if value["kind"] in {"agent.activity", "work.acquire", "work.report"}:
        args["run_id"] = value["run_id"]
    return tool, args


class MailboxCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".runtime-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / "home"
        self.mailbox = self.home / "family" / "board"
        self.spool = self.mailbox / "spool"
        self.spool.mkdir(parents=True)
        self.config = dict(endpoint="board", rooms=["demo"], sources=["harness"], slice=1)
        self.configure()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        env = {key: value for key, value in os.environ.items() if not key.startswith("CW_")}
        env["CW_HOME"] = str(self.home)
        self.stack.enter_context(mock.patch.dict(os.environ, env, clear=True))
        self.stack.enter_context(mock.patch.object(time, "time", return_value=1700000000.0))
        self.stack.enter_context(mock.patch.object(time, "monotonic", return_value=100.0))
        self.stack.enter_context(mock.patch.object(time, "sleep", side_effect=AssertionError("real timers forbidden")))
        tokens = itertools.count(1)
        self.stack.enter_context(mock.patch.object(secrets, "token_hex",
            side_effect=lambda size: format(next(tokens), "0%dx" % (2 * size))))
        for name in ("socket", "create_connection", "socketpair"):
            self.stack.enter_context(mock.patch.object(socket, name, side_effect=AssertionError("network forbidden")))
        self.stack.enter_context(mock.patch.object(subprocess, "Popen", side_effect=AssertionError("process launch forbidden")))

    def configure(self, **changes):
        self.config.update(changes)
        (self.mailbox / "config.json").write_text(json.dumps(self.config), encoding="utf-8")

    def publish(self, value):
        # Exercise the actual mailbox, including producer publication boundaries.
        final = self.spool / (value["id"] + ".json")
        temporary = final.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, final)
        fd = os.open(self.spool, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return final

    def invoke(self, *, admitted=False):
        out, err = io.StringIO(), io.StringIO()
        with ExitStack() as stack, redirect_stdout(out), redirect_stderr(err):
            if admitted:
                self.assertEqual(self.config["slice"], 2, "admission fixture requires explicit slice:2")
                # There is no public ADMIT receipt format. Replace only the
                # existing startup availability seam; never invent a config key
                # or patch validation, authorization, dispatch, dedup, or commit.
                stack.enter_context(mock.patch.object(family, "_available_kinds", return_value=LEGACY | NEW))
            code = family.main(["drain", "--endpoint", "board"])
        self.stdout, self.stderr = out.getvalue(), err.getvalue()
        return code

    def receipt_path(self, value):
        return self.spool / (value["id"] + ".result.json")

    def receipt(self, value):
        path = self.receipt_path(value)
        self.assertTrue(path.is_file(), "mailbox must publish a result")
        receipt = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(receipt["schema"], "tasklight.family/1")
        self.assertEqual(receipt["id"], value["id"])
        return receipt["result"]

    def success(self, value, *, admitted=True):
        self.publish(value)
        self.assertEqual(self.invoke(admitted=admitted), 0, self.stderr)
        result = self.receipt(value)
        self.assertIn("untrusted", result, "%s must reach its backend; received %r" % (value["kind"], result))
        self.assertIsNot(result["untrusted"].get("ok"), False)
        return result["untrusted"]

    def journal_bytes(self):
        directory = self.home / "rooms"
        return {str(path.relative_to(self.home)): path.read_bytes()
                for path in directory.rglob("events.jsonl")} if directory.exists() else {}

    def spy(self):
        return mock.patch.object(app, "dispatch", return_value={"untrusted": {"ok": True, "marker": "backend"}})
