"""Fail-first coverage of the public TaskLight entry points."""

from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from bridge.room import __main__ as room_cli
from bridge.room import app, ext


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
LAUNCHER = ROOT / "bin" / "tasklight"
MODULE = (sys.executable, "-m", "bridge.room")
VERBS = ("post", "read", "wait", "status", "export", "tools", "call", "run", "wave")
UNKNOWN = "tlcli_fixture_unknown"
HOME_PATH = re.compile(r"(?:/home/|/Users/)[^\s/'\"`$<{]+(?:/|(?=[\s'\"`]|$))")

# Fix only sources of nondeterminism in real subprocesses. No CLI or tool
# responses are replaced by this fixture.
OFFLINE_CLOCK = """\
import itertools
import secrets
import socket
import time

def forbidden(*args, **kwargs):
    raise AssertionError('network and sleeps are forbidden in this fixture')

identities = itertools.count(1)
ticks = itertools.count()
time.time = lambda: 1700000000.0
time.monotonic = lambda: next(ticks) / 100
secrets.token_hex = lambda size=32: format(next(identities), f'0{(size or 32) * 2}x')
time.sleep = forbidden
socket.create_connection = forbidden
socket.socket.connect = forbidden
socket.socket.connect_ex = forbidden
"""


class CliCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="scratch-", dir=HERE)
        self.addCleanup(directory.cleanup)
        self.scratch = Path(directory.name)
        self.home = self.scratch / "room data"
        hooks = self.scratch / "hooks"
        hooks.mkdir()
        (hooks / "sitecustomize.py").write_text(OFFLINE_CLOCK, encoding="utf-8")
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("CW_", "PYTHON"))}
        self.env.update(
            CW_HOME=str(self.home), HOME=str(self.scratch),
            PYTHONDONTWRITEBYTECODE="1", PYTHONPATH=str(hooks),
            PYTHONIOENCODING="utf-8", PYTHONHASHSEED="0",
        )

    def process(self, command, *args, cwd=ROOT, env=None, stdin=b""):
        try:
            return subprocess.run(
                [*command, *args], cwd=cwd, env=self.env if env is None else env,
                input=stdin, capture_output=True, timeout=8, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            self.fail(f"could not run {Path(command[0]).name}: {exc}")

    def launcher(self):
        self.assertTrue(LAUNCHER.is_file(), "M1/M4/M5: bin/tasklight is missing")
        self.assertTrue(os.access(LAUNCHER, os.X_OK), "M4: bin/tasklight must be executable")
        return (str(LAUNCHER),)

    def json_line(self, stdout, *, object_required=True):
        self.assertTrue(stdout.endswith(b"\n"), f"missing JSON line: {stdout!r}")
        self.assertEqual(len(stdout.splitlines()), 1, stdout)
        try:
            value = json.loads(stdout)
        except ValueError as exc:
            self.fail(f"stdout is not JSON: {exc}: {stdout!r}")
        if object_required:
            self.assertIsInstance(value, dict)
        return value

    def tools(self):
        result = self.process(MODULE, "tools")
        self.assertEqual(result.returncode, 0, result.stderr)
        tools = self.json_line(result.stdout)["tools"]
        self.assertTrue(tools, "tools discovery must expose the live registry")
        return tools

    @staticmethod
    def outcome(result):
        return result.returncode, result.stdout

    def in_process(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"CW_HOME": str(self.home)}):
            for key in ("CW_PIN_AGENT", "CW_PIN_ROLE"):
                os.environ.pop(key, None)
            with redirect_stdout(out), redirect_stderr(err):
                try:
                    status = room_cli.main(args)
                except SystemExit as exc:
                    status = exc.code
        return status, out.getvalue(), err.getvalue()


