"""Unknown room floors must preserve the private admission boundary."""
import contextlib
import io
import unittest
from unittest.mock import patch

from bridge.tests.wall.u80.test_room_policy import InlineThread
from bridge.wall import model_relay


class RoomFloorRepair2(unittest.TestCase):
    def ask(self, floors, *, room=None, tier="standard", local=False, allow_private=False):
        frames, calls = [], []
        endpoint = {
            "id": "fixture", "kind": "local-openai-compatible" if local else
            "remote-openai-compatible", "model": "fixture", "enabled": True,
            "allow_private": allow_private,
        }
        frame = {
            "t": "model_generate", "v": 1, "rid": "request", "id": "fixture",
            "tier": tier, "messages": [{"role": "user", "content": "body-canary"}],
            "max_tokens": 32, "rung": 2,
        }
        if room is not None:
            frame["room"] = room

        def generate(*args):
            calls.append(args)
            return "reply-canary"

        log = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(model_relay._store, "load", return_value={
                "endpoints": [endpoint], "keys": {"fixture": "key-canary"}}))
            stack.enter_context(patch.object(model_relay._transport, "generate", side_effect=generate))
            stack.enter_context(patch.object(model_relay.threading, "Thread", InlineThread))
            stack.enter_context(contextlib.redirect_stderr(log))
            relay = model_relay.ModelRelay({}, frames.append, room_floors=floors)
            try:
                self.assertEqual(relay.handle(frame), 0)
                relay.poll()
            finally:
                relay.close()
        for canary in ("body-canary", "reply-canary", "key-canary"):
            self.assertNotIn(canary, log.getvalue())
        return frames, calls

    def check(self, floors, *, admitted=False, **kwargs):
        frames, calls = self.ask(floors, **kwargs)
        if admitted:
            self.assertEqual(len(calls), 1)
            self.assertEqual(frames, [{"t": "model_result", "v": 1, "rid": "request",
                                       "text": "reply-canary"}])
        else:
            self.assertEqual(calls, [], "policy denial must precede transport")
            self.assertEqual(frames, [{"t": "model_nack", "v": 1, "rid": "request",
                                       "code": "policy"}])

    def test_unknown_floor_without_room_denies_remote(self):
        self.check({"demo": "unknown"})

    def test_unknown_floor_with_room_denies_remote(self):
        self.check({"demo": "unknown"}, room="demo")

    def test_non_dict_config_denies_every_remote_tier(self):
        for tier in ("standard", "shared", "private"):
            for room in (None, "demo"):
                with self.subTest(tier=tier, room=room):
                    self.check("bogus", tier=tier, room=room)

    def test_non_dict_config_requires_local_private_opt_in(self):
        self.check("bogus", local=True)
        self.check("bogus", local=True, allow_private=True, admitted=True)

    def test_unrecognized_floor_values_require_private_opt_in(self):
        for floor in ("unknown", None, False, 0, [], {}):
            for room in (None, "demo"):
                with self.subTest(floor=floor, room=room):
                    self.check({"demo": floor}, room=room, local=True)
                    self.check({"demo": floor}, room=room, local=True,
                               allow_private=True, admitted=True)

    def test_valid_maps_keep_existing_policy(self):
        self.check({"demo": "private", "work": "standard"})
        self.check({"demo": "private", "work": "standard"}, room="demo")
        self.check({"demo": "private", "work": "standard"}, room="work", admitted=True)
        self.check({"work": "standard"}, admitted=True)
        self.check({"work": "standard"}, room="work", tier="private")
        self.check({"team": "shared"}, room="team")
        self.check({"team": "shared"}, room="team", local=True, admitted=True)
        self.check({"demo": "ONLY_ON_DEVICE"})
        self.check({"work": "PREFER_ON_DEVICE"}, room="work", admitted=True)
        self.check({}, admitted=True)
        self.check(None, admitted=True)
