"""C1cq (C1c review debts 1-2): odd sub-agent types never hide a sub-agent; a null agent_id is the main session."""
import unittest

from bridge.room.hook_claude_native import _lifecycle

BASE = {"session_id": "sess-1", "cwd": "/tmp"}


def life(**kw):
    out = _lifecycle(dict(BASE, **kw))
    return None if out is None else out[1]


class IdentityFallbacks(unittest.TestCase):
    def test_punctuation_only_type_still_registers_child_with_parent(self):
        v = life(hook_event_name="SubagentStart", agent_id="a-1", agent_type="***")
        self.assertIsNotNone(v)
        self.assertTrue(v["agent"].startswith("agent-"))
        self.assertTrue(v["parent_agent"].startswith("cc-"))

    def test_non_ascii_type_still_registers_child(self):
        v = life(hook_event_name="SubagentStart", agent_id="a-2", agent_type="рецензент")
        self.assertIsNotNone(v)
        self.assertTrue(v["agent"].startswith("agent-"))

    def test_missing_type_still_registers_child(self):
        v = life(hook_event_name="SubagentStop", agent_id="a-3")
        self.assertIsNotNone(v)
        self.assertEqual(v["state"], "finished")

    def test_same_child_keeps_identity_across_start_and_stop(self):
        a = life(hook_event_name="SubagentStart", agent_id="a-4", agent_type="***")
        b = life(hook_event_name="SubagentStop", agent_id="a-4", agent_type="***")
        self.assertEqual((a["agent"], a["run_id"]), (b["agent"], b["run_id"]))

    def test_null_agent_id_on_tool_event_is_the_main_session(self):
        v = life(hook_event_name="PreToolUse", agent_id=None, tool_name="Read", tool_use_id="t1")
        self.assertIsNotNone(v)
        self.assertTrue(v["agent"].startswith("cc-"))


if __name__ == "__main__":
    unittest.main()
