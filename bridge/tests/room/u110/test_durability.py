"""A6/A7: replay identity, writer contention, capacity and durable receipts."""
import copy
import hashlib
import json
import multiprocessing
import os
from unittest.mock import patch

from bridge.room import store
from .support import A2, BASE, SendCase, canon, events_path, file_events, mk_event, retry_worker, seed


class Durability(SendCase):
    def test_a6_same_identity_returns_original_durable_receipt(self):
        before = self.journals()
        self.assertEqual(self.send_args(copy.deepcopy(A2)), self.first)
        self.assertEqual(self.journals(), before)
        event = self.event(self.first["id"])
        self.assertEqual(event["op_id"], A2["op_id"])
        self.assertNotIn("op", event)

    def test_a6_payload_conflicts_are_bad_op_without_append(self):
        path = self.fixture()
        evidence = [{"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}]
        for change in ({"to": "executor-b"}, {"act": "handoff"}, {"text": "changed"},
                       {"re": self.q["id"]}, {"evidence": evidence}):
            with self.subTest(field=next(iter(change))):
                self.refuse(dict(A2, **change), "bad_op")

    def test_a6_evidence_object_key_order_and_empty_defaults_are_canonical(self):
        before = self.journals()
        self.assertEqual(self.send_args(dict(A2, evidence=[])), self.first)
        self.assertEqual(self.journals(), before)
        path = self.fixture()
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        args = dict(BASE, op_id="u110-canon-0001", evidence=[{"path": str(path), "sha256": digest}])
        receipt = self.send_args(args)
        before = self.journals()
        reordered = dict(reversed(list(args.items())))
        reordered["evidence"] = [{"sha256": digest, "path": str(path)}]
        self.assertEqual(self.send_args(reordered), receipt)
        self.assertEqual(self.journals(), before)

    def test_a6_existing_replay_precedes_disk_digest_verification(self):
        path = self.fixture(data=b"before")
        evidence = [{"path": str(path), "sha256": hashlib.sha256(b"before").hexdigest()}]
        args = dict(BASE, op_id="u110-evidence-0001", evidence=evidence)
        receipt = self.send_args(args)
        before = self.journals()
        path.write_bytes(b"after!")
        self.assertEqual(self.send_args(copy.deepcopy(args)), receipt)
        self.assertEqual(self.journals(), before)
        self.refuse(dict(args, evidence=[dict(evidence[0], sha256="0" * 64)]), "bad_op")
        self.refuse(dict(args, op_id="u110-evidence-0002"), "bad_evidence")

    def test_a6_identity_is_scoped_by_room_and_sender(self):
        other_sender = self.send_args(dict(A2, agent="another-agent"))
        other_room = self.send_args(dict(A2, room="another-room"))
        self.assertEqual(len({self.first["id"], other_sender["id"], other_room["id"]}), 3)
        self.assertEqual(self.event(other_sender["id"])["op_id"], A2["op_id"])
        self.assertEqual(self.event(other_room["id"], "another-room")["op_id"], A2["op_id"])
        self.assertEqual(self.send_args(dict(A2, room="another-room")), other_room)
        self.assertEqual(self.send_args(dict(A2, agent="another-agent")), other_sender)

    def test_c4_cross_kind_identity_conflicts_include_existing_room_events(self):
        prior = mk_event(20, room="demo", agent="harness", act="heartbeat",
                         op_id="u110-kind-0001", to="executor-a")
        seed(self.home, "demo", [prior])
        self.refuse(dict(BASE, op_id=prior["op_id"]), "bad_op")
        planning = mk_event(21, room="demo", agent="harness", act="op", text="",
                            op={"kind": "activity.beat", "task_id": "T01", "run_id": "run1",
                                "op_id": "u110-kind-0002"})
        seed(self.home, "demo", [planning])
        events, _ = store.read("demo")
        self.assertIn(planning["id"], {event["id"] for event in events})
        self.refuse(dict(BASE, op_id=planning["op"]["op_id"]), "bad_op")

    def test_m6_omitting_identity_does_not_persist_a_synthetic_identity(self):
        receipt = self.send(text="no supplied retry identity")
        self.assertNotIn("op_id", self.event(receipt["id"]))

    def assert_unique_replay(self, events, args, expected):
        matches = [event for event in events if event.get("room") == args["room"]
                   and event.get("agent") == args["agent"] and event.get("op_id") == args["op_id"]]
        self.assertEqual(len(matches), 1, "duplicate persisted replay identity")
        self.assertEqual((matches[0]["id"], matches[0]["lamport"]),
                         (expected["id"], expected["lamport"]))

    def competing(self, args):
        context = multiprocessing.get_context("spawn")
        barrier = context.Barrier(4)
        results = context.Queue()
        self.addCleanup(results.join_thread)
        self.addCleanup(results.close)
        workers = [context.Process(target=retry_worker,
                                   args=(str(self.home), args, barrier, results)) for _ in range(4)]
        def cleanup():
            for worker in workers:
                if worker.pid is not None:
                    if worker.is_alive():
                        worker.terminate()
                    worker.join(timeout=5)
        self.addCleanup(cleanup)
        for worker in workers:
            worker.start()
        replies = [results.get(timeout=20) for _ in workers]
        for worker in workers:
            worker.join(timeout=5)
            self.assertEqual(worker.exitcode, 0)
        for reply in replies:
            self.assertEqual(set(reply), {"receipt"}, reply)
        return [reply["receipt"] for reply in replies]

    def test_a6_competing_processes_and_restart_persist_one_message(self):
        # Exact A2 retries compete against the already durable original event.
        before = self.journals()
        self.assertEqual(self.competing(A2), [self.first] * 4)
        self.assertEqual(self.journals(), before)
        self.assert_unique_replay(file_events(self.home, "demo"), A2, self.first)
        # A never-sent identity additionally races through initial creation.
        args = dict(A2, room="contended-room")
        receipts = self.competing(args)
        self.assertTrue(all(receipt == receipts[0] for receipt in receipts))
        self.assert_unique_replay(file_events(self.home, args["room"]), args, receipts[0])
        before = self.journals()
        for request, expected in ((A2, self.first), (args, receipts[0])):
            restart = self.cli("call", "room_send", "--json", json.dumps(request))
            self.assertEqual(restart.returncode, 0, restart.stdout)
            self.assertEqual(json.loads(restart.stdout), {"untrusted": expected})
        self.assertEqual(self.journals(), before)

    def test_a6_duplicate_fixture_negative_control_rejects_non_deduplicated_history(self):
        events = file_events(self.home, "demo")
        self.assert_unique_replay(events, A2, self.first)
        duplicate = dict(events[0], id="e-ffffffffffffffff", lamport=events[0]["lamport"] + 1)
        with self.assertRaisesRegex(AssertionError, "duplicate persisted replay identity"):
            self.assert_unique_replay(events + [duplicate], A2, self.first)

    def test_a7_capacity_rejects_new_message_but_not_existing_replay(self):
        cap = 8 * 1024 * 1024
        self.assertEqual(store.CAP, cap)
        path = events_path(self.home, "demo")
        data = bytearray(path.read_bytes())
        lamport = self.first["lamport"] + 1
        while cap - len(data) > 4096:
            event = mk_event(lamport, room="demo", agent="filler", act="heartbeat", text="")
            overhead = len((canon(event) + "\n").encode())
            event["text"] = "x" * min(4096, cap - len(data) - overhead - 1)
            data.extend((canon(event) + "\n").encode())
            lamport += 1
        path.write_bytes(data)
        events, malformed = store.read("demo")
        self.assertEqual(malformed, 0)
        self.assertGreater(len(events), 1)
        self.assertLessEqual(path.stat().st_size, cap)
        before = self.journals()
        self.assertEqual(self.send_args(copy.deepcopy(A2)), self.first)
        self.assertEqual(self.journals(), before)
        self.refuse(dict(BASE, text="n" * 4096, op_id="u110-full-0001"), "room_full")

    def test_a7_receipt_follows_real_journal_fsync(self):
        path = events_path(self.home, "demo")
        real_fsync = os.fsync
        durable = set()
        def observe(fd):
            is_journal = path.exists() and os.fstat(fd).st_ino == path.stat().st_ino
            result = real_fsync(fd)
            if is_journal:
                durable.update(event["id"] for event in file_events(self.home, "demo"))
            return result
        with patch.object(os, "fsync", side_effect=observe):
            receipt = self.send(op_id="u110-fsync-0001")
            self.assertIn(receipt["id"], durable, "success preceded journal fsync")

    def test_a7_fsync_failure_rolls_back_and_retry_is_not_cached(self):
        path = events_path(self.home, "demo")
        before = self.journals()
        real_fsync = os.fsync
        def fail_journal(fd):
            if path.exists() and os.fstat(fd).st_ino == path.stat().st_ino:
                raise OSError("injected journal fsync failure")
            return real_fsync(fd)
        args = dict(BASE, op_id="u110-fsync-0002")
        with patch.object(os, "fsync", side_effect=fail_journal):
            self.refuse(args, "internal")
        self.assertEqual(self.journals(), before)
        result = self.send_args(args)
        self.assertEqual(self.event(result["id"])["op_id"], args["op_id"])
        self.assertEqual(len(file_events(self.home, "demo")), 2)
