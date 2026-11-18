"""CL M8 documentation contract."""
import unittest

from .support import ROOT


class DocumentationOracle(unittest.TestCase):
    def test_m8_wave_guide_documents_manifest_reasons_and_orchestrator_loop(self):
        guide = ROOT / "docs/WAVES.md"
        self.assertTrue(guide.is_file(), "missing docs/WAVES.md")
        text = guide.read_text(encoding="utf-8")
        self.assertRegex(text, r"\bwave\s+--manifest\b")
        for field in ("room", "parent", "parent_run", "lanes", "agent", "run_id",
                      "argv", "result_file", "harness", "wall_s"):
            with self.subTest(field=field):
                self.assertRegex(text, rf"\b{field}\b")
        for reason in ("exit:", "signal:", "wrapper:SIGTERM", "wrapper:SIGINT",
                       "wall_timeout"):
            with self.subTest(reason=reason):
                self.assertIn(reason, text)
        self.assertRegex(text.lower(), r"\bbackground\b|[^\n]&\s*(?:\n|$)")
        self.assertRegex(text, r"\bwait_agents\b")
        self.assertRegex(text, r"\bunit_decide\b")
