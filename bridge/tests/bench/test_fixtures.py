"""Determinism, frozen semantic truth, real cursors/CAP and concurrent mutations."""
import copy
import os
from pathlib import Path
import unittest

from bridge.room import app, store
from . import adapters as a
from . import fixtures as f
from .harness import validate_reply


class FixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = f.mixed()
        cls.tail = f.near_cap()

    def test_deterministic_bytes_hash_counts_and_changed_payload(self):
        one, two = self.fixture, f.mixed()
        self.assertEqual(f.journal(one["events"]), f.journal(two["events"]))
        self.assertEqual(one["manifest"], two["manifest"])
        self.assertEqual(f.sha(f.journal(one["events"])), one["manifest"]["fixture_sha256"])
        self.assertEqual(one["manifest"]["event_count"], 10_000)
        self.assertEqual(one["expected"]["ingestion"], {"accepted": 9901, "duplicate": 99, "invalid": 0})
        self.assertNotEqual(one["manifest"]["fixture_sha256"], f.mixed(payload="changed")["manifest"]["fixture_sha256"])
        self.assertNotEqual(one["manifest"]["fixture_sha256"], f.mixed(seed=116)["manifest"]["fixture_sha256"])
        self.assertLessEqual(one["manifest"]["journal_bytes"], store.CAP)
        self.assertGreater(one["events"][0]["lamport"], one["events"][-1]["lamport"])

    def test_over_cap_rejected_before_adapter_or_persistence(self):
        with self.assertRaisesRegex(ValueError, "before measurement"):
            f.admit(b"x"*(store.CAP+1))

    def test_independent_python_expectations_and_omitted_accepted_events(self):
        real = a.fold(self.fixture)
        checked = validate_reply(real, real["expected"], self.fixture["manifest"]["fixture_sha256"], 10_000)
        self.assertTrue(checked["ok"])
        # Drop an accepted operation, not just a display message.
        broken = copy.deepcopy(self.fixture)
        broken["events"] = [e for e in broken["events"] if e["lamport"] != 2]
        mutant = a.fold(broken)
        self.assertFalse(validate_reply(mutant, real["expected"], self.fixture["manifest"]["fixture_sha256"], 10_000)["ok"])
        self.assertEqual(real["actual"]["owners"], ["alice", None])
        self.assertEqual(real["actual"]["progress_pct"], 50)
        self.assertEqual([r["code"] for r in real["actual"]["rejections"]], ["claimed_by_other", "stale_rev", "claimed_by_other"])

    def test_near_cap_cursor_fields_against_full_read_reference(self):
        self.assertEqual(self.tail["manifest"]["journal_bytes"], store.CAP-256)
        for variant in ("latest", "filtered", "future"):
            result = a.tail(self.tail, variant)
            self.assertEqual(result["actual"], result["expected"])
            data = result["actual"]["untrusted"]
            self.assertEqual(set(data), {"events", "next_after", "head", "has_more", "resync"})
            if variant == "future":
                self.assertEqual(data["events"], [])
                self.assertEqual(data["next_after"], data["head"])
                self.assertTrue(data["resync"])
            elif variant == "filtered":
                self.assertTrue(data["has_more"])
                self.assertTrue(all(e["act"] == "question" for e in data["events"]))

    def test_cap_atomicity_and_swallowed_error_mutant(self):
        self.assertTrue(a.cap_check(self.tail)["ok"])
        self.assertFalse(a.cap_check(self.tail, append=lambda: None)["ok"])
        def swallow():
            try:
                store.post("synthetic-tail", "alice", "heartbeat", "x"*4096)
            except store.RoomError:
                pass
        self.assertFalse(a.cap_check(self.tail, append=swallow)["ok"])

    def test_hostile_room_rejected_without_escape_and_real_error_envelopes(self):
        prior = os.environ.get("CW_HOME")
        with f.isolated() as home:
            for room in ("../escape", "<svg onload=alert(1)>", "bad/room", "a"*49):
                with self.assertRaises(store.RoomError) as error:
                    app.dispatch("room_events", {"room": room, "agent": "alice", "after_lamport": 0})
                self.assertEqual(error.exception.code, "bad_room")
                self.assertEqual(app._error_payload(error.exception)["code"], "bad_room")
            self.assertEqual(list(home.iterdir()), [])
        self.assertEqual(os.environ.get("CW_HOME"), prior)
        bad = {"events": [f.event(1, room="../escape")]}
        with self.assertRaises(store.RoomError):
            with f.isolated(bad):
                self.fail("invalid room reached filesystem")

    def test_bounded_client_stream_never_persists_large_room(self):
        before = list((f.ROOT/"tests"/"bench"/".scratch").iterdir())
        count, largest, digest = 0, 0, __import__("hashlib").sha256()
        for chunk in f.stream_chunks():
            count += len(chunk)
            largest = max(largest, len(chunk))
            digest.update(f.journal(chunk))
        self.assertEqual((count, largest), (100_000, 512))
        self.assertEqual(list((f.ROOT/"tests"/"bench"/".scratch").iterdir()), before)
        with self.assertRaises(ValueError):
            next(f.stream_chunks(chunk_size=100_000))

    def test_complete_stream_hash_and_real_freshness_inputs(self):
        fixture = f.client_fixture(self.fixture, "burst")
        chunks = list(f.stream_chunks(count=512, kind="burst"))
        self.assertEqual(len(chunks), 1)
        self.assertEqual(len([e for e in chunks[0] if e["act"] == "op"]), 16)
        self.assertEqual(f.sha(f.journal(chunks[0])), fixture["manifest"]["client_stream_sha256"])
        self.assertEqual(f.sha(f.journal(fixture["events"])+f.journal(chunks[0])), fixture["manifest"]["fixture_sha256"])
        self.assertLessEqual(fixture["manifest"]["journal_bytes"], store.CAP)

    def test_future_fixtures_have_fixed_scope_run_identity_and_counts(self):
        reserved = f.reservations()
        self.assertEqual(len(reserved["swarm"]["agents"]), 15)
        self.assertEqual(len(reserved["swarm"]["tasks"]), 40)
        self.assertTrue(all(len(t["microtasks"]) == 12 for t in reserved["swarm"]["tasks"]))
        life = reserved["lifecycle"]
        self.assertEqual(life["tool"], "agent_lifecycle")
        self.assertEqual(len(life["arguments"]), 105)
        self.assertEqual(len({(x["agent"],x["state"],x["run_id"]) for x in life["arguments"]}), 45)
        self.assertTrue(all(x["room"] == f.ROOM and x["run_id"] for x in life["arguments"]))
        self.assertIsNone(life["counts"]["committed"])
        self.assertEqual(len(reserved["diary"]), 10_000)

    def test_eight_process_mutations_and_duplicate_acknowledgement_negative_control(self):
        result = a.concurrency(self.fixture)
        self.assertEqual(result["actual"], result["expected"])
        self.assertEqual(len(result["ack_samples_ms"]), 8)
        self.assertEqual(result["counts"], {"attempted": 8, "committed": 8, "failed": 0})
        events = [f.event(i, act="op", op={"op_id": f"mutation_{i}"}) for i in range(1, 10)]
        acks = [{"event": e, "error": None} for e in events[1:]]
        self.assertTrue(a.concurrency_check(acks, events, 0)["ok"])
        # A duplicated acknowledgement cannot stand in for a persisted mutation.
        acks[-1] = copy.deepcopy(acks[0])
        self.assertFalse(a.concurrency_check(acks, events, 0)["ok"])
        self.assertFalse(a.concurrency_check(acks, events[:-1], 0)["ok"])


if __name__ == "__main__":
    unittest.main()
