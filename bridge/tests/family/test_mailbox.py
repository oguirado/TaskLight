"""M1/M2/M6/M8: refusal, allowlists and hostile filesystem inputs."""
import copy
import json
import os
from pathlib import Path
from unittest import mock

from bridge.room import app
from .support import FamilyCase, REAL_OPEN, canonical, envelope


class MailboxOracle(FamilyCase):
    def test_a6_missing_config_refuses_before_replay(self):
        self.publish()
        (self.mailbox / "config.json").unlink()
        self.assertEqual(self.invoke(), 2)
        self.assert_no_dispatch()
        self.assertFalse((self.spool / "deploy-0001.result.json").exists())

    def test_a1_missing_u132_refuses_consumer(self):
        self.publish()
        self.backend.lifecycle_available = False
        self.tools[:] = [t for t in self.tools if t["name"] != "agent_lifecycle"]
        with mock.patch.dict(app.V2_DISPATCH):
            app.V2_DISPATCH.pop("agent_lifecycle", None)
            self.assertEqual(self.invoke(), 2)
        self.assert_no_dispatch()

    def test_empty_sweep_is_successful_and_one_shot(self):
        self.assertEqual(self.invoke(), 0)
        self.sleep.assert_not_called()
        self.assert_no_dispatch()

    def test_poll_has_positive_fake_interval_and_clean_interrupt(self):
        def interrupt(interval):
            self.assertEqual(interval, 0.007)
            raise KeyboardInterrupt
        self.sleep.side_effect = interrupt
        self.assertEqual(self.invoke("--poll-ms", "7"), 0)
        self.sleep.assert_called_once()

    def test_a6_private_room_checked_before_dispatch(self):
        self.publish(envelope(room="private", kind="events.read", after=0, payload={}))
        private = self.journal("private")
        private.parent.mkdir(parents=True)
        private.write_bytes(b"private canary never disclose")
        self.assertEqual(self.invoke(), 0)
        self.error_receipt("bad_room")
        self.assert_no_dispatch()
        self.assertNotIn("private canary", self.stdout + self.stderr + self.receipt()["result"].get("detail", ""))

    def test_a6_unconfigured_source_before_replay(self):
        self.drain_error(envelope(source="stranger"))

    def test_a6_authorization_is_rechecked_after_completed_delivery(self):
        value = envelope()
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        original = self.journal_bytes()
        (self.spool / "deploy-0001.result.json").unlink()
        self.configure(sources=["other"])
        self.publish(value)
        self.backend.calls.clear()
        self.assertEqual(self.invoke(), 0)
        self.error_receipt("bad_args")
        self.assertEqual(self.backend.calls, [])
        self.assertEqual(self.journal_bytes(), original)

    def test_a6_room_authorization_is_rechecked_before_replay(self):
        value = envelope()
        self.publish(value)
        self.assertEqual(self.invoke(), 0)
        original = self.journal_bytes()
        (self.spool / "deploy-0001.result.json").unlink()
        self.configure(rooms=["work"])
        self.publish(value)
        self.backend.calls.clear()
        self.assertEqual(self.invoke(), 0)
        self.error_receipt("bad_room")
        self.assertEqual(self.backend.calls, [])
        self.assertEqual(self.journal_bytes(), original)

    def test_a7_existing_consumer_lock_is_never_reclaimed(self):
        lock = self.mailbox / "consumer.lock"
        lock.write_bytes(b"opaque stale ownership; explicit recovery required")
        before = lock.read_bytes()
        self.publish()
        self.assertEqual(self.invoke(), 2)
        self.assertEqual(lock.read_bytes(), before)
        self.assert_no_dispatch()

    def test_a7_exclusive_consumer_creation_rejects_racer(self):
        original_open = os.open
        contested = []
        def race(path, flags, *args, **kwargs):
            target = self.trace.at(path, kwargs.get("dir_fd"))
            if target == self.mailbox / "consumer.lock" and flags & os.O_CREAT:
                self.assertTrue(flags & os.O_EXCL, "ownership must use exclusive create")
                if not contested:
                    target.write_bytes(b"competing consumer")
                    contested.append(target)
            return original_open(path, flags, *args, **kwargs)
        self.publish()
        with mock.patch.object(os, "open", race):
            self.assertEqual(self.invoke(), 2)
        self.assertTrue(contested, "exclusive ownership was not attempted")
        self.assertEqual(contested[0].read_bytes(), b"competing consumer")
        self.assert_no_dispatch()

    def test_only_addressed_endpoint_and_spool_are_consumed(self):
        self.publish()
        peer = self.home / "family" / "other"
        peer.mkdir()
        canary = peer / "unread-request.json"
        canary.write_bytes(b"untouched peer data")
        misplaced = self.mailbox / "outside-0001.json"
        misplaced.write_bytes(canonical(envelope(id="outside-0001")))
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(len(self.backend.calls), 1)
        self.assertEqual(canary.read_bytes(), b"untouched peer data")
        self.assertTrue(misplaced.exists())
        self.assertFalse((self.mailbox / "deploy-0001.result.json").exists())

    def test_temporary_hidden_and_receipt_files_are_ignored(self):
        names = (".hidden.json", "pending.json.tmp", "pending.tmp", "existing-0001.result.json")
        for name in names:
            (self.spool / name).write_bytes(b"opaque untouched data")
        self.assertEqual(self.invoke(), 0)
        for name in names:
            self.assertEqual((self.spool / name).read_bytes(), b"opaque untouched data")
        self.assert_no_dispatch()

    def test_a5_symlink_request_is_unlinked_or_quarantined_without_disclosure(self):
        secret = self.tmp / "private.json"
        secret.write_bytes(canonical(envelope(payload={"reason": "private sentinel"})))
        request = self.spool / "deploy-0001.json"
        request.symlink_to(secret)
        before = secret.read_bytes()
        self.assertEqual(self.invoke(), 0)
        self.assertFalse(request.is_symlink())
        self.assertEqual(secret.read_bytes(), before)
        self.assert_no_dispatch()
        self.assertNotIn("private sentinel", self.stdout + self.stderr)
        for receipt in self.spool.glob("*.result.json"):
            self.assertNotIn(b"private sentinel", receipt.read_bytes())

    def test_a5_hardlinked_request_is_refused_without_touching_alias(self):
        alias = self.tmp / "alias.json"
        alias.write_bytes(canonical(envelope()))
        request = self.spool / "deploy-0001.json"
        os.link(alias, request)
        before = alias.read_bytes()
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(alias.read_bytes(), before)
        self.assertFalse(request.exists())
        self.assert_no_dispatch()

    def test_a5_nonregular_directory_request_is_quarantined(self):
        request = self.spool / "deploy-0001.json"
        request.mkdir()
        self.assertEqual(self.invoke(), 0)
        self.assertFalse(request.exists())
        self.assert_no_dispatch()

    def test_a5_fifo_request_is_rejected_without_blocking(self):
        request = self.spool / "deploy-0001.json"
        os.mkfifo(request)
        original_open = os.open
        def nonblocking(path, flags, *args, **kwargs):
            target = self.trace.at(path, kwargs.get("dir_fd"))
            if target == request:
                self.assertTrue(flags & os.O_NONBLOCK, "FIFO opened with a blocking read")
            return original_open(path, flags, *args, **kwargs)
        with mock.patch.object(os, "open", nonblocking):
            self.assertEqual(self.invoke(), 0)
        self.assertFalse(request.exists())
        self.assert_no_dispatch()

    def test_a5_descriptor_open_replacement_race(self):
        request = self.publish()
        secret = self.tmp / "replacement.json"
        secret.write_bytes(b"private replacement sentinel")
        swapped = []
        def racing_open(path, flags, *args, **kwargs):
            target = self.trace.at(path, kwargs.get("dir_fd"))
            fd = REAL_OPEN(path, flags, *args, **kwargs)
            if target == request and not swapped:
                request.unlink()
                request.symlink_to(secret)
                swapped.append(True)
            return fd
        with mock.patch.object(os, "open", racing_open):
            self.assertEqual(self.invoke(), 0)
        self.assertTrue(swapped, "request was not opened through a descriptor")
        self.assert_no_dispatch()
        self.assertEqual(secret.read_bytes(), b"private replacement sentinel")


