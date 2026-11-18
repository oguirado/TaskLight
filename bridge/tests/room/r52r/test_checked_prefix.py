"""Exercise the public checked reader after warming it on the same journal."""

import builtins
from contextlib import contextmanager, ExitStack
import errno
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from bridge.room import store
from bridge.tests.bench import fixtures


HERE = Path(__file__).resolve().parent
ROOM = "checked-prefix"
ROWS = 4_000
CURSOR = ROWS - 1
FRAGMENT = b'{"incomplete":"fixture detail"'
FILL = "x" * 3_900


def row(number, **fields):
    return fixtures.event(number, **{"room": ROOM, "text": FILL, **fields})


def wire(*rows):
    return fixtures.journal(rows)


class CheckedPrefixOracle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.first = row(1, act="op", text="prefix decode marker",
                        op={"kind": "memory.set", "section": "goal", "base_rev": 0,
                            "text": "proof rule marker"})
        cls.first_line = wire(cls.first)
        cls.interior = ROWS // 3
        cls.before_interior = cls.first_line + fixtures.journal(
            row(number) for number in range(2, cls.interior))
        cls.interior_line = wire(row(cls.interior))
        cls.after_interior = fixtures.journal(
            row(number) for number in range(cls.interior + 1, ROWS + 1))
        cls.original = cls.before_interior + cls.interior_line + cls.after_interior

    def setUp(self):
        self.home = Path(self.enterContext(tempfile.TemporaryDirectory(dir=HERE)))
        self.journal = self.install(self.home, ROOM, self.original)

    @staticmethod
    def install(home, room, data):
        path = home / "rooms" / room / "events.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def read(self, since=CURSOR):
        return store.read_checked(ROOM, since=since, home=self.home)

    def seed(self):
        self.assertEqual(self.read(), ([row(ROWS)], 0))

    def assert_failure(self, read=None):
        if read is None:
            read = self.read
        with self.assertRaises(store.RoomError) as caught:
            read()
        self.assertEqual(caught.exception.code, "room_read_failed")
        self.assertEqual(str(caught.exception), "room_read_failed: Room data could not be read.")

    def rewrite_interior(self, replacement, *, grow=True):
        self.assertEqual(len(replacement), len(self.interior_line))
        with self.journal.open("r+b") as journal:
            journal.seek(len(self.before_interior))
            journal.write(replacement)
            if grow:
                journal.seek(0, os.SEEK_END)
                journal.write(wire(row(ROWS + 1)))

    def append(self, data):
        with self.journal.open("ab") as journal:
            journal.write(data)

    @contextmanager
    def before_journal_open(self, action):
        # Observe the filesystem boundary for both Python stream and fd readers.
        # A stream opener may delegate to a patched fd opener in the same call.
        inside_open = False

        def wrap(original):
            def open_file(file, *args, **kwargs):
                nonlocal inside_open
                if (inside_open or isinstance(file, int)
                        or Path(os.fsdecode(file)) != self.journal):
                    return original(file, *args, **kwargs)
                inside_open = True
                try:
                    action()
                    return original(file, *args, **kwargs)
                finally:
                    inside_open = False
            return open_file

        with ExitStack() as patches:
            for module in (builtins, io, os):
                patches.enter_context(patch.object(module, "open", new=wrap(module.open)))
            yield

    def test_warm_recent_cursor_skips_decoding_a_validated_prefix(self):
        self.seed()
        decoder = json.JSONDecoder.raw_decode.__code__
        marker = self.first["text"]
        prefix_decodes = 0

        def observe(frame, event, arg):
            nonlocal prefix_decodes
            if event == "call" and frame.f_code is decoder and marker in frame.f_locals["s"]:
                prefix_decodes += 1

        prior = sys.getprofile()
        try:
            sys.setprofile(observe)
            result = self.read()
        finally:
            sys.setprofile(prior)
        self.assertEqual(result, ([row(ROWS)], 0))
        self.assertEqual(prefix_decodes, 0,
                         "warm recent cursor decoded a row already validated in the prefix")

    def test_interior_rewrite_plus_append_can_move_a_row_above_cursor(self):
        self.seed()
        changed = row(self.interior)
        # Same line length, same inode, and old end bytes survive the append.
        changed["lamport"] = ROWS + 2
        self.rewrite_interior(wire(changed))
        self.assertEqual(self.read(), ([changed, row(ROWS), row(ROWS + 1)], 0))

    def test_hidden_foreign_row_after_interior_rewrite_and_growth_fails_closed(self):
        self.seed()
        foreign = row(self.interior, room="foreign-prefix")
        self.rewrite_interior(wire(foreign))
        self.assert_failure()

    def test_hidden_malformed_row_after_interior_rewrite_and_growth_fails_closed(self):
        malformed = {
            "bad-json": self.interior_line.replace(b'"lamport":', b'"lamport" ', 1),
            "bad-utf8": self.interior_line.replace(b"xxxx", b"\xffxxx", 1),
            "boolean-lamport": self.interior_line.replace(
                f'"lamport":{self.interior}'.encode(), b'"lamport":true', 1),
        }
        for kind, broken in malformed.items():
            with self.subTest(kind=kind):
                self.journal.write_bytes(self.original)
                self.seed()
                self.rewrite_interior(broken)
                self.assert_failure()

    def test_truncate_and_regrow_reads_changed_prefix(self):
        self.seed()
        changed = row(self.interior)
        changed["lamport"] = ROWS + 2
        with self.journal.open("r+b") as journal:
            journal.truncate(len(self.before_interior))
            journal.seek(0, os.SEEK_END)
            journal.write(wire(changed) + self.after_interior + wire(row(ROWS + 1)))
        self.assertEqual(self.read(), ([changed, row(ROWS), row(ROWS + 1)], 0))

    def test_atomic_replacement_does_not_reuse_stale_validation(self):
        self.seed()
        replacement = self.journal.with_name("replacement")
        replacement.write_bytes(
            self.before_interior + wire(row(self.interior, room="foreign-prefix"))
            + self.after_interior)
        os.replace(replacement, self.journal)
        self.assert_failure()

    def test_warm_permission_loss_is_a_read_failure(self):
        self.seed()

        def deny():
            raise PermissionError(errno.EACCES, "fixture access denied", self.journal)

        with self.before_journal_open(deny):
            self.assert_failure()
        self.seed()

    def test_unchanged_bytes_require_current_validation_rules(self):
        self.seed()
        original = store.validate_op_shape

        def revised_rules(op):
            if op.get("text") == self.first["op"]["text"]:
                raise store.RoomError("bad_op", "fixture rule changed")
            return original(op)

        with patch.object(store, "validate_op_shape", new=revised_rules):
            self.assert_failure()
        self.seed()

    def test_proof_cannot_certify_rows_from_a_different_capture(self):
        self.seed()
        # One view has a bad suffix and the other a bad prefix. Neither is readable.
        self.append(FRAGMENT + b"\n")
        replacement = self.journal.with_name("replacement")
        replacement.write_bytes(
            self.before_interior + wire(row(self.interior, room="foreign-prefix"))
            + self.after_interior + wire(row(ROWS + 1)))
        opens = 0

        def swap_on_reopen():
            nonlocal opens
            opens += 1
            if opens == 2:
                os.replace(replacement, self.journal)

        with self.before_journal_open(swap_on_reopen):
            self.assert_failure()

    def test_a_proof_cannot_authorize_the_same_bytes_in_another_room(self):
        other = "another-room"
        alias = self.home / "rooms" / other / "events.jsonl"
        alias.parent.mkdir()
        os.link(self.journal, alias)
        self.seed()
        self.assert_failure(lambda: store.read_checked(other, since=CURSOR, home=self.home))

    def test_room_churn_preserves_checked_replay_on_revisit(self):
        self.seed()
        for index in range(48):
            room = f"churn-{index}"
            event = row(1, room=room, text="room churn")
            self.install(self.home, room, wire(event))
            self.assertEqual(store.read_checked(room, since=1, home=self.home), ([], 0))
        self.seed()
        self.rewrite_interior(wire(row(self.interior, room="foreign-prefix")))
        self.assert_failure()

    def test_valid_torn_tail_becomes_visible_when_completed(self):
        torn = row(ROWS + 1, text="tail", evidence=[{"path": "fixture", "sha256": "0" * 64}])
        self.append(wire(torn)[:-1])
        self.seed()
        self.append(b"\n")
        self.assertEqual(self.read(), ([row(ROWS), torn], 0))

    def test_invalid_torn_tail_fails_when_completed_even_past_cursor(self):
        self.append(FRAGMENT)
        self.seed()
        self.append(b"\n")
        self.assert_failure(lambda: self.read(ROWS + 1))

    def test_older_cursor_and_prefix_maximum_keep_earlier_physical_rows(self):
        early = {**self.first, "lamport": ROWS + 1}
        self.journal.write_bytes(wire(early) + self.original[len(self.first_line):])
        self.assertEqual(self.read(ROWS + 1), ([], 0))
        self.assertEqual(self.read(), ([early, row(ROWS)], 0))
        self.assertEqual(self.read(1), (
            [early] + [row(n) for n in range(2, ROWS + 1)], 0))

    def test_warm_reads_preserve_physical_order_duplicates_and_nested_values(self):
        self.seed()
        last = row(ROWS + 2, text="nested", evidence=[{"path": "fixture", "sha256": "0" * 64}])
        late = row(ROWS + 1, text="physically later")
        self.append(b" \t\n" + wire(last, late, last))
        expected = [row(ROWS), last, late, last]

        events, malformed = self.read()
        self.assertEqual((events, malformed), (expected, 0))
        events[1]["evidence"][0]["path"] = "caller mutation"
        self.assertEqual(events[3], last)
        events.pop()
        self.assertEqual(self.read(), (expected, 0))
