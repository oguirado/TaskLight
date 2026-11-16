"""Regression oracles for unified operation identity and strict templates."""
import copy
from unittest import mock

from bridge.room import store
from . import support
from .u56_repair3_test import _adding, _fixture_tpl, _opening


class Repair4(support.RoomCase):
    def setUp(self):
        super().setUp()
        self.templates, _ = _fixture_tpl()
        self.kw = dict(home=self.home, clock=self.clock, templates=self.templates)
        store.post("oracle", "alice", "op", "", op=_opening(), **self.kw)

    def assert_conflict(self, call):
        path = support.events_path(self.home, "oracle")
        before = path.read_bytes()
        with self.assertRaises(store.RoomError) as cm:
            call()
        self.assertEqual(str(cm.exception), "bad_op: op_id conflict")
        self.assertEqual(path.read_bytes(), before)

    def test_a_single_then_batch_conflicts(self):
        op = _adding(op_id="op-shared-01")
        first = store.post("oracle", "alice", "op", "", op=op, **self.kw)
        self.assert_conflict(lambda: store.post_ops("oracle", "alice", [op], **self.kw))
        replay = store.post("oracle", "alice", "op", "", op=dict(op, title="Changed"), **self.kw)
        self.assertEqual(replay["id"], first["id"])
        self.assertTrue(replay["replayed"])

    def test_b_duplicate_member_conflicts(self):
        self.assert_conflict(lambda: store.post_ops("oracle", "alice", [
            _adding(op_id="op-alpha-01"), _adding(op_id="op-alpha-01")], **self.kw))

    def test_b_nonfirst_stored_member_conflicts(self):
        store.post("oracle", "alice", "op", "", op=_adding(op_id="op-stored-01"), **self.kw)
        self.assert_conflict(lambda: store.post_ops("oracle", "alice", [
            _adding(op_id="op-fresh-01"), _adding(op_id="op-stored-01")], **self.kw))

    def test_c_reordered_batch_cannot_replay_as_single(self):
        ops = [_adding(key="a", deps=["b"], op_id="batch-0001"), _adding(key="b")]
        first = store.post_ops("oracle", "alice", copy.deepcopy(ops), **self.kw)
        self.assertEqual(first[1]["op"]["op_id"], "batch-0001")
        self.assert_conflict(lambda: store.post("oracle", "alice", "op", "",
                                              op=_adding(op_id="batch-0001"), **self.kw))
        before = support.events_path(self.home, "oracle").read_bytes()
        replay = store.post_ops("oracle", "alice", copy.deepcopy(ops), **self.kw)
        self.assertEqual([e["id"] for e in replay], [e["id"] for e in first])
        self.assertTrue(all(e["replayed"] for e in replay))
        self.assertEqual(support.events_path(self.home, "oracle").read_bytes(), before)

    def test_batch_member_identity_replays_batch(self):
        first = store.post_ops("oracle", "alice", [
            _adding(op_id="batch-main-01"), _adding(op_id="batch-member-01")], **self.kw)
        before = support.events_path(self.home, "oracle").read_bytes()
        replay = store.post_ops("oracle", "alice", [_adding(op_id="batch-member-01")], **self.kw)
        self.assertEqual([e["id"] for e in replay], [e["id"] for e in first])
        self.assertTrue(all(e["replayed"] for e in replay))
        self.assertEqual(support.events_path(self.home, "oracle").read_bytes(), before)

    def test_agent_identity_is_independent(self):
        op = _adding(op_id="op-shared-01")
        store.post("oracle", "alice", "op", "", op=op, **self.kw)
        result = store.post_ops("oracle", "bob", [op], **self.kw)
        self.assertNotIn("replayed", result[0])

    def test_non_strict_missing_archived_template_uses_fallback(self):
        with mock.patch.object(store, "_load_templates", return_value=self.templates):
            self.assertEqual(store._tpl_kw(needed=["missing-archived-template"]),
                             {})

    def test_strict_missing_template_fails_closed(self):
        self._strict_failure({}, "unknown_template")

    def test_strict_missing_conformance_fails_closed(self):
        with mock.patch.object(store, "check_conformance", None):
            self._strict_failure(self.templates, "unknown_template")

    def test_strict_missing_archived_template_fails_closed(self):
        with mock.patch.object(store, "_plan_template_ids",
                               return_value=["missing-archived-template"]):
            self._strict_failure(self.templates, "unknown_template")

    def test_strict_merges_runtime_and_injected_templates(self):
        with mock.patch.object(store, "_load_templates", return_value=self.templates):
            result = store._tpl_kw(templates={"extra": {}},
                                   needed=[*self.templates, "extra"], strict=True)
        self.assertEqual(result, {"templates": dict(self.templates, extra={})})

    def test_strict_runs_conformance(self):
        with mock.patch.object(store, "check_conformance",
                               return_value={"ok": True, "findings": []}) as check:
            store.post_ops("oracle", "alice", [_adding()], strict=True, **self.kw)
        check.assert_called()

    def test_strict_nonconformance_is_not_appended(self):
        with mock.patch.object(store, "check_conformance", return_value={"ok": False}):
            self._strict_failure(self.templates, "not_conformant")

    def _strict_failure(self, runtime, code):
        before = support.events_path(self.home, "oracle").read_bytes()
        with mock.patch.object(store, "_load_templates", return_value=runtime):
            with self.assertRaises(store.RoomError) as cm:
                store.post_ops("oracle", "alice", [_adding()], strict=True,
                               home=self.home, clock=self.clock)
        self.assertEqual(cm.exception.code, code)
        self.assertEqual(support.events_path(self.home, "oracle").read_bytes(), before)

    def test_surrogate_text_is_room_error_before_directory_creation(self):
        with self.assertRaises(store.RoomError) as cm:
            store.post("unused", "alice", "heartbeat", "\ud800", **self.kw)
        self.assertEqual(cm.exception.code, "bad_op")
        self.assertFalse(support.room_dir(self.home, "unused").exists())