CONFIG_BAD = {
    "missing_endpoint": {"rooms": ["demo"], "sources": ["harness"], "slice": 1},
    "wrong_endpoint": {"endpoint": "other", "rooms": ["demo"], "sources": ["harness"], "slice": 1},
    "missing_rooms": {"endpoint": "board", "sources": ["harness"], "slice": 1},
    "missing_sources": {"endpoint": "board", "rooms": ["demo"], "slice": 1},
    "missing_slice": {"endpoint": "board", "rooms": ["demo"], "sources": ["harness"]},
    "rooms_wrong_type": {"endpoint": "board", "rooms": "demo", "sources": ["harness"], "slice": 1},
    "source_wrong_type": {"endpoint": "board", "rooms": ["demo"], "sources": {}, "slice": 1},
    "invalid_room": {"endpoint": "board", "rooms": ["../private"], "sources": ["harness"], "slice": 1},
    "invalid_source": {"endpoint": "board", "rooms": ["demo"], "sources": ["Upper"], "slice": 1},
    "slice_boolean": {"endpoint": "board", "rooms": ["demo"], "sources": ["harness"], "slice": True},
    "slice_zero": {"endpoint": "board", "rooms": ["demo"], "sources": ["harness"], "slice": 0},
    "slice_unknown": {"endpoint": "board", "rooms": ["demo"], "sources": ["harness"], "slice": 3},
}


