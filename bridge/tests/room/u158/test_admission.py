"""Real transport/journal oracle for terminal work admission.

Persona evidence [MEASURED]: deploy `owner-b` run `admission-run`; record `failed`; add fresh task T02; `work_acquire` is refused, but `task_claim(T02)` and `microtask_set(T02.M01, active)` succeed without redeployment.
"""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from bridge.room import app, family, mcp, store
from bridge.room import __main__ as cli

HERE = Path(__file__).resolve().parent
MESSAGE = "not_conformant: terminal agent requires a fresh deployment with a new run_id"


class AdmissionCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        environment = {k: v for k, v in os.environ.items() if not k.startswith("CW_")}
        environment.update(CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        self.enterContext(patch.dict(os.environ, environment, clear=True))
        self.api("plan_create", agent="planner", template_id="blank", title="Admission",
                 brief={"goal": "Verify terminal work admission"}, strict=False,
                 tasks=[dict(key="first", **self.task_input())])

    @staticmethod
    def task_input():
        return dict(title="Ready work", type="task", phase="execute", accept="Verified",
                    microtasks=[{"text": "Execute"}, {"text": "Verify"}])

    def api(self, tool, agent="owner-b", **args):
        return app.dispatch(tool, dict(room="demo", agent=agent, **args))["untrusted"]

    def journal(self):
        return (self.home / "rooms/demo/events.jsonl").read_bytes()

    def projection(self):
        state = self.api("plan_get")
        self.assertEqual(state["rejected"], [])
        return state

    def lifecycle(self, state, run_id="admission-run"):
        return self.api("agent_lifecycle", state=state, run_id=run_id)

    def terminal(self, state="failed"):
        self.lifecycle("deployed")
        self.lifecycle(state)
        self.api("task_add", agent="planner", **self.task_input())

    def transport(self, transport, tool, **args):
        args = dict(room="demo", agent="owner-b", **args)
        if transport == "direct":
            try:
                return app.dispatch(tool, args)["untrusted"]
            except store.RoomError as exc:
                return dict(ok=False, code=exc.code, detail=str(exc))
        out, err = io.StringIO(), io.StringIO()
        if transport == "cli":
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                status = cli.main(["call", tool, "--json", json.dumps(args)])
            self.assertEqual(err.getvalue(), "")
            result = json.loads(out.getvalue())
            result = result.get("untrusted", result)
            self.assertEqual(status, 3 if result.get("ok") is False else 0)
            return result
        self.assertEqual(transport, "mcp")
        messages = [
            {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
             "params": {"name": tool, "arguments": args}},
        ]
        inp = io.TextIOWrapper(io.BytesIO("".join(json.dumps(value) + "\n" for value in messages).encode()), encoding="utf-8")
        with patch.object(sys, "stdin", inp), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            mcp.main()
        self.assertEqual(err.getvalue(), "")
        response = next(json.loads(line) for line in out.getvalue().splitlines()
                        if json.loads(line).get("id") == 1)
        self.assertNotIn("error", response)
        result = json.loads(response["result"]["content"][0]["text"])
        result = result.get("untrusted", result)
        self.assertEqual(response["result"]["isError"], result.get("ok") is False)
        return result

    def assert_refused(self, tool="task_claim", transport="direct", **args):
        before, projection = self.journal(), copy.deepcopy(self.projection())
        result = self.transport(transport, tool, **args)
        self.assertEqual(result, dict(ok=False, code="not_conformant", detail=MESSAGE),
                         "terminal work admission was bypassed")
        self.assertEqual(self.journal(), before, "refusal appended journal bytes")
        self.assertEqual(self.projection(), projection, "refusal changed folded state")

    def mailbox(self, kind, payload=None, identity="mailbox-0001"):
        endpoint = self.home / "family/board"
        spool = endpoint / "spool"
        spool.mkdir(parents=True, exist_ok=True)
        (endpoint / "config.json").write_text(json.dumps(dict(
            endpoint="board", rooms=["demo"], sources=["harness"], slice=1)))
        envelope = dict(schema="tasklight.family/1", id=identity, source="harness", target="board",
                        room="demo", agent="owner-b", run_id="admission-run", kind=kind,
                        payload=payload or {})
        (spool / (identity + ".json")).write_text(json.dumps(envelope))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            status = family.main(["drain", "--endpoint", "board"])
        self.assertEqual(status, 0, err.getvalue())
        return json.loads((spool / (identity + ".result.json")).read_text())["result"]

    def test_persona_reproduction_verbatim(self):
        self.terminal()
        self.assert_refused("work_acquire", transport="mcp")
        self.assert_refused(task_id="T02", transport="mcp")
        self.assert_refused("microtask_set", transport="mcp", id="T02.M01", state="active")

    def test_mailbox_terminal_cannot_be_bypassed_by_claim(self):
        self.lifecycle("deployed")
        result = self.mailbox("agent.failed")
        self.assertIs(result["untrusted"]["ok"], True)
        self.assert_refused(task_id="T01")
        # Planning deliveries are absent at slice:1; keep their existing refusal.
        before = self.journal()
        denied = self.mailbox("task.claim", {"task_id": "T01"}, "mailbox-0002")
        self.assertIs(denied["ok"], False)
        self.assertEqual(denied["code"], "bad_args")
        self.assertEqual(self.journal(), before)

    def test_unregistered_legacy_behaviour_is_preserved(self):
        self.api("task_claim", task_id="T01")
        self.api("microtask_set", id="T01.M01", state="active")
        self.api("microtask_set", id="T01.M01", state="done", outcome="Verified")
        self.api("task_release", task_id="T01")
        self.terminal()
        self.assert_refused(task_id="T02")

    def test_only_new_deployment_run_readmits(self):
        self.terminal()
        self.assert_refused(task_id="T02")
        self.lifecycle("alive")
        self.assert_refused(task_id="T02")
        with self.assertRaises(store.RoomError) as refusal:
            self.lifecycle("deployed")
        self.assertEqual(refusal.exception.code, "not_conformant")
        self.assert_refused(task_id="T02")
        self.lifecycle("deployed", run_id="successor-run")
        self.api("task_claim", task_id="T02")
        self.api("microtask_set", id="T02.M01", state="active")
        self.api("microtask_set", id="T02.M01", state="done", outcome="Verified")
        self.assertEqual(self.projection()["tasks"][1]["assignee"], "owner-b")

    def test_accepted_operation_ids_replay_after_terminal(self):
        self.lifecycle("deployed")
        requests = [
            ("task_claim", dict(task_id="T01", op_id="accepted-claim")),
            ("microtask_set", dict(id="T01.M01", state="active", op_id="accepted-active")),
            ("microtask_set", dict(id="T01.M01", state="done", outcome="Verified", op_id="accepted-done")),
        ]
        original = [self.api(tool, **args) for tool, args in requests]
        self.lifecycle("failed")
        self.assert_refused(task_id="T01", op_id="fresh-claim")
        before = self.journal()
        for (tool, args), first in zip(requests, original):
            replay = self.api(tool, **args)
            self.assertIs(replay.pop("replayed"), True)
            first.pop("replayed", None)
            self.assertEqual(replay, first)
        self.assertEqual(self.journal(), before)
        changed = self.transport("direct", "task_claim", task_id="T02", op_id="accepted-claim")
        self.assertEqual(changed["code"], "bad_op")
        self.assertEqual(self.journal(), before)

    def test_nonassigning_update_and_next_work_keep_their_contract(self):
        self.terminal()
        self.assert_refused(task_id="T02")
        before = self.journal()
        listed = self.api("next_work")
        self.assertTrue(listed["items"])
        self.assertEqual(self.journal(), before)
        task = self.projection()["tasks"][1]
        self.api("task_update", task_id="T02", base_rev=task["rev"], title="Metadata only")
        self.assertIsNone(self.projection()["tasks"][1]["assignee"])
        before = self.journal()
        result = self.transport("direct", "task_update", task_id="T02",
                                base_rev=task["rev"], assignee="owner-b")
        self.assertEqual(result["code"], "bad_op")
        result = self.transport("direct", "next_work", claim=True)
        self.assertEqual(result["code"], "bad_op")
        self.assertEqual(self.journal(), before)

    def test_negative_removing_task_claim_guard_turns_oracle_red(self):
        self.terminal()
        self.assert_refused(task_id="T02")
        original = app._post_one

        def unguarded(room, agent, op, *, args=None):
            if op["kind"] == "task.claim":
                return store.post(room, agent, "op", "", op=op)
            return original(room, agent, op, args=args)

        with patch.object(app, "_post_one", side_effect=unguarded):
            with self.assertRaisesRegex(AssertionError, "terminal work admission was bypassed"):
                self.assert_refused(task_id="T02")
        self.assertEqual(self.projection()["tasks"][1]["assignee"], "owner-b")

    def test_terminal_wins_between_request_and_writer_lock(self):
        self.lifecycle("deployed")
        waiting, resume = threading.Event(), threading.Event()
        lock = store._lock.lock_exclusive

        def delayed(fd, *args, **kwargs):
            if threading.current_thread().name.startswith("claim") and not waiting.is_set():
                waiting.set()
                if not resume.wait(5):
                    raise AssertionError("claim was not resumed")
            return lock(fd, *args, **kwargs)

        with patch.object(store._lock, "lock_exclusive", side_effect=delayed):
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix="claim") as pool:
                future = pool.submit(self.transport, "direct", "task_claim", task_id="T01")
                try:
                    self.assertTrue(waiting.wait(5), "claim never reached the journal lock")
                    self.lifecycle("failed")
                    before = self.journal()
                finally:
                    resume.set()
                result = future.result(timeout=5)
        self.assertEqual(result, dict(ok=False, code="not_conformant", detail=MESSAGE),
                         "terminal work admission was bypassed")
        self.assertEqual(self.journal(), before)
        self.assertIsNone(self.projection()["tasks"][0]["assignee"])

    def test_claim_wins_before_terminal_and_cleanup_releases_once(self):
        self.lifecycle("deployed")
        holding, terminal_waiting, resume = (threading.Event() for _ in range(3))
        apply_op, lock = store.apply_op_event, store._lock.lock_exclusive

        def pause(state, event, **kwargs):
            if event["op"]["kind"] == "task.claim":
                holding.set()
                if not resume.wait(5):
                    raise AssertionError("claim was not resumed")
            return apply_op(state, event, **kwargs)

        def observe_lock(fd, *args, **kwargs):
            if threading.current_thread().name.startswith("terminal"):
                terminal_waiting.set()
            return lock(fd, *args, **kwargs)

        with patch.object(store, "apply_op_event", side_effect=pause), \
             patch.object(store._lock, "lock_exclusive", side_effect=observe_lock):
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix="claim") as claim_pool, \
                 ThreadPoolExecutor(max_workers=1, thread_name_prefix="terminal") as terminal_pool:
                claim = claim_pool.submit(self.transport, "direct", "task_claim", task_id="T01")
                try:
                    self.assertTrue(holding.wait(5), "claim did not reach the locked fold")
                    terminal = terminal_pool.submit(self.lifecycle, "failed")
                    self.assertTrue(terminal_waiting.wait(5))
                finally:
                    resume.set()
                self.assertNotEqual(claim.result(timeout=5).get("ok"), False)
                terminal.result(timeout=5)
        self.assert_refused(task_id="T01")
        events = [json.loads(line) for line in self.journal().splitlines()]
        kinds = [event.get("op", {}).get("kind") for event in events]
        self.assertEqual(kinds.count("task.claim"), 1)
        self.assertEqual(kinds.count("task.release"), 1)
        self.assertIsNone(self.projection()["tasks"][0]["assignee"])


    def _race_work_terminal(self, tool, *, work_first):
        self.lifecycle("deployed")
        args = dict(run_id="admission-run", op_id="racing-work")
        if tool == "work_report":
            acquired = self.api("work_acquire", run_id="admission-run", op_id="setup-acquire")
            proof = self.home / "proof.txt"
            proof.write_text("Verified work")
            args.update(task_id="T01", claim_lamport=acquired["claim_lamport"],
                        done=[dict(id="T01.M01", outcome="Verified", evidence=[str(proof)])])
        before_count = len(self.journal().splitlines())
        waiting, resume, terminal_waiting, writer_unlocked, terminal_done = (
            threading.Event() for _ in range(5))
        committing = threading.local()
        post_ops = store.post_ops
        lock, unlock = store._lock.lock_exclusive, store._lock.unlock

        def wait(event, message):
            if not event.wait(5):
                raise AssertionError(message)

        def commit(*values, **kwargs):
            committing.active = True
            try:
                return post_ops(*values, **kwargs)
            finally:
                committing.active = False

        def ordered_lock(fd, *values, **kwargs):
            is_work = threading.current_thread().name.startswith("work-race")
            if is_work and getattr(committing, "active", False) and not waiting.is_set():
                if work_first:
                    lock(fd, *values, **kwargs)
                waiting.set()
                wait(resume, "work writer was not resumed")
                if work_first:
                    return
            elif threading.current_thread().name.startswith("terminal-race"):
                terminal_waiting.set()
                wait(writer_unlocked, "work writer did not release its lock")
            elif is_work and work_first and writer_unlocked.is_set():
                # Serialize response snapshots behind terminal cleanup as well;
                # no lock retry sleeps are needed for either deterministic order.
                wait(terminal_done, "terminal cleanup did not finish")
            return lock(fd, *values, **kwargs)

        def observe_unlock(fd):
            unlock(fd)
            if getattr(committing, "active", False):
                writer_unlocked.set()

        def fail_agent():
            try:
                return self.lifecycle("failed")
            finally:
                terminal_done.set()

        with patch.object(store, "post_ops", side_effect=commit), \
             patch.object(store._lock, "lock_exclusive", side_effect=ordered_lock), \
             patch.object(store._lock, "unlock", side_effect=observe_unlock), \
             patch.object(store._lock.time, "sleep", side_effect=AssertionError("lock retry sleep")):
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix="work-race") as work_pool, \
                 ThreadPoolExecutor(max_workers=1, thread_name_prefix="terminal-race") as terminal_pool:
                work = work_pool.submit(self.transport, "direct", tool, **args)
                try:
                    wait(waiting, "work did not reach the batch writer lock")
                    if work_first:
                        terminal = terminal_pool.submit(fail_agent)
                        wait(terminal_waiting, "terminal did not reach the writer lock")
                    else:
                        self.lifecycle("failed")
                        terminal_bytes = self.journal()
                finally:
                    resume.set()
                if work_first:
                    terminal.result(timeout=5)
                result = work.result(timeout=5)

        events = [json.loads(line) for line in self.journal().splitlines()]
        self.assertEqual([event["lamport"] for event in events], list(range(1, len(events) + 1)))
        self.assertEqual(len({event["id"] for event in events}), len(events))
        appended = events[before_count:]
        terminals = [event for event in appended
                     if event.get("op", {}).get("kind") == "agent.lifecycle"
                     and event["op"].get("state") == "failed"]
        self.assertEqual(len(terminals), 1)
        batch = [event for event in appended if event.get("batch", {}).get("op_id") == args["op_id"]]
        if work_first:
            self.assertIsNot(result.get("ok"), False, result)
            self.assertEqual([event["op"]["kind"] for event in batch],
                             ["task.claim", "micro.set"] if tool == "work_acquire"
                             else ["task.set", "micro.set", "micro.set"])
            self.assertEqual([event["lamport"] for event in batch],
                             list(range(before_count + 1, before_count + 1 + len(batch))))
            self.assertLess(batch[-1]["lamport"], terminals[0]["lamport"])
            if tool == "work_acquire":
                self.assertEqual(result["task"]["id"], "T01")
            else:
                self.assertEqual(result["done"], ["T01.M01"])
                self.assertEqual(result["active"], "T01.M02")
            before_replay = self.journal()
            replay = self.api(tool, **args)
            self.assertEqual({k: v for k, v in replay.items() if k != "replayed"},
                             {k: v for k, v in result.items() if k != "replayed"})
            self.assertEqual(self.journal(), before_replay)
        else:
            self.assertEqual(result, dict(ok=False, code="not_conformant", detail=MESSAGE),
                             "terminal work admission was bypassed")
            self.assertEqual(batch, [])
            self.assertEqual(self.journal(), terminal_bytes, "refused batch appended journal bytes")
        releases = [event for event in appended if event.get("op", {}).get("kind") == "task.release"]
        self.assertEqual(len(releases), int(work_first or tool == "work_report"))
        projection = self.projection()
        self.assertEqual(projection["agent_lifecycle"]["owner-b"]["lifecycle"], "failed")
        self.assertIsNone(projection["tasks"][0]["assignee"])
        if tool == "work_report":
            self.assertEqual(projection["tasks"][0]["microtasks"][0]["state"],
                             "done" if work_first else "pending")

    def test_terminal_wins_before_work_acquire_writer_lock(self):
        self._race_work_terminal("work_acquire", work_first=False)

    def test_work_acquire_wins_before_terminal_writer_lock(self):
        self._race_work_terminal("work_acquire", work_first=True)

    def test_terminal_wins_before_work_report_writer_lock(self):
        self._race_work_terminal("work_report", work_first=False)

    def test_work_report_wins_before_terminal_writer_lock(self):
        self._race_work_terminal("work_report", work_first=True)


def refusal_case(transport, terminal, tool, args):
    def test(self):
        self.terminal(terminal)
        reference = self.transport(transport, "work_acquire")
        self.assertEqual(reference, dict(ok=False, code="not_conformant", detail=MESSAGE))
        self.assert_refused(tool, transport=transport, **args)
    return test


for _transport in ("mcp", "cli"):
    for _terminal in ("failed", "finished"):
        for _label, _tool, _args in (
            ("claim", "task_claim", dict(task_id="T02")),
            ("takeover", "task_claim", dict(task_id="T02", takeover=True)),
            ("active", "microtask_set", dict(id="T02.M01", state="active")),
            ("done", "microtask_set", dict(id="T02.M01", state="done", outcome="Verified")),
        ):
            setattr(AdmissionCase, "test_%s_%s_%s" % (_transport, _terminal, _label),
                    refusal_case(_transport, _terminal, _tool, _args))
