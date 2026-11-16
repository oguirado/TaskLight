"""Deterministic fixtures and the provisional direct-export adapter."""
import copy
import json
import importlib
import os
import socket
import tempfile
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from bridge.plan.fold import fold_plan
from bridge.room import ext, store

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
BASE_TS = 1_700_000_000_000
EXPLANATION = "Room log position of this section's last accepted update"


def event(rev, op, by="alice"):
    return dict(id="e-%016x" % rev, room="demo", agent=by, act="op",
                text="", ts=BASE_TS + rev, lamport=rev, op=copy.deepcopy(op))


def memory_event(rev, text, base_rev, by="alice", section="goal", op_id=None):
    op = dict(kind="memory.set", section=section, text=text, base_rev=base_rev)
    if op_id is not None:
        op["op_id"] = op_id
    return event(rev, op, by)


def history_events(closed=False):
    first = memory_event(3, "first", 0, op_id="memory003")
    duplicate = memory_event(7, "duplicate poison", 3)
    duplicate["id"] = first["id"]
    values = [event(1, dict(kind="plan.open", title="Oracle plan", template_id="neutral",
                            template_hash="a" * 64)),
              first,
              memory_event(4, "replay poison", 3, op_id="memory003"),
              memory_event(5, "second", 3, by="bob", op_id="memory005"),
              memory_event(6, "stale poison", 3, by="eve"), duplicate,
              memory_event(8, "other section", 0, section="notes"),
              memory_event(9, "", 5, by="carol", op_id="memory009")]
    values.append(copy.deepcopy(values[3]))
    if closed:
        values.append(event(11, dict(kind="plan.close", base_rev=1, outcome="Done")))
    # Disk order deliberately differs from canonical Lamport order.
    return list(reversed(values))


def expected_history():
    return dict(section="goal", versions=[
        dict(rev=9, by="carol", ts=BASE_TS + 9, text=""),
        dict(rev=5, by="bob", ts=BASE_TS + 5, text="second"),
        dict(rev=3, by="alice", ts=BASE_TS + 3, text="first"),
    ])


def tree(root):
    result = {}
    if not root.exists():
        return result
    for p in root.rglob("*"):
        key = p.relative_to(root).as_posix()
        if p.is_symlink():
            result[key] = ("symlink", os.readlink(p))
        elif p.is_file():
            result[key] = ("file", p.read_bytes())
        elif p.is_dir():
            result[key] = ("directory",)
        else:
            result[key] = ("special",)
    return result


def call(name, **args):
    ext.load()
    return ext.EXT_DISPATCH[name](args)


def file_export(room, out):
    # M6 supplies no Python symbol/signature. This is an isolated adapter,
    # not an additional public API requirement; see ORACLE.md.
    return importlib.import_module("bridge.room.ext.export").export_room(room, out)


class Case(unittest.TestCase):
    def setUp(self):
        scratch = HERE / ".scratch"
        scratch.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=scratch)
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {"CW_HOME": str(self.home),
                                                         "HOME": str(self.tmp / "user")}))
        self.stack.enter_context(patch.object(time, "time", return_value=BASE_TS / 1000))
        self.stack.enter_context(patch.object(time, "sleep", side_effect=AssertionError("sleep forbidden")))
        self.stack.enter_context(patch.object(socket, "socket", side_effect=AssertionError("network forbidden")))

    def seed(self, values=None, tail=b""):
        values = history_events() if values is None else values
        path = self.home / "rooms/demo/events.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"".join((json.dumps(e, ensure_ascii=False) + "\n").encode("utf-8")
                                 for e in values) + tail)
        return path

    def export(self, what="memory", **extra):
        return call("room_export", room="demo", agent="reader", what=what, **extra)

    def history(self, section="goal", **extra):
        return call("memory_history", room="demo", agent="reader", section=section, **extra)

    def assert_file_error(self, code, out):
        # Direct routine error representation is unspecified. Both a RoomError
        # and an explicit error dictionary convey the required failure code.
        try:
            result = file_export("demo", out)
        except store.RoomError as exc:
            self.assertEqual(exc.code, code)
        else:
            self.assertIsInstance(result, dict)
            self.assertEqual(result.get("code"), code)

    def assert_export(self, result, projection, what):
        from bridge.plan.markdown import render_memory_md, render_plan_md
        renderer = render_plan_md if what == "plan" else render_memory_md
        self.assertEqual(result, dict(format="markdown", text=renderer(projection),
                                      rev=projection["last_lamport"]))
        self.assertEqual(result["text"].encode("utf-8"), renderer(projection).encode("utf-8"))
        self.assertTrue(result["text"].endswith("\n"))
