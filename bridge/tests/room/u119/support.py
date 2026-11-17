"""Stdlib fixtures; all scratch files stay beside this oracle."""
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
import sys
import tempfile
import time
import unittest
from contextlib import contextmanager, redirect_stdout
from unittest.mock import patch

from bridge.plan import fold_plan
from bridge.room import app, ext, store
from bridge.room.ext import acquire


# A-FLK1: Preserve real sleeps only for direct stdlib wait callers. Product
# sleeps still fail, including product callbacks reached through stdlib frames.
_REAL_SLEEP = time.sleep


def _sleep_guard(message="real sleep forbidden"):
    def guarded_sleep(delay):
        caller_globals = sys._getframe(1).f_globals
        if any(caller_globals is vars(sys.modules[name])
               for name in ("subprocess", "threading", "selectors")
               if name in sys.modules):
            return _REAL_SLEEP(delay)
        raise AssertionError(message)
    return guarded_sleep


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
BASE_TS = 1700000000000


@contextmanager
def deterministic(home, seed="parent"):
    counter = itertools.count()
    def token_hex(size):
        value = seed + ":" + str(next(counter))
        return hashlib.sha256(value.encode()).hexdigest()[:2 * size]
    with patch.dict(os.environ, {"CW_HOME": str(home), "PYTHONDONTWRITEBYTECODE": "1"}), \
         patch.object(time, "time", return_value=BASE_TS / 1000), \
         patch.object(time, "sleep", new=_sleep_guard()), \
         patch.object(secrets, "token_hex", side_effect=token_hex), \
         patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")), \
         patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden")), \
         patch.object(socket.socket, "connect_ex", side_effect=AssertionError("network forbidden")), \
         patch.object(socket.socket, "sendto", side_effect=AssertionError("network forbidden")):
        yield


def acquire_worker(home, agent, barrier, pipe):
    try:
        with deterministic(home, agent):
            barrier.wait(timeout=15)
            result = acquire.work_acquire(dict(room="demo", agent=agent, op_id="acquire-" + agent))
            pipe.send({"result": result})
    except BaseException as exc:
        pipe.send({"error": type(exc).__name__, "detail": str(exc)})
    finally:
        pipe.close()


class WorkCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.home = self.tmp / "cw"
        self.enterContext(deterministic(self.home))
        self.template = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
        folder = self.home / "templates"
        folder.mkdir(parents=True)
        (folder / (self.template["id"] + ".json")).write_text(json.dumps(self.template))
        self.templates = {self.template["id"]: self.template}
        self.proof = self.tmp / "proof.txt"
        self.proof.write_bytes(b"bounded deterministic evidence\n")

    def make_plan(self, count=1, micros=3, deps=None, room="demo"):
        self.post({"kind": "plan.open", "title": "Oracle plan", "template_id": self.template["id"],
                   "template_hash": self.template["hash"], "brief": {"goal": "Verify work"}, "phase": "start"}, room=room)
        for number in range(1, count + 1):
            self.post({"kind": "task.add", "title": "Task " + str(number), "type": "action", "phase": "start",
                       "deps": (deps or {}).get("T%02d" % number, []),
                       "microtasks": [{"text": "Step " + str(i)} for i in range(1, micros + 1)]}, room=room)

    def path(self, room="demo"):
        return self.home / "rooms" / room / "events.jsonl"

    def raw(self, room="demo"):
        path = self.path(room)
        return path.read_bytes() if path.exists() else b""

    def events(self, room="demo"):
        return [json.loads(line) for line in self.raw(room).splitlines() if line]

    def projection(self, room="demo"):
        projection = fold_plan(self.events(room), templates=self.templates)
        self.assertEqual(projection["rejected"], [], "fixture or committed operations were rejected")
        return projection

    def task(self, tid="T01", room="demo"):
        return next(t for t in self.projection(room)["tasks"] if t["id"] == tid)

    def post(self, op, agent="alice", room="demo"):
        return store.post(room, agent, "op", "", op=copy.deepcopy(op), clock=lambda: BASE_TS, templates=self.templates)

    def claim(self, tid="T01", agent="alice", room="demo"):
        return self.post({"kind": "task.claim", "task_id": tid}, agent, room)["lamport"]

    def micro(self, mid="T01.M01", state="active", agent="alice", room="demo", **extra):
        return self.post(dict(kind="micro.set", micro_id=mid, state=state, **extra), agent, room)

    def edit(self, tid="T01", room="demo", **extra):
        return self.post(dict(kind="task.set", task_id=tid, base_rev=self.task(tid, room)["rev"], **extra), room=room)

    def acquire(self, **extra):
        args = dict(room="demo", agent="alice")
        args.update(extra)
        return acquire.work_acquire(args)

    def completion(self, mid="T01.M01", **extra):
        item = dict(id=mid, outcome="Verified", evidence=[str(self.proof)])
        item.update(extra)
        return item

    def report_args(self, **extra):
        args = dict(room="demo", agent="alice", task_id="T01", claim_lamport=self.task()["claim_lamport"],
                    done=[self.completion()])
        args.update(extra)
        return args

    def report(self, **extra):
        return acquire.work_report(self.report_args(**extra))

    def deny(self, tool, args, code, contains=()):
        before = self.raw()
        projection = self.projection()
        with self.assertRaises(store.RoomError) as caught:
            getattr(acquire, tool)(copy.deepcopy(args))
        self.assertEqual(caught.exception.code, code)
        self.assertTrue(str(caught.exception))
        for text in contains:
            self.assertIn(text, str(caught.exception))
        self.assertEqual(self.raw(), before, "rejection appended journal bytes")
        self.assertEqual(self.projection(), projection, "rejection changed folded state")
        return caught.exception

    def assert_acquired(self, result, tid="T01", agent="alice", room="demo"):
        self.assertEqual(set(result), {"task", "items", "claim_lamport"})
        task = self.task(tid, room)
        self.assertEqual(result["task"], task, "response must describe committed task")
        self.assertEqual(task["assignee"], agent)
        self.assertEqual(result["items"], [m for m in task["microtasks"] if m["state"] in ("pending", "active")])
        claims = [e for e in self.events(room) if e.get("op", {}).get("kind") == "task.claim" and e["op"]["task_id"] == tid]
        self.assertIs(type(result["claim_lamport"]), int)
        self.assertGreater(result["claim_lamport"], 0)
        self.assertEqual(result["claim_lamport"], claims[-1]["lamport"])
        self.assertEqual(task["claim_lamport"], result["claim_lamport"])

    def assert_reported(self, result, ids, active, fence):
        self.assertEqual(set(result), {"ok", "task_id", "done", "active", "lamport", "replayed"})
        self.assertIs(result["ok"], True)
        self.assertIs(result["replayed"], False)
        self.assertEqual(result["task_id"], "T01")
        self.assertEqual(result["done"], ids)
        self.assertEqual(result["active"], active)
        self.assertEqual(result["lamport"], self.events()[-1]["lamport"])
        self.assertEqual(self.task()["claim_lamport"], fence)
        self.assertEqual(self.projection()["plan"]["state"], "active")

    def assert_one_group(self, before_count, *, first_kind):
        members = self.events()[before_count:]
        self.assertTrue(members)
        self.assertEqual(members[0]["op"]["kind"], first_kind)
        self.assertEqual(members[0]["batch"]["member_ids"], [e["id"] for e in members])
        self.assertEqual([e["batch"]["seq"] for e in members], list(range(len(members))))
        for member in members:
            self.assertEqual(member["batch"]["member_ids"], members[0]["batch"]["member_ids"])
            self.assertEqual(member["batch"]["count"], len(members))

    @contextmanager
    def extension_loaded(self):
        # U132 owns the permanent module list. Exercise U119's import seam only.
        with patch.object(ext, "EXT_MODULES", ext.EXT_MODULES + (("acquire",) if "acquire" not in ext.EXT_MODULES else ())):
            app._load_extensions()
            yield

    def api(self, transport, tool, args):
        with self.extension_loaded():
            if transport == "mcp":
                from bridge.room import mcp
                sent = []
                with patch.object(mcp, "_send", side_effect=sent.append):
                    mcp._handle(1, "tools/call", {"name": tool, "arguments": args})
                self.assertEqual(len(sent), 1)
                result = sent[0]["result"]
                value = json.loads(result["content"][0]["text"])
                self.assertEqual(bool(result.get("isError")), value.get("ok") is False)
                return value
            from bridge.room import __main__ as cli
            output = io.StringIO()
            with redirect_stdout(output):
                rc = cli.main(["call", tool, "--json", json.dumps(args)])
            value = json.loads(output.getvalue())
            self.assertEqual(rc, 3 if value.get("ok") is False else 0)
            return value

    def restart(self, tool, args):
        # A clean interpreter drops all process-local replay state.
        request = json.dumps([tool, args])
        env = {k: v for k, v in os.environ.items() if not k.startswith("CW_")}
        env.update(CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1", TMPDIR=str(self.tmp))
        child = subprocess.run([sys.executable, "-B", "-m", "bridge.tests.room.u119.restart_probe"],
                               input=request, text=True, capture_output=True, cwd=ROOT, env=env, timeout=15)
        self.assertEqual(child.returncode, 0, child.stderr)
        return json.loads(child.stdout)
