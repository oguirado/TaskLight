"""Exercise the registered waiter against real journals with a virtual clock."""
from contextlib import contextmanager
import os
from pathlib import Path
import sys
from unittest import mock

from bridge.plan.fold import fold_plan
from bridge.plan.template import load_template
from bridge.room import app, store
from bridge.tests.bench.fixtures import encoded, event, journal
from bridge.tests.room.c6 import support


HERE = Path(__file__).resolve().parent
SHARED_OP_ID = "template-dependent-finish"


def life(lamport, state, run="run-a", *, agent="worker", **fields):
    return event(lamport, room="demo", agent=agent, act="op",
                 op={"kind": "agent.lifecycle", "op_id": f"life-{lamport:08d}",
                     "state": state, "run_id": run, **fields})


def heartbeat(lamport):
    return event(lamport, room="demo", agent="observer")


def row(lamport, state, run, parent, **fields):
    link = {"agent": parent[0], "run_id": parent[1]} if parent else None
    return {"agent": "worker", "run_id": run, "state": state, "parent": link,
            "lamport": lamport, **fields}


@contextmanager
def full_folds():
    """Count authoritative replays regardless of the waiter's import style."""
    previous = sys.getprofile()
    calls = []

    def record(frame, action, arg):
        if action == "return" and frame.f_code is fold_plan.__code__:
            calls.append(frame.f_locals.get("raw", []))
        if previous is not None:
            previous(frame, action, arg)

    sys.setprofile(record)
    try:
        yield calls
    finally:
        sys.setprofile(previous)


