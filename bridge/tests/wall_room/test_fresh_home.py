"""A fresh home (config present, no room directory yet) works end to end.

The wall relay resolves its home from the environment when none is passed, the
way the native host builds it. The checked room reader is the only journal
boundary: prime, live poll and replay must consume it even for a room that was
never written. A reader fault on the initial cursor with no room directory is
a healthy empty room; any other fault is reported. Posts stay gated on the
room directory (covered by the U37a post tests).
"""
import os
import unittest
from unittest import mock

from bridge.room import store
from . import support as S


class FreshHomeReader(S.Base):
    """Relay built like the native host: no explicit home, fresh CW_HOME."""

    def relay(self, rooms=(("demo", "private"),)):
        rc = self.cfg(rooms=rooms)
        return self.mod().RoomRelay(rc, self.send, clock=self.clock)

    def fake_reader(self, calls):
        def read(room, since=0, *, home=None):
            calls.append((room, since))
            if since < 1:
                return [S.event(1, room=room, act="heartbeat")], 0
            return [], 0
        return read

    def test_prime_consumes_the_checked_reader_on_a_never_written_room(self):
        r = self.relay()
        calls = []
        with mock.patch.object(store, "read_checked", side_effect=self.fake_reader(calls)):
            r.prime()
        self.assertEqual(calls, [("demo", 0)],
                         "startup must consult the room reader even without a room directory")
        self.assertEqual(r.stats()["events_sent"], 0)

    def test_poll_delivers_events_for_a_never_written_room(self):
        r = self.relay()
        with mock.patch.object(store, "read_checked",
                               side_effect=self.fake_reader([])):
            self.assertEqual(r.poll(), 1)
        frames = self.send.of("room_event")
        self.assertEqual(len(frames), 1)
        self.assertEqual((frames[0]["t"], frames[0]["v"], frames[0]["room"], frames[0]["floor"]),
                         ("room_event", 1, "demo", "ONLY_ON_DEVICE"))
        self.assertEqual(frames[0]["event"]["lamport"], 1)
        self.assertEqual(os.listdir(self.home), [], "poll never creates directories")

    def test_replay_of_a_never_written_room_reads_through_the_reader(self):
        r = self.relay()
        with mock.patch.object(store, "read_checked",
                               side_effect=self.fake_reader([])):
            self.assertEqual(r.handle({"t": "room_sync", "v": 1, "rid": "fh",
                                       "since": {"demo": 0}}), 0)
        kinds = [f["t"] for f in self.send.frames]
        self.assertEqual(kinds, ["room_event", "room_synced"])
        self.assertEqual(self.send.of("room_synced")[0],
                         {"t": "room_synced", "v": 1, "rid": "fh", "room": "demo",
                          "upto": 1, "more": False})


class FreshHomeHealthyEmpty(S.Base):
    """Real store, no mocks: the wall-side contract on a fresh home."""

    def relay(self, rooms=(("demo", "private"),)):
        rc = self.cfg(rooms=rooms)
        return self.mod().RoomRelay(rc, self.send, clock=self.clock)

    def test_startup_and_poll_of_a_fresh_home_are_healthy_and_empty(self):
        r = self.relay()
        r.prime()
        self.assertEqual(r.poll(), 0)
        self.assertEqual(self.send.frames, [], "a never-written room is not a broken journal")
        self.assertEqual(os.listdir(self.home), [])

    def test_replay_of_a_fresh_home_is_certified_empty(self):
        r = self.relay()
        self.assertEqual(r.handle({"t": "room_sync", "v": 1, "rid": "fh",
                                   "since": {"demo": 0}}), 0)
        self.assertEqual(self.send.frames, [
            {"t": "room_synced", "v": 1, "rid": "fh", "room": "demo", "upto": 0, "more": False}])
        self.assertEqual(r.stats()["events_sent"], 0)

    def test_nonzero_cursor_on_a_fresh_home_is_not_certified(self):
        r = self.relay()
        self.assertEqual(r.handle({"t": "room_sync", "v": 1, "rid": "fh",
                                   "since": {"demo": 7}}), 0)
        self.assertEqual(self.send.frames, [
            {"t": "room_sync_error", "v": 1, "room": "demo",
             "code": "room_read_failed", "rid": "fh"}])

    def test_existing_room_directory_without_journal_still_faults(self):
        r = self.relay()
        os.makedirs(os.path.join(self.home, "rooms", "demo"))
        self.assertEqual(r.handle({"t": "room_sync", "v": 1, "rid": "fh",
                                   "since": {"demo": 0}}), 0)
        self.assertEqual(self.send.frames, [
            {"t": "room_sync_error", "v": 1, "room": "demo",
             "code": "room_read_failed", "rid": "fh"}])


if __name__ == "__main__":
    unittest.main()
