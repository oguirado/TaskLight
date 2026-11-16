"""U56 repair flight: one focused test per REVIEW BLOCKING item 1-5."""
import json
import inspect
from pathlib import Path
from unittest import mock

from bridge.room import store
from . import support

ROOT = Path(__file__).resolve().parents[3]


def _fixture_tpl():
    raw = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())
    tpl = raw["templates"][0]
    return {tpl["id"]: tpl}, tpl


def opening(**f):
    _, tpl = _fixture_tpl()
    return dict(kind="plan.open", template_id=tpl["id"], template_hash=tpl["hash"],
                title="Repair plan", brief={"goal": "Deliver"}, phase="start", **f)


def adding(**f):
    return dict({"kind": "task.add", "title": "Action", "type": "action", "phase": "start",
                 "accept": "Checked", "microtasks": [{"text": "First", "accept": "Checked"}]}, **f)


def memory(**f):
    return dict({"kind": "memory.set", "section": "notes", "text": "Decision", "base_rev": 0}, **f)


class Repair1(support.RoomCase):
    def _tpls(self):
        tpls, _ = _fixture_tpl()
        return tpls

    def test_item1_task_set_forward_dep_persisted_eq_validated(self):
        tpls = self._tpls()
        fn = getattr(store, "post_ops", None)
        self.assertTrue(callable(fn))
        ops = [opening(), adding(),
               {"kind": "task.set", "task_id": "T01", "base_rev": 2, "deps": ["T02"]},
               adding()]
        fn("oracle", "alice", ops, home=self.home, clock=self.clock, templates=tpls)
        events, malformed = store.read("oracle", home=self.home)
        self.assertEqual(malformed, 0)
        # Persisted task.set must follow the T02 creator (position 3).
        kinds = [e["op"]["kind"] for e in events]
        self.assertEqual(kinds, ["plan.open", "task.add", "task.add", "task.set"])
        self.assertEqual(events[3]["op"]["deps"], ["T02"])
        # Sequential replay via fold shows no rejected entries and T01 deps T02.
        from bridge.plan import fold_plan
        proj = fold_plan(events, templates=tpls)
        tasks = {t["id"]: t for t in proj.get("tasks", [])}
        self.assertEqual(tasks["T01"].get("deps"), ["T02"])
        self.assertEqual(proj.get("rejected"), [])

    def test_item2_batch_retry_returns_all_members_and_member_alone_never_replays(self):
        tpls = self._tpls()
        ops = [opening(op_id="batch-0001"), memory(), adding()]
        fn = store.post_ops
        first = fn("oracle", "alice", ops, home=self.home, clock=self.clock, templates=tpls)
        self.assertEqual(len(first), 3)
        self.assertTrue(all("replayed" not in e for e in first))
        before = support.events_path(self.home, "oracle").read_bytes()
        import copy
        retry = fn("oracle", "alice", copy.deepcopy(ops), home=self.home, clock=self.clock, templates=tpls)
        self.assertEqual([e["id"] for e in retry], [e["id"] for e in first])
        self.assertEqual([e.get("replayed") for e in retry], [True, True, True])
        self.assertEqual(support.events_path(self.home, "oracle").read_bytes(), before)
        # Lone member collision must not replay: reuse batch-0001 as a later
        # member oid with a fresh batch id; it must execute/fail normally.
        with self.assertRaises(store.RoomError):
            fn("oracle", "alice", [opening(op_id="batch-9999"), adding(op_id="batch-0001")],
               home=self.home, clock=self.clock, templates=tpls)

    def test_item3_unsafe_integer_writer_and_reader(self):
        tpls = self._tpls()
        big = 10 ** 400
        self.assertFalse(store._is_safe_int(big))
        self.assertFalse(store._is_safe_ts(big))
        with self.assertRaises(store.RoomError) as cm:
            store.post("oracle", "alice", "op", "", op=memory(), home=self.home,
                       clock=lambda: big, templates=tpls)
        self.assertEqual(cm.exception.code, "bad_op")
        self.assertFalse(support.room_dir(self.home, "oracle").exists())
        good = support.mk_event(1, room="oracle", agent="alice", act="op", text="", op=memory())
        evil = dict(good, lamport=big)
        self.assertFalse(store._is_valid_event(evil))
        self.assertTrue(store._is_valid_event(good))

    def test_item4_surrogate_text_rejected_as_bad_op_and_invalid_event(self):
        tpls = self._tpls()
        op = memory(text="\ud800")
        self.assertIn("op", inspect.signature(store.post).parameters)
        with mock.patch.object(store, "_ensure_dirs", side_effect=AssertionError("dirs")):
            with self.assertRaises(store.RoomError) as cm:
                store.post("oracle", "alice", "op", "", op=op, home=self.home,
                           clock=self.clock, templates=tpls)
        self.assertEqual(cm.exception.code, "bad_op")
        self.assertFalse(support.room_dir(self.home, "oracle").exists())
        good = support.mk_event(1, room="oracle", agent="alice", act="op", text="", op=memory())
        evil = dict(good, op=memory(text="\ud800"))
        self.assertFalse(store._is_valid_event(evil))

    def test_item5_strict_via_templates_injection(self):
        tpls = self._tpls()
        with self.assertRaises(store.RoomError) as cm:
            store.post_ops("oracle", "alice", [opening(), adding(accept="")], home=self.home,
                           clock=self.clock, templates=tpls, strict=True)
        self.assertEqual(cm.exception.code, "not_conformant")
        store.post_ops("oracle", "alice", [opening(), memory(), adding()], home=self.home,
                       clock=self.clock, templates=tpls, strict=True)
        events, malformed = store.read("oracle", home=self.home)
        self.assertEqual((len(events), malformed), (3, 0))

    def test_item5_runtime_templates_no_fixture_coupling(self):
        src = Path(store.__file__).read_text()
        self.assertNotIn("fixtures/plan/templates.v1.json", src)
        self.assertIn("templates/planning", src)
        self.assertIn("load_template", src)
        self.assertIn("templates", inspect.signature(store.post).parameters)
        self.assertIn("templates", inspect.signature(store.post_ops).parameters)
        tpls = store._load_templates(self.home)
        self.assertNotIn("neutral", tpls)
        self.assertIn("blank", tpls)
        # Invalid user templates are skipped, never fatal.
        udir = Path(self.home) / "templates"
        udir.mkdir(parents=True, exist_ok=True)
        (udir / "bad.json").write_text("{not json", encoding="utf-8")
        tpls2 = store._load_templates(self.home)
        self.assertIn("blank", tpls2)
        # Explicit injection of fixture templates still works.
        fx, _ = _fixture_tpl()
        e = store.post("oracle", "alice", "op", "", op=opening(), home=self.home,
                       clock=self.clock, templates=fx)
        self.assertEqual(e["op"]["kind"], "plan.open")
        # User templates directory resolves neutral without fixture coupling.
        (udir / "neutral.json").write_text(json.dumps(_fixture_tpl()[1]), encoding="utf-8")
        tpls3 = store._load_templates(self.home)
        self.assertIn("neutral", tpls3)
