"""Run identity redaction and repeated-sanitization regressions."""
import copy
import hashlib
import json
import re
import unittest

from bridge.plan.errors import PlanError
from bridge.plan.ops import validate_op_shape
from bridge.tests.wall_room import support as S
from bridge.wall import room_relay as relay
from bridge.wall.emit import redact


ENTROPY_ID = "0123456789abcdef0123456789abcdef"
KINDS = ("agent.lifecycle", "activity.beat")


def event(kind, run_id, op_id="run-op-0001"):
    op = dict(kind=kind, run_id=run_id, op_id=op_id)
    if kind == "agent.lifecycle":
        op.update(state="deployed", harness="external")
    else:
        op.update(task_id="T01", micro_id="T01.M01")
    return S.event(1, act="op", op=op)


def wire_bytes(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class RunIdentityDebt(unittest.TestCase):
    def test_secret_classes_never_become_run_surrogates(self):
        surrogate = "h-" + hashlib.sha256(ENTROPY_ID.encode()).hexdigest()[:32]
        for value in (ENTROPY_ID, surrogate):
            self.assertIsNotNone(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value))
            for secret_class in ("PRIVATE_KEY", "BEARER", "JWT", "KEY_ASSIGN",
                                 "URL_CREDS", "APPCHECK_DEBUG", "EMAIL", "HOME_PATH"):
                marker = "[REDACTED:" + secret_class + "]"
                for classes in ([secret_class], [secret_class, "HIGH_ENTROPY"]):
                    def classified(text, _disable=frozenset()):
                        if text == value:
                            return marker, 1, classes
                        return redact(text)
                    for kind in KINDS:
                        with self.subTest(value=value, classes=classes, kind=kind):
                            with S.patched_redact(classified):
                                clean = relay.sanitize_event(event(kind, value))
                            self.assertIsNotNone(clean)
                            self.assertEqual(clean["op"]["run_id"], marker)
                            with self.assertRaises(PlanError):
                                validate_op_shape(clean["op"])

    def test_surrogate_events_are_byte_idempotent(self):
        identities = {}
        for run_id in (ENTROPY_ID + "-exec-a", ENTROPY_ID + "-exec-b"):
            self.assertEqual(redact(run_id)[2], ["HIGH_ENTROPY"])
            expected = "h-" + hashlib.sha256(run_id.encode()).hexdigest()[:32]
            for kind in KINDS:
                with self.subTest(kind=kind, run_id=run_id):
                    source = event(kind, run_id, op_id=ENTROPY_ID)
                    original = copy.deepcopy(source)
                    clean = relay.sanitize_event(source)
                    self.assertIsNotNone(clean)
                    self.assertEqual(clean["op"]["run_id"], expected)
                    validate_op_shape(clean["op"])
                    identities[(kind, run_id)] = clean["op"]["run_id"]
                    encoded = wire_bytes(clean)
                    for _ in range(3):
                        clean = relay.sanitize_event(json.loads(wire_bytes(clean)))
                        self.assertIsNotNone(clean)
                        self.assertEqual(wire_bytes(clean), encoded)
                        validate_op_shape(clean["op"])
                    self.assertEqual(source, original)
        for run_id in (ENTROPY_ID + "-exec-a", ENTROPY_ID + "-exec-b"):
            self.assertEqual(identities[(KINDS[0], run_id)], identities[(KINDS[1], run_id)])
        self.assertNotEqual(identities[(KINDS[0], ENTROPY_ID + "-exec-a")],
                            identities[(KINDS[0], ENTROPY_ID + "-exec-b")])

    def test_real_token_run_ids_remain_redacted_and_invalid(self):
        jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.fake"
        for value, secret_class in ((S.FAKE_SECRET, "KEY_ASSIGN"),
                                    ("Bearer " + ENTROPY_ID, "BEARER"),
                                    (jwt, "JWT"), ("fixture@example.test", "EMAIL")):
            expected, count, classes = redact(value)
            self.assertGreater(count, 0)
            self.assertIn(secret_class, classes)
            self.assertNotEqual(expected, value)
            for kind in KINDS:
                with self.subTest(kind=kind, secret_class=secret_class):
                    clean = relay.sanitize_event(event(kind, value))
                    self.assertIsNotNone(clean)
                    self.assertEqual(clean["op"]["run_id"], expected)
                    self.assertNotIn(value, wire_bytes(clean).decode())
                    self.assertNotIn(S.FAKE_VALUE, wire_bytes(clean).decode())
                    with self.assertRaises(PlanError):
                        validate_op_shape(clean["op"])
                    self.assertEqual(wire_bytes(relay.sanitize_event(clean)), wire_bytes(clean))

    def test_nested_and_free_text_surrogates_still_redact(self):
        surrogate = "h-" + hashlib.sha256(ENTROPY_ID.encode()).hexdigest()[:32]
        self.assertNotEqual(redact(surrogate)[0], surrogate)
        source = event("agent.lifecycle", ENTROPY_ID)
        source["op"].update(reason=surrogate, brief={"run_id": surrogate},
                            items=[{"op_id": surrogate, "run_id": ENTROPY_ID}])
        clean = relay.sanitize_event(source)
        self.assertIsNotNone(clean)
        self.assertEqual(clean["op"]["reason"], redact(surrogate)[0])
        self.assertEqual(clean["op"]["brief"]["run_id"], redact(surrogate)[0])
        self.assertEqual(clean["op"]["items"][0],
                         {"op_id": redact(surrogate)[0], "run_id": redact(ENTROPY_ID)[0]})
        self.assertEqual(wire_bytes(relay.sanitize_event(clean)), wire_bytes(clean))


if __name__ == "__main__":
    unittest.main()
