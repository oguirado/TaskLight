"""Real backend fixtures and transport entries; only clocks and I/O are faked."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from bridge.room import app, hook, mcp
from bridge.room import __main__ as cli
from bridge.room import family

HERE = Path(__file__).resolve().parent
TRANSPORTS = ("hook", "mcp", "cli", "mailbox")
TERMINALS = ("failed", "finished")


class Crash(BaseException):
    """A synthetic process death that ordinary product handlers cannot swallow."""


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def unwrap(value):
    return value.get("untrusted", value)


class TerminalCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.now = 100.0
        self.seq = 0
        stack = self.enterContext(contextlib.ExitStack())
        env = {k: v for k, v in os.environ.items() if not k.startswith("CW_")}
        env.update(CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        stack.enter_context(mock.patch.dict(os.environ, env, clear=True))
        stack.enter_context(mock.patch.object(time, "time", side_effect=lambda: 1700000000 + self.now))
        stack.enter_context(mock.patch.object(time, "monotonic", side_effect=lambda: self.now))
        stack.enter_context(mock.patch.object(time, "sleep", side_effect=AssertionError("real waits forbidden")))
        for name in ("socket", "create_connection", "socketpair"):
            stack.enter_context(mock.patch.object(socket, name, side_effect=AssertionError("network forbidden")))
        stack.enter_context(mock.patch.object(subprocess, "Popen", side_effect=AssertionError("child processes forbidden")))
        # Exercise the real hook deadline code, but never arm an operating-system timer.
        stack.enter_context(mock.patch.object(signal, "signal", return_value=signal.SIG_DFL))
        stack.enter_context(mock.patch.object(signal, "setitimer", return_value=(0.0, 0.0)))
        stack.enter_context(mock.patch.object(signal, "alarm", return_value=0))

    @property
    def room(self):
        return Path(os.environ["CW_HOME"]) / "rooms" / "demo"

    def journal(self):
        path = self.room / "events.jsonl"
        return path.read_bytes() if path.exists() else b""

    def events(self):
        return [json.loads(line) for line in self.journal().splitlines() if line.strip()]

    def api(self, name, agent="exec-a", **args):
        self.seq += 1
        args.setdefault("op_id", "fixture-%08d" % self.seq)
        if name == "plan_get":
            args.pop("op_id")
        result = unwrap(app.dispatch(name, dict(room="demo", agent=agent, **args)))
        self.assertIsNot(result.get("ok"), False, result)
        return result

    def projection(self):
        return self.api("plan_get")

    def seed(self):
        self.api("memory_set", section="goal", text="Verify terminal cleanup", base_rev=0)
        self.api("agent_lifecycle", state="deployed", run_id="run-old")
        created = self.api("plan_create", template_id="blank", title="Terminal cleanup",
            brief={"goal": "Verify terminal cleanup"}, strict=False,
            tasks=[dict(key=key, title=key, type="task", phase="execute",
                        accept="Verified", deps=[], microtasks=[{"text": "Work"}, {"text": "Keep outcome"}])
                   for key in ("pending", "active", "blocked", "other", "done", "cancelled")])
        self.ids = created["ids"]
        proof = self.home / "evidence.txt"
        proof.write_text("Deterministic cleanup evidence\n")
        for key, task_id in self.ids.items():
            agent = "other" if key == "other" else "exec-a"
            self.api("task_claim", agent=agent, task_id=task_id)
            if key in ("active", "other"):
                self.api("microtask_set", agent=agent, id=task_id + ".M01", state="active")
            if key in ("active", "done"):
                self.api("microtask_set", agent=agent, id=task_id + ".M02", state="done",
                         outcome="Keep this outcome", took="1m", evidence=[str(proof)])
            if key == "done":
                self.api("microtask_set", agent=agent, id=task_id + ".M01", state="done",
                         outcome="Already complete", took="1m")
            if key in ("blocked", "cancelled"):
                task = next(t for t in self.projection()["tasks"] if t["id"] == task_id)
                self.api("task_update", task_id=task_id, base_rev=task["rev"], state=key,
                         reason="Preserve this reason")
        projection = self.projection()
        self.eligible = {self.ids[key] for key in ("pending", "active", "blocked")}
        self.assertEqual({t["state"] for t in projection["tasks"] if t["id"] in self.eligible},
                         {"pending", "active", "blocked"}, "fixture must distinguish eligible states")
        self.assertTrue(all(t["assignee"] == "exec-a" for t in projection["tasks"] if t["id"] in self.eligible))
        return copy.deepcopy(projection)

    def deliver(self, transport, state, *, identity="terminal-0001", run_id="run-old"):
        args = dict(room="demo", agent="exec-a", state=state, run_id=run_id, op_id=identity)
        if transport == "hook":
            value = {k: v for k, v in args.items() if k != "op_id"}
            value["event_id"] = identity
            return unwrap(hook.run_hook_bytes(encoded(value)))
        if transport == "cli":
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                status = cli.main(["call", "agent_lifecycle", "--json", encoded(args).decode()])
            self.assertIn(status, (0, 3), "valid CLI terminal request was not dispatched")
            self.assertEqual(err.getvalue(), "")
            result = unwrap(json.loads(out.getvalue()))
            self.assertEqual(status == 0, result.get("ok") is not False)
            return result
        if transport == "mcp":
            messages = [
                {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                 "params": {"name": "agent_lifecycle", "arguments": args}},
            ]
            out, err = io.StringIO(), io.StringIO()
            inp = io.TextIOWrapper(io.BytesIO(b"\n".join(encoded(v) for v in messages) + b"\n"), encoding="utf-8")
            with mock.patch.object(sys, "stdin", inp), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                status = mcp.main()
            self.assertEqual(status, 0)
            self.assertEqual(err.getvalue(), "")
            response = next(v for v in map(json.loads, out.getvalue().splitlines()) if v.get("id") == 1)
            self.assertNotIn("error", response)
            result = unwrap(json.loads(response["result"]["content"][0]["text"]))
            self.assertEqual(response["result"]["isError"], result.get("ok") is False)
            return result
        self.assertEqual(transport, "mailbox")
        endpoint = Path(os.environ["CW_HOME"]) / "family" / "board"
        pending = endpoint / "spool"
        pending.mkdir(parents=True, exist_ok=True)
        (endpoint / "config.json").write_bytes(encoded(dict(endpoint="board", rooms=["demo"], sources=["harness"], slice=1)))
        envelope = dict(schema="tasklight.family/1", id=identity, source="harness", target="board",
                        kind="agent." + state, room="demo", agent="exec-a", run_id=run_id, payload={})
        # Publish a complete envelope by rename, never expose a partial request.
        staging = pending / (identity + ".pending")
        staging.write_bytes(encoded(envelope))
        staging.replace(pending / (identity + ".json"))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            status = family.main(["drain", "--endpoint", "board"])
        self.assertEqual(status, 0, err.getvalue())
        self.assertEqual(err.getvalue(), "")
        receipt = json.loads((pending / (identity + ".result.json")).read_text())
        return unwrap(receipt["result"])

    def terminal(self, transport, state, **kwargs):
        result = self.deliver(transport, state, **kwargs)
        self.assertIs(result.get("ok"), True, result)
        self.assertIs(type(result.get("lamport")), int, "lifecycle receipt must remain observable")
        return result

    def assert_released(self, before):
        after = self.projection()
        old_by_id = {t["id"]: t for t in before["tasks"]}
        for task in after["tasks"]:
            old = old_by_id[task["id"]]
            if task["id"] not in self.eligible:
                self.assertEqual(task, old, "ineligible work must be preserved")
                continue
            self.assertIsNone(task["assignee"], "terminal cleanup left eligible work claimed: " + task["id"])
            self.assertIsNone(task["claim_lamport"])
            self.assertIsNone(task["claim_ts"])
            self.assertNotIn(task["state"], ("done", "cancelled"))
            for previous, current in zip(old["microtasks"], task["microtasks"]):
                self.assertEqual(current["state"], "pending" if previous["state"] == "active" else previous["state"])
                for field in ("id", "text", "outcome", "took", "evidence"):
                    self.assertEqual(current.get(field), previous.get(field), field)
        for field in ("plan", "memory", "archived_plans"):
            self.assertEqual(after[field], before[field], field)
        return after

    def assert_cleanup_receipt(self, result):
        # No key name, status vocabulary, release algorithm or receipt storage is prescribed.
        lifecycle = {"ok": result["ok"], "lamport": result["lamport"]}
        extra = {k: v for k, v in result.items() if k not in {"ok", "lamport", "replayed", "noop"}}
        self.assertTrue(extra, "terminal cleanup needs a receipt distinct from the lifecycle receipt")
        self.assertTrue(any(v is not None and v != lifecycle and type(v) is not bool for v in extra.values()),
                        "a duplicate lifecycle receipt or boolean alone is not a cleanup receipt")
        return extra

    def release_remaining(self):
        for task in self.projection()["tasks"]:
            if task["id"] in self.eligible and task["assignee"] == "exec-a":
                self.api("task_release", task_id=task["id"], base_rev=task["rev"], claim_lamport=task["claim_lamport"])

    def interrupted_delivery(self, transport, state, *, after_release):
        real_fsync = os.fsync
        interrupted = False

        def fsync(fd):
            nonlocal interrupted
            real_fsync(fd)
            path = self.room / "events.jsonl"
            if not path.exists():
                return
            opened, journal = os.fstat(fd), path.stat()
            if (opened.st_dev, opened.st_ino) != (journal.st_dev, journal.st_ino):
                return
            events = self.events()
            terminal = any(e.get("op", {}).get("kind") == "agent.lifecycle" and
                           e["op"].get("state") == state for e in events)
            released = any(e.get("op", {}).get("kind") == "task.release" for e in events)
            if not interrupted and terminal and (released if after_release else not released):
                interrupted = True
                raise Crash()

        real_dispatch = family.Mailbox.dispatch

        def dispatch(mailbox, envelope):
            try:
                return real_dispatch(mailbox, envelope)
            except Crash:
                # Backend cleanup recovery is this unit's subject. Return only this
                # fixture's own consumer lease; lease-recovery policy belongs to family.
                mailbox.release()
                raise

        try:
            with mock.patch.object(os, "fsync", side_effect=fsync), mock.patch.object(family.Mailbox, "dispatch", new=dispatch):
                self.deliver(transport, state)
        except Crash:
            pass
        self.assertTrue(interrupted, "terminal cleanup never reached the required durable crash boundary")
