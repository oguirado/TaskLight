"""Claude Code PostToolUse hook helper."""
import json, os, unittest

from .support import RoomCase, run_module, file_events, room_dir

MOD = "bridge.room.hook_claude"


def todos(*pairs):
    return [{"content": c, "status": s, "activeForm": c + "ing"} for c, s in pairs]


class Hook(RoomCase):
    def run_hook(self, payload, stdin=None, cwd=None, **env):
        data = stdin if stdin is not None else json.dumps(payload)
        extra = {k: v for k, v in env.items()}
        cp = run_module(MOD, home=self.home, stdin=data, cwd=cwd, **extra)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        self.assertEqual(cp.stdout, b"")
        return cp

    def payload(self, items, sid="s1", tool="TodoWrite", key="todos", cwd=None):
        return {"session_id": sid, "cwd": str(cwd or self.tmp), "hook_event_name": "PostToolUse",
                "tool_name": tool, "tool_input": {key: items}}

    def test_plan_then_steps(self):
        env = dict(CW_ROOM="hr", CW_AGENT="bot")
        self.run_hook(self.payload(todos(("a", "pending"), ("b", "pending"), ("c", "pending"))), **env)
        evs = file_events(self.home, "hr")
        self.assertEqual([e["act"] for e in evs], ["plan"])
        self.assertEqual(evs[0]["agent"], "bot")
        self.assertEqual([s["text"] for s in evs[0]["plan"]["steps"]], ["a", "b", "c"])
        self.run_hook(self.payload(todos(("a", "completed"), ("b", "in_progress"), ("c", "pending"))), **env)
        evs = file_events(self.home, "hr")
        steps = [e["step"] for e in evs if e["act"] == "step"]
        self.assertEqual([e["act"] for e in evs], ["plan", "step", "step"])
        self.assertEqual({(s["index"], s["state"]) for s in steps}, {(0, "done"), (1, "active")})
        self.run_hook(self.payload(todos(("a", "completed"), ("b", "in_progress"), ("c", "pending"))), **env)
        self.assertEqual(len(file_events(self.home, "hr")), 3)           # unchanged -> nothing new
        self.run_hook(self.payload(todos(("a", "completed"), ("b", "completed"), ("c", "pending"))), **env)
        last = file_events(self.home, "hr")[-1]
        self.assertEqual((last["act"], last["step"]["index"], last["step"]["state"]), ("step", 1, "done"))
        self.assertEqual(len(file_events(self.home, "hr")), 4)

    def test_new_session_posts_new_plan(self):
        env = dict(CW_ROOM="hr")
        self.run_hook(self.payload(todos(("a", "pending")), sid="s1"), **env)
        self.run_hook(self.payload(todos(("a", "pending")), sid="s2"), **env)
        self.assertEqual([e["act"] for e in file_events(self.home, "hr")], ["plan", "plan"])

    def test_default_agent_and_room_from_cwd(self):
        proj = self.tmp / "My Project"
        proj.mkdir()
        self.run_hook(self.payload(todos(("a", "pending")), cwd=proj), cwd=proj)
        evs = file_events(self.home, "my-project")
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0]["agent"], "claude-code")

    def test_items_and_text_key_for_other_tools(self):
        items = [{"text": "x1", "status": "pending"}, {"text": "x2", "status": "pending"}]
        self.run_hook(self.payload(items, tool="SomePlanner", key="items"), CW_ROOM="hr")
        evs = file_events(self.home, "hr")
        self.assertEqual([s["text"] for s in evs[0]["plan"]["steps"]], ["x1", "x2"])

    def test_non_plan_tool_ignored(self):
        self.run_hook({"session_id": "s", "cwd": str(self.tmp), "tool_name": "Bash",
                       "tool_input": {"command": "ls"}}, CW_ROOM="hr")
        self.assertEqual(file_events(self.home, "hr"), [])

    def test_garbage_stdin_exits_zero_silently(self):
        for data in (b"", b"not json", b"[1,2]", b"null", b"\xff\xfe\x00", b'{"tool_name":"TodoWrite"}',
                     b'{"tool_name":"TodoWrite","tool_input":{"todos":"x"}}',
                     b'{"tool_name":"TodoWrite","tool_input":{"todos":[1,2]}}', b"{" * 5000):
            self.run_hook(None, stdin=data, CW_ROOM="hr")
        self.assertEqual(file_events(self.home, "hr"), [])

    def test_errors_go_to_log_never_stdout(self):
        room_dir(self.home, "hr").mkdir(parents=True)
        self.run_hook(self.payload(todos(("a", "pending"))), CW_ROOM="hr", CW_AGENT="BAD AGENT")
        log = room_dir(self.home, "hr") / "hook.log"
        self.assertTrue(log.exists())
        self.assertGreater(log.stat().st_size, 0)
        self.assertEqual(file_events(self.home, "hr"), [])

    def test_log_is_capped_at_256_kib(self):
        d = room_dir(self.home, "hr")
        d.mkdir(parents=True)
        (d / "hook.log").write_bytes(b"x" * (256 * 1024))
        for _ in range(3):
            self.run_hook(self.payload(todos(("a", "pending"))), CW_ROOM="hr", CW_AGENT="BAD AGENT")
        self.assertLessEqual((d / "hook.log").stat().st_size, 256 * 1024)


if __name__ == "__main__":
    unittest.main()
