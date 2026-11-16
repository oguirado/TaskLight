"""U56 stop rule: legacy wire bytes, reads, errors and returns are frozen."""
import hashlib
from unittest import mock
from bridge.room import store
from . import support
from . import u56_op_store_test as oracle


class LegacyCompat(oracle.OpCase):
    def test_all_legacy_acts_golden_bytes_and_read_models(self):
        proof = self.make_file(data=b"proof\n")
        evidence = [{"path": str(proof.resolve()), "sha256": hashlib.sha256(b"proof\n").hexdigest()}]
        cases = [
            ("open", {}),
            ("plan", {"plan": {"title": "Plan", "steps": [{"text": "Step", "accept": "Done"}]}}),
            ("step", {"step": {"index": 0, "state": "done", "outcome": "OK", "took": "1m"}}),
            ("question", {"to": "bob"}),
            ("answer", {"re": "e-0000000000000004", "to": "bob"}),
            ("handoff", {"to": "bob"}),
            ("ack", {"re": "e-0000000000000006"}),
            ("heartbeat", {}), ("verdict", {}), ("close", {}),
        ]
        expected = []
        for n, (act, fields) in enumerate(cases, 1):
            e = {"id": "e-%016x" % n, "lamport": n, "ts": 1000000,
                 "room": "oracle", "agent": "alice", "act": act, "text": "café",
                 "evidence": evidence, **fields}
            with mock.patch.object(store.secrets, "token_hex", return_value="%016x" % n):
                actual = store.post("oracle", "alice", act, "café", home=self.home,
                                    clock=lambda: 1000000, evidence=[str(proof)], **fields)
            self.assertEqual(actual, e)
            self.assertTrue(store._is_valid_event(e))
            expected.append(e)
        self.assertEqual(self.raw(), b"".join((support.canon(e) + "\n").encode() for e in expected))
        self.assertEqual(store.read("oracle", home=self.home), (expected, 0))
        self.assertEqual(store.read("oracle", since=8, home=self.home), (expected[8:], 0))
        self.assertEqual(store.wait("oracle", 3, timeout_s=0, home=self.home), expected[3])
        self.assertIsNone(store.wait("oracle", 10, timeout_s=0, home=self.home))
        self.assertEqual(store.inbox("oracle", "bob", home=self.home), [expected[i] for i in (3, 4, 5)])
        with mock.patch.object(store.time, "time", return_value=1000):
            self.assertEqual(store.status("oracle", home=self.home),
                             {"open_questions": [], "handoffs_without_ack": [],
                              "last_by_agent": {"alice": expected[-1]}, "silent": []})

    def test_legacy_event_with_op_is_invalid(self):
        ev = support.mk_event(1, op=oracle.memory())
        self.assertFalse(store._is_valid_event(ev))
        support.seed(self.home, "oracle", [ev])
        self.assertEqual(store.read("oracle", home=self.home), ([], 1))

    def test_legacy_plan_rejects_op_before_directories_or_lock(self):
        self.require_post()
        with mock.patch.object(store, "_ensure_dirs", side_effect=AssertionError("cross-contamination created directories")), \
             mock.patch.object(store.fcntl, "flock", side_effect=AssertionError("cross-contamination acquired lock")):
            with self.assertRaises(store.RoomError) as cm:
                store.post("oracle", "alice", "plan", "", op=oracle.memory(),
                           plan={"title": "Plan", "steps": [{"text": "Step"}]}, home=self.home)
        self.assertEqual(cm.exception.code, "bad_op")
        self.assertFalse(self.home.exists())

    def test_op_rejects_legacy_plan(self):
        with self.assertRaises(store.RoomError) as cm:
            self.send(oracle.memory(), plan={"title": "Plan", "steps": [{"text": "Step"}]})
        self.assertEqual(cm.exception.code, "bad_plan")
        self.assertFalse(self.home.exists())

    def test_op_rejects_legacy_step(self):
        with self.assertRaises(store.RoomError) as cm:
            self.send(oracle.memory(), step={"index": 0, "state": "done"})
        self.assertEqual(cm.exception.code, "bad_step")
        self.assertFalse(self.home.exists())

    def test_legacy_explicit_op_none_preserves_wire_bytes(self):
        self.require_post()
        with mock.patch.object(store.secrets, "token_hex", return_value="0" * 16):
            event = store.post("oracle", "alice", "heartbeat", "", op=None,
                               home=self.home, clock=lambda: 1000000)
        self.assertNotIn("op", event)
        self.assertEqual(self.raw(), b'{"act":"heartbeat","agent":"alice","id":"e-0000000000000000","lamport":1,"room":"oracle","text":"","ts":1000000}\n')


def install_error(name, code, args, kwargs):
    def test(self):
        with self.assertRaises(store.RoomError) as cm:
            store.post(*args, home=self.home, clock=lambda: 1000000, **kwargs)
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(self.home.exists())
    setattr(LegacyCompat, "test_legacy_error_" + name, test)


for name, code, args, kwargs in [
    ("room", "bad_room", ("BAD", "alice", "heartbeat", ""), {}),
    ("agent", "bad_agent", ("oracle", "BAD", "heartbeat", ""), {}),
    ("act", "bad_act", ("oracle", "alice", "unknown", ""), {}),
    ("text", "text_too_long", ("oracle", "alice", "heartbeat", "x" * 4097), {}),
    ("plan", "bad_plan", ("oracle", "alice", "plan", ""), {"plan": {}}),
    ("step", "bad_step", ("oracle", "alice", "step", ""), {"step": {"index": True, "state": "done"}}),
    ("re", "bad_re", ("oracle", "alice", "answer", ""), {}),
    ("evidence", "bad_evidence", ("oracle", "alice", "heartbeat", ""), {"evidence": ["relative"]}),
]:
    install_error(name, code, args, kwargs)
