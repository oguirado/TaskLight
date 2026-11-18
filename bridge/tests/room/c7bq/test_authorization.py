"""C7bq: artifact_read authorizes paths only from admitted terminal lifecycle ops."""
import json

from bridge.tests.room.c7 import support as c7
from bridge.tests.room.c7b.support import ARTIFACT, NO_REFERENCE, ROOM, ProjectCase


class AuthorizationRegression(ProjectCase):
    def write_artifact(self):
        (self.project / ARTIFACT).write_bytes(b"report\n")

    def append(self, *items):
        path = self.path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as stream:
            for item in items:
                stream.write(json.dumps(item) + "\n")

    def read(self):
        return lambda: self.dispatch("artifact_read", {"room": ROOM, "agent": "reviewer", "path": ARTIFACT})

    def test_non_op_record_carrying_a_lifecycle_result_does_not_authorize(self):
        self.write_artifact()
        self.record_receipt(path="artifacts/other.txt")
        head = max(item["lamport"] for item in self.events())
        record = c7.event(head + 1, {"kind": "agent.lifecycle", "state": "finished", "run_id": "x-run",
                                      "result": {"verdict": "OK", "receipt": ARTIFACT}}, agent="worker")
        record["act"] = "say"
        self.append(record)
        self.assert_room_error(self.read(), "bad_args", NO_REFERENCE)

    def test_ignored_terminal_without_registration_does_not_authorize(self):
        self.write_artifact()
        self.record_receipt(path="artifacts/other.txt")
        head = max(item["lamport"] for item in self.events())
        # A terminal op for a run that was never deployed is not an admitted result.
        self.append(c7.event(head + 1, {"kind": "agent.lifecycle", "state": "finished", "run_id": "ghost-run",
                                        "result": {"verdict": "OK", "receipt": ARTIFACT}}, agent="ghost"))
        self.assert_room_error(self.read(), "bad_args", NO_REFERENCE)

    def test_malformed_result_shapes_do_not_crash(self):
        self.write_artifact()
        self.record_receipt(path="artifacts/other.txt")
        head = max(item["lamport"] for item in self.events())
        for offset, result in enumerate((None, [], {"evidence": "x"}, {"evidence": [None, {"path": ARTIFACT}]}), 1):
            self.append(c7.event(head + offset, {"kind": "agent.lifecycle", "state": "finished",
                                                 "run_id": "bad-%d" % offset, "result": result}, agent="worker"))
        try:
            self.read()()
        except Exception as exc:  # noqa: BLE001 - only RoomError is acceptable
            from bridge.room import store
            self.assertIsInstance(exc, store.RoomError)


class ObserverGuard(ProjectCase):
    """White-box: drive the observer with the dispositions and shapes the fold may emit."""

    def observe_with(self, items):
        from unittest import mock
        from bridge.room.ext import artifact

        def fake_fold(events, _observe=None, **kwargs):
            for event, disposition in items:
                _observe(event, {}, disposition)
            return {}

        with mock.patch.object(artifact, "fold_plan", fake_fold), \
                mock.patch.object(artifact, "_read_events", lambda room, **kw: []):
            return artifact._recorded_hashes(ROOM, ARTIFACT)

    def lifecycle(self, result, act="op"):
        return {"act": act, "room": ROOM, "op": {"kind": "agent.lifecycle", "state": "finished",
                                                 "run_id": "r", "result": result}}

    def test_ignored_and_non_op_events_never_authorize(self):
        result = {"verdict": "OK", "receipt": ARTIFACT}
        for event, disposition in ((self.lifecycle(result), {"ignored": True}),
                                   ({"act": "say", "room": ROOM}, {"ok": True}),
                                   (self.lifecycle(result, act="say"), {"ok": True})):
            with self.subTest(disposition=disposition, act=event.get("act")):
                self.assert_room_error(lambda: self.observe_with([(event, disposition)]), "bad_args", NO_REFERENCE)

    def test_malformed_results_never_crash(self):
        for result in (None, [], {"evidence": None}, {"evidence": [None, {"path": ARTIFACT}]}):
            with self.subTest(result=result):
                items = [(self.lifecycle(result), {"ok": True})]
                if isinstance(result, dict) and result.get("evidence"):
                    self.assertEqual(self.observe_with(items), set())
                else:
                    self.assert_room_error(lambda: self.observe_with(items), "bad_args", NO_REFERENCE)