class ToolParity(CliCase):
    def assert_registry_parity(self, command):
        mismatches = []
        codes = set()
        for tool in self.tools():
            name = tool["name"]
            tail = ("--json", "{}")
            reference = self.process(MODULE, "call", name, *tail)
            self.json_line(reference.stdout)
            codes.add(reference.returncode)
            alias = self.process(command, name, *tail)
            if self.outcome(alias) != self.outcome(reference):
                mismatches.append(name)
        self.assertTrue({0, 3}.issubset(codes), "registry cases must include success and tool refusal")
        self.assertFalse(self.home.exists(), "empty payload probes must leave storage untouched")
        self.assertEqual(mismatches, [], "standalone dispatch differs from call for these tools")

    def assert_refusals(self, command):
        bad_op = json.dumps({"room": "demo", "agent": "alice", "phase": [], "base_rev": 0})
        cases = (
            ("malformed JSON", "list_templates", ("--json", "{"), 2, "bad_args"),
            ("non-object JSON", "list_templates", ("--json", "[]"), 2, "bad_args"),
            ("missing JSON", "list_templates", ("--json",), 2, "bad_args"),
            ("unexpected trailing token", "list_templates", ("--json", "{}", "extra"), 2, "bad_args"),
            ("schema refusal", "post_status", ("--json", "{}"), 3, "bad_args"),
            ("operation refusal", "plan_phase", ("--json", bad_op), 3, "bad_op"),
            ("unknown tool", UNKNOWN, ("--json", "{}"), 2, "bad_args"),
            ("path-like tool", "../list_templates", ("--json", "{}"), 2, "bad_args"),
            ("shell-like tool", "list_templates$(printf '%s' '')", ("--json", "{}"), 2, "bad_args"),
        )
        mismatches = []
        for label, name, tail, status, code in cases:
            reference = self.process(MODULE, "call", name, *tail)
            self.assertEqual((reference.returncode, self.json_line(reference.stdout)["code"]),
                             (status, code), f"legacy call control: {label}")
            alias = self.process(command, name, *tail)
            if self.outcome(alias) != self.outcome(reference):
                mismatches.append(label)
        self.assertFalse(self.home.exists(), "refused calls must leave storage untouched")
        self.assertEqual(mismatches, [], "standalone refusal differs from call")

    def assert_literal_write(self, command):
        text = "café ' \" $(printf substituted) `printf backtick` ; --json\nsecond line"
        payload = json.dumps({"room": "demo", "agent": "alice", "text": text}, ensure_ascii=False)
        reference_home = self.scratch / "legacy home"
        legacy = self.process(MODULE, "call", "post_status", "--json", payload,
                              env={**self.env, "CW_HOME": str(reference_home)})
        self.assertEqual(legacy.returncode, 0, legacy.stdout)
        self.assertEqual(self.json_line(legacy.stdout)["event"]["untrusted_text"], text)
        candidate = self.process(command, "post_status", "--json", payload)
        self.assertEqual(self.outcome(candidate), self.outcome(legacy))
        journal = Path("rooms", "demo", "events.jsonl")
        self.assertTrue((self.home / journal).is_file(), "successful write did not commit an event")
        self.assertEqual((self.home / journal).read_bytes(), (reference_home / journal).read_bytes())
        self.assertEqual(len((self.home / journal).read_bytes().splitlines()), 1)

    def test_m1_launcher_registry_parity(self):
        self.assert_registry_parity(self.launcher())

    def test_m1_launcher_refusals(self):
        self.assert_refusals(self.launcher())

    def test_m1_launcher_literal_write(self):
        self.assert_literal_write(self.launcher())

    def test_m3_module_registry_parity(self):
        self.assert_registry_parity(MODULE)

    def test_m3_module_refusals(self):
        self.assert_refusals(MODULE)

    def test_m3_module_literal_write(self):
        self.assert_literal_write(MODULE)


    def test_m3_module_passes_nonempty_objects_for_every_registered_tool(self):
        def reply(name, args, *, pin=None):
            return {"untrusted": {"tool": name, "arguments": args}}

        mismatches = []
        for tool in self.tools():
            name = tool["name"]
            args = {"text": f"test data for {name} — café", "nested": [True, {"value": 7}]}
            tail = ("--json", json.dumps(args, ensure_ascii=False))
            # The registry stays real. Feed deterministic successes at the same
            # dispatch boundary for readers, writers and stateful extensions.
            with mock.patch.object(app, "dispatch", side_effect=reply) as dispatch:
                reference = self.in_process("call", name, *tail)
                self.assertEqual(reference[0], 0, reference)
                dispatch.reset_mock()
                alias = self.in_process(name, *tail)
                if dispatch.call_count != 1 or alias[:2] != reference[:2]:
                    mismatches.append(name)
        self.assertEqual(mismatches, [], "direct dispatch lost a valid call at the shared tool boundary")


