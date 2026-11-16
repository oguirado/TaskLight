"""Repair loop 1 regressions from the cross-family review of U33 (see ORACLE.md "Repair loop 1")."""
import json, math, subprocess, sys, threading, time, unittest

from .support import RoomCase, canon, events_path, mk_event, run_cli, run_py, seed


def _store():
    from bridge.room import store
    return store


class R1Lamport(RoomCase):
    def test_lamport_ignores_nested_or_textual_lamport(self):
        seed(self.home, "r1", events=[mk_event(1, text='payload "lamport":900 inside text')])
        ev = self.post()
        self.assertEqual(ev["lamport"], 2)

    def test_plan_step_unknown_keys_refused(self):
        store = _store()
        with self.assertRaises(store.RoomError) as cm:
            self.post(act="plan", text="p", plan={"title": "T", "steps": [{"text": "s", "lamport": 900}]})
        self.assertEqual(cm.exception.code, "bad_plan")
        self.assertEqual(self.post()["lamport"], 1)


class R2TornTail(RoomCase):
    def test_complete_fragment_without_newline_never_duplicates_order(self):
        seed(self.home, "r1", raw_tail=canon(mk_event(1)).encode("utf-8"))
        ev = self.post()
        events, _ = _store().read("r1", home=self.home)
        lamports = [e["lamport"] for e in events]
        self.assertEqual(lamports, sorted(set(lamports)), "lamports must be unique and increasing")
        self.assertEqual(ev["lamport"], max(lamports))
        self.assertIn(ev["id"], [e["id"] for e in events])


class R3NonFiniteTiming(RoomCase):
    def _call_bounded(self, fn):
        box = {}
        def run():
            try:
                box["r"] = fn()
            except Exception as e:  # noqa: BLE001
                box["e"] = e
        t = threading.Thread(target=run, daemon=True)
        t.start(); t.join(5)
        self.assertFalse(t.is_alive(), "call must not stall")
        return box

    def test_store_wait_rejects_nan_inf_negative(self):
        self.post()
        store = _store()
        for bad in (float("nan"), float("inf"), -1.0):
            box = self._call_bounded(lambda: store.wait("r1", 0, timeout_s=bad, home=self.home, act="question"))
            self.assertIn("e", box, f"timeout_s={bad} must be rejected")
        box = self._call_bounded(lambda: store.wait("r1", 0, timeout_s=0.2, poll_s=float("nan"), home=self.home, act="question"))
        self.assertIn("e", box, "poll_s=nan must be rejected")

    def test_cli_wait_nan_refused_quickly(self):
        self.post()
        t0 = time.monotonic()
        cp = run_cli(["wait", "--room", "r1", "--timeout", "nan"], self.home, timeout=10)
        self.assertLess(time.monotonic() - t0, 8)
        self.assertEqual(cp.returncode, 2)


class R4TypeErrors(RoomCase):
    def test_non_string_act_is_bad_act(self):
        store = _store()
        with self.assertRaises(store.RoomError) as cm:
            self.post(act=[])
        self.assertEqual(cm.exception.code, "bad_act")

    def test_non_string_step_state_is_bad_step(self):
        store = _store()
        with self.assertRaises(store.RoomError) as cm:
            self.post(act="step", text="s", step={"index": 0, "state": []})
        self.assertEqual(cm.exception.code, "bad_step")


class R5Slugs(RoomCase):
    def test_trailing_newline_room_and_agent_refused(self):
        store = _store()
        with self.assertRaises(store.RoomError) as cm:
            self.post(room="r1\n")
        self.assertEqual(cm.exception.code, "bad_room")
        with self.assertRaises(store.RoomError) as cm:
            self.post(agent="a1\n")
        self.assertEqual(cm.exception.code, "bad_agent")


HOOK = r"""
import io, json, sys, runpy
sys.stdin = io.TextIOWrapper(io.BytesIO(sys.argv[1].encode()))
sys.argv = ["hook"]
try:
    runpy.run_module("bridge.room.hook_claude", run_name="__main__")
except SystemExit:
    pass
"""


class R6HookRaces(RoomCase):
    def test_concurrent_hooks_one_plan_per_session(self):
        import os
        procs = []
        for i in range(8):
            sid = f"s{i % 4}"
            payload = {"session_id": sid, "cwd": str(self.tmp), "hook_event_name": "PostToolUse", "tool_name": "TodoWrite",
                       "tool_input": {"todos": [{"content": "a", "status": "pending", "activeForm": "a"},
                                                {"content": "b", "status": "pending", "activeForm": "b"}]}}
            env = dict(os.environ, CW_HOME=str(self.home), CW_ROOM="race", CW_AGENT="bot",
                       PYTHONPATH=str(__import__("pathlib").Path(__file__).resolve().parents[3]))
            procs.append(subprocess.Popen([sys.executable, "-c", HOOK, json.dumps(payload)], env=env,
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE))
        for p in procs:
            out, _ = p.communicate(timeout=30)
            self.assertEqual(p.returncode, 0)
            self.assertEqual(out, b"")
        events, malformed = _store().read("race", home=self.home)
        self.assertEqual(malformed, 0)
        plans = [e for e in events if e["act"] == "plan"]
        self.assertEqual(len(plans), 4, "exactly one plan per session id under concurrency")


if __name__ == "__main__":
    unittest.main()
