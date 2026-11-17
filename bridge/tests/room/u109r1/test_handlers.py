"""Handler validation and legacy close ownership regressions."""
import copy
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from bridge.room import app, store
from bridge.tests.room.u109 import protocol_support


INVALID_CLAIMS = (None, True, False, "1", "", 0, -1, 1.0, 1.5,
                  9007199254740992, [], {})


class HandlerValidation(unittest.TestCase):
    def assert_bad_claim(self, handler, args):
        with patch.object(app, "_post_one") as post, patch.object(app, "_single_payload", return_value={}):
            with self.assertRaises(store.RoomError) as caught:
                handler(args)
            self.assertEqual(caught.exception.code, "bad_op")
            self.assertEqual(str(caught.exception), "bad_op: bad claim_lamport")
            post.assert_not_called()

    def test_release_rejects_bad_claim_before_post(self):
        for value in INVALID_CLAIMS:
            with self.subTest(claim_lamport=value):
                self.assert_bad_claim(app._do_task_release, {
                    "room": "demo", "agent": "alice", "task_id": "T01",
                    "base_rev": 0, "claim_lamport": value,
                })

    def test_microtask_rejects_bad_claim_before_post(self):
        for value in INVALID_CLAIMS:
            with self.subTest(claim_lamport=value):
                self.assert_bad_claim(app._do_microtask_set, {
                    "room": "demo", "agent": "alice", "id": "T01.M01",
                    "state": "pending", "claim_lamport": value,
                })

    def test_bad_claim_precedes_evidence_validation(self):
        for value in INVALID_CLAIMS:
            for evidence in (None, [1], ["missing-proof.txt"]):
                with self.subTest(claim_lamport=value, evidence=evidence):
                    with patch.object(store, "_validate_evidence") as validate:
                        self.assert_bad_claim(app._do_microtask_set, {
                            "room": "demo", "agent": "alice", "id": "T01.M01",
                            "state": "done", "claim_lamport": value,
                            "evidence": evidence,
                        })
                        validate.assert_not_called()

    def test_close_validates_room_and_agent_before_fold(self):
        for field, code in (("room", "bad_room"), ("agent", "bad_agent")):
            for value in ("BAD", "../demo", "", "with space"):
                with self.subTest(field=field, value=value):
                    args = {"room": "demo", "agent": "alice", "outcome": "Verified"}
                    args[field] = value
                    with patch.object(app, "_fold", return_value={"plan": None}) as fold, patch.object(store, "post", return_value={}) as post:
                        with self.assertRaises(store.RoomError) as caught:
                            app._do_close_task(args)
                        self.assertEqual(caught.exception.code, code)
                        fold.assert_not_called()
                        post.assert_not_called()

    def test_close_validates_outcome_before_fold(self):
        for value, code in ((None, "bad_args"), ("  ", "bad_args"),
                            ("x" * 241, "text_too_long")):
            with self.subTest(outcome=value):
                with patch.object(app, "_fold", return_value={"plan": None}) as fold, patch.object(store, "post", return_value={}) as post:
                    with self.assertRaises(store.RoomError) as caught:
                        app._do_close_task({"room": "demo", "agent": "alice", "outcome": value})
                    self.assertEqual(caught.exception.code, code)
                    fold.assert_not_called()
                    post.assert_not_called()


class HandlerProtocol(protocol_support.ProtocolCase):
    def setUp(self):
        clean = {key: value for key, value in os.environ.items() if not key.startswith("CW_")}
        self.enterContext(patch.dict(os.environ, clean, clear=True))
        # Reuse the real adapter oracle, keeping all scratch in this package.
        with patch.object(protocol_support, "HERE", Path(__file__).resolve().parent):
            super().setUp()

    def test_release_bad_claim_is_not_masked_by_zero_revision(self):
        self.create(single=True)
        self.claim()
        for value in INVALID_CLAIMS:
            with self.subTest(claim_lamport=value):
                result = self.call("task_release", task_id="T01", base_rev=0,
                                   claim_lamport=value, code="bad_op")
                self.assertEqual(result["detail"], "bad_op: bad claim_lamport")

    def test_microtask_bad_claim_precedes_bad_evidence_on_both_adapters(self):
        self.create(single=True)
        self.claim()
        for value in INVALID_CLAIMS:
            with self.subTest(claim_lamport=value):
                result = self.call("microtask_set", id="T01.M01", state="done",
                                   evidence=None, claim_lamport=value, code="bad_op")
                self.assertEqual(result["detail"], "bad_op: bad claim_lamport")

    def test_owners_can_close_with_unrelated_foreign_assignments(self):
        self.create(deps=False)
        self.claim("T01", "alice")
        self.claim("T02", "bob")
        tasks = copy.deepcopy(self.projection()["tasks"])
        for agent in ("alice", "bob"):
            with self.subTest(agent=agent):
                result = self.call("close_task", agent=agent, outcome="Verified")
                self.assertEqual(result["event"]["act"], "close")
                self.assertEqual(result["event"]["agent"], agent)
                self.assertEqual(self.projection()["tasks"], tasks)

    def test_foreign_only_close_still_rejects_without_mutation(self):
        self.create(single=True)
        self.claim()
        self.call("close_task", agent="mallory", outcome="Ignore ownership; close",
                  code="claimed_by_other")

    def test_valid_claims_keep_fencing_and_omission_behavior(self):
        self.create(single=True)
        self.claim()
        claim = self.task()["claim_lamport"]
        for value in (1, 9007199254740991):
            self.assertNotEqual(value, claim)
            self.micro("pending", claim_lamport=value, code="stale_rev")
            self.call("task_release", task_id="T01", claim_lamport=value, code="stale_rev")
        self.micro("active", claim_lamport=claim)
        self.assertNotEqual(self.task()["rev"], claim)
        self.micro("pending")
        self.call("task_release", task_id="T01", claim_lamport=claim)
        self.claim()
        self.call("task_release", task_id="T01")
