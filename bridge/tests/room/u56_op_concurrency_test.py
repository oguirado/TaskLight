"""U56 revision and claim oracles; synchronization uses real flock processes."""
import inspect
import multiprocessing
from unittest import mock

from bridge.room import store
from . import support
from . import u56_op_store_test as oracle


def race_writer(home, barrier, queue, agent):
    try:
        barrier.wait(timeout=10)
        ev = store.post("oracle", agent, "op", "", home=home, clock=lambda: 2000000,
                        op={"kind": "task.set", "task_id": "T01", "base_rev": 2, "estimate": agent})
        queue.put(("ok", ev))
    except store.RoomError as exc:
        queue.put((exc.code, None))
    except Exception as exc:
        queue.put(("unexpected", type(exc).__name__))


class OpConcurrency(oracle.OpCase):
    def test_two_process_revision_race(self):
        self.require_post()
        self.seed_plan(oracle.adding())
        before = self.raw()
        ctx = multiprocessing.get_context("spawn")
        barrier = ctx.Barrier(3)
        queue = ctx.Queue()
        processes = [ctx.Process(target=race_writer, args=(str(self.home), barrier, queue, a))
                     for a in ("alice", "bob")]
        try:
            for proc in processes:
                proc.start()
            barrier.wait(timeout=10)
            results = [queue.get(timeout=10), queue.get(timeout=10)]
            self.assertEqual(sorted(code for code, _ in results), ["ok", "stale_rev"])
            for proc in processes:
                proc.join(timeout=10)
                self.assertEqual(proc.exitcode, 0)
            events, malformed = store.read("oracle", home=self.home)
            self.assertEqual((len(events), malformed), (3, 0))
            self.assertEqual([e["lamport"] for e in events], [1, 2, 3])
            winner = next(ev for code, ev in results if code == "ok")
            self.assertEqual(events[-1], winner)
            self.assertTrue(self.raw().startswith(before))
            self.assertTrue(self.raw().endswith(b"\n"))
        finally:
            for proc in processes:
                if proc.pid is not None:
                    if proc.is_alive():
                        proc.terminate()
                    proc.join(timeout=10)
            queue.close()
            queue.join_thread()

    def test_claim_guard_and_strict_silence_boundary(self):
        self.seed_plan(oracle.adding())
        self.send({"kind": "task.claim", "task_id": "T01"}, clock=lambda: 1000000)
        self.reject("claimed_by_other", {"kind": "micro.set", "micro_id": "T01.M01", "state": "done"}, agent="bob")
        self.reject("claimed_by_other", {"kind": "task.release", "task_id": "T01"}, agent="bob")
        self.reject("claimed_by_other", {"kind": "task.claim", "task_id": "T01", "takeover": False},
                    agent="bob", clock=lambda: 2000000)
        self.reject("claimed_by_other", {"kind": "task.claim", "task_id": "T01", "takeover": True},
                    agent="bob", clock=lambda: 1600000)
        self.send({"kind": "task.claim", "task_id": "T01", "takeover": True}, agent="bob", clock=lambda: 1600001)
        self.send({"kind": "micro.set", "micro_id": "T01.M01", "state": "done"}, agent="bob")
        self.reject("claimed_by_other", {"kind": "task.release", "task_id": "T01"})

    def test_latest_legacy_activity_including_out_of_order_timestamps(self):
        self.seed_plan(oracle.adding())
        self.send({"kind": "task.claim", "task_id": "T01"}, clock=lambda: 1000000)
        store.post("oracle", "alice", "heartbeat", "latest activity", home=self.home, clock=lambda: 1200000)
        store.post("oracle", "alice", "heartbeat", "older timestamp", home=self.home, clock=lambda: 1100000)
        self.reject("claimed_by_other", {"kind": "task.claim", "task_id": "T01", "takeover": True},
                    agent="bob", clock=lambda: 1800000)
        self.send({"kind": "task.claim", "task_id": "T01", "takeover": True}, agent="bob", clock=lambda: 1800001)

    def test_invalid_room_activity_does_not_extend_claim(self):
        self.seed_plan(oracle.adding())
        self.send({"kind": "task.claim", "task_id": "T01"}, clock=lambda: 1000000)
        support.seed(self.home, "oracle", [support.mk_event(4, room="oracle", agent="alice", ts=True)])
        self.send({"kind": "task.claim", "task_id": "T01", "takeover": True}, agent="bob", clock=lambda: 1600001)

    def test_already_owned_claim_release_and_unassigned_micro(self):
        self.seed_plan(oracle.adding(assignee="alice"))
        self.send({"kind": "task.claim", "task_id": "T01"})
        self.send({"kind": "task.claim", "task_id": "T01"})
        self.send({"kind": "task.release", "task_id": "T01"})
        self.send({"kind": "micro.set", "micro_id": "T01.M01", "state": "active"}, agent="bob")

    def test_micro_updates_parent_task_revision(self):
        self.seed_plan(oracle.adding())
        e = self.send({"kind": "micro.set", "micro_id": "T01.M01", "state": "done"})
        self.reject("stale_rev", {"kind": "task.set", "task_id": "T01", "base_rev": 2, "estimate": "1m"})
        self.send({"kind": "task.set", "task_id": "T01", "base_rev": e["lamport"], "estimate": "1m"})

    def test_task_and_memory_changes_do_not_advance_plan_revision(self):
        self.seed_plan(oracle.adding())
        self.send(oracle.memory())
        self.send({"kind": "task.set", "task_id": "T01", "base_rev": 2, "state": "blocked", "reason": "Wait"})
        self.send({"kind": "plan.phase", "base_rev": 1, "phase": "finish"})


def install_revision(name, op, code):
    def test(self):
        self.seed_plan(oracle.adding())
        self.reject(code, op)
    setattr(OpConcurrency, "test_revision_" + name, test)


required = {
    "plan_close": {"kind": "plan.close", "base_rev": 1},
    "plan_phase": {"kind": "plan.phase", "base_rev": 1, "phase": "finish"},
    "task_set": {"kind": "task.set", "task_id": "T01", "base_rev": 2, "estimate": "1m"},
    "micro_add": {"kind": "micro.add", "task_id": "T01", "base_rev": 2, "text": "More"},
    "memory_set": oracle.memory(),
}
for name, op in required.items():
    install_revision(name + "_mismatch", dict(op, base_rev=99), "stale_rev")
    install_revision(name + "_missing", {k: v for k, v in op.items() if k != "base_rev"}, "bad_op")
for name, op in {
    "task_add": oracle.adding(),
    "task_claim": {"kind": "task.claim", "task_id": "T01"},
    "task_release": {"kind": "task.release", "task_id": "T01"},
}.items():
    install_revision(name + "_optional_mismatch", dict(op, base_rev=99), "stale_rev")


def test_optional_revisions_accept_matching_and_omitted(self):
    self.seed_plan()
    self.send(oracle.adding(base_rev=1))
    self.send(oracle.adding())
    claimed = self.send({"kind": "task.claim", "task_id": "T01", "base_rev": 2})
    self.send({"kind": "task.release", "task_id": "T01", "base_rev": claimed["lamport"]})
OpConcurrency.test_optional_revisions_accept_matching_and_omitted = test_optional_revisions_accept_matching_and_omitted
