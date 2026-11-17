"""SPEC_CX M4/M6: executable settings and their public setup documentation."""

import re

from .support import EVENTS, IGNORED, MODULE, ROOT, NativeCase


class SettingsOracle(NativeCase):
    def test_m4_settings_have_exact_mapped_events_and_codex_handler_shape(self):
        settings = self.settings()
        self.assertEqual(set(settings), {"hooks"})
        self.assertEqual(set(settings["hooks"]), set(EVENTS))
        for event, groups in settings["hooks"].items():
            self.assertIsInstance(groups, list)
            self.assertEqual(len(groups), 1)
            self.assertIsInstance(groups[0], dict)
            handlers = groups[0]["hooks"]
            self.assertIsInstance(handlers, list)
            self.assertEqual(len(handlers), 1)
            self.assertEqual(handlers[0]["type"], "command")
            self.assertEqual(handlers[0]["command"], "python3 -m " + MODULE)

    def test_m4_session_end_and_interrupt_are_synchronous_with_timeout_three(self):
        hooks = self.settings()["hooks"]
        for event in ("SessionEnd", "Interrupt"):
            handler = hooks[event][0]["hooks"][0]
            self.assertEqual(handler["timeout"], 3)
            self.assertNotIn("async", handler, "terminal/interrupt settings omit async")

    def test_m4_other_events_are_async_with_timeout_ten(self):
        hooks = self.settings()["hooks"]
        for event in set(EVENTS) - {"SessionEnd", "Interrupt"}:
            handler = hooks[event][0]["hooks"][0]
            self.assertIs(handler["async"], True)
            self.assertEqual(handler["timeout"], 10)

    def test_m4_ignored_events_are_not_installed(self):
        hooks = self.settings()["hooks"]
        self.assertTrue(set(IGNORED).isdisjoint(hooks))

    def test_m4_print_settings_is_silent_on_stderr_and_does_not_read_or_install(self):
        self.assertIsInstance(self.settings(), dict)


class DocumentationOracle(NativeCase):
    def codex_section(self):
        # Exercise the documented command first. M6 remains red on the missing
        # executable behavior, rather than passing against stale prose.
        self.settings()
        document = (ROOT / "docs" / "HARNESS_HOOKS.md").read_text(encoding="utf-8")
        headers = list(re.finditer(r"(?m)^(#{1,6})\s+.*Codex[^\n]*$", document))
        self.assertTrue(headers, "M6 requires a Codex section in docs/HARNESS_HOOKS.md")
        header = headers[0]
        following = re.search(r"(?m)^#{1,%d}\s" % len(header[1]), document[header.end():])
        end = header.end() + following.start() if following else len(document)
        return document[header.start():end]

    def test_m6_documented_settings_command_and_configuration_locations(self):
        section = self.codex_section()
        self.assertIn("python3 -m " + MODULE + " --print-settings", section)
        self.assertIn("~/.codex/hooks.json", section)
        self.assertRegex(section, r"(?<![~\w/])\.codex/hooks\.json")
        self.assertRegex(section.lower(), r"trusted[\s\S]*project|project[\s\S]*trusted")

    def test_m6_documents_review_trust_and_vetted_automation(self):
        section = self.codex_section()
        self.assertIn("/hooks", section)
        self.assertIn("--dangerously-bypass-hook-trust", section)
        self.assertRegex(section.lower(), r"trust")
        self.assertRegex(section.lower(), r"non.managed|unmanaged|not managed")
        self.assertRegex(section.lower(), r"vet|review")

    def test_m6_event_mapping_table_matches_executable_events(self):
        section = self.codex_section()
        rows = [line for line in section.splitlines() if line.lstrip().startswith("|")]
        self.assertTrue(rows, "M6 requires an event mapping table")
        for event, state in EVENTS.items():
            self.assertTrue(any(re.search(r"\b" + event + r"\b", row) and state in row for row in rows),
                            "missing documented mapping for " + event)

    def test_m6_codex_setup_contains_no_private_paths(self):
        section = self.codex_section()
        self.assertNotRegex(section, r"/(?:home|Users)/[^\s`<>]+")
        self.assertNotRegex(section, r"[A-Za-z]:[\\/]Users[\\/][^\s`<>]+")
