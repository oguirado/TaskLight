"""Evidence digests survive relay redaction only at the evidence boundary."""
import copy
import hashlib
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from bridge.room import mcp, store
from bridge.wall import room_relay as relay
from bridge.wall.emit import redact
from bridge.tests.wall_room import support as S


DIGEST = hashlib.sha256(b"Evidence fixture contents").hexdigest()


class EvidenceHashTests(unittest.TestCase):
    def event(self, value=DIGEST, **extra):
        return S.event(1, act="op", op={
            "kind": "micro.set", "micro_id": "T01.M01", "state": "done",
            "evidence": [{"path": "artifact.txt", "sha256": value}], **extra})

    def call(self, name, args):
        output = io.StringIO()
        with redirect_stdout(output):
            mcp._handle(1, "tools/call", {"name": name, "arguments": args})
        reply = json.loads(output.getvalue())
        self.assertNotIn("error", reply)
        self.assertFalse(reply["result"]["isError"], reply)

    def test_real_store_evidence_survives_with_redacted_paths(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            home = Path(tmp)
            with mock.patch.dict(os.environ, {"CW_HOME": str(home)}):
                self.call("plan_create", dict(
                    room="evidence", agent="alice", template_id="web-app",
                    title="Evidence plan", brief={"goal": "Verify evidence"},
                    tasks=[dict(key="verify", title="Verify", type="feature",
                                phase="discovery", accept="Evidence survives",
                                microtasks=[{"text": "Check", "accept": "Passes"}])]))
                secret_dir = home / S.FAKE_SECRET
                secret_dir.mkdir()
                paths = [secret_dir / name for name in ("first.txt", "second.txt")]
                for i, path in enumerate(paths):
                    path.write_bytes(b"Evidence fixture contents" + bytes([i]))
                # A-U109c: SPEC_U109 M3 - only the assignee may write a microtask; claim T01 first.
                self.call("task_claim", dict(room="evidence", agent="alice", task_id="T01"))
                self.call("microtask_set", dict(
                    room="evidence", agent="alice", id="T01.M01", state="done",
                    evidence=[str(path) for path in paths]))
                events, malformed = store.read("evidence", 0, home=home)
                self.assertEqual(malformed, 0)
                before = copy.deepcopy(events)
                sanitized = [relay.sanitize_event(event) for event in events]
                self.assertTrue(all(event is not None for event in sanitized))
                self.assertEqual(events, before)
                original = next(e["op"] for e in events if e["op"]["kind"] == "micro.set")
                clean = next(e["op"] for e in sanitized if e["op"]["kind"] == "micro.set")
                self.assertEqual(len(clean["evidence"]), len(paths))
                for path, raw, item in zip(paths, original["evidence"], clean["evidence"]):
                    self.assertEqual(raw["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
                    self.assertEqual(set(redact(raw["sha256"])[2]), {"HIGH_ENTROPY"})
                    self.assertEqual(item["sha256"], raw["sha256"])
                    # Mirror the evidence-item shape in the page validator.
                    self.assertEqual(set(item), {"path", "sha256"})
                    self.assertIsInstance(item["path"], str)
                    self.assertTrue(1 <= len(item["path"]) <= 512)
                    self.assertRegex(item["sha256"], r"^[0-9a-f]{64}$")
                    self.assertEqual(item["path"], redact(raw["path"])[0])
                    self.assertNotEqual(item["path"], raw["path"])
                self.assertNotIn(S.FAKE_VALUE, repr(sanitized))

    def test_invalid_hash_formats_keep_redaction(self):
        for value in (DIGEST.upper(), DIGEST[:-1], DIGEST + "a",
                      "g" + DIGEST[1:], S.FAKE_SECRET):
            with self.subTest(value=value):
                clean = relay.sanitize_event(self.event(value))
                self.assertIsNotNone(clean)
                self.assertEqual(clean["op"]["evidence"][0]["sha256"], redact(value)[0])
                self.assertNotEqual(clean["op"]["evidence"][0]["sha256"], value)

    def test_non_entropy_classes_are_not_exempt(self):
        for classes in (["KEY_ASSIGN"], ["HIGH_ENTROPY", "KEY_ASSIGN"]):
            with self.subTest(classes=classes):
                def redactor(value):
                    return ("[REDACTED:KEY_ASSIGN]", 1, classes) if value == DIGEST else (value, 0, [])
                with mock.patch.object(relay, "redact", side_effect=redactor):
                    clean = relay.sanitize_event(self.event())
                self.assertIsNotNone(clean)
                self.assertEqual(clean["op"]["evidence"][0]["sha256"], "[REDACTED:KEY_ASSIGN]")

    def test_other_sha256_locations_are_not_exempt(self):
        source = self.event(brief={"sha256": DIGEST,
                                   "evidence": [{"sha256": DIGEST}]},
                            sha256=DIGEST, other=[{"sha256": DIGEST}])
        source["op"]["evidence"][0]["nested"] = {"sha256": DIGEST}
        source["op"]["evidence"].append([{"sha256": DIGEST}])
        clean = relay.sanitize_event(source)["op"]
        expected = redact(DIGEST)[0]
        self.assertNotEqual(expected, DIGEST)
        self.assertEqual(clean["brief"]["sha256"], expected)
        self.assertEqual(clean["brief"]["evidence"][0]["sha256"], expected)
        self.assertEqual(clean["sha256"], expected)
        self.assertEqual(clean["other"][0]["sha256"], expected)
        self.assertEqual(clean["evidence"][0]["nested"]["sha256"], expected)
        self.assertEqual(clean["evidence"][1][0]["sha256"], expected)
        self.assertEqual(clean["evidence"][0]["sha256"], DIGEST)

    def test_evidence_mapping_is_not_an_evidence_list(self):
        source = self.event()
        source["op"]["evidence"] = {"sha256": DIGEST}
        clean = relay.sanitize_event(source)
        self.assertEqual(clean["op"]["evidence"]["sha256"], redact(DIGEST)[0])
