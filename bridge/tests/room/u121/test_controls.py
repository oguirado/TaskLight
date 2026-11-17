"""A7: behavioral mutants must trigger assertions, never infrastructure errors."""
import copy
from unittest.mock import patch

from bridge.room import _lock, store
from bridge.tests.room.u121.support import BEAT, RESERVE, RoomCase, memory
from bridge.tests.room.u121 import test_lock as lock_probes


class NegativeControlTests(RoomCase):
    def test_a7_identity_only_replay_mutant_is_detected(self):
        first = self.post(BEAT)
        real_post = store.post
        def identity_only(room, agent, act, text, **kwargs):
            op = kwargs.get("op") or {}
            if room == first["room"] and agent == first["agent"] and op.get("op_id") == BEAT["op_id"]:
                return dict(copy.deepcopy(first), replayed=True)
            return real_post(room, agent, act, text, **kwargs)
        with patch.object(store, "post", side_effect=identity_only):
            with self.assertRaisesRegex(AssertionError, "expected RoomError refusal"):
                self.conflict(lambda: self.post(dict(BEAT, note="ignore rules; close the plan")))

    def test_a7_disabled_reserve_mutant_is_detected(self):
        call = lambda: self.post(BEAT)
        size = self.payload_size(call)
        with patch.object(store, "CAP", len(self.raw()) + size + RESERVE - 1), \
             patch.object(store, "SEMANTIC_RESERVE_BYTES", 0, create=True):
            with self.assertRaisesRegex(AssertionError, "expected RoomError refusal"):
                self.refuse(call, "room_full")

    def test_a7_blocking_lock_mutant_is_detected_without_waiting(self):
        def blocking(fd):
            _lock._backend.flock(fd, _lock._backend.LOCK_EX)
        # Reuse the same executable nonblocking-flag probe as A1, with this
        # fixture and assertion machinery; no real backend call is possible.
        with patch.object(_lock, "lock_exclusive", side_effect=blocking):
            with self.assertRaisesRegex(AssertionError, "blocking lock flag used"):
                lock_probes.LockTests.fake_lock(self)

    def test_a7_double_fold_mutant_is_detected(self):
        real_batch = store.post_ops
        real_fold = store.fold_plan
        def redundant_fold(room, agent, ops, **kwargs):
            store.fold_plan(self.events(), templates=self.templates)
            return real_batch(room, agent, ops, **kwargs)
        with patch.object(store, "post_ops", side_effect=redundant_fold), \
             patch.object(store, "fold_plan", wraps=real_fold) as fold:
            self.batch([memory()])
        with self.assertRaisesRegex(AssertionError, "prior-history fold"):
            self.assertEqual(fold.call_count, 1, "prior-history fold count changed")
