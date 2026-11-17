"""M6-M8: public API, transitive imports and operator-facing documentation."""
import ast
import importlib.util
import inspect
import json
import os
import re
import socket
import typing

from bridge.room import hook
from .support import HookCase, ROOT


def import_graph(seeds):
    todo = list(seeds)
    visited = set()
    edges = set()
    while todo:
        module = todo.pop()
        if module in visited or not module.startswith("bridge"):
            continue
        path = ROOT.joinpath(*module.split("."))
        is_package = path.is_dir()
        path = path / "__init__.py" if is_package else path.with_suffix(".py")
        if not path.exists():
            continue
        visited.add(module)
        package = module if is_package else module.rpartition(".")[0]
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                target = node.module or ""
                if node.level:
                    target = importlib.util.resolve_name("." * node.level + target, package)
                names = [target] + [target + "." + alias.name for alias in node.names]
            for name in names:
                edges.add(name)
                todo.append(name)
    return visited, edges


class BoundaryOracle(HookCase):
    def documentation(self):
        path = ROOT / "docs/HARNESS_HOOKS.md"
        self.assertTrue(path.is_file(), "M8 harness hook documentation is absent")
        return path.read_text(encoding="utf-8")

    def test_amendment_c_exact_exported_signature(self):
        signature = inspect.signature(hook.run_hook_bytes)
        self.assertEqual(list(signature.parameters), ["raw"])
        self.assertEqual(signature.parameters["raw"].default, inspect.Parameter.empty)
        self.assertEqual(typing.get_type_hints(hook.run_hook_bytes), {"raw": bytes, "return": dict})

    def test_m8_transitive_import_graph_has_no_provider_clients(self):
        visited, imports = import_graph(("bridge.room.hook", "bridge.room.hook_claude"))
        self.assertIn("bridge.room.hook", visited)
        denied = {"openai", "anthropic", "litellm", "boto3"}
        self.assertEqual({name for name in imports if name.split(".")[0] in denied}, set())
        self.assertFalse(any(name.startswith(("google.generativeai", "google.genai")) for name in imports))

    def test_m8_documented_json_fixtures_cover_all_four_states(self):
        text = self.documentation()
        decoder = json.JSONDecoder()
        fixtures = []
        for start, character in enumerate(text):
            if character != "{":
                continue
            try:
                value, _ = decoder.raw_decode(text[start:])
            except ValueError:
                continue
            if isinstance(value, dict) and {"event_id", "room", "agent", "run_id", "state"} <= value.keys():
                fixtures.append(value)
        self.assertEqual({value["state"] for value in fixtures}, {"deployed", "alive", "finished", "failed"})
        self.assertTrue(all(all(isinstance(value[key], str) and value[key] for key in
                               ("event_id", "room", "agent", "run_id")) for value in fixtures))

    def test_m8_documents_commands_home_replay_cleanup_and_identity_trust(self):
        text = self.documentation()
        self.assertIn("python3 -m bridge.room.hook", text)
        self.assertIn("python3 -m bridge.room.hook_claude --lifecycle", text)
        self.assertIn("CW_HOME", text)
        for word in ("replay", "release", "failed", "silent"):
            self.assertIn(word, text.lower())
        self.assertRegex(text.lower(), r"caller[- ]asserted")
        self.assertRegex(text.lower(), r"not authenticated|unauthenticated")

    def test_m6_documents_wait_only_deadline_and_non_posix_limit(self):
        text = self.documentation().lower()
        self.assertRegex(text, r"(?:2|two)\s*(?:s\b|seconds?)")
        self.assertIn("stdin", text)
        self.assertIn("lock", text)
        self.assertIn("write", text)
        self.assertRegex(text, r"non[- ]posix|windows")
        self.assertIn("u121", text)
        self.assertIn("u137", text)
        self.assertRegex(text, r"ausente|absent")

    def test_m8_public_documentation_excludes_local_identity_and_paths(self):
        text = self.documentation()
        for private in (str(ROOT), str(self.home), socket.gethostname(), os.path.expanduser("~")):
            if private:
                self.assertNotIn(private, text)
