"""U139: observable replay behavior, without choosing a persistence format."""
import copy
import errno
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from bridge.plan.errors import PlanError
from bridge.plan.fold import apply_op_event, fold_plan
from bridge.room import store
from bridge.room.ext import lifecycle
from bridge.room.ext.lifecycle import agent_lifecycle


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
DEPLOY = dict(room="demo", agent="exec-a", state="deployed", run_id="r1",
              op_id="deploy-0001")
ALIVE = dict(DEPLOY, state="alive", op_id="alive-0001")
THROTTLED = dict(ALIVE, op_id="alive-0002")


def event(lamport, now, args):
    """Public event envelope; delivery IDs differ while op_id stays stable."""
    op = {"kind": "agent.lifecycle"}
    op.update({k: v for k, v in args.items() if k not in ("room", "agent")})
    return dict(id=f"e-{lamport:016x}", room=args["room"], agent=args["agent"],
                act="op", text="", op=op, lamport=lamport, ts=now)


class DurableNoopOracle(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="runtime-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.now = 1000
        self.enterContext(mock.patch.dict(os.environ, {
            "CW_HOME": str(self.home), "PYTHONDONTWRITEBYTECODE": "1",
            "TMPDIR": str(self.home),
        }))
        self.enterContext(mock.patch.object(store.time, "time", side_effect=lambda: self.now / 1000))
        self.enterContext(mock.patch.object(socket, "socket", side_effect=AssertionError("network forbidden")))
        self.enterContext(mock.patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")))
        self.assertEqual(agent_lifecycle(copy.deepcopy(DEPLOY)), {"ok": True, "lamport": 1})
        self.now = 2000
        self.original = agent_lifecycle(copy.deepcopy(ALIVE))
        self.assertEqual(self.original, {"ok": True, "lamport": 2})
        self.assertEqual(len(self.events()), 2, "prerequisite: deployment and first alive must commit")

    def raw(self):
        return (self.home / "rooms" / "demo" / "events.jsonl").read_bytes()

    def events(self):
        return [json.loads(line) for line in self.raw().splitlines() if line]

    def lifecycle(self):
        return fold_plan(self.events())["agent_lifecycle"]

    def process(self, args, now, crash=False):
        request = dict(args=args, now=now, crash_after_backend=crash)
        if crash:
            request["expected"] = self.original
        completed = subprocess.run(
            [sys.executable, "-B", "-m", "bridge.tests.room.u139.probe"],
            cwd=ROOT, input=json.dumps(request), text=True,
            capture_output=True, timeout=10, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        if crash:
            self.assertEqual(completed.stdout, "", "the consumer must lose the backend reply")
            return None
        return json.loads(completed.stdout)

    def lose_ack(self):
        before = self.raw()
        lifecycle = self.lifecycle()
        self.process(copy.deepcopy(THROTTLED), 3000, crash=True)
        self.assertEqual(self.raw(), before, "a throttled request must not append a lifecycle event")
        self.assertEqual(self.lifecycle(), lifecycle, "throttling must not refresh lifecycle evidence")

    def assert_conflict(self, args):
        before = self.raw()
        lifecycle = self.lifecycle()
        self.now = 80000
        with self.assertRaises(store.RoomError, msg="a successful no-op must reserve its exact payload") as caught:
            agent_lifecycle(args)
        self.assertEqual(caught.exception.code, "bad_op", "identity conflict precedes lifecycle admission")
        self.assertEqual(self.raw(), before, "a conflicting replay must append nothing")
        self.assertEqual(self.lifecycle(), lifecycle)

    def test_a1_throttled_call_preserves_original_receipt_and_journal(self):
        before, lifecycle = self.raw(), self.lifecycle()
        self.now = 3000
        self.assertEqual(agent_lifecycle(copy.deepcopy(THROTTLED)), self.original)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.lifecycle(), lifecycle)

    def assert_noop_persists(self, platform_os):
        before = self.raw()
        self.now = 3000
        with mock.patch.object(lifecycle, "os", platform_os):
            self.assertEqual(agent_lifecycle(copy.deepcopy(THROTTLED)), self.original)
        self.now = 80000
        self.assertEqual(agent_lifecycle(copy.deepcopy(THROTTLED)), self.original)
        self.assertEqual(self.raw(), before)

    def test_noop_receipt_without_o_directory(self):
        platform_os = SimpleNamespace(**vars(os))
        if hasattr(platform_os, "O_DIRECTORY"):
            del platform_os.O_DIRECTORY
        with mock.patch.object(platform_os, "fsync", wraps=os.fsync) as sync:
            self.assert_noop_persists(platform_os)
        sync.assert_called_once()

    @unittest.skipUnless(hasattr(os, "O_DIRECTORY"), "directory open flag required")
    def test_noop_receipt_when_directory_open_fails(self):
        def open_path(path, flags, *args, **kwargs):
            if flags & os.O_DIRECTORY:
                raise OSError(errno.EACCES, "directory open denied")
            return os.open(path, flags, *args, **kwargs)

        platform_os = SimpleNamespace(**vars(os))
        with mock.patch.object(platform_os, "open", side_effect=open_path) as open_mock:
            self.assert_noop_persists(platform_os)
        self.assertTrue(any(call.args[1] & os.O_DIRECTORY for call in open_mock.call_args_list))

    @unittest.skipUnless(hasattr(os, "O_DIRECTORY"), "directory open flag required")
    def test_noop_receipt_fsyncs_file_then_directory(self):
        synced_directories = []

        def fsync(fd):
            synced_directories.append(stat.S_ISDIR(os.fstat(fd).st_mode))
            os.fsync(fd)

        platform_os = SimpleNamespace(**vars(os))
        with mock.patch.object(platform_os, "fsync", side_effect=fsync):
            self.assert_noop_persists(platform_os)
        self.assertEqual(synced_directories, [False, True])

    def test_a2_crash_before_consumer_record_recovers_original_result(self):
        self.lose_ack()
        replay = self.process(copy.deepcopy(THROTTLED), 80000)
        self.assertEqual(replay, self.original, "alive-0002 must recover Lamport 2 after the throttle window")

    def test_a3_crash_retry_appends_no_journal_event(self):
        self.lose_ack()
        before, lifecycle = self.raw(), self.lifecycle()
        self.process(copy.deepcopy(THROTTLED), 80000)
        self.assertEqual(self.raw(), before, "retrying the no-op must not append a new journal event")
        self.assertEqual(self.lifecycle(), lifecycle)

    def test_a2_retry_after_intervening_alive_keeps_original_result(self):
        self.lose_ack()
        self.now = 32000
        later = agent_lifecycle(dict(ALIVE, op_id="alive-0003"))
        self.assertGreater(later["lamport"], self.original["lamport"])
        before, lifecycle = self.raw(), self.lifecycle()
        self.assertEqual(self.process(copy.deepcopy(THROTTLED), 80000), self.original)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.lifecycle(), lifecycle)

    def test_a2_retry_after_run_supersession_keeps_original_result(self):
        self.lose_ack()
        self.now = 4000
        agent_lifecycle(dict(DEPLOY, run_id="r2", op_id="deploy-0002"))
        before, lifecycle = self.raw(), self.lifecycle()
        self.assertEqual(self.process(copy.deepcopy(THROTTLED), 80000), self.original)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.lifecycle(), lifecycle)

    def test_h1_same_noop_id_changed_state_is_bad_op(self):
        self.lose_ack()
        self.assert_conflict(dict(THROTTLED, state="failed"))

    def test_h2_same_noop_id_changed_run_id_is_bad_op(self):
        self.lose_ack()
        self.assert_conflict(dict(THROTTLED, run_id="r2"))

    def test_lifecycle_journal_append_opens_in_binary_mode(self):
        native_binary = getattr(os, "O_BINARY", 0)
        binary_flag = native_binary or (1 << 30)
        platform_os = SimpleNamespace(**vars(os))
        platform_os.O_BINARY = binary_flag

        def open_path(path, flags, mode):
            return os.open(path, flags if native_binary else flags & ~binary_flag, mode)

        self.now = 32000
        with mock.patch.object(lifecycle, "os", platform_os), \
             mock.patch.object(platform_os, "open", side_effect=open_path) as opened:
            result = agent_lifecycle(dict(ALIVE, op_id="alive-0003"))
        self.assertEqual(result, {"ok": True, "lamport": 3})
        journal = str(self.home / "rooms" / "demo" / "events.jsonl")
        self.assertEqual([call.args[1] for call in opened.call_args_list if call.args[0] == journal],
                         [os.O_CREAT | os.O_WRONLY | os.O_APPEND | binary_flag])

    def test_p1_fresh_id_at_window_boundary_is_new_event(self):
        self.lose_ack()
        self.now = 32000
        result = agent_lifecycle(dict(ALIVE, op_id="alive-0003"))
        self.assertEqual(result, {"ok": True, "lamport": 3})
        self.assertEqual(len(self.events()), 3)
        self.assertEqual(self.lifecycle()["exec-a"]["last_alive_ts"], 32000)

    def test_p2_committed_id_replay_still_returns_original_result(self):
        before, lifecycle = self.raw(), self.lifecycle()
        self.assertEqual(self.process(copy.deepcopy(ALIVE), 80000), self.original)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.lifecycle(), lifecycle)

    def test_p3_committed_id_payload_conflict_is_rejected(self):
        self.assert_conflict(dict(ALIVE, state="failed"))


