"""Public entry, isolated homes, stdin fixtures and journal observations."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MODULE = "bridge.room.hook_claude_native"
FIXTURES = json.loads((HERE / "fixtures.json").read_text(encoding="utf-8"))
NOW = 1800000000.0
EVENTS = tuple(FIXTURES["events"])
REASONS = ("clear", "resume", "logout", "prompt_input_exit", "other")
PRIVATE = (
    "raw-session-privacy-canary", "raw-child-privacy-canary",
    "transcripts/main-privacy-canary.jsonl", "transcripts/child-privacy-canary.jsonl",
    "prompt-privacy-canary", "tool-input-privacy-canary",
    "tool-response-privacy-canary", "assistant-message-privacy-canary",
    "child-message-privacy-canary",
)


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def sha(value, length):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def session_agent(session_id=FIXTURES["common"]["session_id"]):
    return "cc-" + sha(session_id, 10)


def child_agent(agent_id="raw-child-privacy-canary", agent_type="Release / QA Reviewer"):
    prefix = re.sub(r"[^a-z0-9]+", "-", agent_type.lower()).strip("-")[:24].rstrip("-")
    return prefix + "-" + sha(agent_id, 8)


class NativeCase(unittest.TestCase):
    NEEDS_ADAPTER = True

    def setUp(self):
        # All transient files stay inside the assigned test surface and are removed.
        temporary = tempfile.TemporaryDirectory(prefix=".case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.home = self.tmp / "home"
        self.project = self.tmp.joinpath("project", "a", "b", "c", "d", "e", "f", "g", "work")
        self.project.mkdir(parents=True)
        self.sequence = 0
        if self.NEEDS_ADAPTER:
            self.require_adapter()

    def payload(self, event="SessionStart", **overrides):
        value = copy.deepcopy(FIXTURES["common"])
        value.update(copy.deepcopy(FIXTURES["events"].get(event, {})))
        value.update(cwd=str(self.project), hook_event_name=event)
        value.update(overrides)
        return value

    def config(self, directory, room):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / ".tasklight.json").write_text(json.dumps({"room": room}), encoding="utf-8")

    def require_adapter(self):
        self.assertIsNotNone(
            importlib.util.find_spec(MODULE),
            "M1 missing native adapter behavior: bridge.room.hook_claude_native entry is absent",
        )

    def invoke(self, payload=None, *, raw=None, room="demo", now=NOW, mode="real",
               args=(), extra_env=None, module=MODULE, silent=True, no_read=False):
        if module == MODULE:
            # Discovery is an assertion gate; the missing module is never imported.
            self.require_adapter()
        self.sequence += 1
        report_path = self.tmp / ("report-%d.json" % self.sequence)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("CW_", "TASKLIGHT_", "CLAUDE", "ANTHROPIC", "PYTHON", "C1C_"))}
        env.update(CW_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1",
                   C1C_REPORT=str(report_path), C1C_NOW=str(now), C1C_MODE=mode,
                   C1C_NO_READ="1" if no_read else "0")
        if room is not None:
            env["TASKLIGHT_ROOM"] = room
        env.update(extra_env or {})
        if raw is None:
            raw = encode(self.payload() if payload is None else payload)
        started = time.perf_counter()
        try:
            child = subprocess.run(
                [sys.executable, "-B", "-m", "bridge.tests.room.c1c.cli_probe", module, *args],
                input=raw, cwd=ROOT, env=env, capture_output=True, timeout=8,
            )
        except subprocess.TimeoutExpired:
            self.fail("M1 native entry did not return within the bounded fixture budget")
        external_elapsed = time.perf_counter() - started
        self.assertEqual(child.returncode, 0, "probe failed: " + child.stderr.decode(errors="replace"))
        self.assertTrue(report_path.is_file(), "entry probe must produce its test-only report")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        report["external_elapsed"] = external_elapsed
        self.assertIsNone(report["exception"], "entry raised: " + str(report["exception"]))
        self.assertEqual(report["violations"], [], "adapter attempted a network, process or sleep operation")
        self.assert_observational(report["exit_code"], child.stdout, child.stderr, silent=silent)
        return child, report

    def assert_observational(self, code, stdout, stderr, *, silent=True):
        self.assertEqual(code, 0, "M1 requires exit zero")
        if silent:
            self.assertEqual(stdout, b"", "M1 forbids stdout")
        self.assertLessEqual(len(stderr.splitlines()), 1, "M1 permits at most one stderr line")

    def events(self, room="demo", home=None):
        path = (home or self.home) / "rooms" / room / "events.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_bytes().splitlines() if line.strip()]

    def lifecycle(self, room="demo", home=None):
        return [event for event in self.events(room, home)
                if event.get("op", {}).get("kind") == "agent.lifecycle"]

    def assert_no_lifecycle(self):
        for path in self.tmp.rglob("events.jsonl"):
            for line in path.read_bytes().splitlines():
                self.assertNotEqual(json.loads(line).get("op", {}).get("kind"), "agent.lifecycle")

    def session_start(self, **kwargs):
        return self.invoke(self.payload(), **kwargs)

    def captured(self, report):
        return [args for name, args in report["calls"] if name == "agent_lifecycle"]

    def assert_one_state(self, state, *, agent=None, room="demo"):
        records = self.lifecycle(room)
        self.assertTrue(records, "native event must persist a lifecycle record")
        self.assertEqual(records[-1]["op"]["state"], state)
        if agent is not None:
            self.assertEqual(records[-1]["agent"], agent)
        return records[-1]

    def assert_private(self, blob):
        for marker in PRIVATE:
            self.assertNotIn(marker.encode(), blob, "M3 leaked raw hook content")

    def room_bytes(self):
        directory = self.home / "rooms"
        return b"\n".join(path.read_bytes() for path in sorted(directory.rglob("*")) if path.is_file())

    def assert_parent(self, record, parent, run_id):
        self.assertEqual(record.get("parent_agent"), parent, "M4 requires parent_agent")
        self.assertEqual(record.get("parent_run_id"), run_id, "M4 requires parent_run_id")

    def assert_unique(self, events):
        keys = [(event["agent"], event["op"]["op_id"]) for event in events]
        self.assertEqual(len(keys), len(set(keys)), "M5 duplicated a lifecycle operation")
