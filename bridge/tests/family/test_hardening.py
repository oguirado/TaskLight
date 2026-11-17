"""Bounded, untimed functional portion of the family-drain-1k target."""
import hashlib

from bridge.room import store
from .support import FamilyCase, canonical, envelope


class HardeningOracle(FamilyCase):
    def test_family_drain_1k_has_no_duplicate_mutations_or_receipt_disagreement(self):
        identities = ["deploy-%04d" % n for n in range(1000)]
        # Fixed reverse publication order asserts no FIFO assumption.
        request_hashes = {}
        for identity in reversed(identities):
            value = envelope(id=identity)
            self.publish(value)
            request_hashes[identity] = hashlib.sha256(canonical(value)).hexdigest()
        self.assertEqual(self.invoke(), 0)
        events = self.events()
        self.assertEqual(len(events), len(identities))
        self.assertEqual(len({e["id"] for e in events}), len(identities))
        self.assertEqual(len({e["op"]["op_id"] for e in events}), len(identities))
        self.assertLessEqual(len(self.journal_bytes()), store.CAP)
        response_hashes = {}
        witnessed = {e["lamport"] for e in events}
        for identity in identities:
            response = self.receipt(identity)
            self.assertTrue(response["result"]["untrusted"]["ok"])
            self.assertIn(response["result"]["untrusted"]["lamport"], witnessed)
            response_hashes[identity] = hashlib.sha256(canonical(response)).hexdigest()
        before = self.journal_bytes()
        for identity in identities:
            (self.spool / (identity + ".result.json")).unlink()
            value = envelope(id=identity)
            self.assertEqual(hashlib.sha256(canonical(value)).hexdigest(), request_hashes[identity])
            self.publish(value)
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.journal_bytes(), before)
        for identity in identities:
            self.assertEqual(hashlib.sha256(canonical(self.receipt(identity))).hexdigest(),
                             response_hashes[identity])
