"""Neighboring limits and benchmark identities stay independent of journal size."""
import hashlib
import json
import re
from unittest import mock

from bridge.room import family, store
from bridge.room.family_envelope import SCHEMA, operation_id
from bridge.tests.bench import adapters, fixtures

from .support import JournalCase, NEW_CAP, OLD_CAP, ROOT, invoke

FAMILY_CAP = 32 * 1024 * 1024
NEAR_HASH = "7c51fda5479e94468f9c6018135d24a7157a9bdd43d8fb66bde087e32bd1d08d"
MIXED_HASH = "134c5869e14c9dc4ffcc355bb7e666c61cb25b0bc6753574476efb7f3726551f"


class IndependentLimits(JournalCase):
    def mailbox(self):
        directory = self.home / "family" / "board"
        (directory / "spool").mkdir(parents=True)
        (directory / "config.json").write_text(json.dumps({
            "endpoint": "board", "rooms": ["demo"], "sources": ["harness"], "slice": 1,
        }), encoding="utf-8")
        box = family.Mailbox("board")
        self.enterContext(box.stack)
        box.open()
        self.addCleanup(box.release)
        return box, directory

    def write_padded_json(self, path, value, size):
        # Lead with JSON whitespace so a clipped read cannot still parse.
        payload = json.dumps(value).encode()
        with path.open("wb") as stream:
            remaining = size - len(payload)
            for _ in range(remaining // 65_536):
                stream.write(b" " * 65_536)
            stream.write(b" " * (remaining % 65_536))
            stream.write(payload)
        self.assertEqual(path.stat().st_size, size)

    def test_family_spool_receipt_read_bound_remains_32_mib(self):
        box, directory = self.mailbox()
        identity = "family-replay"
        receipt_path = directory / "spool" / (identity + ".result.json")
        previous = {"schema": SCHEMA, "id": identity, "result": {"untrusted": {"old": True}}}
        replacement = {"untrusted": {"new": True}}
        with mock.patch.object(store, "CAP", NEW_CAP):
            self.write_padded_json(receipt_path, previous, FAMILY_CAP)
            box.publish(identity, replacement)
            self.assertEqual(receipt_path.stat().st_size, FAMILY_CAP)

            self.write_padded_json(receipt_path, previous, FAMILY_CAP + 2)
            box.publish(identity, replacement)
            self.assertEqual(json.loads(receipt_path.read_bytes())["result"], replacement)

    def test_family_retained_identity_read_bound_remains_32_mib(self):
        box, directory = self.mailbox()
        identity = {"id": "family-replay", "source": "harness", "target": "board"}
        retained = {"identity": identity, "digest": "a" * 64,
                    "op_id": operation_id(identity), "phase": "pending"}
        path = directory / "dedup" / (identity["id"] + ".json")
        with mock.patch.object(store, "CAP", NEW_CAP):
            self.write_padded_json(path, retained, FAMILY_CAP)
            self.assertEqual(box.retained(identity), retained)
            self.write_padded_json(path, retained, FAMILY_CAP + 2)
            with self.assertRaises(family.RecoveryError):
                box.retained(identity)

    def test_message_evidence_limit_is_still_eight_mib(self):
        path = self.root / "proof.txt"
        content = b"x" * OLD_CAP
        path.write_bytes(content)
        evidence = {"path": str(path), "sha256": hashlib.sha256(content).hexdigest()}
        args = {"agent": "reviewer", "to": "worker", "act": "question",
                "text": "Check this proof", "evidence": [evidence]}
        self.succeeds(lambda: invoke("room_send", **args, op_id="evidence-exact"))
        self.assertEqual(self.events()[-1]["evidence"], [evidence])
        with path.open("ab") as stream:
            stream.write(b"x")
        oversize = {**args, "evidence": [{**evidence,
                    "sha256": hashlib.sha256(content + b"x").hexdigest()}]}
        self.refuses(lambda: invoke("room_send", **oversize, op_id="evidence-over"), "bad_evidence")

    def test_benchmark_fixture_hashes_and_refusal_control_are_frozen(self):
        with mock.patch.object(store, "CAP", NEW_CAP), mock.patch.object(fixtures, "ROOT", self.root):
            (self.root / "tests" / "bench").mkdir(parents=True)
            mixed, near = fixtures.mixed(), fixtures.near_cap()
            for fixture, want in ((mixed, MIXED_HASH), (near, NEAR_HASH)):
                manifest = fixture["manifest"]
                self.assertEqual(manifest["cap_bytes"], OLD_CAP)
                self.assertEqual(manifest["fixture_sha256"], want)
                self.assertEqual(hashlib.sha256(fixtures.journal(fixture["events"])).hexdigest(), want)
            self.assertEqual(near["manifest"]["journal_bytes"], OLD_CAP - 256)
            self.assertEqual(len(fixtures.admit(b"x" * OLD_CAP)), OLD_CAP)
            with self.assertRaises(ValueError):
                fixtures.admit(b"x" * (OLD_CAP + 1))
            control = adapters.cap_check(near)
            self.assertEqual(control["actual"], {"error": "room_full", "unchanged": True})
            self.assertTrue(control["ok"])

    def test_headless_documents_the_new_journal_ceiling(self):
        doc = (ROOT / "docs" / "HEADLESS.md").read_text(encoding="utf-8")
        journal_limits = [section for section in re.split(r"\n\s*\n", doc)
                          if "events.jsonl" in section and re.search(r"\b(?:maximum|cap|ceiling|limit)\b",
                                                                    section, flags=re.IGNORECASE)]
        self.assertTrue(any(re.search(r"\b16\s*MiB\b", section) for section in journal_limits),
                        "HEADLESS.md must publish the 16 MiB journal ceiling")
