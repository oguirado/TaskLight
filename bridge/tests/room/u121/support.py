"""Real storage fixtures; scratch data remains inside this test directory."""
import copy
import hashlib
import io
import itertools
import json
import os
from pathlib import Path
import secrets
import socket
import tempfile
import sys
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from bridge.plan import fold_plan
from bridge.room import app, store


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
ROOM = "u121"
AGENT = "executor-a"
TS = 1700000000000
RESERVE = 512 * 1024
BEAT = dict(kind="activity.beat", task_id="T01", micro_id="T01.M01",
            run_id="run-a", op_id="u121beat0001", note="working")
ARGS = dict(room=ROOM, agent=AGENT, **{k: v for k, v in BEAT.items() if k != "kind"})


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def memory(oid="memory0001", text="Decision", rev=0, section="notes"):
    return dict(kind="memory.set", op_id=oid, section=section, text=text, base_rev=rev)


class RoomCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / "cw"
        self.enterContext(patch.dict(os.environ, CW_HOME=str(self.home),
                                    PYTHONDONTWRITEBYTECODE="1"))
        self.enterContext(patch.object(time, "time", return_value=TS / 1000))
        self.enterContext(patch.object(time, "sleep", new=_sleep_guard()))
        counter = itertools.count(100)
        self.enterContext(patch.object(secrets, "token_hex", side_effect=lambda n: format(next(counter), "0%dx" % (2*n))))
        for target in ("socket.create_connection", "socket.socket.connect", "socket.socket.connect_ex", "socket.socket.sendto"):
            self.enterContext(patch(target, side_effect=AssertionError("network forbidden")))
        template = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
        self.templates = {template["id"]: template}
        folder = self.home / "templates"
        folder.mkdir(parents=True)
        (folder / (template["id"] + ".json")).write_bytes(canonical(template))
        self.post(dict(kind="plan.open", title="Oracle", template_id=template["id"],
                       template_hash=template["hash"], brief={"goal": "Verify"}, phase="start"))
        self.post(dict(kind="task.add", title="Work", type="action", phase="start", accept="Checked",
                       microtasks=[dict(text="Execute", accept="Checked")]))
        self.post(dict(kind="task.claim", task_id="T01"))
        self.post(dict(kind="micro.set", micro_id="T01.M01", state="active"))
        self.assertEqual(self.projection()["rejected"], [], "invalid oracle precondition")
        task = self.projection()["tasks"][0]
        self.assertEqual(task["assignee"], AGENT)
        self.assertEqual(task["microtasks"][0]["state"], "active")

    @property
    def path(self):
        return self.home / "rooms" / ROOM / "events.jsonl"

    def raw(self):
        return self.path.read_bytes() if self.path.exists() else b""

    def events(self):
        return [json.loads(line) for line in self.raw().splitlines() if line]

    def projection(self):
        return fold_plan(self.events(), templates=self.templates)

    def snapshot(self):
        raw = self.raw()
        events = self.events()
        return raw, max((e["lamport"] for e in events), default=0), self.projection()

    def post(self, op, **kwargs):
        args = dict(home=self.home, clock=lambda: TS, templates=self.templates)
        args.update(kwargs)
        agent = args.pop("agent", AGENT)
        room = args.pop("room", ROOM)
        return store.post(room, agent, "op", "", op=copy.deepcopy(op), **args)

    def batch(self, ops, **kwargs):
        args = dict(home=self.home, clock=lambda: TS, templates=self.templates)
        args.update(kwargs)
        agent = args.pop("agent", AGENT)
        return store.post_ops(ROOM, agent, copy.deepcopy(ops), **args)

    def heartbeat(self, text="é progress"):
        return store.post(ROOM, AGENT, "heartbeat", text, home=self.home, clock=lambda: TS)

    def completion_op(self):
        # A-U164: capacity/replay fixtures complete work with real test evidence.
        proof = Path(__file__).resolve()
        return dict(kind="micro.set", micro_id="T01.M01", state="done", outcome="Verified",
                    evidence=[{"path": str(proof), "sha256": hashlib.sha256(proof.read_bytes()).hexdigest()}])

    def completion(self):
        return self.post(self.completion_op())

    def refuse(self, call, code="bad_op", detail=None):
        before = self.snapshot()
        caught = None
        try:
            call()
        except Exception as exc:
            caught = exc
        self.assertIsInstance(caught, store.RoomError, "expected RoomError refusal, got %r" % (caught,))
        self.assertEqual(caught.code, code)
        if detail:
            self.assertIn(detail, str(caught))
        self.assertEqual(self.snapshot(), before, "refusal changed journal bytes, head or projection")
        return caught

    def conflict(self, call):
        return self.refuse(call, "bad_op", "op_id conflict")

    def api(self, transport, args, tool="activity_beat"):
        app._load_extensions()
        if transport == "mcp":
            from bridge.room import mcp
            sent = []
            with patch.object(mcp, "_send", side_effect=sent.append):
                mcp._handle(1, "tools/call", dict(name=tool, arguments=args))
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
        self.assertEqual(rc == 0, value.get("ok") is not False)
        return value

    def payload_size(self, call):
        """Measure actual serialization, including metadata; restore the fixture."""
        before = self.raw()
        call()
        after = self.raw()
        self.assertTrue(after.startswith(before))
        self.path.write_bytes(before)
        return len(after) - len(before)

    def fill_to(self, size):
        """Valid inert records of bounded text with increasing Lamports."""
        data = bytearray(self.raw())
        head = max(e["lamport"] for e in self.events())
        counter = itertools.count()
        while len(data) < size:
            head += 1
            event = dict(id="e-%016x" % (0xffff0000 + next(counter)), room=ROOM,
                         agent="filler", act="heartbeat", text="", ts=TS, lamport=head)
            overhead = len(canonical(event)) + 1
            remaining = size - len(data)
            self.assertGreaterEqual(remaining, overhead)
            text_size = min(4096, remaining - overhead)
            if 0 < remaining - overhead - text_size < overhead:
                text_size -= overhead - (remaining - overhead - text_size)
            event["text"] = "x" * text_size
            data.extend(canonical(event) + b"\n")
        self.assertEqual(len(data), size)
        self.path.write_bytes(data)
        parsed, malformed = store.read(ROOM, home=self.home)
        self.assertEqual(malformed, 0)
        self.assertEqual(len(parsed), len(self.events()))
