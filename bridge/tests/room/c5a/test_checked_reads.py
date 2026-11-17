"""M1 strict storage contract and M6 preserved tolerant-reader controls."""
import os

from bridge.room import store
from .support import BROKEN_JOURNALS, OracleCase, encoded, record


class CheckedReads(OracleCase):
    def test_m1_healthy_events_equal_legacy_read_without_mutation(self):
        events = [record(lamport=2), record(lamport=1), record(lamport=2)]
        self.install(b"".join(encoded(event) for event in events))
        (self.path().parent / "sentinel").write_bytes(b"unchanged")
        expected, malformed = store.read("demo")
        self.assertEqual((expected, malformed), (events, 0))
        with self.unchanged():
            self.assertEqual(self.checked(), expected)

    def test_m1_existing_empty_journal_succeeds(self):
        self.install()
        with self.unchanged():
            self.assertEqual(self.checked(), [])

    def test_m1_existing_blank_journal_succeeds(self):
        self.install(b"\n \t\r\n\n")
        with self.unchanged():
            self.assertEqual(self.checked(), [])

    def test_m1_absent_home_is_not_created_by_checked_read(self):
        with self.unchanged():
            self.expect_room_error(self.checked)
        self.assertFalse(self.home.exists())

    def test_m1_absent_room_is_not_created_by_checked_read(self):
        (self.home / "rooms").mkdir(parents=True)
        with self.unchanged():
            self.expect_room_error(self.checked)
        self.assertFalse(self.path().parent.exists())

    def test_m1_existing_symlink_matches_legacy_acceptance_policy(self):
        target = self.runtime / "elsewhere.jsonl"
        event = record()
        target.write_bytes(encoded(event))
        self.path().parent.mkdir(parents=True)
        self.path().symlink_to(os.path.relpath(target, self.path().parent))
        self.assertEqual(store.read("demo"), ([event], 0),
                         "this baseline accepts journal symlinks; M1 rejection is conditional")
        with self.unchanged():
            self.assertEqual(self.checked(), [event])

    def test_m1_dangling_journal_symlink_is_missing_storage(self):
        self.path().parent.mkdir(parents=True)
        self.path().symlink_to("missing-target.jsonl")
        with self.unchanged():
            self.expect_room_error(self.checked)

    def test_m1_room_failures_do_not_poison_an_independent_healthy_room(self):
        self.install(b"not-json\n")
        event = record(room="healthy")
        self.install(encoded(event), room="healthy")
        with self.unchanged():
            self.expect_room_error(self.checked)
            self.assertEqual(self.checked("healthy"), [event])

    def test_m1_repair_is_observed_without_persisted_read_state(self):
        self.install(b"not-json\n")
        with self.unchanged():
            self.expect_room_error(self.checked)
        event = record()
        self.path().write_bytes(encoded(event))
        with self.unchanged():
            self.assertEqual(self.checked(), [event])


def broken_case(kind):
    def check(self):
        self.install(encoded(record()))
        path = self.break_journal(kind)
        with self.unchanged(), self.io_fault(path, kind):
            self.expect_room_error(self.checked)
    check.__doc__ = "M1/M5 reject %s without disclosure or filesystem mutation." % kind
    return check


for _kind in BROKEN_JOURNALS:
    setattr(CheckedReads, "test_m1_rejects_" + _kind, broken_case(_kind))


TORN_TAILS = {
    "json_fragment": b'{"private":"unfinished',
    "invalid_utf8": b'{"text":"\xe6\x97',
    "complete_json_without_newline": encoded(record(lamport=2)).rstrip(b"\n"),
    "invalid_non_json_without_newline": b"not-json",
    "wrong_room_without_newline": encoded(record(room="other", lamport=2)).rstrip(b"\n"),
}


def torn_case(tail):
    def check(self):
        event = record()
        self.install(encoded(event) + tail)
        self.assertEqual(store.read("demo"), ([event], 0))
        with self.unchanged():
            self.assertEqual(self.checked(), [event], "M1 a torn final line is not an error")
    return check


for _name, _tail in TORN_TAILS.items():
    setattr(CheckedReads, "test_m1_ignores_torn_" + _name, torn_case(_tail))


MALFORMED_COMPLETE = {
    "null": b"null\n",
    "scalar": b"42\n",
    "object_without_event_fields": b'{"x":1}\n',
    "invalid_event_envelope": encoded(record(id="not-an-event-id")),
    "invalid_op_envelope": encoded(record(act="op", op={"kind": "nonexistent"})),
}


def malformed_case(data):
    def check(self):
        self.install(encoded(record()) + data)
        with self.unchanged():
            self.expect_room_error(self.checked)
    return check


for _name, _data in MALFORMED_COMPLETE.items():
    setattr(CheckedReads, "test_m1_rejects_complete_" + _name, malformed_case(_data))


class LegacyTolerance(OracleCase):
    def test_m6_missing_journal_remains_tolerant_without_creation(self):
        with self.unchanged():
            self.assertEqual(store.read("demo"), ([], 0))

    def test_m6_directory_journal_remains_tolerant(self):
        self.path().mkdir(parents=True)
        with self.unchanged():
            self.assertEqual(store.read("demo"), ([], 0))

    def test_m6_malformed_lines_are_counted_and_healthy_events_survive(self):
        events = [record(), record(lamport=2)]
        self.install(encoded(events[0]) + b"garbage\n[1,2]\n\xff\n \t\n" + encoded(events[1]))
        with self.unchanged():
            self.assertEqual(store.read("demo"), (events, 3))

    def test_m6_torn_tail_remains_ignored_by_legacy_read(self):
        event = record()
        self.install(encoded(event) + b'{"unfinished":')
        with self.unchanged():
            self.assertEqual(store.read("demo"), ([event], 0))

    def test_m6_since_filter_and_parse_diagnostics_are_preserved(self):
        event = record(lamport=2)
        self.install(encoded(record()) + b"bad\n" + encoded(event))
        with self.unchanged():
            self.assertEqual(store.read("demo", since=1), ([event], 1))

    def test_m6_waiter_still_skips_corruption_without_sleeping(self):
        event = record()
        self.install(b"bad\n" + encoded(event))
        with self.unchanged():
            self.assertEqual(store.wait("demo", 0, timeout_s=0), event)
            self.assertIsNone(store.wait("demo", 1, timeout_s=0))

    def test_m6_inbox_still_filters_tolerant_events(self):
        event = record(act="question", to="worker")
        self.install(b"bad\n" + encoded(event))
        with self.unchanged():
            self.assertEqual(store.inbox("demo", "worker"), [event])

    def test_m6_status_observer_keeps_tolerant_valid_content(self):
        event = record(act="question", to="worker")
        self.install(b"bad\n" + encoded(event))
        with self.unchanged():
            result = store.status("demo")
        self.assertEqual(result["open_questions"], [event])

    def test_m6_export_keeps_tolerant_empty_projection(self):
        self.install(b"bad\n")
        with self.unchanged():
            result = self.direct("room_export", dict(room="demo", agent="worker", what="plan"))
        self.assertEqual(result["format"], "markdown")
        self.assertEqual(result["rev"], 0)
        self.assertIsInstance(result["text"], str)

    def test_m6_snapshot_keeps_its_distinct_snapshot_unavailable_code(self):
        self.install(b"bad\n")
        with self.unchanged():
            self.expect_room_error(lambda: self.direct("orchestrator_snapshot", dict(room="demo")),
                                   "snapshot_unavailable", fixed=False)