class LegacyPrecedence(CliCase):
    def test_m2_legacy_verbs_win_when_each_name_is_registered_as_a_tool(self):
        tail = ("--json", "{}")
        baseline = {verb: self.in_process(verb, *tail) for verb in VERBS}
        with (mock.patch.object(ext, "EXT_TOOLS", ext.EXT_TOOLS.copy()),
              mock.patch.dict(ext.EXT_DISPATCH), mock.patch.dict(app.V2_DISPATCH)):
            for verb in VERBS:
                schema = {"type": "object", "properties": {}}
                ext.register({"name": verb, "description": "CLI collision fixture", "inputSchema": schema},
                             lambda args, name=verb: {"fixture": name})
            for verb in VERBS:
                with self.subTest(verb=verb):
                    status, stdout, _ = self.in_process("call", verb, *tail)
                    self.assertEqual(status, 0, stdout)
                    self.assertEqual(self.json_line(stdout.encode()), {"untrusted": {"fixture": verb}})
                    self.assertEqual(self.in_process(verb, *tail), baseline[verb])

    def test_m2_legacy_room_verbs_keep_existing_results(self):
        room = ("--room", "demo")
        posted = self.process(MODULE, "post", *room, "--agent", "alice",
                              "--act", "question", "--text", "Fixture question")
        self.assertEqual(posted.returncode, 0, posted.stderr)
        event = self.json_line(posted.stdout)["event"]
        probes = (
            (("read", *room, "--json"), "events", [event]),
            (("wait", *room, "--timeout", "0"), "event", event),
            (("status", *room), "open_questions", [event]),
        )
        for args, key, expected in probes:
            with self.subTest(verb=args[0]):
                result = self.process(MODULE, *args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.json_line(result.stdout)[key], expected)
        timeout = self.process(MODULE, "wait", *room, "--since", str(event["lamport"]), "--timeout", "0")
        self.assertEqual(timeout.returncode, 124)
        self.assertEqual(self.json_line(timeout.stdout), {"ok": False, "code": "timeout"})
        missing = self.process(MODULE, "read", "--room", "missing")
        self.assertEqual(missing.returncode, 4)
        self.assertEqual(self.json_line(missing.stdout), {"ok": False, "code": "not_found"})
        exported = self.process(MODULE, "export", *room, "--out", "exported")
        self.assertEqual(exported.returncode, 0, exported.stdout)
        for filename in ("PLAN.md", "MEMORY.md", "INTEGRATION.md"):
            self.assertTrue((self.home / "exported" / filename).is_file(), filename)

    def test_m2_run_and_wave_keep_their_dedicated_parsers(self):
        for verb, option, tail in (("run", b"--room", ("--help", "--")),
                                   ("wave", b"--manifest", ("--help",))):
            with self.subTest(verb=verb):
                result = self.process(MODULE, verb, *tail)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(option, result.stdout)
                self.assertFalse(self.home.exists())


