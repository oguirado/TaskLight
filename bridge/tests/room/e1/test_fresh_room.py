"""E1: a room that was allowlisted but never written is a healthy empty room, not a broken journal.

The relay reads an allowlisted room whose directory does not exist yet. That is the normal state
right after installation, before any agent writes. It must not raise a read fault, and once the
first events land they must be delivered live. A missing journal inside an existing room directory
keeps the c5b contract and still faults.
"""

from pathlib import Path
import tempfile
import unittest

from bridge.tests.room.c5a.support import encoded, record
from bridge.wall import room_relay


DEMO, OTHER = "demo", "other"
RID = "fresh-room"
FLOOR = "ONLY_ON_DEVICE"


class FreshRoom(unittest.TestCase):
    def setUp(self):
        self.runtime = Path(self.enterContext(
            tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)))
        self.frames = []
        self.relay = room_relay.RoomRelay(
            {"rooms": [{"room": room, "floor": FLOOR} for room in (DEMO, OTHER)],
             "agent": "wall-user"},
            self.frames.append, home=self.runtime, clock=lambda: 100.0,
        )
        self.journal(OTHER).parent.mkdir(parents=True, exist_ok=True)
        self.journal(OTHER).write_bytes(encoded(record(room=OTHER, lamport=1)))

    def journal(self, room):
        return self.runtime / "rooms" / room / "events.jsonl"

    def of_type(self, kind, room):
        return [f for f in self.frames if f.get("room") == room and f["t"] == kind]

    def lamports(self, room):
        return [f["event"]["lamport"] for f in self.of_type("room_event", room)]

    def write(self, room, *lamports):
        path = self.journal(room)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("ab") as stream:
            stream.write(b"".join(encoded(record(room=room, lamport=n)) for n in lamports))

    def test_replay_of_a_room_never_written_is_healthy_and_empty(self):
        self.relay.handle({"t": "room_sync", "v": 1, "rid": RID, "since": {DEMO: 0, OTHER: 0}})
        self.assertEqual(self.of_type("room_sync_error", DEMO), [],
                         "a room that was never written is not a broken journal")
        self.assertEqual(self.of_type("room_synced", DEMO), [
            {"t": "room_synced", "v": 1, "room": DEMO, "rid": RID, "upto": 0, "more": False}])
        self.assertEqual(self.lamports(DEMO), [])
        self.assertEqual([f["upto"] for f in self.of_type("room_synced", OTHER)], [1])

    def test_prime_and_poll_of_a_room_never_written_do_not_fault_and_deliver_later_writes(self):
        self.relay.prime()
        self.relay.poll()
        self.assertEqual(self.of_type("room_sync_error", DEMO), [],
                         "startup of a fresh installation must not report a read fault")
        self.write(DEMO, 1, 2)
        self.relay.poll()
        self.assertEqual(self.lamports(DEMO), [1, 2],
                         "once the room is written its events must arrive live, without a reload")
        self.assertEqual(self.of_type("room_sync_error", DEMO), [])
        self.assertEqual(self.lamports(OTHER), [],
                         "a fresh room must not make the relay deliver a peer room's history again")
        self.relay.handle({"t": "room_sync", "v": 1, "rid": RID, "since": {DEMO: 0}})
        self.assertEqual(self.lamports(DEMO), [1, 2, 1, 2])

    def test_missing_journal_inside_an_existing_room_directory_still_faults(self):
        self.journal(DEMO).parent.mkdir(parents=True, exist_ok=True)
        self.relay.handle({"t": "room_sync", "v": 1, "rid": RID, "since": {DEMO: 0}})
        self.assertEqual(self.of_type("room_sync_error", DEMO), [
            {"t": "room_sync_error", "v": 1, "room": DEMO, "code": "room_read_failed", "rid": RID}])
        self.assertEqual(self.of_type("room_synced", DEMO), [],
                         "a lost journal in an existing room cannot be certified as complete")

    def test_nonzero_cursor_on_a_room_never_written_is_not_certified(self):
        self.relay.handle({"t": "room_sync", "v": 1, "rid": RID, "since": {DEMO: 7}})
        self.assertEqual(self.of_type("room_synced", DEMO), [],
                         "a cursor past events the host never saw cannot be certified on a fresh room")
        self.assertEqual(self.of_type("room_sync_error", DEMO), [
            {"t": "room_sync_error", "v": 1, "room": DEMO, "code": "room_read_failed", "rid": RID}])


if __name__ == "__main__":
    unittest.main()
