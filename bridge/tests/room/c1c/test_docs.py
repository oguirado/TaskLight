"""Documentation acceptance without editing the documentation surface."""
import re
import unittest

from .support import ROOT


class DocumentationOracle(unittest.TestCase):
    def test_m8_native_adapter_setup_is_documented_in_at_most_six_steps(self):
        text = (ROOT / "docs" / "HARNESS_HOOKS.md").read_text(encoding="utf-8")
        heading = re.search(r"^##\s+Claude Code native adapter\s*$", text, re.MULTILINE)
        self.assertIsNotNone(heading, "M8 missing Claude Code native adapter section")
        section = text[heading.end():]
        section = re.split(r"\n##\s+", section, maxsplit=1)[0]
        for term in ("--print-settings", "TASKLIGHT_ROOM", ".tasklight.json", "CW_HOME"):
            with self.subTest(term=term):
                self.assertIn(term, section)
        steps = re.findall(r"^\s*\d+[.)]\s+", section, re.MULTILINE)
        self.assertLessEqual(len(steps), 6)
        self.assertRegex(section.lower(), r"never|not recorded|not stored|not persisted")
        concepts = (
            r"session[_ /-]?(?:id|identif)", r"agent[_ /-]?(?:id|identif)", r"prompt",
            r"tool[_ /-]?input", r"tool[_ /-]?(?:response|output)", r"transcript",
            r"(?:last[_ /-]?)?assistant[_ /-]?message",
        )
        for concept in concepts:
            with self.subTest(privacy=concept):
                self.assertRegex(section.lower(), concept)

    def test_m8_desktop_setup_explains_how_to_enable_native_adapter(self):
        text = (ROOT / "docs" / "DESKTOP_SETUP.md").read_text(encoding="utf-8")
        self.assertRegex(text, r"hook_claude_native|Claude Code native adapter",
                         "M8 missing native adapter setup paragraph")
        paragraphs = re.split(r"\n\s*\n", text)
        self.assertTrue(any(("hook_claude_native" in paragraph or "Claude Code native adapter" in paragraph) and
                            ("HARNESS_HOOKS" in paragraph or "--print-settings" in paragraph)
                            for paragraph in paragraphs), "setup must link instructions or show the settings entry")