class FoldNoopOracle(unittest.TestCase):
    def setUp(self):
        self.prefix = [event(1, 1000, DEPLOY), event(2, 2000, ALIVE)]
        self.throttled_event = event(3, 3000, THROTTLED)
        self.before = fold_plan(self.prefix)
        original = copy.deepcopy(self.before)
        self.throttled, self.result = apply_op_event(self.before, self.throttled_event)
        self.assertEqual(self.before, original, "public fold input must remain detached")
        self.assertTrue(self.result.get("noop"), "prerequisite: the call must actually be throttled")
        self.assertEqual(self.result["lamport"], 2)
        self.assertEqual(self.throttled["agent_lifecycle"], original["agent_lifecycle"])

    def continuation(self):
        # Serialization eliminates object identity and process-local caches.
        return json.loads(json.dumps(self.throttled))

    def assert_conflict(self, args):
        state = self.continuation()
        before = copy.deepcopy(state)
        with self.assertRaises(PlanError, msg="the fold must remember the no-op's payload identity") as caught:
            apply_op_event(state, event(4, 80000, args))
        self.assertEqual(caught.exception.code, "bad_op")
        self.assertEqual(state, before, "a rejected replay must not mutate its input")

    def test_n1_fold_json_continuation_remembers_noop_result(self):
        state = self.continuation()
        frozen = copy.deepcopy(state)
        after, replay = apply_op_event(state, event(4, 80000, THROTTLED))
        self.assertEqual(replay["lamport"], self.result["lamport"], "early-return fold loses the no-op identity")
        self.assertTrue(replay.get("noop"), "a retry must remain a no-op after the window")
        self.assertEqual(after["agent_lifecycle"], self.before["agent_lifecycle"])
        self.assertEqual(state, frozen)

    def test_n1_fold_history_replay_preserves_lifecycle(self):
        history = self.prefix + [self.throttled_event, event(4, 80000, THROTTLED)]
        before = copy.deepcopy(history)
        after = fold_plan(history)
        self.assertEqual(after["rejected"], [], "an exact retry is successful")
        self.assertEqual(after["agent_lifecycle"], self.before["agent_lifecycle"],
                         "an exact retry must not advance lifecycle evidence")
        self.assertEqual(history, before)

    def test_h1_fold_rejects_changed_state_for_noop_id(self):
        self.assert_conflict(dict(THROTTLED, state="failed"))

    def test_h2_fold_rejects_changed_run_id_for_noop_id(self):
        self.assert_conflict(dict(THROTTLED, run_id="r2"))