class WaitIntegrityOracle(support.RoomCase):
    def setUp(self):
        with mock.patch.object(support, "HERE", HERE):
            super().setUp()
        self.journal = self.home / "rooms" / "demo" / "events.jsonl"

    def write(self, *events):
        self.journal.parent.mkdir(parents=True, exist_ok=True)
        self.journal.write_bytes(journal(events))

    def append(self, *events):
        self.append_bytes(journal(events))

    def append_bytes(self, data):
        with self.journal.open("ab") as stream:
            stream.write(data)

    def wait(self, **fields):
        return self.direct_wait(timeout_s=1, **fields)

    def assert_full_replay(self, calls, *events):
        def key(event):
            return event["lamport"], event["id"]

        expected = sorted(events, key=key)
        self.assertTrue(any(sorted(snapshot, key=key) == expected for snapshot in calls),
                        "fallback must replay the complete checked snapshot")

    def assert_journal_failure(self, *, since=0):
        args = {"room": "demo", "since_lamport": since, "timeout_s": 1}
        with support.operation_budget():
            try:
                app.dispatch("wait_agents", args)
            except store.RoomError as error:
                self.assertEqual(error.code, "room_read_failed")
                self.assertEqual(str(error).removeprefix("room_read_failed: "),
                                 "Room data could not be read.")
            except OSError:
                self.fail("wait_agents exposed a raw I/O error")
            else:
                self.fail("a broken journal returned a successful wait reply")
        self.assertLess(self.clock.now, 1, "a detected read error must stop the wait")

    def test_ordered_heartbeat_extensions_advance_head_without_repeat_folds(self):
        initial = life(1, "deployed")
        self.write(initial)
        self.clock.later(0.25, lambda: self.append(heartbeat(2)))
        self.clock.later(0.55, lambda: self.append(heartbeat(3), heartbeat(4)))

        with full_folds() as calls:
            self.assertEqual(self.wait(since_lamport=1),
                             {"events": [], "cursor": 4, "timed_out": True})
        self.assertAlmostEqual(self.clock.now, 1)
        self.assertFalse(self.clock.pending)
        self.assertEqual([len(snapshot) for snapshot in calls], [1],
                         "verified heartbeat-only growth must perform zero repeat folds")
        self.assertEqual(calls[0], [initial])

    def test_heartbeat_then_matches_preserve_runs_parents_and_exclusive_cursor(self):
        old = life(1, "deployed", "old", parent_agent="leader", parent_run_id="old-parent")
        boundary = life(2, "finished", "old")
        self.write(old, boundary)
        beat = heartbeat(3)
        self.clock.later(0.25, lambda: self.append(beat))
        matched = (
            life(4, "deployed", "run-a", parent_agent="leader", parent_run_id="parent-a"),
            life(5, "failed", "run-a"),
            life(6, "deployed", "unrelated", parent_agent="other", parent_run_id="other-parent"),
            life(7, "finished", "unrelated"),
            life(8, "deployed", "run-b", parent_agent="leader", parent_run_id="parent-b"),
            life(9, "finished", "run-b", result={"verdict": "OK"}),
            heartbeat(10),
        )
        self.clock.later(0.55, lambda: self.append(*matched))
        filters = {"since_lamport": 2, "parent": "leader", "agents": ["worker"]}
        expected = {"events": [
            row(5, "failed", "run-a", ("leader", "parent-a")),
            row(9, "finished", "run-b", ("leader", "parent-b"), result={"verdict": "OK"}),
        ], "cursor": 10}

        with full_folds() as calls:
            self.assertEqual(self.wait(**filters), expected)
        self.assert_full_replay(calls, old, boundary, beat, *matched)
        self.assertEqual(self.wait(**filters), expected)

    def test_explicit_nonterminal_states_still_return_complete_replies(self):
        initial = life(1, "deployed", "old")
        self.write(initial)
        beat = heartbeat(2)
        self.clock.later(0.25, lambda: self.append(beat))
        new_run = (
            life(3, "deployed", parent_agent="leader", parent_run_id="parent-a"),
            life(4, "alive"),
            heartbeat(5),
        )
        self.clock.later(0.55, lambda: self.append(*new_run))
        expected = {"events": [
            row(3, "deployed", "run-a", ("leader", "parent-a")),
            row(4, "alive", "run-a", ("leader", "parent-a")),
        ], "cursor": 5}
        with full_folds() as calls:
            self.assertEqual(self.wait(since_lamport=1, states=["deployed", "alive"]), expected)
        self.assert_full_replay(calls, initial, beat, *new_run)

    def test_late_deployment_before_cursor_can_admit_an_existing_terminal(self):
        boundary = heartbeat(2)
        terminal = life(3, "finished")
        self.write(boundary, terminal)
        deployment = life(1, "deployed", parent_agent="leader", parent_run_id="parent-a")
        self.clock.later(0.25, lambda: self.append(deployment))

        with full_folds() as calls:
            self.assertEqual(self.wait(since_lamport=2, parent="leader"), {
                "events": [row(3, "finished", "run-a", ("leader", "parent-a"))],
                "cursor": 3,
            })
        self.assert_full_replay(calls, boundary, terminal, deployment)

    def template_contrast(self, *, append_heartbeat):
        source = HERE.parents[3] / "templates" / "planning" / "blank.json"
        initial_hash = load_template(source)["hash"]
        opened = event(1, room="demo", agent="worker", act="op", op={
            "kind": "plan.open", "op_id": SHARED_OP_ID, "title": "Waiter fixture",
            "template_id": "blank", "template_hash": initial_hash,
        })
        deployed = life(2, "deployed")
        # The accepted plan.open reserves this operation ID. After replacement
        # its hash is rejected and the already present terminal can be admitted.
        terminal = life(3, "finished", op_id=SHARED_OP_ID)
        self.write(opened, deployed, terminal)
        args = {"since_lamport": 2, "agents": ["worker"]}
        self.assertEqual(self.wait(**args), {"events": [], "cursor": 3, "timed_out": True})

        template = self.home / "templates" / source.name
        template.parent.mkdir()
        beat = heartbeat(4)

        def replace():
            template.write_text(source.read_text().replace("Blank Project", "Updated Project"),
                                encoding="utf-8")
            self.assertNotEqual(load_template(template)["hash"], initial_hash)
            if append_heartbeat:
                self.append(beat)

        self.clock.later(0.25, replace)
        with full_folds() as calls:
            self.assertEqual(self.wait(**args), {
                "events": [row(3, "finished", "run-a", None)],
                "cursor": 4 if append_heartbeat else 3,
            }, "a replacement can make an existing terminal newly admissible")
        suffix = (beat,) if append_heartbeat else ()
        self.assert_full_replay(calls, opened, deployed, terminal, *suffix)

    def test_replaced_template_invalidates_heartbeat_skip(self):
        self.template_contrast(append_heartbeat=True)

    def test_replaced_template_invalidates_no_match_with_identical_journal(self):
        self.template_contrast(append_heartbeat=False)

    def test_same_inode_rewrite_with_heartbeat_growth_can_change_parent(self):
        old = life(1, "deployed", parent_agent="parent-a", parent_run_id="run-parent")
        terminal = life(2, "finished")
        self.write(old, terminal)
        new = life(1, "deployed", parent_agent="parent-b", parent_run_id="run-parent")
        beat = heartbeat(3)
        inode = self.journal.stat().st_ino

        def rewrite_and_grow():
            self.assertEqual(len(journal([old])), len(journal([new])))
            with self.journal.open("r+b") as stream:
                stream.write(journal([new]))
            self.append(beat)
            self.assertEqual(self.journal.stat().st_ino, inode)

        self.clock.later(0.25, rewrite_and_grow)
        with full_folds() as calls:
            self.assertEqual(self.wait(parent="parent-b"), {
                "events": [row(2, "finished", "run-a", ("parent-b", "run-parent"))],
                "cursor": 3,
            })
        self.assert_full_replay(calls, new, terminal, beat)

    def corrupt_before_cursor(self, replacement):
        head = 12
        self.write(*(heartbeat(number) for number in range(1, head + 1)))
        inode = self.journal.stat().st_ino
        prefix_size = len(journal([heartbeat(1)]))
        self.assertEqual(len(replacement), prefix_size)

        def corrupt_and_grow():
            # Leave the old tail unchanged so a local boundary check alone
            # cannot discover the corrupted committed record.
            with self.journal.open("r+b") as stream:
                stream.write(replacement)
            self.append(heartbeat(head + 1))
            self.assertEqual(self.journal.stat().st_ino, inode)

        self.clock.later(0.25, corrupt_and_grow)
        self.assert_journal_failure(since=head)
        self.assertFalse(self.clock.pending)

    def test_malformed_committed_row_before_cursor_cannot_hide_behind_growth(self):
        original = journal([heartbeat(1)])
        self.corrupt_before_cursor(b"!" + original[1:])

    def test_foreign_committed_row_before_cursor_cannot_hide_behind_growth(self):
        self.corrupt_before_cursor(journal([dict(heartbeat(1), room="peer")]))

    def test_termination_of_a_torn_record_makes_a_match_visible(self):
        deployed = life(1, "deployed")
        terminal = life(2, "finished")
        self.write(deployed)
        self.append_bytes(encoded(terminal))
        self.clock.later(0.25, lambda: self.append_bytes(b"\n"))
        with full_folds() as calls:
            self.assertEqual(self.wait(since_lamport=1), {
                "events": [row(2, "finished", "run-a", None)], "cursor": 2,
            })
        self.assert_full_replay(calls, deployed, terminal)

    def test_previously_observed_room_vanishing_is_a_sanitized_error(self):
        self.write(life(1, "deployed"))
        moved = self.journal.parent.with_name("removed")

        def remove():
            os.replace(self.journal.parent, moved)

        self.clock.later(0.25, remove)
        self.assert_journal_failure(since=1)
        self.assertTrue(moved.is_dir())

    def test_never_created_room_times_out_without_creating_storage(self):
        self.assertFalse(self.journal.parent.exists())
        self.assertEqual(self.wait(), {"events": [], "cursor": 0, "timed_out": True})
        self.assertAlmostEqual(self.clock.now, 1)
        self.assertFalse(self.journal.parent.exists())
