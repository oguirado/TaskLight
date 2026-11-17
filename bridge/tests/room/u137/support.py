"""Bounded artifact checks and real stdio dispatch, using stdlib only."""
import contextlib
import io
import itertools
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from bridge.room import mcp

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
GUIDE = "docs/HARNESS_ANTIGRAVITY.md"
COORDINATOR = "templates/antigravity/coordinator.md"
EXECUTOR = "templates/antigravity/executor.md"
FALLBACK = "templates/antigravity/lifecycle-agent-reported.md"
ADAPTER = "bridge/room/hook_antigravity.py"
REPORTED = "Antigravity 2 (agent-reported)"
RECORDED = "Antigravity 2 (harness-recorded)"
PUBLIC_ARTIFACTS = (GUIDE, COORDINATOR, EXECUTOR, FALLBACK)


def fences(text):
    marker = chr(96) * 3
    return re.findall(r"(?ms)^" + marker + r"([^\n]*)\n(.*?)^" + marker + r"[ \t]*$", text)


def fallback_provenance(text):
    """A missing positive control is an error, never a detected mutant."""
    if REPORTED not in text:
        raise AssertionError("fallback harness provenance: agent-reported label missing")
    for language, body in fences(text):
        if RECORDED in body:
            raise AssertionError("fallback harness provenance: example claims harness-recorded")
    for line in text.splitlines():
        if RECORDED in line and re.search(r"\bharness\s*[:=]", line):
            if not re.search(r"\b(?:never|not|forbid|invalid|reject)\b", line, re.I):
                raise AssertionError("fallback harness provenance: harness-recorded assignment")


def exclusive_modes(text):
    """Check the rule's stop condition, not an invented backend identity gate."""
    for sentence in re.split(r"[.!?\n]", text.lower()):
        if ("hook" in sentence and "fallback" in sentence
                and re.search(r"\b(?:run|attempt)\b", sentence)
                and re.search(r"\b(?:never|not|disable|stop|exclusive|only one)\b", sentence)
                and re.search(r"\b(?:concurrent|simultaneous|same|active|enabled|both)\w*\b", sentence)):
            return
    raise AssertionError("hook/fallback collision: missing same-run mutual exclusion rule")


class ArtifactCase(unittest.TestCase):
    def text(self, relative):
        path = ROOT / relative
        self.assertTrue(path.is_file(), f"U137 required artifact AUSENTE: {relative}")
        try:
            return path.read_text(encoding="utf-8")
        except UnicodeError:
            self.fail(f"U137 artifact must be readable UTF-8: {relative}")

    def mentions(self, text, *terms):
        for term in terms:
            with self.subTest(required=term):
                self.assertIn(term.lower(), text.lower())

    def rule(self, text, pattern, reason):
        self.assertRegex(text, "(?is)" + pattern, reason)

    def registration(self):
        found = []
        for language, body in fences(self.text(GUIDE)):
            if language.strip().lower() != "json":
                continue
            try:
                value = json.loads(body)
            except ValueError:
                if "mcpServers" in body and "tasklight" in body:
                    self.fail("M1 TaskLight registration must be copyable valid JSON")
                continue
            if isinstance(value, dict) and isinstance(value.get("mcpServers"), dict):
                entry = value["mcpServers"].get("tasklight")
                if entry is not None:
                    found.append(entry)
        self.assertTrue(found, "M1 copyable mcpServers.tasklight entry AUSENTE")
        for entry in found:
            self.assertIsInstance(entry, dict)
            self.assertEqual(set(entry), {"command", "args"},
                             "M1 permits only evidenced Antigravity command/args keys")
            self.assertIsInstance(entry["command"], str)
            self.assertTrue(entry["command"].strip())
            self.assertIsInstance(entry["args"], list)
            self.assertTrue(all(isinstance(arg, str) for arg in entry["args"]))
        return found[0]

    def launcher(self):
        candidates = [body for language, body in fences(self.text(GUIDE))
                      if language.split() and language.split()[0].lower() in
                      ("sh", "bash", "shell", "zsh")
                      and "bridge.room.mcp" in body and "CW_HOME" in body]
        self.assertTrue(candidates, "M1 user-owned shell launcher example AUSENTE")
        return candidates[0]


