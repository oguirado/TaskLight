"""Execute documented registration examples with bounded, offline stdio."""
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from .support import ArtifactCase, HERE, ROOT, configure_launcher


BOOTSTRAP = """
import json, os, runpy, socket, subprocess, sys, time
def forbidden(*args, **kwargs):
    raise AssertionError("network, inference processes and real sleeps forbidden")
socket.socket = forbidden
socket.create_connection = forbidden
subprocess.Popen = forbidden
time.sleep = forbidden
time.time = lambda: 1700000000.0
assert sys.argv[1:][-2:] == ["-m", "bridge.room.mcp"], "launcher must execute the MCP module"
if os.environ["ORACLE_MODE"] == "inspect":
    print(json.dumps(dict(cwd=os.getcwd(), home=os.environ.get("CW_HOME"), args=sys.argv[1:])))
else:
    sys.path.insert(0, os.getcwd())
    runpy.run_module("bridge.room.mcp", run_name="__main__")
"""


class LauncherExamples(ArtifactCase):
    def launch(self, *, hostile=False, mode="inspect", existing=None):
        entry = self.registration()
        source = self.launcher()
        self.assertFalse(Path(entry["command"]).name in ("python", "python3")
                         and entry["args"][:2] == ["-m", "bridge.room.mcp"],
                         "M1 raw module entry cannot establish launcher cwd/CW_HOME")
        self.assertNotRegex(source, r"(?m)^\s*(?:eval|curl|wget|pip|npm|npx)\b",
                            "registration launcher must only configure and execute")
        with tempfile.TemporaryDirectory(prefix="launcher-", dir=HERE) as directory:
            scratch = Path(directory)
            suffix = " dir ' $(touch QUOTING_BREACH) " + chr(96) + "touch OTHER_BREACH" + chr(96)
            repo = scratch / ("repo" + suffix if hostile else "repo")
            repo.symlink_to(ROOT, target_is_directory=True)
            home = scratch / ("storage" + suffix if hostile else "storage")
            home.mkdir()
            config = scratch / "client-config.json"
            if existing is not None:
                config.write_bytes(existing)
            original = config.read_bytes() if config.exists() else None
            script = scratch / "tasklight-mcp"
            configured_source = configure_launcher(source, repo, home)
            if not configured_source.startswith("#!"):
                configured_source = "#!/usr/bin/env sh\n" + configured_source
            script.write_text(configured_source, encoding="utf-8")
            script.chmod(0o700)
            bindir = scratch / "bin"
            bindir.mkdir()
            wrapper = bindir / "python3"
            wrapper.write_text('#!/usr/bin/env sh\nexec "$ORACLE_PYTHON" -B -c "$ORACLE_BOOTSTRAP" "$@"\n')
            wrapper.chmod(0o700)
            # Bind only the operator-owned launcher path in the parsed example.
            configured = copy.deepcopy(entry)
            if Path(entry["command"]).name in ("sh", "bash", "zsh"):
                operands = [i for i, arg in enumerate(entry["args"]) if not arg.startswith("-")]
                self.assertTrue(operands, "registration shell entry has no launcher operand")
                self.assertNotIn("-c", entry["args"], "use the documented user-owned launcher file")
                configured["args"][operands[0]] = str(script)
            else:
                configured["command"] = str(script)
            env = dict(PATH=str(bindir) + os.pathsep + os.defpath, HOME=str(scratch),
                       LC_ALL="C", PYTHONDONTWRITEBYTECODE="1",
                       ORACLE_PYTHON=sys.executable, ORACLE_BOOTSTRAP=BOOTSTRAP,
                       ORACLE_MODE=mode)
            requests = [
                dict(jsonrpc="2.0", id=1, method="initialize", params={
                    "protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "u137-offline-oracle", "version": "1"}}),
                dict(jsonrpc="2.0", method="notifications/initialized"),
                dict(jsonrpc="2.0", id=2, method="tools/list", params={}),
                dict(jsonrpc="2.0", id=3, method="prompts/list", params={}),
            ]
            wire = "".join(json.dumps(request) + "\n" for request in requests)
            try:
                child = subprocess.run([configured["command"], *configured["args"]],
                                       cwd=scratch, env=env, input=wire,
                                       text=True, capture_output=True, timeout=5)
            except (OSError, subprocess.TimeoutExpired) as error:
                self.fail("documented launcher failed its bounded offline scenario: " + type(error).__name__)
            self.assertEqual(child.returncode, 0, "documented launcher execution failed")
            self.assertEqual(child.stderr, "", "documented launcher produced an error")
            self.assertEqual(config.read_bytes() if config.exists() else None, original,
                             "launcher changed existing client configuration")
            self.assertFalse((scratch / "QUOTING_BREACH").exists(), "path substitution executed a command")
            self.assertFalse((scratch / "OTHER_BREACH").exists(), "backtick path executed a command")
            self.assertFalse(list(home.rglob("events.jsonl")), "discovery must not fabricate room activity")
            try:
                output = [json.loads(line) for line in child.stdout.splitlines()]
            except ValueError:
                self.fail("documented launcher did not return JSON output")
            if mode == "inspect":
                self.assertEqual(len(output), 1)
                self.assertEqual(Path(output[0]["cwd"]).resolve(), ROOT)
                self.assertEqual(output[0]["home"], str(home))
            return output

    def test_a1_registration_json_has_only_public_command_and_args(self):
        self.registration()

    def test_a1_documented_launcher_initializes_and_discovers_offline(self):
        replies = self.launch(mode="server")
        self.assertEqual([reply["id"] for reply in replies], [1, 2, 3])
        self.assertEqual(replies[0]["result"]["serverInfo"]["name"], "tasklight")
        self.assertIn("version", replies[0]["result"]["serverInfo"])
        tools = {tool["name"] for tool in replies[1]["result"]["tools"]}
        prompts = {prompt["name"] for prompt in replies[2]["result"]["prompts"]}
        self.assertTrue({"swarm_coordinator", "swarm_executor"} <= prompts)
        if "agent_lifecycle" not in tools:
            self.skipTest("BLOCKED A1: U132 agent_lifecycle AUSENTE; offline discovery is not live client compatibility")

    def test_a1_launcher_preserves_unrelated_and_malformed_configurations(self):
        self.registration()
        self.launcher()
        for existing in (b'{"mcpServers":{"unrelated":{"command":"keep","args":[]}}}\n',
                         b'{"mcpServers": broken and must stay untouched\n'):
            with self.subTest(existing=existing):
                self.launch(existing=existing)

    def test_a5_launcher_quotes_hostile_configured_paths(self):
        self.launch(hostile=True)

    def test_a5_launcher_never_interpolates_event_text_into_shell(self):
        source = self.launcher()
        self.assertNotRegex(source, r"(?m)^\s*eval\b",
                            "launcher must not evaluate event input")
        self.assertNotRegex(source, r"(?i)\$(?:\{)?(?:event|payload|reason|text)\b")

    def test_a5_quoting_probe_keeps_unsafe_expansions_visible(self):
        # In-memory positive and negative controls for the test's configurator.
        good = 'REPO="configured"\nCW_HOME="configured"\nexport CW_HOME\ncd -- "$REPO"\nexec python3 -m bridge.room.mcp\n'
        bad = good.replace('cd -- "$REPO"', "cd -- $REPO")
        rendered_good = configure_launcher(good, "repo with spaces", "storage with spaces")
        rendered_bad = configure_launcher(bad, "repo with spaces", "storage with spaces")
        self.assertIn('cd -- "$REPO"', rendered_good)
        self.assertIn("cd -- $REPO", rendered_bad)
        self.assertNotEqual(rendered_good, rendered_bad)
