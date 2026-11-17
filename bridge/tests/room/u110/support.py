"""Bounded stdlib-only fixtures for the public room_send contract."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from bridge.room import app, store
from bridge.room.ext.send import room_send
from bridge.tests.room.support import BASE_TS, canon, events_path, file_events, mk_event, seed

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
BASE = {"room": "demo", "agent": "harness", "to": "executor-a",
        "act": "question", "text": "Need evidence?"}
A2 = dict(BASE, op_id="u110-msg-0001")


def retry_worker(home, args, barrier, results):
    """A process barrier creates contention without sleep-based scheduling."""
    os.environ["CW_HOME"] = home
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        with patch.object(store.time, "time", return_value=BASE_TS / 1000):
            barrier.wait(timeout=15)
            results.put({"receipt": room_send(args)})
    except Exception as exc:
        results.put({"error": type(exc).__name__, "detail": str(exc)})


class SendCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="scratch-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.home = self.tmp / "cw"
        env = patch.dict(os.environ, {"CW_HOME": str(self.home),
                                    "PYTHONDONTWRITEBYTECODE": "1"})
        env.start()
        self.addCleanup(env.stop)
        clock = patch.object(store.time, "time", return_value=BASE_TS / 1000)
        clock.start()
        self.addCleanup(clock.stop)
        for target in ("socket.create_connection", "socket.socket.connect"):
            offline = patch(target, side_effect=AssertionError("network is outside U110"))
            offline.start()
            self.addCleanup(offline.stop)
        # This valid no-plan message is an executable precondition, not a mock.
        # An unimplemented entry point must report its actual stub exception.
        self.first = self.send_args(copy.deepcopy(A2))
        self.q = self.event(self.first["id"])

    def send_args(self, args):
        result = room_send(args)
        self.assertIsInstance(result, dict)
        self.assertEqual(set(result), {"ok", "id", "lamport"})
        self.assertIs(result["ok"], True)
        self.assertRegex(result["id"], r"^e-[0-9a-f]{16}$")
        self.assertIs(type(result["lamport"]), int)
        self.assertGreater(result["lamport"], 0)
        return result

    def send(self, **changes):
        return self.send_args(dict(BASE, **changes))

    def event(self, event_id, room="demo"):
        return next(event for event in file_events(self.home, room)
                    if event["id"] == event_id)

    def journals(self):
        return {str(path.relative_to(self.home)): path.read_bytes()
                for path in sorted(self.home.glob("rooms/*/events.jsonl"))}

    def refuse(self, args, code):
        before = self.journals()
        with self.assertRaises(store.RoomError) as caught:
            room_send(copy.deepcopy(args))
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.journals(), before, "a refusal changed the journal")

    def fixture(self, name="note.txt", data=b"evidence bytes\n"):
        path = self.tmp / "files" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def run_process(self, args, *, stdin="", home=None):
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("CW_") and not key.startswith("PYTHON")}
        env.update(CW_HOME=str(home or self.home), PYTHONDONTWRITEBYTECODE="1",
                   TMPDIR=str(self.tmp))
        return subprocess.run([sys.executable, *args], input=stdin, text=True,
                              capture_output=True, cwd=ROOT, env=env, timeout=20)

    def cli(self, *args, home=None):
        return self.run_process(["-m", "bridge.room", *args], home=home)

    def rpc(self, requests, *, home=None):
        cp = self.run_process(["-m", "bridge.room.mcp"], home=home,
                              stdin="".join(json.dumps(req) + "\n" for req in requests))
        self.assertEqual(cp.returncode, 0, cp.stderr)
        replies = [json.loads(line) for line in cp.stdout.splitlines() if line.strip()]
        self.assertEqual(len(replies), len(requests), cp.stdout)
        return replies

    def rpc_call(self, args, *, tool="room_send", home=None):
        reply = self.rpc([{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                           "params": {"name": tool, "arguments": args}}], home=home)[0]
        self.assertNotIn("error", reply, reply)
        result = reply["result"]
        self.assertEqual(result["content"][0]["type"], "text")
        return result, json.loads(result["content"][0]["text"])

    def assert_descriptor(self, tools):
        found = [tool for tool in tools if tool["name"] == "room_send"]
        self.assertEqual(len(found), 1, "room_send must be exposed exactly once")
        return found[0]

    def open_ids(self):
        return {event["id"] for event in store.status("demo")["open_questions"]}
