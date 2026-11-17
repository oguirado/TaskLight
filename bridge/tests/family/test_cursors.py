"""M9/A8: nonwaiting locked snapshots and adapter-only event revisions."""
import copy

from .support import FamilyCase, REAL_DISPATCH, canonical, envelope


def event(n, *, act="heartbeat", op=None):
    value = dict(id="e-%016x" % n, lamport=n, ts=n * 1000,
                 room="demo", agent="executor-a", act=act, text="passive event")
    if op is not None:
        value["op"] = copy.deepcopy(op)
    return value


class CursorOracle(FamilyCase):
    def seed(self):
        for item in (event(1), event(2, act="op", op={"kind": "task.set",
                     "task_id": "T01", "base_rev": 1, "state": "blocked"}), event(3)):
            self.append_committed(item)

    def read(self, *, identity="events-0001", after=0, payload=None):
        value = envelope(id=identity, kind="events.read", after=after,
                         payload={} if payload is None else payload)
        value.pop("run_id")
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        return self.receipt(identity)["result"]["untrusted"]

    def assert_matches_shared_cursor(self, page, after, payload):
        original = REAL_DISPATCH("room_events", dict(payload, room="demo", agent="executor-a",
                                                    after_lamport=after, wait_ms=0))["untrusted"]
        normalized = copy.deepcopy(page)
        for item in normalized["events"]:
            self.assertEqual(item.pop("revision"), item["lamport"])
        self.assertEqual(normalized, original)

    def test_a8_paged_reads_match_room_events_modulo_revision(self):
        self.seed()
        first = self.read(payload={"limit": 1})
        self.assert_matches_shared_cursor(first, 0, {"limit": 1})
        self.assertTrue(first["has_more"])
        second = self.read(identity="events-0002", after=first["next_after"], payload={"limit": 1})
        self.assert_matches_shared_cursor(second, first["next_after"], {"limit": 1})
        self.assertNotEqual(first["events"][0]["id"], second["events"][0]["id"])

    def test_a8_filtered_reads_preserve_event_identity_op_and_cursor(self):
        self.seed()
        filters = {"acts": ["op"], "ops": ["task.set"], "limit": 2}
        page = self.read(payload=filters)
        self.assert_matches_shared_cursor(page, 0, filters)
        self.assertEqual([e["lamport"] for e in page["events"]], [2])
        self.assertEqual(page["events"][0]["revision"], 2)
        self.assertEqual(page["events"][0]["op"]["base_rev"], 1)
        self.assertEqual(page["head"], 3)
        self.assertEqual(page["next_after"], 3)

    def test_a8_future_cursor_requests_resync(self):
        self.seed()
        page = self.read(after=99)
        self.assert_matches_shared_cursor(page, 99, {})
        self.assertEqual(page, {"events": [], "next_after": 3, "head": 3,
                                "has_more": False, "resync": True})

    def test_empty_room_has_no_created_journal_or_events_lock(self):
        page = self.read()
        self.assertEqual(page, {"events": [], "next_after": 0, "head": 0,
                                "has_more": False, "resync": False})
        self.assertFalse(self.journal().parent.exists(), "empty snapshot created room storage")
        self.assertFalse(self.trace.locked)

    def test_a8_partial_batch_is_not_read_before_writer_commit(self):
        self.append_committed(event(1))
        journal = self.journal()
        # Deterministic schedule: a writer has appended an uncommitted prefix.
        with journal.open("ab") as stream:
            stream.write(canonical(event(2)) + b"\n")
        committed = []
        def finish_writer():
            self.append_committed(event(3))
            committed.append(True)
        self.trace.before_read_lock = finish_writer
        page = self.read()
        self.assertEqual(committed, [True], "reader bypassed the pending writer")
        self.assertEqual([e["lamport"] for e in page["events"]], [1, 2, 3])
        self.assert_matches_shared_cursor(page, 0, {})

    def test_reads_never_request_backend_long_poll(self):
        self.seed()
        self.read()
        self.assertEqual(self.backend.calls, [("room_events", {
            "room": "demo", "agent": "executor-a", "after_lamport": 0, "wait_ms": 0})])
        self.sleep.assert_not_called()
