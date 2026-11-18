"""Exercise journal reads and observable relay frames without live I/O or waits."""

import builtins
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from bridge.tests.room.c5a.support import encoded, record
from bridge.wall import native_host, room_relay


DEMO, OTHER = "demo", "other"
RID = "replay-one"
FLOOR = "ONLY_ON_DEVICE"
PRIVATE = "private_record_marker"
CORRUPT = b'{"detail":"' + PRIVATE.encode() + b'"\n'


class RelayErrors(unittest.TestCase):
    def setUp(self):
        self.runtime = Path(self.enterContext(
            tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)))
        self.frames = []
        self.failed_send = None
        self.relay = room_relay.RoomRelay(
            {"rooms": [{"room": room, "floor": FLOOR} for room in (DEMO, OTHER)],
             "agent": "wall-user"},
            self.send, home=self.runtime, clock=lambda: 100.0,
        )
        for room in (DEMO, OTHER):
            self.install(room)

    def send(self, frame):
        if self.failed_send is not None:
            matches, failure = self.failed_send
            if matches(frame):
                if failure == "exception":
                    raise OSError(PRIVATE)
                return False
        self.frames.append(frame)
        return True

    def journal(self, room):
        return self.runtime / "rooms" / room / "events.jsonl"

    def install(self, room, *lamports, tail=b""):
        journal = self.journal(room)
        journal.parent.mkdir(parents=True, exist_ok=True)
        journal.write_bytes(b"".join(encoded(record(room=room, lamport=n))
                                     for n in lamports) + tail)

    def replay(self, since=None, rid=RID):
        if since is None:
            since = {DEMO: 0, OTHER: 0}
        return self.relay.handle({"t": "room_sync", "v": 1, "rid": rid, "since": since})

    def of_type(self, kind, room):
        return [f for f in self.frames if f.get("room") == room and f["t"] == kind]

    def lamports(self, room):
        return [f["event"]["lamport"] for f in self.of_type("room_event", room)]

    def assert_fault(self, room=DEMO, *, code="room_read_failed", rid=None):
        expected = {"t": "room_sync_error", "v": 1, "room": room, "code": code}
        if rid is not None:
            expected["rid"] = rid
        self.assertEqual(self.of_type("room_sync_error", room), [expected],
                         "the failed operation must surface exactly one content-free room fault")
        self.assertEqual(self.of_type("room_synced", room), [],
                         "a failed operation cannot certify replay completion")

    def assert_terminal(self, room, upto, rid=RID):
        self.assertEqual(self.of_type("room_synced", room), [
            {"t": "room_synced", "v": 1, "room": room, "rid": rid, "upto": upto, "more": False}
        ])

    def test_prime_fault_preserves_cursor_and_still_primes_healthy_room(self):
        self.install(DEMO, 1, tail=CORRUPT)
        self.install(OTHER, 1)
        self.relay.prime()
        self.install(DEMO, 1, 2)
        self.install(OTHER, 1, 2)
        self.relay.poll()
        self.assertEqual(self.lamports(OTHER), [2])
        self.assertEqual(self.lamports(DEMO), [1, 2],
                         "failed prime must not advance across the valid prefix of a broken journal")
        self.assert_fault()

    def test_startup_fault_reaches_native_wire_after_hello_even_if_room_is_repaired(self):
        self.install(DEMO, 1, tail=CORRUPT)
        self.install(OTHER, 1)
        checked = room_relay.store.read_checked

        def repair_after_failed_read(room, *args, **kwargs):
            try:
                return checked(room, *args, **kwargs)
            except room_relay.store.RoomError:
                if room == DEMO:
                    self.install(DEMO, 1)
                raise

        config = {
            "v": 1, "extensionId": "a" * 32, "spoolDir": str(self.runtime),
            "projects": [], "rooms": {"agent": "wall-user", "home": str(self.runtime),
                "allow": [{"room": room, "tier": "private"} for room in (DEMO, OTHER)]},
        }
        config_path = self.runtime / "wall.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        output = io.BytesIO()
        with tempfile.TemporaryFile(dir=self.runtime) as stdin:
            for frame in (
                {"t": "room_sync", "v": 1, "rid": RID, "since": {DEMO: 0, OTHER: 0}},
                {"t": "bye", "v": 1},
            ):
                data = json.dumps(frame).encode()
                stdin.write(struct.pack("<I", len(data)) + data)
            stdin.seek(0)
            ready = ([stdin.fileno()], [], [])
            with patch.object(native_host.select, "select", return_value=ready), \
                 patch.object(room_relay.store, "read_checked", side_effect=repair_after_failed_read):
                rc = native_host.main(["--config", str(config_path), f"chrome-extension://{'a' * 32}/"],
                                      stdin=stdin, stdout=output, stderr=io.StringIO())
        self.assertEqual(rc, 0)
        wire = []
        output.seek(0)
        while header := output.read(4):
            (size,) = struct.unpack("<I", header)
            wire.append(json.loads(output.read(size)))
        hello = next((f for f in wire if f["t"] == "room_hello"), {})
        self.assertEqual({entry["room"] for entry in hello.get("rooms", [])}, {DEMO, OTHER})
        self.frames = [f for f in wire if "room" in f]
        self.assert_terminal(OTHER, 1)
        fault = {"t": "room_sync_error", "v": 1, "room": DEMO, "code": "room_read_failed"}
        self.assertEqual(self.of_type("room_sync_error", DEMO), [fault],
                         "the startup failure must remain reportable after storage is repaired")
        self.assertLess(wire.index(hello), wire.index(fault), "hello membership must precede the fault")
        for frame in self.of_type("room_synced", DEMO):
            self.assertLess(wire.index(fault), wire.index(frame))

    def test_poll_fault_stops_progress_and_recovers_from_last_good_cursor(self):
        self.install(DEMO, 1)
        self.install(OTHER, 1)
        self.relay.poll()
        self.assertEqual(self.lamports(DEMO), [1])
        self.frames.clear()

        self.install(DEMO, 1, 2, tail=CORRUPT)
        self.install(OTHER, 1, 2)
        self.relay.poll()
        with self.subTest(stage="broken"):
            self.assertEqual(self.lamports(OTHER), [2])
            self.assertEqual(self.lamports(DEMO), [], "a failed poll cannot deliver the valid prefix")
            self.assert_fault()
        self.frames.clear()
        self.install(DEMO, 1, 2)
        self.relay.poll()
        self.assertEqual(self.lamports(DEMO), [2], "after repair, only unadvanced progress is due")
        self.assertEqual(self.lamports(OTHER), [])

    def test_replay_fault_correlates_and_never_certifies_a_broken_journal(self):
        self.install(OTHER, 1)
        for broken in ("missing", "directory", "committed", "foreign-before-cursor"):
            with self.subTest(broken=broken):
                self.install(DEMO, 1, 4)
                if broken == "missing":
                    self.journal(DEMO).unlink()
                elif broken == "directory":
                    self.journal(DEMO).unlink()
                    self.journal(DEMO).mkdir()
                elif broken == "committed":
                    self.install(DEMO, 1, 4, tail=CORRUPT)
                else:
                    self.journal(DEMO).write_bytes(encoded(record(room=OTHER, lamport=2))
                                                   + encoded(record(room=DEMO, lamport=4)))
                self.frames.clear()
                self.replay({DEMO: 3, OTHER: 0})
                self.assert_terminal(OTHER, 1)
                self.assertEqual(self.lamports(DEMO), [], "replay must stop at a failed read")
                self.assert_fault(rid=RID)
            if self.journal(DEMO).is_dir():
                self.journal(DEMO).rmdir()

    def test_replay_refuses_unreadable_journal_without_leaking_error(self):
        self.install(DEMO, 1)
        original_open = builtins.open

        def deny_demo(path, *args, **kwargs):
            if isinstance(path, (str, Path)) and Path(path) == self.journal(DEMO):
                raise PermissionError(PRIVATE)
            return original_open(path, *args, **kwargs)

        with patch.object(builtins, "open", side_effect=deny_demo):
            with self.assertRaisesRegex(room_relay.store.RoomError, "room_read_failed"):
                room_relay.store.read_checked(DEMO, home=self.runtime)
            self.replay()
        self.assert_terminal(OTHER, 0)
        self.assertEqual(self.lamports(DEMO), [])
        self.assert_fault(rid=RID)

    def test_replay_can_retry_a_repaired_journal(self):
        self.journal(DEMO).unlink()
        self.replay({DEMO: 0})
        with self.subTest(stage="broken"):
            self.assert_fault(rid=RID)
        self.frames.clear()
        self.install(DEMO, 1)
        self.replay({DEMO: 0}, rid="replay-retry")
        self.assertEqual(self.lamports(DEMO), [1])
        self.assert_terminal(DEMO, 1, rid="replay-retry")
        self.assertEqual(self.of_type("room_sync_error", DEMO), [])

    def test_other_checked_read_failure_uses_generic_code(self):
        checked = room_relay.store.read_checked

        def read(room, *args, **kwargs):
            if room == DEMO:
                raise OSError(PRIVATE)
            return checked(room, *args, **kwargs)

        with patch.object(room_relay.store, "read_checked", side_effect=read):
            self.replay()
        self.assert_terminal(OTHER, 0)
        self.assert_fault(code="room_sync_failed", rid=RID)

    def test_invalid_checked_result_cannot_certify_replay(self):
        checked = room_relay.store.read_checked

        for bad in (object(), ([record(room=OTHER, lamport=5)], 0)):
            with self.subTest(result=type(bad).__name__):
                self.frames.clear()

                def read(room, *args, **kwargs):
                    return bad if room == DEMO else checked(room, *args, **kwargs)

                with patch.object(room_relay.store, "read_checked", side_effect=read):
                    self.replay()
                self.assert_terminal(OTHER, 0)
                self.assertEqual(self.lamports(DEMO), [])
                self.assert_fault(code="room_sync_failed", rid=RID)

    def test_empty_blank_and_torn_only_journals_stay_healthy(self):
        for tail in (b"", b" \n\t\n", CORRUPT.rstrip(b"\n")):
            with self.subTest(tail=tail):
                self.install(DEMO, tail=tail)
                self.frames.clear()
                self.relay.prime()
                self.relay.poll()
                self.assertEqual(self.frames, [])
                self.replay({DEMO: 0})
                self.assert_terminal(DEMO, 0)
                self.assertEqual(self.of_type("room_sync_error", DEMO), [])

    def test_torn_tail_preserves_committed_prefix(self):
        self.install(DEMO, 1, tail=CORRUPT.rstrip(b"\n"))
        self.replay({DEMO: 0})
        self.assertEqual(self.lamports(DEMO), [1])
        self.assert_terminal(DEMO, 1)
        self.assertEqual(self.of_type("room_sync_error", DEMO), [])

    def test_sanitizer_and_oversize_remain_gaps_among_delivered_events(self):
        sanitize = room_relay.sanitize_event
        for reason in ("sanitize_failed", "oversize"):
            with self.subTest(reason=reason):
                middle = record(lamport=2)
                if reason == "oversize":
                    # Legacy references can be read independently of the wire limit.
                    middle["re"] = "ordinary words " * 6000
                self.journal(DEMO).write_bytes(encoded(record(lamport=1)) + encoded(middle)
                                               + encoded(record(lamport=3)))
                self.frames.clear()
                with patch.object(room_relay, "sanitize_event", side_effect=lambda event:
                                  None if reason == "sanitize_failed" and event["lamport"] == 2
                                  else sanitize(event)):
                    self.replay({DEMO: 0})
                self.assertEqual([f["t"] for f in self.frames],
                                 ["room_event", "room_gap", "room_event", "room_synced"])
                self.assertEqual(self.lamports(DEMO), [1, 3])
                self.assertEqual(self.of_type("room_gap", DEMO), [
                    {"t": "room_gap", "v": 1, "room": DEMO, "rid": RID,
                     "from_lamport": 2, "to_lamport": 2, "reason": reason}
                ])
                self.assert_terminal(DEMO, 3)

    def assert_replay_send_failure(self, kind):
        self.install(DEMO, 1, 2)
        self.install(OTHER, 1)
        sanitize = room_relay.sanitize_event
        for failure in ("exception", "false"):
            with self.subTest(failure=failure):
                self.frames.clear()
                self.failed_send = (lambda frame: (frame["room"], frame["t"]) == (DEMO, kind), failure)
                with patch.object(room_relay, "sanitize_event", side_effect=lambda event:
                                  None if kind == "room_gap" and event["room"] == DEMO
                                  and event["lamport"] == 1 else sanitize(event)):
                    self.replay()
                self.assert_terminal(OTHER, 1)
                expected = [1, 2] if kind == "room_synced" else []
                self.assertEqual(self.lamports(DEMO), expected,
                                 "failed replay delivery stops the affected room")
                self.assert_fault(code="room_sync_failed", rid=RID)

    def test_replay_event_send_failure_stops_failed_room(self):
        self.assert_replay_send_failure("room_event")

    def test_replay_gap_send_failure_stops_failed_room(self):
        self.assert_replay_send_failure("room_gap")

    def test_replay_terminal_send_failure_surfaces_instead_of_certifying(self):
        self.assert_replay_send_failure("room_synced")

    def test_poll_failed_send_retries_only_undelivered_progress(self):
        self.install(DEMO, 1, 2, 3)
        self.install(OTHER, 1)

        def second_event(frame):
            return (frame["room"] == DEMO and frame["t"] == "room_event"
                    and frame["event"]["lamport"] == 2)

        self.failed_send = (second_event, "false")
        self.relay.poll()
        with self.subTest(stage="failed delivery"):
            self.assertEqual(self.lamports(DEMO), [1])
            self.assertEqual(self.lamports(OTHER), [1])
            self.assert_fault(code="room_sync_failed")
        self.frames.clear()
        self.failed_send = None
        self.relay.poll()
        self.assertEqual(self.lamports(DEMO), [2, 3])
        self.assertEqual(self.lamports(OTHER), [])

    def test_undelivered_read_fault_is_reported_before_later_completion(self):
        self.journal(DEMO).unlink()
        self.failed_send = (
            lambda frame: frame["room"] == DEMO and frame["t"] == "room_sync_error", "false"
        )
        self.relay.poll()
        self.assertEqual(self.of_type("room_sync_error", DEMO), [])

        self.failed_send = None
        self.install(DEMO, 1)
        self.replay({DEMO: 0}, rid="replay-after-repair")
        self.assertEqual([f["t"] for f in self.frames if f["room"] == DEMO
                          and f["t"] in ("room_sync_error", "room_synced")],
                         ["room_sync_error", "room_synced"])
        self.assertEqual(self.of_type("room_sync_error", DEMO), [
            {"t": "room_sync_error", "v": 1, "room": DEMO, "code": "room_read_failed"}
        ])
        self.assert_terminal(DEMO, 1, rid="replay-after-repair")
