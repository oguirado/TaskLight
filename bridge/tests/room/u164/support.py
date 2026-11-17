"""Real journals, deterministic clocks, and bounded local transports."""
import copy
import fcntl
import hashlib
import io
import itertools
import json
import os
from pathlib import Path
import secrets
import socket
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from bridge.plan import fold_plan
from bridge.plan.template import validate_template
from bridge.room import app, mcp, store
from bridge.room import __main__ as cli
from bridge.room.ext import admission

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
BASE_TS = 1700000000000
MID = "T01.M01"
MESSAGE = "Evidence required to complete " + MID + "."


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class EvidenceCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.home = self.tmp / "home"
        environment = {k: v for k, v in os.environ.items() if not k.startswith("CW_")}
        environment.update(CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        self.enterContext(patch.dict(os.environ, environment, clear=True))
        self.enterContext(patch.object(time, "time", return_value=BASE_TS / 1000))
        self.enterContext(patch.object(time, "sleep", side_effect=AssertionError("real timers forbidden")))
        for name in ("connect", "connect_ex", "sendto"):
            self.enterContext(patch.object(socket.socket, name, side_effect=AssertionError("network forbidden")))
        self.enterContext(patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")))
        counter = itertools.count(1)
        self.enterContext(patch.object(secrets, "token_hex", side_effect=lambda size: format(next(counter), "x").zfill(size * 2)))
        raw = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
        raw.pop("hash", None)
        raw["id"] = "u164-oracle"
        optional = copy.deepcopy(raw["task_types"][0])
        optional.update(id="optional", label="Optional", evidence_required=False)
        raw["task_types"].append(optional)
        for section in raw["memory_sections"]:
            section["required"] = False
        self.template = validate_template(raw)
        self.templates = {self.template["id"]: self.template}
        directory = self.home / "templates"
        directory.mkdir(parents=True)
        self.template_path = directory / (self.template["id"] + ".json")
        self.template_path.write_text(canonical(self.template))
        self.proof = self.tmp / "proof.txt"
        self.proof.write_bytes(b"verified output\n")
        self.evidence = [{"path": str(self.proof.resolve()), "sha256": hashlib.sha256(self.proof.read_bytes()).hexdigest()}]

    def start(self, *, optional=False, micros=1):
        self.write(dict(kind="plan.open", template_id=self.template["id"], template_hash=self.template["hash"],
                        title="Evidence admission", brief={"goal": "Verify evidence"}, phase="start"))
        self.write(dict(kind="task.add", title="Check output", type="optional" if optional else "action",
                        phase="start", accept="Verified", microtasks=[{"text": "Check"} for _ in range(micros)]))
        self.write(dict(kind="task.claim", task_id="T01"))

    def write(self, op, route="single", *, strict=False):
        if route == "single":
            return store.post("oracle", "alice", "op", "", op=copy.deepcopy(op), clock=lambda: BASE_TS)
        if route == "batch":
            return self.batch([op], strict=strict)
        if route == "admission":
            return admission.post("oracle", "alice", copy.deepcopy(op))
        raise AssertionError("unknown route")

    def batch(self, ops, **kwargs):
        return store.post_ops("oracle", "alice", copy.deepcopy(ops), clock=lambda: BASE_TS, **kwargs)

    @staticmethod
    def complete(**changes):
        return dict(kind="micro.set", micro_id=MID, state="done", **changes)

    def path(self):
        return self.home / "rooms/oracle/events.jsonl"

    def raw(self):
        return self.path().read_bytes() if self.path().exists() else b""

    def events(self):
        return [json.loads(line) for line in self.raw().splitlines()]

    def state(self):
        state = fold_plan(self.events(), templates=self.templates)
        self.assertEqual(state["rejected"], [], "invalid fixture or historical reinterpretation")
        return state

    def task(self):
        return self.state()["tasks"][0]

    def snapshot(self):
        return self.raw(), copy.deepcopy(self.state())

    def append_legacy(self, op, *, identified=False):
        """Independent historical wire event; never disable production admission."""
        number = max((e["lamport"] for e in self.events()), default=0) + 1
        event = dict(id="e-" + format(0xA00000 + number, "016x"), lamport=number, ts=BASE_TS,
                     room="oracle", agent="alice", act="op", text="", op=copy.deepcopy(op))
        if identified:
            request = dict(act="op", text="", re=None, to=None, evidence=[], op=op)
            event["request_sha256"] = hashlib.sha256(canonical(request).encode()).hexdigest()
        with self.path().open("ab") as stream:
            stream.write((canonical(event) + "\n").encode())
        return event

    def edit(self, **changes):
        return dict(kind="task.set", task_id="T01", base_rev=self.task()["rev"], **changes)

    def assert_released(self):
        with (self.path().parent / "events.lock").open("r+b") as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                self.fail("rejection retained the journal lock")
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def refuse(self, action, code="missing_evidence", message=MESSAGE):
        before = self.snapshot()
        with self.assertRaises(store.RoomError, msg="completion without usable evidence was admitted") as caught:
            action()
        self.assertEqual(caught.exception.code, code)
        if message is not None:
            self.assertEqual(str(caught.exception).split(": ", 1)[-1], message)
        self.assertEqual(self.snapshot(), before, "rejection changed journal, revisions, receipts or Lamport")
        self.assert_released()
        previous = self.events()[-1]["lamport"]
        heartbeat = store.post("oracle", "alice", "heartbeat", "Still working", clock=lambda: BASE_TS)
        self.assertEqual(heartbeat["lamport"], previous + 1, "rejection consumed a Lamport value")

    def rpc(self, method, params):
        output = io.StringIO()
        with redirect_stdout(output):
            mcp._handle(7, method, params)
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        reply = json.loads(lines[0])
        self.assertNotIn("error", reply)
        return reply["result"]

    def transport(self, tool, args, transport="mcp"):
        args = dict(room="oracle", agent="alice", **args)
        if transport == "mcp":
            result = self.rpc("tools/call", dict(name=tool, arguments=args))
            payload = json.loads(result["content"][0]["text"])
            self.assertEqual(result["isError"], payload.get("ok") is False)
        else:
            output, errors = io.StringIO(), io.StringIO()
            with redirect_stdout(output), redirect_stderr(errors):
                status = cli.main(["call", tool, "--json", json.dumps(args)])
            self.assertEqual(errors.getvalue(), "")
            payload = json.loads(output.getvalue())
            self.assertEqual(status, 3 if payload.get("ok") is False else 0)
        return payload.get("untrusted", payload)

    def refuse_transport(self, tool, args, transport="mcp", code="missing_evidence", message=MESSAGE):
        before = self.snapshot()
        payload = self.transport(tool, args, transport)
        self.assertIs(payload.get("ok"), False, "transport admitted completion without usable evidence")
        self.assertEqual(payload["code"], code)
        if message is not None:
            self.assertEqual(payload.get("detail", "").split(": ", 1)[-1], message)
        self.assertEqual(self.snapshot(), before, "transport refusal mutated journal or projection")
        self.assert_released()
