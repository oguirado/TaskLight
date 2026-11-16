"""U5657 repair regression: BLOCKING items from the three reviews."""
import copy
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from bridge.room import mcp, store
from . import support

ROOT = Path(__file__).resolve().parents[3]


def _fixture_tpl():
    tpl = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
    return {tpl["id"]: tpl}, tpl


def _opening(**f):
    _, tpl = _fixture_tpl()
    return dict(kind="plan.open", template_id=tpl["id"], template_hash=tpl["hash"],
                title="Oracle plan", brief={"goal": "Deliver"}, phase="start", **f)


def _adding(**f):
    return dict({"kind": "task.add", "title": "Action", "type": "action", "phase": "start",
                 "accept": "Checked", "microtasks": [{"text": "First", "accept": "Checked"}]}, **f)


def _memory(**f):
    return dict({"kind": "memory.set", "section": "notes", "text": "Decision", "base_rev": 0}, **f)


class StoreRepair(support.RoomCase):
    def _tpls(self):
        t, _ = _fixture_tpl()
        return t

    def test_a_deep_nesting_post_and_post_ops(self):
        value = "x"
        for _ in range(3000):
            value = [value]
        op = _memory(text=value)
        with self.assertRaises(store.RoomError) as cm:
            store.post("oracle", "alice", "op", "", op=op, home=self.home,
                       clock=self.clock, templates=self._tpls())
        self.assertEqual(cm.exception.code, "bad_op")
        self.assertFalse(support.room_dir(self.home, "oracle").exists())
        with self.assertRaises(store.RoomError) as cm2:
            store.post_ops("oracle", "alice", [op], home=self.home,
                           clock=self.clock, templates=self._tpls())
        self.assertEqual(cm2.exception.code, "bad_op")
        self.assertFalse(support.room_dir(self.home, "oracle").exists())

    def test_b_short_write_post_ops_truncates(self):
        store.post("oracle", "alice", "heartbeat", "", home=self.home, clock=self.clock)
        before = support.events_path(self.home, "oracle").read_bytes()
        real_write = os.write
        state = {"done": False}

        def short_write(fd, data):
            if not state["done"]:
                state["done"] = True
                half = max(1, len(data) // 2)
                real_write(fd, data[:half])
                return half
            raise OSError("disk full")

        with mock.patch.object(store.os, "write", side_effect=short_write):
            with self.assertRaises((store.RoomError, OSError)):
                store.post_ops("oracle", "alice", [_opening(), _adding()],
                               home=self.home, clock=self.clock, templates=self._tpls())
        after = support.events_path(self.home, "oracle").read_bytes()
        self.assertEqual(after, before)

    def test_c_batch_replay_different_payload_and_length(self):
        ops = [_opening(op_id="batch-0001"), _memory(), _adding(title="First title")]
        first = store.post_ops("oracle", "alice", ops, home=self.home,
                               clock=self.clock, templates=self._tpls())
        self.assertEqual(len(first), 3)
        before = support.events_path(self.home, "oracle").read_bytes()
        # Retry with different title and shorter list (only opening), still full batch result.
        _retry_open = dict(_opening(op_id="batch-0001"))
        _retry_open["title"] = "Replacement"
        retry = store.post_ops("oracle", "alice", [_retry_open],
                               home=self.home, clock=self.clock, templates=self._tpls())
        self.assertEqual(len(retry), 3)
        self.assertEqual([e["id"] for e in retry], [e["id"] for e in first])
        self.assertTrue(all(e.get("replayed") is True for e in retry))
        self.assertEqual(support.events_path(self.home, "oracle").read_bytes(), before)

    def test_d_individually_posted_not_a_batch(self):
        store.post("oracle", "alice", "op", "", op=_opening(op_id="batch-0001"),
                   home=self.home, clock=self.clock, templates=self._tpls())
        store.post("oracle", "alice", "op", "", op=_memory(),
                   home=self.home, clock=self.clock, templates=self._tpls())
        store.post("oracle", "alice", "op", "", op=_adding(),
                   home=self.home, clock=self.clock, templates=self._tpls())
        # Same 3 ops via batch: must NOT return the 3 individual events as a
        # batch replay. Fold replays `open` but the memory write is stale,
        # so the batch fails atomically with no appended events.
        before_bytes = support.events_path(self.home, "oracle").read_bytes()
        with self.assertRaises(store.RoomError) as cm:
            store.post_ops("oracle", "alice",
                           [_opening(op_id="batch-0001"), _memory(), _adding()],
                           home=self.home, clock=self.clock, templates=self._tpls())
        self.assertIn(cm.exception.code, {"stale_rev", "plan_exists", "bad_op"})
        self.assertEqual(support.events_path(self.home, "oracle").read_bytes(),
                         before_bytes)


class McpRepair(support.RoomCase):
    def setUp(self):
        super().setUp()
        self.tmp2 = Path(self.tmp)
        patcher = mock.patch.dict(os.environ, {"CW_HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)
        e = mock.patch.object(store.time, "time", side_effect=lambda: self.clock.t / 1000)
        e.start()
        self.addCleanup(e.stop)
        _, tpl = _fixture_tpl()
        self.template = tpl
        d = Path(self.home) / "templates"
        d.mkdir(parents=True, exist_ok=True)
        (d / (tpl["id"] + ".json")).write_text(json.dumps(tpl), encoding="utf-8")

    def _rpc(self, method, params=None):
        out = io.StringIO()
        with redirect_stdout(out):
            mcp._handle(1, method, {} if params is None else params)
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        return json.loads(lines[0])

    def _call(self, name, args):
        r = self._rpc("tools/call", {"name": name, "arguments": args})
        self.assertIn("result", r)
        return r["result"]

    def _decode(self, result):
        return json.loads(result["content"][0]["text"])

    def _ok(self, name, args):
        result = self._call(name, args)
        self.assertIs(result.get("isError"), False, result)
        payload = self._decode(result)
        return payload["untrusted"]

    def _err(self, name, args):
        result = self._call(name, args)
        self.assertIs(result.get("isError"), True, result)
        return self._decode(result)

    def _create_args(self, **changes):
        value = dict(room="oracle", agent="alice", template_id="neutral",
                     title="Plan", brief={"goal": "Deliver"},
                     tasks=[dict(key="first", title="Action", type="action",
                                 phase="start", accept="Pass",
                                 microtasks=[dict(text="Step", accept="Pass")])])
        value.update(changes)
        return value

    def test_e_template_traversal_rejected(self):
        for tid in ("../../rooms/secret/note", "a/b", "..", ".hidden"):
            with self.subTest(tid=tid):
                dec = self._err("get_template", {"template_id": tid})
                self.assertEqual(dec, {"ok": False, "code": "bad_op"})
                dec2 = self._err("plan_create", self._create_args(template_id=tid))
                self.assertEqual(dec2, {"ok": False, "code": "bad_op"})

    def test_f_evidence_dict_bypass_rejected(self):
        self._ok("plan_create", self._create_args())
        dec = self._err("microtask_set", dict(
            room="oracle", agent="alice", id="T01.M01", state="done",
            evidence=[{"path": "/home/user/.ssh/id_rsa", "sha256": "0" * 64}]))
        self.assertEqual(dec, {"ok": False, "code": "bad_evidence"})

    def test_g_creation_race_heartbeat_before_lock(self):
        store.post("oracle", "alice", "heartbeat", "", home=self.home, clock=self.clock)
        real = store._max_lamport_fast

        def stale(path):
            try:
                return max(0, real(path) - 1)
            except Exception:
                return 0

        tasks = [dict(key="first", title="Action", type="action", phase="start",
                      accept="Pass", deps=["second"],
                      microtasks=[dict(text="Step", accept="Pass")]),
                 dict(key="second", title="Action", type="action", phase="start",
                      accept="Pass", microtasks=[dict(text="Step", accept="Pass")])]
        with mock.patch.object(store, "_max_lamport_fast", side_effect=stale):
            out = self._ok("plan_create", self._create_args(tasks=tasks))
        self.assertEqual(out["ids"], {"first": "T01", "second": "T02"})
        proj = self._ok("plan_get", {"room": "oracle"})
        self.assertEqual(len(proj["tasks"]), 2)

    def test_h_nullable_schemas(self):
        tools = {t["name"]: t["inputSchema"]["properties"] for t in mcp.TOOLS[6:]}
        for field in ("state", "reason", "estimate"):
            typ = tools["task_update"][field].get("type")
            self.assertIn("null", typ if isinstance(typ, list) else [typ],
                          f"task_update.{field} must allow null: {typ!r}")
        for field in ("assignee", "estimate"):
            typ = tools["task_add"][field].get("type")
            self.assertIn("null", typ if isinstance(typ, list) else [typ],
                          f"task_add.{field} must allow null: {typ!r}")

    def test_i_deps_nonstring_is_bad_op(self):
        self._ok("plan_create", self._create_args())
        proj = self._ok("plan_get", {"room": "oracle"})
        dec = self._err("task_update", dict(room="oracle", agent="alice", task_id="T01",
                                            base_rev=proj["tasks"][0]["rev"], deps=[{}]))
        self.assertEqual(dec, {"ok": False, "code": "bad_op"})

    def test_j_batch_replay_replacement_keys(self):
        first = self._ok("plan_create", self._create_args(op_id="create_01"))
        self.assertEqual(first["ids"], {"first": "T01"})
        before = (Path(self.home) / "rooms" / "oracle" / "events.jsonl").read_bytes()
        replacement = [dict(key="replacement", title="Action", type="action",
                            phase="start", accept="Pass",
                            microtasks=[dict(text="Step", accept="Pass")])]
        second = self._ok("plan_create", self._create_args(
            op_id="create_01", title="Changed", tasks=replacement))
        self.assertIs(second["replayed"], True)
        self.assertEqual(second["ids"], {"first": "T01"})
        self.assertEqual(second["rev"], first["rev"])
        after = (Path(self.home) / "rooms" / "oracle" / "events.jsonl").read_bytes()
        self.assertEqual(after, before)
