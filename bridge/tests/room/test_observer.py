"""RoomObserver: poll -> emit_fn(project=, kind=, text=, source=), cursor semantics."""
import inspect, unittest

from bridge.room.observer import RoomObserver
from .support import RoomCase, canon, mk_event, seed


class Rec:
    def __init__(self, results=None):
        self.calls, self.results = [], list(results or [])

    def __call__(self, project, kind, text, source="agent"):
        self.calls.append({"project": project, "kind": kind, "text": text, "source": source})
        return self.results.pop(0) if self.results else True


class Observer(RoomCase):
    def obs(self, fn):
        return RoomObserver(str(self.home / "rooms" / "*"), fn)

    def test_emits_each_event_once_with_expected_kwargs(self):
        e1, e2 = mk_event(1, room="ra"), mk_event(2, room="ra", text="ñ")
        seed(self.home, "ra", [e1, e2])
        rec = Rec()
        o = self.obs(rec)
        o.poll()
        self.assertEqual(rec.calls, [
            {"project": "ra", "kind": "agent_event", "text": canon(e1), "source": "agent"},
            {"project": "ra", "kind": "agent_event", "text": canon(e2), "source": "agent"}])
        o.poll()
        self.assertEqual(len(rec.calls), 2)
        seed(self.home, "ra", [mk_event(3, room="ra")])
        o.poll()
        self.assertEqual(len(rec.calls), 3)
        self.assertEqual(rec.calls[-1]["text"], canon(mk_event(3, room="ra")))

    def test_called_with_keywords_only_compatible(self):
        seen = []
        seed(self.home, "ra", [mk_event(1, room="ra")])
        self.obs(lambda **kw: seen.append(kw) or True).poll()
        self.assertEqual(set(seen[0]), {"project", "kind", "text", "source"})

    def test_real_emit_signature_is_compatible(self):
        from bridge.wall.emit import emit
        inspect.signature(emit).bind(project="ra", kind="agent_event", text="{}", source="agent")

    def test_cursor_does_not_advance_on_falsy(self):
        seed(self.home, "ra", [mk_event(1, room="ra")])
        rec = Rec([False, None, 0, True])
        o = self.obs(rec)
        for _ in range(4):
            o.poll()
        self.assertEqual(len(rec.calls), 4)                        # re-offered until truthy
        self.assertEqual(len({c["text"] for c in rec.calls}), 1)
        o.poll()
        self.assertEqual(len(rec.calls), 4)                        # then consumed

    def test_failure_midway_keeps_order_and_earlier_cursor(self):
        seed(self.home, "ra", [mk_event(i, room="ra") for i in (1, 2, 3)])
        rec = Rec([True, False])
        o = self.obs(rec)
        o.poll()
        first_poll = [c["text"] for c in rec.calls]
        self.assertEqual(first_poll[:2], [canon(mk_event(1, room="ra")), canon(mk_event(2, room="ra"))])
        n = len(rec.calls)
        o.poll()
        self.assertEqual(rec.calls[n]["text"], canon(mk_event(2, room="ra")))   # 2 retried, 1 not repeated
        self.assertNotIn(canon(mk_event(1, room="ra")), [c["text"] for c in rec.calls[n:]])

    def test_cursor_per_room(self):
        seed(self.home, "ra", [mk_event(1, room="ra")])
        seed(self.home, "rb", [mk_event(1, room="rb"), mk_event(2, room="rb")])
        rec = Rec()
        o = self.obs(rec)
        o.poll()
        self.assertEqual(sorted(c["project"] for c in rec.calls), ["ra", "rb", "rb"])
        seed(self.home, "ra", [mk_event(2, room="ra")])
        o.poll()
        self.assertEqual([c["project"] for c in rec.calls[3:]], ["ra"])

    def test_new_room_appearing_later_is_picked_up(self):
        rec = Rec()
        o = self.obs(rec)
        o.poll()
        self.assertEqual(rec.calls, [])
        seed(self.home, "late", [mk_event(1, room="late")])
        o.poll()
        self.assertEqual([c["project"] for c in rec.calls], ["late"])

    def test_malformed_and_torn_lines_skipped_once(self):
        seed(self.home, "ra", [mk_event(1, room="ra")], raw_lines=["garbage", "[1]"],
             raw_tail=b'{"torn":')
        rec = Rec()
        o = self.obs(rec)
        o.poll()
        o.poll()
        self.assertEqual([c["text"] for c in rec.calls], [canon(mk_event(1, room="ra"))])

    def test_glob_limits_rooms(self):
        seed(self.home, "ra", [mk_event(1, room="ra")])
        seed(self.home, "zz", [mk_event(1, room="zz")])
        rec = Rec()
        RoomObserver(str(self.home / "rooms" / "r*"), rec).poll()
        self.assertEqual([c["project"] for c in rec.calls], ["ra"])


if __name__ == "__main__":
    unittest.main()
