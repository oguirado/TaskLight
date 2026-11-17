"""M1-M6: public CLI tests with small local Python children and pipe barriers."""
import json
import signal
import sys

from .support import ALLOWED_EVENT, ALLOWED_OP, BASE, ROOT, RunCase


class ProcessOracle(RunCase):
    def test_m1_binary_stdin_stdout_stderr_pass_through_without_supervisor_output(self):
        data = b"input\x00\xff\r\nutf8:\xc3\xa9\n"
        result = self.invoke(child=self.child("streams"), data=data)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"OUT\x00\xff:" + data)
        self.assertEqual(result.stderr, b"ERR\x00\xfe:" + data[::-1])
        self.assert_lifecycle()

    def test_m1_argv_remains_literal_after_the_separator(self):
        arguments = ["", "two words", "'quoted'", "$(printf injected)", "; exit 99",
                     "*", "line\nbreak", "\u00e9", "--room", "other", "--beat", "300"]
        result = self.invoke(child=self.child("argv", *arguments))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), arguments)
        self.assertFalse((self.home / "rooms" / "other").exists())

    def test_m2_deployed_is_visible_before_the_real_child_starts(self):
        result = self.invoke(child=self.child("deployed"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"deployed-before-child\n")
        self.assert_lifecycle()

    def test_m2_explicit_run_id_and_harness_are_preserved(self):
        result = self.invoke(options=BASE + ["--harness", "generic CLI"], child=self.child("exit", "0"))
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.assert_lifecycle()
        self.assertEqual(events[0]["op"].get("harness"), "generic CLI")
        for event in events:
            if "harness" in event["op"]:
                self.assertEqual(event["op"]["harness"], "generic CLI")

    def test_m2_generated_run_ids_are_fresh_for_repeated_invocations(self):
        options = ["--room", "demo", "--agent", "exec-a"]
        for _ in range(2):
            result = self.invoke(options=options)
            self.assertEqual(result.returncode, 0, result.stderr)
        events = self.lifecycle()
        runs = [event["op"]["run_id"] for event in events if event["op"]["state"] == "deployed"]
        self.assertEqual(len(runs), 2)
        self.assertNotEqual(runs[0], runs[1])
        for run in runs:
            self.assertRegex(run, r"\A[A-Za-z0-9_-]{1,64}\Z")
            sequence = [event["op"]["state"] for event in events if event["op"]["run_id"] == run]
            self.assertEqual(sequence[0], "deployed")
            self.assertEqual(sequence[-1], "finished")

    def test_m5_journal_never_contains_argv_output_or_environment(self):
        self.env["C1B_CHILD_VALUE"] = "C1B_ENV_SENTINEL"
        result = self.invoke(options=BASE + ["--harness", "codex"],
                             child=self.child("privacy", "C1B_ARGV_SENTINEL"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"C1B_STDOUT_SENTINEL")
        self.assertEqual(result.stderr, b"C1B_STDERR_SENTINEL")
        events = self.assert_lifecycle()
        for path in (self.home / "rooms" / "demo").rglob("*"):
            if path.is_file():
                content = path.read_bytes()
                for secret in (b"C1B_ARGV_SENTINEL", b"C1B_ENV_SENTINEL",
                               b"C1B_STDOUT_SENTINEL", b"C1B_STDERR_SENTINEL"):
                    self.assertNotIn(secret, content, path.name)
        for event in events:
            self.assertLessEqual(set(event), ALLOWED_EVENT)
            self.assertLessEqual(set(event["op"]), ALLOWED_OP)
            self.assertEqual(event.get("text", ""), "")

    def test_m6_missing_home_and_room_are_created_without_a_plan(self):
        self.assertFalse(self.home.exists())
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.assert_lifecycle()
        self.assertTrue((self.home / "rooms" / "demo" / "events.jsonl").is_file())
        self.assertEqual(self.events(), events, "supervision must not manufacture a plan")

    def test_m6_existing_room_history_is_preserved(self):
        arguments = {"room": "demo", "agent": "prior-agent", "state": "deployed", "run_id": "prior-run"}
        process = self.launch([sys.executable, "-B", "-m", "bridge.room", "call", "agent_lifecycle",
                               "--json", json.dumps(arguments)])
        out, err = process.communicate(b"", timeout=10)
        self.assertEqual(process.returncode, 0, err)
        path = self.home / "rooms" / "demo" / "events.jsonl"
        original = path.read_bytes()
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(path.read_bytes().startswith(original))
        self.assert_lifecycle()
        self.assertEqual(len([event for event in self.events() if event["agent"] == "prior-agent"]), 1)


def exit_case(code):
    def test(self):
        result = self.invoke(child=self.child("exit", str(code)))
        self.assertEqual(result.returncode, code, "supervisor must propagate the child's exit code")
        self.assertEqual(result.stdout, b"child-ran\n", "a refusal is not a child exit")
        self.assertEqual(result.stderr, b"")
        self.assert_lifecycle("failed", "exit:" + str(code))
    return test


for _code in (2, 7, 23, 255):
    setattr(ProcessOracle, "test_m1_m2_nonzero_exit_" + str(_code), exit_case(_code))


def signal_case(name, mode):
    def test(self):
        if mode == "self":
            result = self.invoke(child=self.child("self-signal", name))
        else:
            result = self.signal_run(name, catch=mode == "caught")
        expected = 19 if mode == "caught" else 128 + int(getattr(signal, name))
        self.assertEqual(result.returncode, expected, "signal forwarding must preserve the child's actual outcome")
        reason = "exit:19" if mode == "caught" else "signal:" + name
        self.assert_lifecycle("failed", reason)
    return test


for _signal in ("SIGINT", "SIGTERM"):
    for _mode in ("self", "forwarded", "caught"):
        setattr(ProcessOracle, "test_m1_m2_m3_" + _signal.lower() + "_" + _mode,
                signal_case(_signal, _mode))


def loss_case(code):
    def test(self):
        self.home.write_text("not a directory", encoding="utf-8")
        result = self.invoke(child=self.child("exit", str(code)))
        self.assertEqual(result.returncode, code, "room failure must not replace the child outcome")
        self.assertEqual(result.stdout, b"child-ran\n")
        self.assertTrue(self.marker.is_file(), "room failure must not prevent launch")
        diagnostics = [line for line in result.stderr.splitlines() if b"lifecycle" in line.lower()]
        self.assertEqual(len(diagnostics), 1, "report lifecycle loss once on stderr")
        self.assertEqual(self.home.read_text(), "not a directory")
    return test


for _code in (0, 29):
    setattr(ProcessOracle, "test_m3_unwritable_room_preserves_exit_" + str(_code), loss_case(_code))


# Each rejection test also checks that no child or room-side effect occurred.
INVALID = {
    "missing_separator": (BASE, False, None),
    "missing_command": (BASE, True, []),
    "missing_room": (["--agent", "exec-a"], True, None),
    "missing_agent": (["--room", "demo"], True, None),
    "empty_room": (["--room", "", "--agent", "exec-a"], True, None),
    "room_traversal": (["--room", "../escape", "--agent", "exec-a"], True, None),
    "uppercase_room": (["--room", "Demo", "--agent", "exec-a"], True, None),
    "long_room": (["--room", "r" * 49, "--agent", "exec-a"], True, None),
    "empty_agent": (["--room", "demo", "--agent", ""], True, None),
    "agent_traversal": (["--room", "demo", "--agent", "../escape"], True, None),
    "uppercase_agent": (["--room", "demo", "--agent", "Exec"], True, None),
    "long_agent": (["--room", "demo", "--agent", "a" * 49], True, None),
    "beat_below_minimum": (BASE + ["--beat", "1"], True, None),
    "beat_zero": (BASE + ["--beat", "0"], True, None),
    "beat_negative": (BASE + ["--beat", "-2"], True, None),
    "beat_above_maximum": (BASE + ["--beat", "301"], True, None),
    "beat_nan": (BASE + ["--beat", "nan"], True, None),
    "beat_infinite": (BASE + ["--beat", "inf"], True, None),
    "beat_not_numeric": (BASE + ["--beat", "soon"], True, None),
    "parent_without_run": (BASE + ["--parent", "parent-a"], True, None),
    "parent_run_without_parent": (BASE + ["--parent-run", "parent-run"], True, None),
    "invalid_parent_slug": (BASE + ["--parent", "../parent", "--parent-run", "parent-run"], True, None),
    "invalid_parent_run": (BASE + ["--parent", "parent-a", "--parent-run", "bad/run"], True, None),
    "invalid_run_id": (BASE + ["--run-id", "bad/run"], True, None),
}


class ArgumentOracle(RunCase):
    pass


def rejection_case(options, separator, child):
    def test(self):
        # Prove that `run` exists before accepting an invalid invocation's refusal.
        # The prerequisite has separate storage and a separate child marker.
        valid_env = dict(self.env, CW_HOME=str(self.scratch / "valid-home"),
                         C1B_CHILD_MARKER=str(self.scratch / "valid-started"))
        valid = self.invoke(env=valid_env)
        self.assertEqual(valid.returncode, 0, "argument checks require a working run entry")
        self.assertEqual(valid.stdout, b"child-ran\n")
        result = self.invoke(options=options, separator=separator, child=child)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.marker.exists(), "bad arguments started the child")
        self.assertFalse(self.home.exists(), "bad arguments wrote or bootstrapped room storage")
    return test


for _name, _case in INVALID.items():
    setattr(ArgumentOracle, "test_m4_" + _name, rejection_case(*_case))