def configure_launcher(script, repo, home):
    """Configure assignments and cd without repairing expansion-site quoting."""
    word = r"(?:\"(?:\\.|[^\"\\])*\"|'[^']*'|[^\s;&]+)"
    cd = re.search(r"(?m)\bcd\s+(?:--\s+)?(" + word + r")", script)
    if cd is None:
        raise AssertionError("M1 launcher does not set the repository working directory")
    operand = cd.group(1)
    variable = re.fullmatch(r"[\"']?\$\{?([A-Za-z_][A-Za-z_0-9]*)\}?[\"']?", operand)

    def assignment(source, name, value):
        pattern = r"(?m)(^\s*(?:export\s+)?" + re.escape(name) + r"=)(" + word + r")"
        result, count = re.subn(pattern, lambda match: match.group(1) + shlex.quote(str(value)), source, count=1)
        if count != 1:
            raise AssertionError("M1 launcher user configuration assignment AUSENTE: " + name)
        return result

    if variable:
        script = assignment(script, variable.group(1), repo)
    else:
        configured = shlex.quote(str(repo)) if operand[:1] in ("'", '"') else str(repo)
        script = script[:cd.start(1)] + configured + script[cd.end(1):]
    return assignment(script, "CW_HOME", home)


class ProtocolCase(ArtifactCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.scratch = Path(temporary.name)
        self.home = self.scratch / "storage"
        self.home.mkdir()
        self.now = 1700000000.0
        self.ids = itertools.count(1)
        self.enterContext(patch.dict(os.environ, {
            "CW_HOME": str(self.home), "PYTHONDONTWRITEBYTECODE": "1"}))
        self.enterContext(patch.object(time, "time", side_effect=lambda: self.now))
        for module, name in ((time, "sleep"), (socket, "socket"),
                             (socket, "create_connection"), (subprocess, "Popen")):
            self.enterContext(patch.object(module, name, side_effect=AssertionError("external I/O forbidden")))
        self.enterContext(patch.object(secrets, "token_hex", side_effect=lambda n: f"{next(self.ids):0{2*n}x}"))
        self.enterContext(patch.object(mcp, "TOOLS", mcp.TOOLS))
        self.enterContext(patch.object(mcp, "_TOOL_NAMES", mcp._TOOL_NAMES))

    def wire(self, data):
        output = io.StringIO()
        inp = io.TextIOWrapper(io.BytesIO(data), encoding="utf-8")
        with patch.object(mcp.sys, "stdin", inp), contextlib.redirect_stdout(output):
            self.assertEqual(mcp.main(), 0)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def rpc(self, method, params=None):
        request = dict(jsonrpc="2.0", id=7, method=method, params=params or {})
        replies = self.wire((json.dumps(request) + "\n").encode())
        self.assertEqual(len(replies), 1)
        self.assertEqual((replies[0]["jsonrpc"], replies[0]["id"]), ("2.0", 7))
        return replies[0]

    def tool(self, name, **arguments):
        reply = self.rpc("tools/call", {"name": name, "arguments": arguments})
        self.assertNotIn("error", reply, "MCP infrastructure error is not a conformance result")
        result = reply["result"]
        data = json.loads(result["content"][0]["text"])
        if result.get("isError"):
            return data
        self.assertEqual(set(data), {"untrusted"})
        return data["untrusted"]

    def snapshot(self):
        return {str(p.relative_to(self.scratch)): p.read_bytes()
                for p in self.scratch.rglob("*") if p.is_file()}

    def events(self, room="demo"):
        path = self.home / "rooms" / room / "events.jsonl"
        return [json.loads(line) for line in path.read_bytes().splitlines()] if path.exists() else []

    def require_lifecycle(self):
        names = {tool["name"] for tool in self.rpc("tools/list")["result"]["tools"]}
        if "agent_lifecycle" not in names:
            self.skipTest("BLOCKED: U132 agent_lifecycle prerequisite AUSENTE; not a U137 failure")

    def lifecycle(self, state="deployed", **extra):
        args = dict(room="demo", agent="exec-a", state=state, run_id="attempt-1",
                    harness=REPORTED, op_id="life-" + state)
        args.update(extra)
        return self.tool("agent_lifecycle", **args)
