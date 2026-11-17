"""A4/A5: hostile input, byte limits and server-verified evidence."""
import hashlib
import json
import os
from unittest.mock import patch

from bridge.room import store
from .support import BASE, SendCase, file_events


class Validation(SendCase):
    def test_a5_required_and_closed_request_shape(self):
        for field in BASE:
            with self.subTest(missing=field):
                args = dict(BASE)
                del args[field]
                self.refuse(args, "bad_args")
        for value in (None, [], "message", 1, True):
            with self.subTest(non_object=value):
                self.refuse(value, "bad_args")
        for key in ("command", "plan", "step", "op", "unexpected"):
            with self.subTest(extra=key):
                self.refuse(dict(BASE, **{key: "execute"}), "bad_args")

    def test_a5_room_and_agent_slug_boundaries(self):
        for room in ("", "Demo", "../demo", "a/b", "a b", "é", "a" * 49, None, 7):
            with self.subTest(room=room):
                self.refuse(dict(BASE, room=room), "bad_room")
        for field in ("agent", "to"):
            for value in ("", "Bad", "-a", "a/b", "a b", "a" * 49, None, 3):
                with self.subTest(field=field, value=value):
                    self.refuse(dict(BASE, **{field: value}), "bad_agent")
        self.send(room="a" * 48, agent="a" * 48, to="a" * 48)
        self.send(room="0-z", agent="x.y_z-1", to="b.c")

    def test_a4_only_coordination_acts_are_accepted(self):
        for act in ("open", "plan", "step", "heartbeat", "verdict", "close", "op",
                    "Question", "", None, [], 1):
            with self.subTest(act=act):
                self.refuse(dict(BASE, act=act), "bad_act")

    def test_a5_null_optional_fields_are_bad_args(self):
        for key in ("re", "evidence", "op_id"):
            with self.subTest(key=key):
                self.refuse(dict(BASE, **{key: None}), "bad_args")

    def test_a5_text_is_measured_in_utf8_bytes(self):
        for text in ("a" * 4096, "é" * 2048, "😀" * 1024):
            with self.subTest(accepted_bytes=len(text.encode("utf-8"))):
                receipt = self.send(text=text)
                self.assertEqual(self.event(receipt["id"])["text"], text)
        for text in ("a" * 4097, "é" * 2048 + "a", "😀" * 1024 + "a"):
            with self.subTest(rejected_bytes=len(text.encode("utf-8"))):
                self.refuse(dict(BASE, text=text), "text_too_long")

    def test_a5_text_type_empty_and_encoding_errors(self):
        for text in (None, 7, [], {}, True):
            with self.subTest(text=text):
                self.refuse(dict(BASE, text=text), "text_too_long")
        for text in ("", " ", "\t\r\n", "\ud800"):
            with self.subTest(text=repr(text)):
                self.refuse(dict(BASE, text=text), "bad_op")

    def test_a5_operation_identity_boundaries(self):
        for op_id in ("a" * 8, "Z_-09abc", "a" * 64):
            with self.subTest(accepted=op_id):
                receipt = self.send(op_id=op_id)
                self.assertEqual(self.event(receipt["id"])["op_id"], op_id)
        for op_id in ("", "a" * 7, "a" * 65, "bad.id00", "white space", 8, [], True):
            with self.subTest(rejected=op_id):
                self.refuse(dict(BASE, op_id=op_id), "bad_op")

    def test_a5_evidence_correct_digest_and_entry_limit(self):
        evidence = []
        for index in range(8):
            data = ("fixture %s" % index).encode()
            path = self.fixture("note-%s.txt" % index, data)
            evidence.append({"path": str(path), "sha256": hashlib.sha256(data).hexdigest()})
        receipt = self.send(evidence=evidence)
        self.assertEqual(self.event(receipt["id"])["evidence"], evidence)
        self.refuse(dict(BASE, evidence=evidence + evidence[:1]), "bad_evidence")
        self.send(evidence=[])

    def test_a5_evidence_schema_and_digest_negative_control(self):
        path = self.fixture(data=b"abc")
        digest = hashlib.sha256(b"abc").hexdigest()
        good = {"path": str(path), "sha256": digest}
        accepted = self.send(evidence=[good])
        self.assertEqual(self.event(accepted["id"])["evidence"], [good])
        bads = (str(path), {}, (good,), [str(path)], [None], [[]], [{}],
                [{"path": str(path)}], [{"sha256": digest}],
                [dict(good, extra="x")], [dict(good, path=8)],
                [dict(good, sha256=8)], [dict(good, sha256=digest.upper())],
                [dict(good, sha256="a" * 63)], [dict(good, sha256="a" * 65)],
                [dict(good, sha256="g" * 64)], [dict(good, sha256="0" * 64)])
        for evidence in bads:
            with self.subTest(evidence=evidence):
                self.refuse(dict(BASE, evidence=evidence), "bad_evidence")

    def test_a5_evidence_path_exclusions_and_symlinks(self):
        fixture = self.fixture()
        digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
        credential = self.fixture("auth.json")
        inside = self.home / "outside-rooms.txt"
        inside.write_bytes(fixture.read_bytes())
        linked = self.tmp / "link.txt"
        linked.symlink_to(fixture)
        alias = self.tmp / "home-alias"
        alias.symlink_to(self.home, target_is_directory=True)
        fifo = self.tmp / "pipe"
        os.mkfifo(fifo)
        for path in ("relative.txt", credential, inside, alias / inside.name, linked,
                     fixture.parent, self.tmp / "missing.txt",
                     self.home / "rooms" / "demo" / "events.jsonl"):
            with self.subTest(path=str(path.relative_to(self.tmp)) if hasattr(path, "relative_to") else path):
                self.refuse(dict(BASE, evidence=[{"path": str(path), "sha256": digest}]),
                            "bad_evidence")

        # A broken FIFO guard must fail within a process deadline, never hang discovery.
        before = self.journals()
        cp = self.cli("call", "room_send", "--json", json.dumps(dict(
            BASE, evidence=[{"path": str(fifo), "sha256": digest}])))
        self.assertEqual(cp.returncode, 3, cp.stdout)
        self.assertEqual(json.loads(cp.stdout)["code"], "bad_evidence")
        self.assertEqual(self.journals(), before)

    def test_a5_evidence_file_size_boundary(self):
        path = self.fixture("large.bin", b"")
        limit = 8 * 1024 * 1024
        with path.open("wb") as stream:
            stream.truncate(limit)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self.send(evidence=[{"path": str(path), "sha256": digest}])
        with path.open("ab") as stream:
            stream.write(b"x")
        self.refuse(dict(BASE, evidence=[{"path": str(path), "sha256": digest}]), "bad_evidence")

    def test_m5_legacy_path_list_evidence_is_preserved(self):
        path = self.fixture()
        event = store.post("demo", "legacy", "heartbeat", "legacy evidence",
                           evidence=[str(path)], clock=lambda: 1700000000000)
        self.assertEqual(event["evidence"], [{"path": str(path),
                                            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}])
        self.assertEqual(file_events(self.home, "demo")[-1], event)

    def test_c3_structural_evidence_refusal_precedes_writer_lock(self):
        credential = self.fixture("secret.txt")
        regular = self.fixture()
        linked = self.tmp / "evidence-link.txt"
        linked.symlink_to(regular)
        digest = hashlib.sha256(regular.read_bytes()).hexdigest()
        oversized = self.fixture("oversized.bin", b"")
        with oversized.open("wb") as stream:
            stream.truncate(8 * 1024 * 1024 + 1)
        with patch.object(store._lock, "lock_exclusive",
                          side_effect=AssertionError("invalid evidence reached writer lock")):
            for path in (credential, linked, regular.parent, oversized, self.home / "rooms" / "demo" / "events.jsonl"):
                with self.subTest(path=path.name):
                    self.refuse(dict(BASE, evidence=[{"path": str(path), "sha256": digest}]),
                                "bad_evidence")
