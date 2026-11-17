"""M7: the dedicated guide documents the complete cursor-driven loop."""
import re
import unittest
from .support import ROOT


class DocumentationOracle(unittest.TestCase):
    def test_m7_wait_agents_guide_contains_launch_wait_cursor_and_completion_loop(self):
        path = ROOT / "docs/WAIT_AGENTS.md"
        self.assertTrue(path.is_file(), "M7 docs/WAIT_AGENTS.md must document the orchestrator loop")
        text = path.read_text(encoding="utf-8")
        self.assertRegex(text, r"tasklight\s+run\b")
        for flag in ("--parent", "--result-file"):
            self.assertIn(flag, text)
        self.assertIn("wait_agents", text)
        self.assertTrue("--since" in text or "since_lamport" in text)
        self.assertIn("cursor", text)
        self.assertRegex(text.lower(), r"\b(while|until|loop)\b")
        self.assertRegex(text.lower(), r"\b(finished|ended|terminal|remaining|pending)\b")