class LauncherAndHelp(CliCase):
    def test_m4_launcher_resolves_relative_symlink_from_hostile_cwd(self):
        self.launcher()
        foreign = self.scratch / "caller ' $(printf unused) ; space"
        foreign.mkdir()
        decoy = foreign / "bridge"
        decoy.mkdir()
        (decoy / "__init__.py").write_text("raise SystemExit('wrong package')\n", encoding="utf-8")
        links = self.scratch / "link space"
        links.mkdir()
        first = links / "first link"
        first.symlink_to(os.path.relpath(LAUNCHER, links))
        second = foreign / "tasklight link"
        second.symlink_to(os.path.relpath(first, foreign))
        env = {key: value for key, value in self.env.items() if key != "PYTHONPATH"}
        reference = self.process(MODULE, "call", "list_templates", "--json", "{}", env=env)
        self.assertEqual(reference.returncode, 0, reference.stderr)
        for command in ((str(second),), ("sh", str(second))):
            result = self.process(command, "list_templates", "--json", "{}", cwd=foreign, env=env)
            self.assertEqual(self.outcome(result), self.outcome(reference), command[0])

    def test_m4_launcher_execs_documented_python_with_literal_argv_and_streams(self):
        command = self.launcher()
        source = LAUNCHER.read_text(encoding="utf-8")
        self.assertNotRegex(source, HOME_PATH)
        bindir = self.scratch / "interpreter path"
        bindir.mkdir()
        python = bindir / "python3"
        python.write_text('#!/bin/sh\nexec "$TLCLI_ORACLE_PYTHON" -c "$TLCLI_ORACLE_PROBE" "$@"\n',
                          encoding="utf-8")
        python.chmod(0o700)
        probe = (
            "import json, os, sys\n"
            "print(json.dumps([os.getpid(), sys.argv[1:]]), flush=True)\n"
            "sys.stdout.buffer.write(sys.stdin.buffer.read())\n"
            "sys.stderr.buffer.write(b'probe stderr\\x00\\xff')\n"
            "raise SystemExit(47)\n"
        )
        env = {**self.env, "PATH": str(bindir) + os.pathsep + self.env.get("PATH", os.defpath),
               "TLCLI_ORACLE_PYTHON": sys.executable, "TLCLI_ORACLE_PROBE": probe}
        args = ("list_templates", "--json", '{"text":"é $(printf unused) `literal`"}')
        payload = b"stdin\x00\xff\n"
        try:
            with subprocess.Popen([*command, *args], cwd=self.scratch, env=env,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
                try:
                    stdout, stderr = proc.communicate(payload, timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
                    self.fail("launcher did not pass control to python3")
        except OSError as exc:
            self.fail(f"bin/tasklight could not execute: {exc}")
        self.assertEqual(proc.returncode, 47, (stdout, stderr))
        header, separator, body = stdout.partition(b"\n")
        self.assertEqual((separator, body, stderr), (b"\n", payload, b"probe stderr\x00\xff"))
        pid, argv = self.json_line(header + separator, object_required=False)
        self.assertEqual(pid, proc.pid, "python3 must replace the launcher process")
        self.assertEqual(argv[-(len(args) + 2):], ["-m", "bridge.room", *args])

    def test_m5_help_lists_verbs_and_live_tool_names_on_one_json_line(self):
        result = self.process(self.launcher(), "--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        help_info = self.json_line(result.stdout, object_required=False)

        def names(value):
            if isinstance(value, str):
                yield value
            elif isinstance(value, list):
                for item in value:
                    yield from names(item)
            elif isinstance(value, dict):
                for item in value.values():
                    yield from names(item)

        reported = set(names(help_info))
        self.assertIn("open", help_info["verbs"])
        self.assertEqual(set(VERBS) - reported, set(), "missing legacy verbs in help")
        self.assertEqual({tool["name"] for tool in self.tools()} - reported, set(),
                         "missing registered tool names in help")
        self.assertFalse(self.home.exists(), "discovery must leave room storage untouched")


class CompatibilityAndDocs(CliCase):
    def test_m6_mcp_discovery_success_and_refusal_keep_wire_contract(self):
        tools = self.tools()
        queries = (("list_templates", {}, 0), ("plan_phase", {}, 3))
        requests = [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}]
        for number, (name, args, _) in enumerate(queries, 2):
            requests.append({"jsonrpc": "2.0", "id": number, "method": "tools/call",
                             "params": {"name": name, "arguments": args}})
        data = b"".join(json.dumps(request).encode() + b"\n" for request in requests)
        result = self.process((sys.executable, "-m", "bridge.room.mcp"), stdin=data)
        self.assertEqual(result.returncode, 0, result.stderr)
        replies = [self.json_line(line) for line in result.stdout.splitlines(keepends=True)]
        self.assertEqual([(reply["jsonrpc"], reply["id"]) for reply in replies],
                         [("2.0", 1), ("2.0", 2), ("2.0", 3)])
        self.assertEqual(replies[0]["result"], {"tools": tools})
        for reply, (name, args, status) in zip(replies[1:], queries):
            legacy = self.process(MODULE, "call", name, "--json", json.dumps(args))
            self.assertEqual(legacy.returncode, status, legacy.stdout)
            payload = self.json_line(legacy.stdout)
            self.assertIn("untrusted" if status == 0 else "code", payload)
            wire = reply["result"]
            self.assertIs(wire["isError"], status != 0)
            self.assertEqual(len(wire["content"]), 1)
            self.assertEqual(wire["content"][0]["type"], "text")
            self.assertEqual(json.loads(wire["content"][0]["text"]), payload)
        self.assertFalse(self.home.exists())

    def test_docs_cli_has_one_example_for_every_verb_and_operation(self):
        path = ROOT / "docs" / "CLI.md"
        self.assertTrue(path.is_file(), "docs/CLI.md is missing")
        markdown = path.read_text(encoding="utf-8")
        self.assertNotRegex(markdown, HOME_PATH)
        example = re.compile(r"(?m)(?:^|[\s`])(?:\./)?(?:bin/)?tasklight\s+([^\n`]+)")
        command_lines = [match.group(1) for match in example.finditer(markdown.replace("\\\n", " "))]
        verbs, tools = set(), set()
        for line in command_lines:
            try:
                words = shlex.split(line)
            except ValueError:
                continue
            if not words:
                continue
            if words[0] in VERBS:
                verbs.add(words[0])
            if "--json" in words:
                name_index = 1 if words[0] == "call" else 0
                if name_index < words.index("--json"):
                    tools.add(words[name_index])
        self.assertEqual(set(VERBS) - verbs, set(), "undocumented verb examples")
        self.assertEqual({tool["name"] for tool in self.tools()} - tools, set(),
                         "undocumented operation examples")

    def test_docs_readme_and_setup_each_point_to_cli_guide(self):
        missing = []
        for relative in ("README.md", "docs/SETUP_WITH_AI.md"):
            path = ROOT / relative
            targets = re.findall(r"\]\(<?([^\s)>]+?)(?:#[^\s)>]+)?>?\)",
                                 path.read_text(encoding="utf-8"))
            paths = {((ROOT / target.lstrip("/")) if target.startswith("/")
                      else (path.parent / target)).resolve() for target in targets}
            if ROOT / "docs" / "CLI.md" not in paths:
                missing.append(relative)
        self.assertEqual(missing, [], "missing one-line links to docs/CLI.md")
