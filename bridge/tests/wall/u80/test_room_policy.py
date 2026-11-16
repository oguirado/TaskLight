"""U80 admission oracle. No sockets, disk stores, worker threads, or wall clocks."""
import contextlib
import io
import json
import unittest
from unittest.mock import patch
from bridge.wall import native_host, model_relay


class InlineThread:
    def __init__(self, target, **kwargs):
        self.target = target
        self.args = kwargs.get("args", ())
    def start(self):
        self.target(*self.args)
    def is_alive(self):
        return False
    def join(self, *args):
        pass


class RoomPolicy(unittest.TestCase):
    def ask(self, *, rooms=(("demo", "private"), ("work", "standard")),
            room="demo", tier="standard", local=False, allow_private=False, extra=None):
        frames, calls = [], []
        cfg = {"models": {}}
        if rooms:
            cfg["rooms"] = {"agent": "oracle", "allow": [
                {"room": name, "tier": floor} for name, floor in rooms]}
        endpoint = {"id": "fixture", "kind": "local-openai-compatible" if local else
                    "remote-openai-compatible", "model": "fixture", "label": "Fixture",
                    "enabled": True, "allow_private": allow_private}
        frame = {"t": "model_generate", "v": 1, "rid": "request", "id": "fixture",
                 "tier": tier, "messages": [{"role": "user", "content": "body-canary"}],
                 "max_tokens": 32, "rung": 2}
        if room is not None:
            frame["room"] = room
        if extra:
            frame.update(extra)
        log = io.StringIO()
        def generate(*args):
            calls.append(args)
            return "reply-canary"
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(model_relay._store, "load", return_value={
                "endpoints": [endpoint], "keys": {"fixture": "key-canary"}}))
            stack.enter_context(patch.object(model_relay._transport, "generate", side_effect=generate))
            stack.enter_context(patch.object(model_relay.threading, "Thread", InlineThread))
            stack.enter_context(patch.object(model_relay.time, "monotonic", return_value=1.0))
            stack.enter_context(contextlib.redirect_stderr(log))
            relay = native_host._build_model_relay(cfg, frames.append)
            self.assertIsNotNone(relay, "host must build a functioning model relay")
            try:
                rc = relay.handle(frame)
                relay.poll()
            finally:
                relay.close()
        return rc, frames, calls, log.getvalue()

    def denied(self, **kwargs):
        rc, frames, calls, log = self.ask(**kwargs)
        self.assertEqual(frames, [{"t": "model_nack", "v": 1, "rid": "request", "code": "policy"}],
                         "room policy must produce a policy nack, not structural rejection or admission")
        self.assertEqual(rc, 0)
        self.assertEqual(calls, [], "denied content must never reach transport")
        for canary in ("body-canary", "reply-canary", "key-canary", "demo", "ghost"):
            self.assertNotIn(canary, log)
        return log

    def admitted(self, **kwargs):
        rc, frames, calls, log = self.ask(**kwargs)
        self.assertEqual(len(calls), 1, "valid allowed room must reach injected transport")
        self.assertEqual(rc, 0)
        self.assertEqual(frames, [{"t": "model_result", "v": 1, "rid": "request", "text": "reply-canary"}])
        for canary in ("body-canary", "reply-canary", "key-canary"):
            self.assertNotIn(canary, log)

    def test_A1_private_floor_denies_remote(self):
        self.denied()
    def test_A1_standard_floor_admits_remote(self):
        self.admitted(room="work")
    def test_A1_declared_private_wins(self):
        self.denied(room="work", tier="private")
    def test_A2_missing_room_uses_strictest(self):
        self.denied(room=None)
    def test_A2_only_standard_admits(self):
        self.admitted(room=None, rooms=(("work", "standard"),))
    def test_A2_floor_order_independent(self):
        self.denied(room=None, rooms=(("work", "standard"), ("demo", "private")))
    def test_A3_unknown_room_denies(self):
        self.denied(room="ghost")
    def test_A3_unknown_room_local_opt_in_denies(self):
        self.denied(room="ghost", local=True, allow_private=True)
    def test_A3_unknown_room_without_config_denies(self):
        self.denied(room="ghost", rooms=())
    def test_A4_local_private_opt_in_admits(self):
        self.admitted(local=True, allow_private=True)
    def test_A4_local_without_opt_in_denies(self):
        self.denied(local=True)
    def test_M3_declared_shared_denies_remote(self):
        self.denied(room="work", tier="shared")
    def test_M3_shared_cannot_weaken_private_floor(self):
        self.denied(tier="shared", local=True)
    def test_M3_shared_local_standard_floor_admits(self):
        self.admitted(room="work", tier="shared", local=True)
    def test_M5_empty_config_preserves_standard(self):
        self.admitted(room=None, rooms=())
    def test_M5_empty_config_preserves_private_denial(self):
        self.denied(room=None, rooms=(), tier="private")
    def test_M5_missing_room_local_requires_opt_in(self):
        self.denied(room=None, local=True)
    def test_M5_missing_room_local_opt_in_admits(self):
        self.admitted(room=None, local=True, allow_private=True)
    def test_M1_malformed_room_is_structural(self):
        for room in ("../x", 7, "", "A", "a" * 49, "demo\n", [], {}):
            with self.subTest(room=room):
                rc, frames, calls, _ = self.ask(room=room)
                self.assertEqual(rc, 2)
                self.assertEqual(frames, [])
                self.assertEqual(calls, [])
    def test_M1_explicit_null_room_is_structural(self):
        rc, frames, calls, _ = self.ask(extra={"room": None})
        self.assertEqual((rc, frames, calls), (2, [], []))
    def test_M1_unknown_keys_still_rejected(self):
        rc, frames, calls, _ = self.ask(room=None, extra={"surprise": True})
        self.assertEqual((rc, frames, calls), (2, [], []))
    def test_M7_denial_log_uses_policy(self):
        log = self.denied()
        if log:
            self.assertIn("policy", log)
