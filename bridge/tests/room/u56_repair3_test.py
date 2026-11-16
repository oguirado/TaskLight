"""U56 repair flight 3: four REVIEW HOLD items, fail-first (red before fix)."""
import copy
import errno
import json
import os
from pathlib import Path
from unittest import mock

from bridge.room import store
from . import support

ROOT = Path(__file__).resolve().parents[3]


def _fixture_tpl():
    tpl = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
    return {tpl["id"]: tpl}, tpl


def _opening(**f):
    _, tpl = _fixture_tpl()
    return dict(kind="plan.open", template_id=tpl["id"], template_hash=tpl["hash"],
                title="Repair3 plan", brief={"goal": "Deliver"}, phase="start", **f)


def _adding(**f):
    return dict({"kind": "task.add", "title": "Action", "type": "action", "phase": "start",
                 "accept": "Checked", "microtasks": [{"text": "First", "accept": "Checked"}]}, **f)


class Repair3(support.RoomCase):
    def _tpls(self):
        t, _ = _fixture_tpl()
        return t

    def test_1_reordered_batch_retry_identity(self):
        tpls = self._tpls()
        store.post("oracle", "alice", "op", "", op=_opening(),
                   home=self.home, clock=self.clock, templates=tpls)
        ops = [dict(_adding(), key="a", deps=["b"], op_id="batch-0001"),
               dict(_adding(), key="b")]
        first = store.post_ops("oracle", "alice", copy.deepcopy(ops),
                               home=self.home, clock=self.clock, templates=tpls)
        self.assertEqual(len(first), 2)
        self.assertTrue(all("replayed" not in e for e in first))
        # Reordered order persisted: b first (T01), a second (T02 deps T01).
        events, malformed = store.read("oracle", home=self.home)
        self.assertEqual(malformed, 0)
        self.assertEqual(len(events), 3)
        self.assertEqual(events[1]["op"].get("deps", []), [])
        self.assertEqual(events[2]["op"].get("deps"), ["T01"])
        before = support.events_path(self.home, "oracle").read_bytes()
        retry = store.post_ops("oracle", "alice", copy.deepcopy(ops),
                               home=self.home, clock=self.clock, templates=tpls)
        self.assertEqual([e["id"] for e in retry], [e["id"] for e in first])
        self.assertEqual([e.get("replayed") for e in retry], [True, True])
        self.assertEqual(support.events_path(self.home, "oracle").read_bytes(), before)
        events2, _ = store.read("oracle", home=self.home)
        self.assertEqual(len(events2), 3)

    def test_2_stale_base_rev_not_healed(self):
        tpls = self._tpls()
        opened = store.post("oracle", "alice", "op", "", op=_opening(),
                            home=self.home, clock=self.clock, templates=tpls)
        self.assertEqual(opened["op"]["kind"], "plan.open")
        # Plan rev is the open lamport; phase advance moves it.
        store.post("oracle", "alice", "op", "",
                   op={"kind": "plan.phase", "base_rev": 1, "phase": "finish"},
                   home=self.home, clock=self.clock, templates=tpls)
        before = support.events_path(self.home, "oracle").read_bytes()
        with self.assertRaises(store.RoomError) as cm:
            store.post_ops("oracle", "alice", [_adding(base_rev=1)],
                           home=self.home, clock=self.clock, templates=tpls)
        self.assertEqual(cm.exception.code, "stale_rev")
        self.assertEqual(support.events_path(self.home, "oracle").read_bytes(), before)
        # Current rev still succeeds.
        ok = store.post_ops("oracle", "alice", [_adding(base_rev=2)],
                            home=self.home, clock=self.clock, templates=tpls)
        self.assertEqual(len(ok), 1)
        self.assertNotIn("replayed", ok[0])

    def test_3_reopen_batch_task_ids_reset(self):
        tpls = self._tpls()
        store.post("oracle", "alice", "op", "", op=_opening(),
                   home=self.home, clock=self.clock, templates=tpls)
        store.post("oracle", "alice", "op", "", op=_adding(),
                   home=self.home, clock=self.clock, templates=tpls)
        store.post("oracle", "alice", "op", "",
                   op={"kind": "plan.close", "base_rev": 1, "outcome": "Done"},
                   home=self.home, clock=self.clock, templates=tpls)
        ops = [_opening(), _adding(key="new"),
               {"kind": "micro.add", "task_id": "new", "base_rev": 1, "text": "Step"}]
        got = store.post_ops("oracle", "alice", copy.deepcopy(ops),
                             home=self.home, clock=self.clock, templates=tpls)
        self.assertEqual(len(got), 3)
        events, malformed = store.read("oracle", home=self.home)
        self.assertEqual(malformed, 0)
        self.assertEqual(len(events), 6)
        from bridge.plan import fold_plan
        proj = fold_plan(events, templates=tpls)
        self.assertEqual(proj.get("rejected"), [])
        tasks = proj.get("tasks", [])
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["id"], "T01")
        self.assertEqual(len(tasks[0].get("microtasks", [])), 2)

    def test_4_fsync_failure_not_acknowledged(self):
        tpls = self._tpls()
        boom = OSError(errno.EIO, "sync failed")
        with mock.patch.object(store.os, "fsync", side_effect=boom):
            with self.assertRaises(store.RoomError):
                store.post("oracle", "alice", "op", "", op=_opening(),
                           home=self.home, clock=self.clock, templates=tpls)
            with self.assertRaises(store.RoomError):
                store.post_ops("oracle", "alice", [_opening(), _adding()],
                               home=self.home, clock=self.clock, templates=tpls)
