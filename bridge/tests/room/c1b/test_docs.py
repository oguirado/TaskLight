"""M7: Codex and generic examples across the designated supervisor guides."""
import re
import shlex
import unittest

from .support import ROOT


class DocumentationOracle(unittest.TestCase):
    def examples(self):
        commands = []
        for relative in ("docs/HEADLESS.md", "docs/HARNESS_HOOKS.md"):
            text = (ROOT / relative).read_text(encoding="utf-8").replace("\\\n", " ")
            for line in text.splitlines():
                match = re.search(r"\btasklight\s+run\b.*", line)
                if not match:
                    continue
                try:
                    command = shlex.split(match.group().rstrip("`"))
                except ValueError:
                    continue
                if "--" not in command:
                    continue
                split = command.index("--")
                options, child = command[:split], command[split + 1:]
                if child and "--room" in options and "--agent" in options:
                    commands.append((options, child))
        return commands

    def test_m7_codex_exec_example(self):
        examples = [(options, child) for options, child in self.examples()
                    if child[:2] == ["codex", "exec"] and "--harness" in options
                    and options[options.index("--harness") + 1:][:1] == ["codex"]]
        self.assertTrue(examples, "guides must show tasklight run with --harness codex -- codex exec")

    def test_m7_generic_command_example(self):
        examples = [(options, child) for options, child in self.examples() if child[0] != "codex"]
        self.assertTrue(examples, "guides must show tasklight run with a generic child command")
