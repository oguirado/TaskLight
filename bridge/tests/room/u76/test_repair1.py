"""Regression coverage for optional planning contract argument validation."""
import contextlib
import io
import json
import unittest
from unittest.mock import patch

from bridge.room import mcp


class PlanningContractRepairTests(unittest.TestCase):
    def prompt(self, arguments):
        output = io.StringIO()
        with patch.object(mcp, "_contract_prompt_body", return_value="Contract text."), \
                contextlib.redirect_stdout(output):
            mcp._handle(1, "prompts/get", {
                "name": "planning_contract", "arguments": arguments,
            })
        return json.loads(output.getvalue())

    def assert_invalid(self, arguments):
        reply = self.prompt(arguments)
        self.assertIn("error", reply)
        self.assertEqual(reply["error"]["code"], -32602)

    def test_null_room_rejected(self):
        self.assert_invalid({"room": None})

    def test_null_agent_rejected(self):
        self.assert_invalid({"agent": None})

    def test_null_room_and_agent_rejected(self):
        self.assert_invalid({"room": None, "agent": None})

    def test_omitted_keys_return_body_without_suffix(self):
        reply = self.prompt({})
        self.assertNotIn("error", reply)
        self.assertEqual(reply["result"]["messages"][0]["content"]["text"],
                         "Contract text.")

    def test_valid_room_and_agent_append_suffix(self):
        reply = self.prompt({"room": "demo", "agent": "a1"})
        self.assertNotIn("error", reply)
        self.assertEqual(reply["result"]["messages"][0]["content"]["text"],
                         "Contract text.\nRoom: demo. Agent: a1.")
