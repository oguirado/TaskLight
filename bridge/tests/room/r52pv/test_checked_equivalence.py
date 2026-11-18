"""Compare warmed checked reads with a new interpreter on the same journal."""

import json
from os import SEEK_END
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from bridge.room import store
from bridge.tests.bench.fixtures import event, journal


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
ROOM = "checked-proof"
CURSOR = 30
READ_FAILURE = {
    "code": "room_read_failed",
    "message": "room_read_failed: Room data could not be read.",
}
FRESH_READ = """
import json
import sys
from bridge.tests.room.r52pv.test_checked_equivalence import checked_outcome

home, cursor = sys.argv[1:]
print(json.dumps(checked_outcome(home, int(cursor))))
"""


def checked_outcome(home, cursor):
    try:
        events, malformed = store.read_checked(ROOM, since=cursor, home=home)
    except store.RoomError as exc:
        return {"code": exc.code, "message": str(exc)}
    return {"result": [events, malformed]}


class CheckedReadEquivalence(unittest.TestCase):
    def setUp(self):
        self.home = Path(self.enterContext(tempfile.TemporaryDirectory(dir=HERE)))
        self.path = self.home / "rooms" / ROOM / "events.jsonl"
        self.path.parent.mkdir(parents=True)
        self.first = event(10, room=ROOM)
        self.interior = event(20, room=ROOM)
        self.boundary = event(30, room=ROOM)
        self.tail = event(40, room=ROOM)
        self.rows = [self.first, self.interior, self.boundary, self.tail]
        self.path.write_bytes(journal(self.rows))

    def seed(self):
        self.assertEqual(checked_outcome(self.home, CURSOR), {"result": [[self.tail], 0]})

    def assert_equivalent(self, expected, cursor=CURSOR):
        captured = self.path.read_bytes()
        warm = checked_outcome(self.home, cursor)
        self.assertEqual(self.path.read_bytes(), captured)
        command = [sys.executable, "-B"]
        if hasattr(sys, "get_int_max_str_digits"):
            command.extend(["-X", f"int_max_str_digits={sys.get_int_max_str_digits()}"])
        child = subprocess.run(
            [*command, "-c", FRESH_READ, str(self.home), str(cursor)],
            cwd=ROOT, capture_output=True, text=True, timeout=15, check=True,
        )
        self.assertEqual(self.path.read_bytes(), captured)
        fresh = json.loads(child.stdout)
        self.assertEqual(warm, fresh)
        self.assertEqual(fresh, expected)

    def rewrite_and_append(self, replacement, appended):
        self.assertEqual(len(replacement), len(journal([self.interior])))
        with self.path.open("r+b") as stream:
            stream.seek(len(journal([self.first])))
            stream.write(replacement)
            stream.seek(0, SEEK_END)
            stream.write(journal([appended]))

    def test_interior_rewrite_and_append_returns_promoted_row_in_physical_order(self):
        self.seed()
        promoted = dict(self.interior, lamport=50)
        appended = event(60, room=ROOM)
        self.rewrite_and_append(journal([promoted]), appended)

        self.assert_equivalent({"result": [[promoted, self.tail, appended], 0]})

    def test_interior_rewrite_and_append_rejects_malformed_row_below_cursor(self):
        self.seed()
        malformed = journal([self.interior]).replace(b'"lamport":', b'"lamport";', 1)
        self.assertNotEqual(malformed, journal([self.interior]))
        self.rewrite_and_append(malformed, event(60, room=ROOM))

        self.assert_equivalent(READ_FAILURE)

    def test_truncate_and_regrow_rejects_invalid_row_below_cursor(self):
        self.seed()
        kept = journal([self.first])
        invalid = dict(self.interior, lamport=True)
        with self.path.open("r+b") as stream:
            stream.truncate(len(kept))
            stream.seek(len(kept))
            stream.write(journal([invalid, self.boundary, self.tail, event(60, room=ROOM)]))

        self.assert_equivalent(READ_FAILURE)

    def test_atomic_replacement_rejects_foreign_row_below_cursor(self):
        self.seed()
        replacement = self.path.with_name("replacement")
        foreign = dict(self.interior, room="foreign-proof")
        replacement.write_bytes(journal([self.first, foreign, self.boundary, self.tail]))
        replacement.replace(self.path)

        self.assert_equivalent(READ_FAILURE)

    @unittest.skipUnless(hasattr(sys, "set_int_max_str_digits"), "requires the integer digit limit")
    def test_tighter_integer_rule_rejects_unchanged_prefix(self):
        previous = sys.get_int_max_str_digits()
        self.addCleanup(sys.set_int_max_str_digits, previous)
        minimum = sys.int_info.str_digits_check_threshold
        sys.set_int_max_str_digits(minimum + 1)
        wide = dict(self.interior, ts=10 ** minimum)
        original = journal([self.first, wide, self.boundary, self.tail])
        self.path.write_bytes(original)
        self.seed()

        sys.set_int_max_str_digits(minimum)
        self.assert_equivalent(READ_FAILURE)
        self.assertEqual(self.path.read_bytes(), original)

    def test_valid_control_preserves_recent_and_historical_results(self):
        self.seed()
        recent = {"result": [[self.tail], 0]}
        self.assert_equivalent(recent)
        self.assert_equivalent({"result": [self.rows, 0]}, cursor=0)
        self.assert_equivalent(recent)
