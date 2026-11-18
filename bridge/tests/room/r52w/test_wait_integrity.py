"""Distinguish an idle wait from a journal whose terminal coverage is unknown."""
import builtins
from contextlib import ExitStack
import errno
import io
import json
import os
from pathlib import Path
from unittest import mock

from bridge.room import app, store
from bridge.tests.room.c6 import support


HERE = Path(__file__).resolve().parent
FOREIGN_ROOM = "fixture-foreign-room"
FOREIGN_SUMMARY = "fixture-private-terminal-summary"
RAW_IO_DETAIL = "fixture-private-io-diagnostic"


class WaitIntegrityOracle(support.RoomCase):
    def setUp(self):
        with mock.patch.object(support, "HERE", HERE):
            super().setUp()
        self.journal = self.home / "rooms" / "demo" / "events.jsonl"

    def assert_journal_failure(self, *, since=0):
        args = {"room": "demo", "since_lamport": since, "timeout_s": 1}
        try:
            with support.operation_budget():
                reply = support.unwrap(app.dispatch("wait_agents", args))
        except store.RoomError as exc:
            self.assertTrue(exc.code, "the waiter must expose a tool error code")
            self.assertNotIn(exc.code, {"bad_args", "bad_room"},
                             "the request is valid and the journal is broken")
            public_error = f"{exc.code} {exc}"
            for private_value in (str(self.home), self.journal.name, RAW_IO_DETAIL,
                                  FOREIGN_ROOM, FOREIGN_SUMMARY, "Traceback"):
                self.assertNotIn(private_value, public_error)
        except OSError as exc:
            raise AssertionError(
                f"wait_agents leaked {type(exc).__name__} instead of a sanitized tool error"
            ) from None
        else:
            if reply.get("timed_out") is True:
                self.fail("wait_agents timed out with a broken journal")
            self.fail("wait_agents returned a successful reply with a broken journal")

    def test_never_created_room_times_out_empty(self):
        self.assertFalse(self.journal.parent.exists())
        reply = self.direct_wait(timeout_s=1)
        self.assertEqual(reply["events"], [])
        self.assertEqual(reply["cursor"], 0)
        self.assertIs(reply.get("timed_out"), True)
        self.assertAlmostEqual(self.clock.now, 1)
        self.assertFalse(self.journal.parent.exists())

    def test_directory_substitution_is_a_journal_error(self):
        self.life(state="finished")
        self.journal.unlink()
        self.journal.mkdir()

        self.assert_journal_failure()

    def test_directory_substitution_during_wait_is_a_journal_error(self):
        self.life()

        def replace_journal():
            self.journal.unlink()
            self.journal.mkdir()

        self.clock.later(0.25, replace_journal)
        self.assert_journal_failure()
        self.assertTrue(self.journal.is_dir(), "the fault must occur during the wait")

    def test_unreadable_file_is_a_sanitized_journal_error(self):
        self.life(state="finished")
        healthy = self.direct_wait(timeout_s=1)
        self.assertEqual([row["run_id"] for row in healthy["events"]], ["r1"])

        def deny_journal_open(original):
            def open_file(file, *args, **kwargs):
                if isinstance(file, (str, bytes, os.PathLike)):
                    if Path(os.fsdecode(file)) == self.journal:
                        raise PermissionError(errno.EACCES, RAW_IO_DETAIL, self.journal)
                return original(file, *args, **kwargs)
            return open_file

        with ExitStack() as patches:
            for module in (builtins, io, os):
                patches.enter_context(mock.patch.object(module, "open", deny_journal_open(module.open)))
            self.assert_journal_failure()

    def install_foreign_terminal(self):
        self.life(agent="other-worker", state="finished", run="foreign-run",
                  result={"verdict": "OK", "summary": FOREIGN_SUMMARY})
        self.life(state="finished", run="local-run")
        foreign, local = self.terminals()
        cursor = local["lamport"] - 1
        self.assertLess(foreign["lamport"], cursor)
        healthy = self.direct_wait(since_lamport=cursor, timeout_s=1)
        self.assertEqual([row["run_id"] for row in healthy["events"]], ["local-run"])

        # Change only the room of a complete, newline-terminated journal row.
        rows = self.events()
        for row in rows:
            if row["id"] == foreign["id"]:
                row["room"] = FOREIGN_ROOM
        self.journal.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        return cursor

    def test_foreign_committed_row_is_a_journal_error(self):
        self.install_foreign_terminal()
        self.assert_journal_failure()

    def test_foreign_committed_row_before_cursor_is_a_journal_error(self):
        cursor = self.install_foreign_terminal()
        self.assert_journal_failure(since=cursor)

    def test_all_runs_keep_their_parent_at_the_event(self):
        self.life(run="r1", parent_agent="leader", parent_run_id="p1")
        self.life(state="failed", run="r1")
        self.life(run="r2", parent_agent="elsewhere", parent_run_id="p2")
        self.life(state="finished", run="r2")
        self.life(run="r3", parent_agent="leader", parent_run_id="p3")
        self.life(state="finished", run="r3", result={"verdict": "OK"})

        terminal_lamports = [row["lamport"] for row in self.terminals()]
        reply = self.direct_wait(agents=["worker"], timeout_s=1)
        expected = [
            ("r1", "failed", {"agent": "leader", "run_id": "p1"}, terminal_lamports[0]),
            ("r2", "finished", {"agent": "elsewhere", "run_id": "p2"}, terminal_lamports[1]),
            ("r3", "finished", {"agent": "leader", "run_id": "p3"}, terminal_lamports[2]),
        ]
        self.assertEqual([(row["run_id"], row["state"], row["parent"], row["lamport"])
                          for row in reply["events"]], expected)
        self.assertEqual(reply["events"][-1]["result"], {"verdict": "OK"})
        filtered = self.direct_wait(agents=["worker"], parent="leader", timeout_s=1)
        self.assertEqual(filtered["events"], [reply["events"][0], reply["events"][2]])

    def test_exclusive_cursor_and_stateless_replay(self):
        self.life(state="failed", run="r1")
        self.life(state="finished", run="r2")
        self.life(agent="observer")
        boundary, pending = [row["lamport"] for row in self.terminals()]
        head = self.events()[-1]["lamport"]

        reply = self.direct_wait(since_lamport=boundary, timeout_s=1)
        self.assertEqual([(row["run_id"], row["lamport"]) for row in reply["events"]],
                         [("r2", pending)])
        self.assertEqual(reply["cursor"], head)
        self.assertEqual(self.direct_wait(since_lamport=boundary, timeout_s=1), reply)

        self.life(state="finished", run="r3")
        later = self.direct_wait(since_lamport=reply["cursor"], timeout_s=1)
        last = self.terminals()[-1]["lamport"]
        self.assertEqual([(row["run_id"], row["lamport"]) for row in later["events"]],
                         [("r3", last)])
        self.assertEqual(later["cursor"], last)
