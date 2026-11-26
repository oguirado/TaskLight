"""Claude Code PostToolUse hook helper."""
import json, os, unittest
from types import SimpleNamespace
from unittest import mock

from bridge.room import hook_claude

from .support import RoomCase, run_module, run_py, file_events, room_dir

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

    def test_todo_hook_uses_windows_exclusive_lock_without_fcntl(self):
        code = """
import io
import os
import runpy
# Load subprocess before the fake msvcrt module can affect its platform detection.
import subprocess
import sys
from types import SimpleNamespace

calls = []
def locking(fd, mode, count):
    assert count == 1 and os.lseek(fd, 0, os.SEEK_CUR) == 0
    calls.append((mode, fd))

sys.modules["fcntl"] = None
sys.modules["msvcrt"] = SimpleNamespace(
    LK_LOCK="lock", LK_NBLCK="lock", LK_UNLCK="unlock", locking=locking)
os.environ["CW_ROOM"] = "hr"
sys.stdin = SimpleNamespace(buffer=io.BytesIO(sys.argv[2].encode()))
module = sys.argv[1]
sys.argv = [module]
try:
    runpy.run_module(module, run_name="__main__")
except SystemExit as exc:
    assert exc.code == 0, exc.code

assert [mode for mode, _ in calls] == ["lock", "lock", "unlock", "unlock"], calls
_, hook_fd = calls[0]
_, journal_fd = calls[1]
assert hook_fd != journal_fd and calls[2:] == [
    ("unlock", journal_fd), ("unlock", hook_fd)], calls
"""
        payload = json.dumps(self.payload(todos(("a", "pending"))))
        cp = run_py(code, MOD, payload, home=self.home)
        self.assertEqual(cp.returncode, 0, cp.stderr.decode())
        self.assertEqual(cp.stdout, b"")
        self.assertEqual([e["act"] for e in file_events(self.home, "hr")], ["plan"])
        state = room_dir(self.home, "hr") / "hook_state.json"
        self.assertEqual(json.loads(state.read_text(encoding="utf-8")),
                         {"s1": {"statuses": ["pending"], "texts": ["a"]}})

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

    def test_log_and_state_open_in_binary_mode(self):
        native_binary = getattr(os, "O_BINARY", 0)
        binary_flag = native_binary or (1 << 30)
        platform_os = SimpleNamespace(**vars(os))
        platform_os.O_BINARY = binary_flag

        def open_path(path, flags, mode):
            return os.open(path, flags if native_binary else flags & ~binary_flag, mode)

        directory = room_dir(self.home, "hr")
        directory.mkdir(parents=True)
        (directory / "hook.log").write_bytes(b"x" * hook_claude.LOG_CAP)
        with mock.patch.dict(os.environ, {"CW_HOME": str(self.home)}), \
             mock.patch.object(hook_claude, "os", platform_os), \
             mock.patch.object(platform_os, "open", side_effect=open_path) as opened:
            hook_claude._log("hr", "entry")
            hook_claude._save_state("hr", {"s1": {}})

        self.assertEqual([call.args[1] for call in opened.call_args_list], [
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC | binary_flag,
            os.O_WRONLY | os.O_CREAT | os.O_APPEND | binary_flag,
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC | binary_flag,
        ])

    def test_log_is_capped_at_256_kib(self):
        d = room_dir(self.home, "hr")
        d.mkdir(parents=True)
        (d / "hook.log").write_bytes(b"x" * (256 * 1024))
        for _ in range(3):
            self.run_hook(self.payload(todos(("a", "pending"))), CW_ROOM="hr", CW_AGENT="BAD AGENT")
        self.assertLessEqual((d / "hook.log").stat().st_size, 256 * 1024)


if __name__ == "__main__":
    unittest.main()
