"""CL M6–M7 through the wave command boundary."""
import json
import os
import subprocess
import sys
import threading
from unittest import mock

from bridge.room.__main__ import main as room_main

from .support import BoundExceeded, RoomCase


class WaveOracle(RoomCase):
    def lane(self, index):
        return {
            "agent": f"lane-{index}", "run_id": f"attempt-{index}",
            "argv": [sys.executable, "-c", "raise SystemExit(0)", "", "two words"],
            "result_file": str(self.scratch / f"result-{index}.json"),
        }

    def manifest(self, lanes):
        return {"room": "demo", "parent": "leader", "parent_run": "leader-attempt",
                "lanes": lanes}

    def call_wave(self, manifest, spawn, *, public=False):
        if not public:
            from bridge.room.ext.wave import main as entry
        else:
            entry = room_main
        path = self.scratch / "manifest.json"
        if isinstance(manifest, str):
            path.write_text(manifest, encoding="utf-8")
        else:
            path.write_text(json.dumps(manifest), encoding="utf-8")
        argv = ["--manifest", str(path)]
        if public:
            argv.insert(0, "wave")
        with mock.patch.object(subprocess, "Popen", side_effect=spawn):
            return self.invoke(entry, argv)

    def assert_rejection(self, manifest, index=None):
        def unexpected_launch(*args, **kwargs):
            raise BoundExceeded("invalid manifest launched a process")

        before = self.journal()
        code, stdout, stderr = self.call_wave(manifest, unexpected_launch)
        self.assertNotEqual(code, 0)
        response = json.loads(stdout)
        self.assertEqual(response.get("code"), "bad_args", stderr)
        if index is not None:
            detail = response.get("detail")
            self.assertIsInstance(detail, str)
            # The indexed array may be described using zero- or one-based prose.
            self.assertRegex(detail.lower(), rf"\blanes?\b[^\d\n]*({index}|{index + 1})\b")
        self.assertEqual(self.journal(), before, "rejected manifest wrote lifecycle history")

    def test_m6_bad_lane_is_rejected_before_any_launch_or_registration(self):
        bad = self.lane(1)
        bad["argv"] = []
        self.assert_rejection(self.manifest([self.lane(0), bad]), 1)

    def test_m6_duplicate_agent_run_pair_is_rejected(self):
        second = self.lane(1)
        second.update(agent="lane-0", run_id="attempt-0")
        self.assert_rejection(self.manifest([self.lane(0), second]), 1)

    def test_m6_duplicate_result_file_is_rejected(self):
        second = self.lane(1)
        second["result_file"] = self.lane(0)["result_file"]
        self.assert_rejection(self.manifest([self.lane(0), second]), 1)

    def test_m6_same_result_file_with_dot_alias_is_rejected(self):
        second = self.lane(1)
        second["result_file"] = os.path.join(str(self.scratch), ".", "result-0.json")
        self.assert_rejection(self.manifest([self.lane(0), second]), 1)

    def test_m6_malformed_lane_values_are_rejected_before_launch(self):
        for key, value in (
            ("argv", "a string is not an argv array"), ("argv", [""]),
            ("argv", ["tool", 7]), ("argv", ["tool", "\x00"]),
            ("agent", "../escape"), ("run_id", []), ("result_file", ""),
            ("harness", []), ("wall_s", "later"),
        ):
            bad = self.lane(1)
            bad[key] = value
            self.assert_rejection(self.manifest([self.lane(0), bad]), 1)

    def test_m6_missing_required_header_is_rejected(self):
        manifest = self.manifest([self.lane(0)])
        del manifest["parent_run"]
        self.assert_rejection(manifest)

    def test_m6_missing_required_lane_key_is_rejected(self):
        bad = self.lane(1)
        del bad["result_file"]
        self.assert_rejection(self.manifest([self.lane(0), bad]), 1)

    def test_m6_empty_lane_list_is_rejected(self):
        self.assert_rejection(self.manifest([]))

    def test_m6_over_lane_limit_is_rejected(self):
        self.assert_rejection(self.manifest([self.lane(n) for n in range(65)]))

    def test_m6_malformed_json_is_rejected(self):
        self.assert_rejection('{"lanes":[')

    def test_m6_public_cli_routes_manifest_option(self):
        lane = self.lane(0)
        self.assert_successful_wave([lane], public=True)

    def test_m6_minimum_single_lane_is_admitted(self):
        self.assert_successful_wave([self.lane(0)])

    def test_m6_maximum_64_lanes_are_admitted(self):
        self.assert_successful_wave([self.lane(n) for n in range(64)])

    def test_m6_concurrent_lanes_preserve_run_options_and_wait_for_all(self):
        first, second = self.lane(0), self.lane(1)
        first.update(harness="codex", wall_s=40)
        self.assert_successful_wave([first, second])

    def test_m6_mixed_finish_and_failure_returns_all_rows_and_nonzero(self):
        self.assert_successful_wave([self.lane(0), self.lane(1), self.lane(2)],
                                    outcomes={"lane-1": ("failed", "exit:19", 19)})

    def test_m6_cancellation_with_zero_child_exit_fails_wave(self):
        self.assert_successful_wave([self.lane(0), self.lane(1)],
                                    outcomes={"lane-1": ("failed", "wall_timeout", 0)})

    def assert_successful_wave(self, lanes, *, outcomes=None, public=False, skipped=()):
        # Parent admission is a pre-existing lifecycle concern. Seed a real
        # parent so this probe also verifies that the wrapper received both IDs.
        if not self.journal():
            self.lifecycle("leader", "leader-attempt", "deployed")
        outcomes = outcomes or {}
        success = ("finished", "exit:0", 0)
        expected = {(lane["agent"], lane["run_id"]): lane for lane in lanes}
        to_launch = set(expected) - set(skipped)
        launched, completed = set(), set()
        all_started = threading.Event()
        lock = threading.RLock()

        def spawn(command, *positional, **kwargs):
            command = list(command)
            self.assertFalse(kwargs.get("shell", False))
            separator = command.index("--")
            run = command[:separator]
            self.assertIn("run", run)
            self.assertNotIn("--no-group", run)
            tokens = iter(run[run.index("run") + 1:])
            flags = {}
            for token in tokens:
                key, equal, value = token.partition("=")
                flags[key] = value if equal else next(tokens)
            identity = flags["--agent"], flags["--run-id"]
            self.assertIn(identity, to_launch, "unexpected or previously terminal run launched")
            lane = expected[identity]
            self.assertEqual(command[separator + 1:], lane["argv"])
            self.assertEqual(flags["--room"], "demo")
            self.assertEqual(flags["--parent"], "leader")
            self.assertEqual(flags["--parent-run"], "leader-attempt")
            self.assertEqual(os.path.abspath(flags["--result-file"]), lane["result_file"])
            if "harness" in lane:
                self.assertEqual(flags["--harness"], lane["harness"])
            if "wall_s" in lane:
                self.assertEqual(float(flags["--wall-s"]), lane["wall_s"])

            with lock:
                self.assertNotIn(identity, launched)
                launched.add(identity)
                self.lifecycle(*identity, "deployed", parent_agent="leader",
                               parent_run_id="leader-attempt")
                if launched == to_launch:
                    all_started.set()

            class Wrapper:
                returncode = None
                args = command
                stdin = stdout = stderr = None

                def poll(wrapper):
                    if not all_started.is_set():
                        return None
                    with lock:
                        if wrapper.returncode is None:
                            state, reason, status = outcomes.get(identity[0], success)
                            self.lifecycle(*identity, state, reason=reason)
                            completed.add(identity)
                            wrapper.returncode = status
                    return wrapper.returncode

                def wait(wrapper, timeout=None):
                    # Event, not elapsed time, releases a lane. The timeout
                    # only bounds deadlock if a coordinator waits serially.
                    if not all_started.wait(timeout=2):
                        raise BoundExceeded("wave waited for a lane before starting its peers")
                    return wrapper.poll()

                def communicate(wrapper, input=None, timeout=None):
                    wrapper.wait(timeout)
                    return None, None

                def __enter__(wrapper):
                    return wrapper

                def __exit__(wrapper, *_):
                    wrapper.wait()

            return Wrapper()

        code, stdout, stderr = self.call_wave(self.manifest(lanes), spawn, public=public)
        self.assertEqual(launched, to_launch, (stdout, stderr))
        self.assertEqual(completed, to_launch, "wave returned before all wrappers completed")
        self.assertEqual(len(stdout.splitlines()), 1, "wave must emit a single JSON summary line")
        rows = json.loads(stdout)["wave"]["lanes"]
        actual = {(row["agent"], row["run_id"]): row for row in rows}
        self.assertEqual(len(rows), len(expected))
        self.assertEqual(actual.keys(), expected.keys())
        for identity in to_launch:
            row = actual[identity]
            self.assertEqual((row["state"], row["reason"], row["exit"]),
                             outcomes.get(identity[0], success))
        for identity in skipped:
            row = actual[identity]
            # Accept either a dedicated skip field or the uniform state/reason
            # record, since the spec gives the skip token in prose.
            if "skipped" in row:
                self.assertEqual(row["skipped"], "already_terminal")
            else:
                self.assertEqual((row["state"], row["reason"]),
                                 ("skipped", "already_terminal"))
        all_finished = not skipped and all(
            outcomes.get(agent, success)[0] == "finished" for agent, _ in to_launch
        )
        self.assertEqual(code == 0, all_finished)
        return rows

    def terminal_history(self, lane, state):
        identity = lane["agent"], lane["run_id"]
        self.lifecycle(*identity, "deployed", parent_agent="leader",
                       parent_run_id="leader-attempt")
        self.lifecycle(*identity, state, reason="exit:0" if state == "finished" else "exit:9")

    def test_m7_finished_run_is_skipped_and_new_run_is_admitted(self):
        lane, sibling = self.lane(0), self.lane(1)
        self.lifecycle("leader", "leader-attempt", "deployed")
        self.terminal_history(lane, "finished")
        identity = lane["agent"], lane["run_id"]
        before = self.journal()
        self.assert_successful_wave([lane, sibling], skipped=[identity])
        self.assertEqual([row for row in self.journal()
                          if row["agent"] == lane["agent"]], [
                              row for row in before if row["agent"] == lane["agent"]
                          ])
        retry = {**lane, "run_id": "retry-0", "result_file": sibling["result_file"]}
        self.assert_successful_wave([retry])

    def test_m7_failed_historical_run_is_skipped_even_after_newer_run(self):
        lane = self.lane(0)
        self.lifecycle("leader", "leader-attempt", "deployed")
        self.terminal_history(lane, "failed")
        self.terminal_history({**lane, "run_id": "newer-attempt"}, "finished")
        before = self.journal()
        self.assert_successful_wave([lane], skipped=[(lane["agent"], lane["run_id"])])
        self.assertEqual(self.journal(), before)

    def test_m7_terminal_pair_in_another_room_does_not_block_launch(self):
        lane = self.lane(0)
        self.lifecycle("leader", "leader-attempt", "deployed", room="other")
        args = lane["agent"], lane["run_id"]
        self.lifecycle(*args, "deployed", room="other",
                       parent_agent="leader", parent_run_id="leader-attempt")
        self.lifecycle(*args, "finished", room="other", reason="exit:0")
        self.assert_successful_wave([lane])
