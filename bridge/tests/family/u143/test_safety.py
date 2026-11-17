"""AC5/AC6: hostile allowlists and immutable message identity on new routes."""
import copy
from unittest import mock

from bridge.room import family
from .support import ROUTES, MailboxCase, request


class SafetyOracle(MailboxCase):
    def test_changed_unread_envelope_never_overwrites_receipt_or_redispatches(self):
        self.configure(slice=2)
        value = request()
        with self.spy() as dispatch:
            self.success(value)
            prior = self.receipt_path(value).read_bytes()
            dispatch.reset_mock()
            changed = copy.deepcopy(value)
            changed["payload"]["args"]["title"] = "Changed"
            self.publish(changed)
            self.assertEqual(self.invoke(admitted=True), 0)
            dispatch.assert_not_called()
            self.assertEqual(self.receipt_path(value).read_bytes(), prior)

    def test_revoked_allowlist_applies_before_replaying_a_completed_result(self):
        self.configure(slice=2)
        value = request()
        with self.spy() as dispatch:
            self.success(value)
            self.receipt_path(value).unlink()
            self.configure(sources=[])
            dispatch.reset_mock()
            self.publish(value)
            self.assertEqual(self.invoke(admitted=True), 0)
            self.assertEqual(self.receipt(value).get("code"), "bad_args")
            dispatch.assert_not_called()

    def test_changed_pending_envelope_cannot_be_redispatched(self):
        self.configure(slice=2)
        value = request()
        self.publish(value)
        with mock.patch.object(family.Mailbox, "dispatch", side_effect=OSError("controlled interruption")):
            self.assertEqual(self.invoke(admitted=True), 3)
        changed = copy.deepcopy(value)
        changed["payload"]["args"]["title"] = "Conflicting retry"
        self.publish(changed)
        with self.spy() as dispatch:
            self.assertEqual(self.invoke(admitted=True), 0)
        self.assertEqual(self.receipt(changed).get("code"), "bad_op")
        dispatch.assert_not_called()
        self.assertEqual(self.journal_bytes(), {})

    def test_agent_plan_rejects_arbitrary_dispatch_tool_names(self):
        self.configure(slice=2)
        for index, tool in enumerate(("memory_set", "close_task", "agent_lifecycle", "unknown")):
            with self.subTest(tool=tool), self.spy() as dispatch:
                value = request(payload={"tool": tool, "args": {}}, identity="invalid-%04d" % index)
                self.publish(value)
                self.assertEqual(self.invoke(admitted=True), 0)
                self.assertEqual(self.receipt(value).get("code"), "bad_args")
                dispatch.assert_not_called()

    def test_payload_cannot_override_envelope_identity_or_generation(self):
        self.configure(slice=2)
        keys = ("room", "agent", "run_id", "op_id", "plan_opened", "expected_opened_lamport")
        for index, key in enumerate(keys):
            for nested in (False, True):
                with self.subTest(key=key, nested=nested), self.spy() as dispatch:
                    args = {key: "forged"}
                    payload = {"tool": "task_add", "args": args} if nested else args
                    value = request("agent.plan" if nested else "work.acquire", payload,
                                    identity="override-%04d-%d" % (index, nested))
                    self.publish(value)
                    self.assertEqual(self.invoke(admitted=True), 0)
                    self.assertEqual(self.receipt(value).get("code"), "bad_args")
                    dispatch.assert_not_called()
        self.assertEqual(self.journal_bytes(), {})

    def test_missing_or_invalid_generation_is_rejected_before_dispatch(self):
        self.configure(slice=2)
        cases = (None, False, 0, -1, "11")
        for index, generation in enumerate(cases):
            for row in ROUTES:
                if row[1] == "agent.plan":
                    continue  # plan_create forbids, rather than requires, a generation.
                with self.subTest(kind=row[1], generation=generation), self.spy() as dispatch:
                    value = request(row[1], row[3], identity="generation-%02d-%s" % (index, row[0]))
                    if generation is None:
                        value.pop("plan_opened")
                    else:
                        value["plan_opened"] = generation
                    self.publish(value)
                    self.assertEqual(self.invoke(admitted=True), 0)
                    self.assertEqual(self.receipt(value).get("code"), "bad_args")
                    dispatch.assert_not_called()
        self.assertEqual(self.journal_bytes(), {})


def deny_case(row, denied):
    def test(self):
        self.configure(slice=2)
        value = request(row[1], row[3], **{denied: "outsider"})
        self.publish(value)
        with self.spy() as dispatch:
            self.assertEqual(self.invoke(admitted=True), 0)
        self.assertEqual(self.receipt(value).get("code"), "bad_room" if denied == "room" else "bad_args")
        dispatch.assert_not_called()
        self.assertEqual(self.journal_bytes(), {})
    return test


def replay_case(row, conflict):
    def test(self):
        self.configure(slice=2)
        value = request(row[1], row[3])
        with self.spy() as dispatch:
            first = self.success(value)
            dispatch.assert_called_once()
            before = self.journal_bytes()
            self.receipt_path(value).unlink()
            changed = copy.deepcopy(value)
            if conflict:
                changed["run_id"] = "run-b"
            self.publish(changed)
            dispatch.reset_mock()
            self.assertEqual(self.invoke(admitted=True), 0)
            dispatch.assert_not_called()
        result = self.receipt(changed)
        if conflict:
            self.assertEqual(result.get("code"), "bad_op")
        else:
            self.assertEqual(result, {"untrusted": first})
        self.assertEqual(self.journal_bytes(), before)
    return test


for _row in ROUTES:
    for _field in ("source", "room"):
        setattr(SafetyOracle, "test_denies_" + _field + "_" + _row[0], deny_case(_row, _field))
    setattr(SafetyOracle, "test_exact_replay_" + _row[0], replay_case(_row, False))
    setattr(SafetyOracle, "test_changed_envelope_" + _row[0], replay_case(_row, True))
