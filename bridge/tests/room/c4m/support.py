"""Run real room tools against disposable byte-sized journals."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest import mock

from bridge.room import _lock, app, store
from bridge.room.ext import waiter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
ROOM = "demo"
OLD_CAP = 8 * 1024 * 1024
NEW_CAP = 16 * 1024 * 1024
RESERVE = 512 * 1024
NOISE_CAP = NEW_CAP - RESERVE
NOW = 1_800_000_000_000


def invoke(tool, **args):
    reply = app.dispatch(tool, {"room": ROOM, **args})
    return reply.get("untrusted", reply)


def outcome(call):
    try:
        return {"reply": call()}
    except store.RoomError as error:
        return {"code": error.code}


@contextmanager
def offline_room(root):
    home = root / "home"

    def no_wait(_):
        raise AssertionError("unexpected polling wait")

    virtual_time = SimpleNamespace(monotonic=lambda: 0.0, sleep=no_wait)
    env = {key: value for key, value in os.environ.items()
           if key not in ("CW_AGENT", "CW_ROLE", "CW_SESSION_AGENT", "CW_SESSION_ROLE")}
    env.update(CW_HOME=str(home), TMPDIR=str(root))
    with mock.patch.dict(os.environ, env, clear=True), \
            mock.patch.object(store.time, "time", return_value=NOW / 1000), \
            mock.patch.object(waiter, "time", virtual_time), \
            mock.patch.object(_lock, "time", virtual_time), \
            mock.patch.object(socket, "socket", side_effect=AssertionError("unexpected network")), \
            mock.patch.object(socket, "create_connection", side_effect=AssertionError("unexpected network")):
        yield home


class JournalCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(dir=HERE)))
        self.home = self.enterContext(offline_room(self.root))
        self.room_dir = self.home / "rooms" / ROOM
        self.journal = self.room_dir / "events.jsonl"
        self.lock = self.room_dir / "events.lock"
        self.noops = self.room_dir / "lifecycle-noops.json"

    def post(self, act="heartbeat", text="seed", agent="reviewer"):
        return store.post(ROOM, agent, act, text)

    def batch(self, ops):
        return store.post_ops(ROOM, "reviewer", ops)

    def life(self, state, op_id, **args):
        return invoke("agent_lifecycle", agent="worker", run_id="run-current",
                      state=state, op_id=op_id, **args)

    def plan(self, *, tasks=None):
        if tasks is None:
            tasks = [{"key": "first", "title": "First task", "phase": "execute",
                      "type": "task", "accept": "Record the outcome",
                      "microtasks": [{"text": "Verify the work"}]}]
        return invoke("plan_create", agent="reviewer", template_id="blank",
                      title="Continuity plan", brief={"goal": "Keep the journal"},
                      strict=False, tasks=tasks, op_id="initial-plan")

    def pad(self, prefix, total, tail=b""):
        # Bounded blank lines keep the fixture valid without thousands of folds.
        remaining = total - len(prefix) - len(tail)
        self.assertGreaterEqual(remaining, 0, "fixture does not fit")
        with self.journal.open("wb") as stream:
            stream.write(prefix)
            for _ in range(remaining // 65_536):
                stream.write(b" " * 65_535 + b"\n")
            fragment = remaining % 65_536
            if fragment:
                stream.write(b" " * (fragment - 1) + b"\n")
            stream.write(tail)
        self.assertEqual(self.journal.stat().st_size, total)

    def events(self):
        return store.read_checked(ROOM)[0]

    def snapshot(self):
        events, malformed = store.read(ROOM)
        return self.journal.read_bytes(), max((e["lamport"] for e in events), default=0), malformed

    def succeeds(self, call):
        result = outcome(call)
        self.assertIn("reply", result, f"expected append or replay, got {result}")
        return result["reply"]

    def refuses(self, call, code="room_full"):
        before = self.snapshot()
        self.assertEqual(outcome(call), {"code": code})
        after = self.snapshot()
        self.assertTrue(before[0] == after[0], f"{code} changed journal bytes")
        self.assertEqual(before[1:], after[1:], f"{code} changed journal head or malformed count")

    def payload_size(self, call):
        # Measure the real writer at low occupancy. The caller restores the
        # snapshot before each boundary attempt, keeping the next head stable.
        before = self.journal.read_bytes()
        self.succeeds(call)
        size = self.journal.stat().st_size - len(before)
        self.journal.write_bytes(before)
        self.assertGreater(size, 0, "calibration must append")
        return size

    def restart(self, calls=()):
        result = subprocess.run(
            [sys.executable, "-B", "-m", "bridge.tests.room.c4m.probe"],
            cwd=ROOT, input=json.dumps({"root": str(self.root), "calls": calls}),
            text=True, capture_output=True, timeout=15, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)
