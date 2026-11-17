"""M4/A4: actual UTF-8 wire size, inclusive ceilings, atomic mixed batches."""
from unittest.mock import patch

from bridge.room import store
from bridge.tests.room.u121.support import BEAT, RESERVE, RoomCase, memory


class ReserveTests(RoomCase):
    def test_m4_constants(self):
        self.assertEqual(store.CAP, 8 * 1024 * 1024)
        self.assertEqual(getattr(store, "SEMANTIC_RESERVE_BYTES", None), RESERVE)

    def candidate(self, kind, text="é progress"):
        if kind == "heartbeat":
            return lambda: self.heartbeat(text)
        if kind == "beat":
            return lambda: self.post(dict(BEAT, note=text))
        if kind == "beat_batch":
            return lambda: self.batch([dict(BEAT, note=text)])
        if kind == "mixed_batch":
            # A-U164: measure the complete evidence-bearing wire operation.
            return lambda: self.batch([dict(BEAT, note=text), self.completion_op()])
        if kind == "semantic_batch":
            return lambda: self.batch([memory(text=text)])
        return lambda: self.post(memory(text=text))

    def boundary(self, kind, over, separator=False):
        if separator:
            self.path.write_bytes(self.raw().rstrip(b"\n"))
        call = self.candidate(kind, text="é火 progress")
        size = self.payload_size(call)
        before = self.raw()
        lower = kind in ("heartbeat", "beat", "beat_batch", "mixed_batch")
        # CAP alone is scaled. The specified reserve is unchanged. Measuring
        # the actual serialized candidate avoids hard-coding metadata layout.
        cap = len(before) + size + (RESERVE if lower else 0) - int(over)
        with patch.object(store, "CAP", cap):
            if over:
                self.refuse(call, "room_full")
            else:
                result = call()
                self.assertTrue(result)
                self.assertEqual(len(self.raw()), len(before) + size)
        if not over:
            self.assertEqual(self.projection()["rejected"], [])

    def test_a4_real_reserve_refuses_beat_but_allows_completion(self):
        self.fill_to(store.CAP - RESERVE)
        self.refuse(lambda: self.post(BEAT), "room_full")
        self.completion()
        self.assertEqual(self.projection()["tasks"][0]["microtasks"][0]["state"], "done")
        self.assertLessEqual(len(self.raw()), store.CAP)

    def test_a4_batch_reserve_refusal_then_semantic_completion(self):
        beat_call = self.candidate("beat_batch")
        size = self.payload_size(beat_call)
        with patch.object(store, "CAP", len(self.raw()) + size + RESERVE - 1):
            self.refuse(beat_call, "room_full")
            # A-U164: semantic completion still carries the required evidence.
            events = self.batch([self.completion_op()])
        self.assertEqual(len(events), 1)
        self.assertEqual(self.projection()["tasks"][0]["microtasks"][0]["state"], "done")

    def test_a4_mixed_batch_never_silently_drops_a_member(self):
        call = self.candidate("mixed_batch")
        size = self.payload_size(call)
        with patch.object(store, "CAP", len(self.raw()) + size + RESERVE - 1):
            self.refuse(call, "room_full")
        self.assertEqual(self.projection()["tasks"][0]["microtasks"][0]["state"], "active")


def boundary_test(kind, over, separator):
    def test(self):
        self.boundary(kind, over, separator)
    return test


for kind in ("heartbeat", "beat", "beat_batch", "mixed_batch", "semantic", "semantic_batch"):
    for over in (False, True):
        for separator in (False, True):
            name = "test_a4_" + kind + ("_one_byte_over" if over else "_exact_ceiling")
            name += "_separator" if separator else "_newline"
            setattr(ReserveTests, name, boundary_test(kind, over, separator))