def config_case(value):
    def test(self):
        self.publish()
        (self.mailbox / "config.json").write_bytes(canonical(value))
        self.assertEqual(self.invoke(), 2)
        self.assert_no_dispatch()
    return test


for _name, _value in CONFIG_BAD.items():
    setattr(MailboxOracle, "test_invalid_configuration_" + _name, config_case(_value))


def poll_case(value):
    def test(self):
        self.assertEqual(self.invoke("--poll-ms", value), 2)
        self.assert_no_dispatch()
    return test


for _name, _value in {"zero": "0", "negative": "-1", "float": "1.5", "text": "abc"}.items():
    setattr(MailboxOracle, "test_invalid_poll_" + _name, poll_case(_value))


def symlink_component(component):
    def test(self):
        self.publish()
        target = self.tmp / ("saved-" + component)
        if component == "home":
            path = self.home
        elif component == "family":
            path = self.home / "family"
        elif component == "endpoint":
            path = self.mailbox
        elif component == "spool":
            path = self.spool
        else:
            path = self.mailbox / "config.json"
        path.rename(target)
        path.symlink_to(target, target_is_directory=target.is_dir())
        self.assertEqual(self.invoke(), 2)
        self.assert_no_dispatch()
    return test


for _part in ("home", "family", "endpoint", "spool", "config"):
    setattr(MailboxOracle, "test_reject_symlink_component_" + _part, symlink_component(_part))


def endpoint_case(value):
    def test(self):
        self.assertEqual(self.invoke(endpoint=value), 2)
        self.assert_no_dispatch()
    return test


for _name, _value in {"empty": "", "traversal": "../board", "absolute": str(Path.cwd()),
                      "uppercase": "Board", "too_long": "b" * 65, "slash": "a/b"}.items():
    setattr(MailboxOracle, "test_invalid_endpoint_" + _name, endpoint_case(_value))


def empty_allowlist_case(field):
    def test(self):
        self.configure(**{field: []})
        self.publish()
        code = self.invoke()
        # Either refuse an unusable config or deny the individual request.
        self.assertIn(code, (0, 2))
        if code == 0:
            self.error_receipt("bad_args" if field == "sources" else "bad_room")
        self.assert_no_dispatch()
    return test


for _field in ("sources", "rooms"):
    setattr(MailboxOracle, "test_empty_allowlist_never_allows_" + _field, empty_allowlist_case(_field))


def malformed_config(self):
    (self.mailbox / "config.json").write_bytes(b"{invalid configuration")
    self.publish()
    self.assertEqual(self.invoke(), 2)
    self.assert_no_dispatch()


MailboxOracle.test_malformed_configuration_refuses_startup = malformed_config


def unsafe_state_case(component):
    def test(self):
        self.publish()
        alias = self.tmp / ("private-" + component)
        alias.mkdir()
        sentinel = alias / "sentinel.json"
        sentinel.write_bytes(b"private state canary")
        (self.mailbox / component).symlink_to(alias, target_is_directory=True)
        self.assertIn(self.invoke(), (2, 3))
        self.assert_no_dispatch()
        self.assertEqual(list(alias.iterdir()), [sentinel])
        self.assertEqual(sentinel.read_bytes(), b"private state canary")
    return test


for _component in ("state", "dedup"):
    setattr(MailboxOracle, "test_unsafe_metadata_component_" + _component, unsafe_state_case(_component))


def unsafe_filename_case(name):
    def test(self):
        request = self.publish(envelope(), filename=name)
        self.assertEqual(self.invoke(), 0)
        self.assertFalse(request.exists())
        self.assert_no_dispatch()
    return test


for _name, _filename in {"too_short": "short.json", "too_long": "x" * 65 + ".json",
                         "invalid_character": "invalid!.json"}.items():
    setattr(MailboxOracle, "test_invalid_request_filename_" + _name, unsafe_filename_case(_filename))
