"""Independent journal fixtures, fake time, and bounded process helpers."""
import contextlib
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import traceback
import unittest
from unittest import mock

from bridge.room import store
from bridge.room.ext.events import handler

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
FIELDS = ("id", "room", "agent", "act", "text", "ts", "lamport", "op")


def event(lamport, *, agent="worker-a", room="demo", act="heartbeat", text="literal", **extra):
    return {"id": "e-%016x" % lamport, "room": room, "agent": agent,
            "act": act, "text": text, "ts": 1700000000000 + lamport,
            "lamport": lamport, **extra}


def memory(lamport=6, text="Keep this literal"):
    return event(lamport, agent="worker-b", act="op", text="", op={
        "kind": "memory.set", "section": "notes", "text": text, "base_rev": 0,
        "op_id": "memory_%02d" % lamport})


def fixture():
    template = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
    opening = event(2, act="op", text="", op={
        "kind": "plan.open", "template_id": template["id"], "template_hash": template["hash"],
        "title": "Cursor fixture", "brief": {"goal": "Read all events"}, "phase": "start"})
    return [event(1), opening, memory(3), event(4, agent="worker-b")]


def encoded(events):
    return b"".join((json.dumps(e, ensure_ascii=False) + "\n").encode() for e in events)


def project(events):
    return [{key: copy.deepcopy(e[key]) for key in FIELDS
             if key in e and (key != "op" or isinstance(e[key], dict))} for e in events]


def footprint(home):
    """Ignore read access times; preserve names, bytes, modes, inodes and write times."""
    if not home.exists():
        return None
    result = {}
    for path in [home, *sorted(home.rglob("*"))]:
        stat = path.stat()
        result[str(path.relative_to(home))] = (
            stat.st_mode, stat.st_ino, stat.st_mtime_ns,
            path.read_bytes() if path.is_file() else None)
    return result


class Clock:
    def __init__(self, wait_ms, on_sleep=None):
        self.now = 100.0
        self.start = self.now
        self.deadline = self.now + wait_ms / 1000
        self.sleeps = []
        self.clock_reads = 0
        self.on_sleep = on_sleep

    def monotonic(self):
        self.clock_reads += 1
        if self.clock_reads > 200002:
            raise AssertionError("monotonic polling watchdog exhausted without completion")
        return self.now

    def sleep(self, delay):
        remaining = self.deadline - self.now
        if not 0 < delay <= remaining + 1e-10:
            raise AssertionError("sleep must be positive and capped by remaining monotonic time")
        self.sleeps.append(delay)
        if len(self.sleeps) > 100000:
            raise AssertionError("polling watchdog exhausted")
        if self.on_sleep is not None:
            self.on_sleep(len(self.sleeps))
        self.now += delay


@contextlib.contextmanager
def replace_bound_functions(originals):
    """Replace public dependencies and already-bound imports, independent of import style."""
    aliases = []
    for name, module in list(sys.modules.items()):
        if module is None or not name.startswith(("bridge.room", "bridge.plan")):
            continue
        for attr, value in list(vars(module).items()):
            for original, replacement in originals.items():
                if value is original:
                    aliases.append((module, attr, replacement))
    with contextlib.ExitStack() as stack:
        for module, attr, replacement in aliases:
            stack.enter_context(mock.patch.object(module, attr, replacement))
        yield


@contextlib.contextmanager
def fake_time(clock):
    """Inject monotonic time without requiring any private helper name or poll period."""
    with replace_bound_functions({time.monotonic: clock.monotonic, time.sleep: clock.sleep}), \
         contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(time, "monotonic", clock.monotonic))
        stack.enter_context(mock.patch.object(time, "sleep", clock.sleep))
        yield clock


class CursorCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.temp = Path(temporary.name)
        self.home = self.temp / "cw"
        self.path = self.home / "rooms/demo/events.jsonl"
        self.events = fixture()
        env = mock.patch.dict(os.environ, {"CW_HOME": str(self.home), "PYTHONDONTWRITEBYTECODE": "1"})
        env.start()
        self.addCleanup(env.stop)

    def seed(self, events=None, raw=b""):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_bytes(encoded(self.events if events is None else events) + raw)

    def request(self, **changes):
        return handler({"room": "demo", "agent": "reader", "after_lamport": 0, **changes})

    def check(self, actual, events, next_after, head, has_more=False, resync=False):
        self.assertEqual(actual, {"events": project(events), "next_after": next_after,
                                  "head": head, "has_more": has_more, "resync": resync})
        self.assertIs(type(actual["next_after"]), int)
        self.assertIs(type(actual["head"]), int)
        self.assertIs(type(actual["has_more"]), bool)
        self.assertIs(type(actual["resync"]), bool)

    def rpc(self, *requests):
        messages = [{"jsonrpc": "2.0", "id": i, **request} for i, request in enumerate(requests, 1)]
        run = subprocess.run([sys.executable, "-B", "-m", "bridge.room.mcp"],
                             cwd=ROOT, env=dict(os.environ), text=True, capture_output=True,
                             input="".join(json.dumps(m) + "\n" for m in messages), timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stderr, "")
        replies = [json.loads(line) for line in run.stdout.splitlines()]
        self.assertEqual(len(replies), len(messages), run.stdout)
        for i, reply in enumerate(replies, 1):
            self.assertEqual((reply["jsonrpc"], reply["id"]), ("2.0", i))
        return replies

    def call(self, **changes):
        return {"method": "tools/call", "params": {"name": "room_events", "arguments": {
            "room": "demo", "agent": "reader", "after_lamport": 0, **changes}}}

    def data(self, reply):
        self.assertNotIn("error", reply, reply)
        result = reply["result"]
        self.assertIs(result["isError"], False, result)
        self.assertEqual(len(result["content"]), 1)
        self.assertEqual(result["content"][0]["type"], "text")
        payload = json.loads(result["content"][0]["text"])
        self.assertEqual(set(payload), {"untrusted"})
        return payload["untrusted"]


def waiting_child(home, pipe):
    """Logical polling steps are released by the parent, never elapsed real time."""
    try:
        os.environ["CW_HOME"] = home
        def pause(_):
            pipe.send(("poll", None))
            if pipe.recv() != "continue":
                raise AssertionError("invalid synchronization command")
        clock = Clock(30000, pause)
        with fake_time(clock):
            data = handler({"room": "demo", "agent": "reader", "after_lamport": 4,
                            "ops": ["memory.set"], "wait_ms": 30000})
        pipe.send(("result", {"data": data, "elapsed": clock.now - clock.start}))
    except BaseException:
        pipe.send(("error", traceback.format_exc()))
    finally:
        pipe.close()


def writer_child(home, pipe):
    try:
        path = Path(home) / "rooms/demo/events.jsonl"
        while True:
            command = pipe.recv()
            if command == "stop":
                break
            if command == "heartbeat":
                # A public writer acquires its normal writer lock while the reader sleeps.
                result = store.post("demo", "worker-b", "heartbeat", "unrelated", home=home,
                                    clock=lambda: 1700000000005)
            else:
                result = memory(6)
                with path.open("ab") as stream:
                    stream.write(encoded([result]))
            pipe.send(("written", result))
    except BaseException:
        pipe.send(("error", traceback.format_exc()))
    finally:
        pipe.close()
