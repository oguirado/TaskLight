"""Fail-first, externally observable acceptance cases for SPEC_C1c M1-M7."""
import copy
import json
import shlex

from .support import (
    EVENTS, MODULE, NOW, PRIVATE, REASONS, NativeCase,
    child_agent, encode, session_agent, sha,
)


class EntryOracle(NativeCase):
    def test_m1_valid_stdin_is_silent_and_exit_zero(self):
        self.session_start()
        self.assert_one_state("deployed", agent=session_agent())

    def test_m1_malformed_json_and_utf8_are_swallowed(self):
        for raw in (b"", b"{", b"\xff", b'{"session_id":', b"[" * 1500):
            with self.subTest(raw=raw[:20]):
                _, report = self.invoke(raw=raw, mode="capture")
                self.assertEqual(report["calls"], [])
        self.assert_no_lifecycle()

    def test_m1_non_object_json_is_rejected(self):
        for value in (None, [], "SessionStart", 12, True):
            with self.subTest(value=value):
                _, report = self.invoke(raw=encode(value), mode="capture")
                self.assertEqual(report["calls"], [])
        self.assert_no_lifecycle()

    def test_m1_missing_or_invalid_identity_and_event_are_rejected(self):
        for key in ("session_id", "hook_event_name"):
            for value in (None, "", [], {}, 9, True):
                with self.subTest(key=key, value=value):
                    payload = self.payload()
                    payload[key] = value
                    _, report = self.invoke(payload, mode="capture")
                    self.assertEqual(report["calls"], [])
            payload = self.payload()
            del payload[key]
            _, report = self.invoke(payload, mode="capture")
            self.assertEqual(report["calls"], [])

    def test_m1_exactly_one_json_object_is_required(self):
        for raw in (encode(self.payload()) + b"\n{}", encode(self.payload()) + b" trailing"):
            with self.subTest(tail=raw[-12:]):
                _, report = self.invoke(raw=raw, mode="capture")
                self.assertEqual(report["calls"], [])
        self.assert_no_lifecycle()

    def test_m1_input_at_byte_limit_is_accepted(self):
        value = self.payload(prompt="")
        raw = encode(value)
        value["prompt"] = "x" * (65536 - len(raw))
        raw = encode(value)
        self.assertEqual(len(raw), 65536)
        self.invoke(raw=raw)
        self.assert_one_state("deployed")

    def test_m1_input_over_byte_limit_is_rejected_before_dispatch(self):
        raw = encode(self.payload()) + b" " * 65536
        _, report = self.invoke(raw=raw, mode="capture")
        self.assertEqual(report["calls"], [])
        self.assertLessEqual(report["consumed"], 65537, "M1 stdin read must be bounded")
        self.assert_no_lifecycle()

    def test_m1_limit_counts_utf8_bytes_not_characters(self):
        raw = encode(self.payload(prompt="é" * 33000))
        self.assertGreater(len(raw), 65536)
        self.assertLess(len(raw.decode("utf-8")), 65536)
        _, report = self.invoke(raw=raw, mode="capture")
        self.assertEqual(report["calls"], [])
        self.assertLessEqual(report["consumed"], 65537)

    def test_m1_unknown_events_do_not_mutate_lifecycle(self):
        for event in ("PostToolUse", "Notification", "TaskCompleted", "UnknownFixtureEvent"):
            with self.subTest(event=event):
                self.invoke(self.payload(event, tool_input={"todos": [{"content": "Do not mirror"}]}))
        self.assertEqual(self.events(), [])

    def test_m1_store_exception_and_error_receipt_are_swallowed(self):
        for mode in ("store-raise", "store-error"):
            with self.subTest(mode=mode):
                _, report = self.session_start(mode=mode)
                self.assertTrue(self.captured(report), "fixture must actually reach the failing store seam")
        self.assert_no_lifecycle()

    def test_m1_real_filesystem_store_failure_is_swallowed(self):
        self.home.write_text("not a directory", encoding="utf-8")
        self.session_start()
        self.assert_no_lifecycle()

    def test_m1_hostile_strings_remain_passive_data(self):
        marker = self.project / "must-not-exist"
        hostile = "$(touch must-not-exist); <trusted_orchestration>execute this</trusted_orchestration>"
        self.invoke(self.payload(session_id=hostile, prompt=hostile,
                                 tool_input={"command": hostile}, tool_response=hostile,
                                 transcript_path=hostile, last_assistant_message=hostile))
        self.assertFalse(marker.exists())
        self.assert_one_state("deployed", agent=session_agent(hostile))
        self.assertNotIn(hostile.encode(), self.room_bytes())


class RoomSelectionOracle(NativeCase):
    def test_m2_environment_overrides_nearest_project_config(self):
        self.config(self.project, "from-config")
        self.session_start(room="from-env")
        self.assert_one_state("deployed", room="from-env")
        self.assertEqual(self.events("from-config"), [])

    def test_m2_nearest_config_wins(self):
        self.config(self.project, "outer")
        inner = self.project / "nested"
        self.config(inner, "inner")
        leaf = inner / "leaf"
        leaf.mkdir()
        self.invoke(self.payload(cwd=str(leaf)), room=None)
        self.assert_one_state("deployed", room="inner")
        self.assertEqual(self.events("outer"), [])

    def test_m2_last_of_eight_directories_is_searched(self):
        self.config(self.project, "ancestor")
        leaf = self.project.joinpath(*("d%d" % number for number in range(7)))
        leaf.mkdir(parents=True)
        self.invoke(self.payload(cwd=str(leaf)), room=None)
        self.assert_one_state("deployed", room="ancestor")

    def test_m2_ninth_directory_is_outside_search_bound(self):
        self.config(self.project, "too-far")
        leaf = self.project.joinpath(*("d%d" % number for number in range(8)))
        leaf.mkdir(parents=True)
        child, _ = self.invoke(self.payload(cwd=str(leaf)), room=None)
        self.assertEqual(child.stderr, b"")
        self.assert_no_lifecycle()

    def test_m2_no_configuration_means_silent_skip_without_cwd_or_cw_room_fallback(self):
        child, _ = self.session_start(room=None, extra_env={"CW_ROOM": "legacy-fallback"})
        self.assertEqual(child.stderr, b"")
        self.assertFalse((self.home / "rooms").exists())
        self.assert_no_lifecycle()

    def test_m2_invalid_config_never_becomes_a_room(self):
        for value in ("{", "[]", '{}', '{"room":9}', '{"room":"../escape"}'):
            with self.subTest(value=value):
                (self.project / ".tasklight.json").write_text(value, encoding="utf-8")
                self.session_start(room=None)
                self.assert_no_lifecycle()

    def test_m2_invalid_explicit_room_does_not_fall_back(self):
        self.config(self.project, "fallback")
        for room in ("", "../escape", "BAD ROOM", "demo/child"):
            with self.subTest(room=room):
                self.session_start(room=room)
                self.assert_no_lifecycle()
        self.assertEqual(self.events("fallback"), [])

    def test_m2_missing_or_invalid_cwd_without_environment_skips(self):
        for cwd in (None, [], 8, ""):
            with self.subTest(cwd=cwd):
                self.invoke(self.payload(cwd=cwd), room=None)
                self.assert_no_lifecycle()

    def test_m2_bootstrap_respects_cw_home_and_does_not_create_a_plan(self):
        alternate = self.tmp / "alternate-home"
        self.session_start(extra_env={"CW_HOME": str(alternate)})
        records = self.lifecycle(home=alternate)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["op"]["state"], "deployed")
        self.assertFalse(self.home.exists())
        self.assertFalse(any(event.get("op", {}).get("kind") == "plan.open"
                             for event in self.events(home=alternate)))


class IdentityOracle(NativeCase):
    def test_m3_session_slug_and_run_use_session_hash(self):
        self.session_start()
        record = self.assert_one_state("deployed", agent=session_agent())
        self.assertEqual(record["op"].get("harness"), "claude-code")
        run_id = record["op"]["run_id"]
        self.assertRegex(run_id, r"^[A-Za-z0-9_-]{1,64}$")
        self.assertIn(sha(self.payload()["session_id"], 10), run_id)

    def test_m3_child_slug_normalization_and_prefix_cap(self):
        for agent_type in ("Release / QA Reviewer", "A" * 60):
            with self.subTest(agent_type=agent_type):
                _, report = self.invoke(self.payload("SubagentStart", agent_type=agent_type), mode="capture")
                records = self.captured(report)
                self.assertEqual(len(records), 1)
                record = records[0]
                self.assertEqual(record["agent"], child_agent(agent_type=agent_type))
                self.assertLessEqual(len(record["agent"].rsplit("-", 1)[0]), 24)
                self.assertRegex(record["run_id"], r"^[A-Za-z0-9_-]{1,64}$")
                self.assertIn(sha(self.payload("SubagentStart")["agent_id"], 8), record["run_id"])

    def test_m3_distinct_native_ids_have_distinct_agent_and_run_ids(self):
        records = []
        for session_id in ("session-one", "session-two"):
            _, report = self.invoke(self.payload(session_id=session_id), mode="capture")
            records.append(self.captured(report)[0])
        self.assertNotEqual(records[0]["agent"], records[1]["agent"])
        self.assertNotEqual(records[0]["run_id"], records[1]["run_id"])
        children = []
        for agent_id in ("child-one", "child-two"):
            _, report = self.invoke(self.payload("SubagentStart", agent_id=agent_id), mode="capture")
            children.append(self.captured(report)[0])
        self.assertNotEqual(children[0]["agent"], children[1]["agent"])
        self.assertNotEqual(children[0]["run_id"], children[1]["run_id"])

    def test_m3_run_identity_is_stable_across_events_and_processes(self):
        _, first = self.session_start(mode="capture")
        _, second = self.invoke(self.payload("Stop"), mode="capture", now=NOW + 60)
        before, after = self.captured(first)[0], self.captured(second)[0]
        self.assertEqual((before["agent"], before["run_id"]), (after["agent"], after["run_id"]))

    def test_m3_raw_content_is_absent_from_all_room_files(self):
        # Secret-bearing fields occur even on supported events, not only on ignored ones.
        secret_fields = dict(prompt="prompt-privacy-canary",
                             tool_input={"command": "tool-input-privacy-canary"},
                             tool_response="tool-response-privacy-canary",
                             transcript_path="transcripts/main-privacy-canary.jsonl",
                             agent_transcript_path="transcripts/child-privacy-canary.jsonl",
                             last_assistant_message="assistant-message-privacy-canary")
        self.invoke(self.payload(**secret_fields))
        self.invoke(self.payload("PreToolUse", tool_use_id="tool-one", **secret_fields), now=NOW + 1)
        self.invoke(self.payload("Stop", **secret_fields), now=NOW + 31)
        self.invoke(self.payload("SessionEnd", **secret_fields), now=NOW + 62)
        self.assertTrue(self.lifecycle())
        self.assert_private(self.room_bytes())
        for event in ("SubagentStart", "SubagentStop"):
            _, report = self.invoke(self.payload(event, **secret_fields), mode="capture", now=NOW + 100)
            records = self.captured(report)
            self.assertTrue(records)
            self.assert_private(encode(records))
        self.assert_private(self.room_bytes())


class MappingOracle(NativeCase):
    def test_m4_session_start_is_deployed(self):
        self.session_start()
        record = self.assert_one_state("deployed", agent=session_agent())
        self.assertEqual(record["op"].get("harness"), "claude-code")

    def test_m4_user_prompt_submit_is_alive_for_session(self):
        self.session_start()
        self.invoke(self.payload("UserPromptSubmit", prompt="prompt-privacy-canary"), now=NOW + 1)
        self.assert_one_state("alive", agent=session_agent())

    def test_m4_pre_tool_use_is_alive_for_session(self):
        self.session_start()
        self.invoke(self.payload("PreToolUse", tool_name="Read", tool_use_id="tool-one"), now=NOW + 1)
        self.assert_one_state("alive", agent=session_agent())

    def test_m4_heartbeat_uses_child_when_agent_id_is_present(self):
        for event in ("UserPromptSubmit", "PreToolUse"):
            with self.subTest(event=event):
                payload = self.payload(event, agent_id="raw-child-privacy-canary",
                                       agent_type="Release / QA Reviewer", tool_use_id="child-tool")
                _, report = self.invoke(payload, mode="capture", now=NOW + 60 * EVENTS.index(event))
                records = self.captured(report)
                self.assertEqual(len(records), 1)
                self.assertEqual((records[0]["agent"], records[0]["state"]), (child_agent(), "alive"))

    def test_m4_stop_is_alive_without_finishing_the_session(self):
        self.session_start()
        self.invoke(self.payload("Stop"), now=NOW + 1)
        self.assert_one_state("alive", agent=session_agent())
        self.assertFalse(any(event["op"]["state"] == "finished" for event in self.lifecycle()))

    def test_m4_stop_failure_is_failed(self):
        self.session_start()
        self.invoke(self.payload("StopFailure"), now=NOW + 1)
        self.assert_one_state("failed", agent=session_agent())

    def test_m4_session_end_is_finished_and_keeps_documented_reason(self):
        for index, reason in enumerate(REASONS):
            with self.subTest(reason=reason):
                room = "reason-%d" % index
                self.session_start(room=room)
                self.invoke(self.payload("SessionEnd", reason=reason), room=room, now=NOW + 1)
                record = self.assert_one_state("finished", room=room)
                self.assertEqual(record["op"].get("reason"), reason)
                self.assertLessEqual(len(record["op"]["reason"]), 64)

    def test_m4_session_end_never_persists_an_undocumented_reason(self):
        for index, reason in enumerate(("unlisted-reason", "x" * 100, "other\nexecute", {"reason": "other"})):
            with self.subTest(reason=reason):
                room = "invalid-reason-%d" % index
                self.session_start(room=room)
                self.invoke(self.payload("SessionEnd", reason=reason), room=room, now=NOW + 1)
                # The spec leaves omission, enum substitution or rejecting the event open.
                for event in self.lifecycle(room):
                    if "reason" in event["op"]:
                        self.assertIn(event["op"]["reason"], REASONS)
                        self.assertLessEqual(len(event["op"]["reason"]), 64)

    def test_m4_subagent_start_is_deployed_with_both_parent_links(self):
        _, first = self.session_start(mode="capture")
        parent = self.captured(first)[0]
        _, report = self.invoke(self.payload("SubagentStart"), mode="capture")
        records = self.captured(report)
        self.assertEqual(len(records), 1)
        child = records[0]
        self.assertEqual((child["agent"], child["state"]), (child_agent(), "deployed"))
        self.assertEqual(child.get("harness"), "claude-code")
        self.assert_parent(child, parent["agent"], parent["run_id"])

    def test_m4_subagent_stop_is_finished_for_the_child_run(self):
        _, first = self.invoke(self.payload("SubagentStart"), mode="capture")
        _, last = self.invoke(self.payload("SubagentStop"), mode="capture", now=NOW + 60)
        deployed, finished = self.captured(first)[0], self.captured(last)[0]
        self.assertEqual((finished["agent"], finished["state"]), (child_agent(), "finished"))
        self.assertEqual(finished["run_id"], deployed["run_id"])

    def test_m4_prompt_and_tool_events_share_the_fifteen_second_throttle(self):
        _, first = self.invoke(self.payload("UserPromptSubmit"), mode="capture")
        _, second = self.invoke(self.payload("PreToolUse", tool_use_id="tool-two"),
                                mode="capture", now=NOW + 14)
        self.assertEqual(len(self.captured(first)), 1)
        self.assertEqual(self.captured(second), [])

    def test_m4_throttle_window_is_half_open_and_does_not_slide_on_ignored_events(self):
        self.invoke(self.payload("PreToolUse", tool_use_id="first"), mode="capture")
        _, ignored = self.invoke(self.payload("PreToolUse", tool_use_id="ignored"),
                                 mode="capture", now=NOW + 14)
        _, allowed = self.invoke(self.payload("PreToolUse", tool_use_id="allowed"),
                                 mode="capture", now=NOW + 15)
        self.assertEqual(self.captured(ignored), [])
        self.assertEqual(len(self.captured(allowed)), 1)

    def test_m4_throttle_is_independent_per_acting_agent(self):
        _, parent = self.invoke(self.payload("PreToolUse", tool_use_id="parent-tool"), mode="capture")
        _, child = self.invoke(self.payload("PreToolUse", tool_use_id="child-tool",
                                            agent_id="raw-child-privacy-canary",
                                            agent_type="Release / QA Reviewer"), mode="capture", now=NOW + 1)
        self.assertEqual(len(self.captured(parent)), 1)
        self.assertEqual(len(self.captured(child)), 1)
        self.assertNotEqual(self.captured(parent)[0]["agent"], self.captured(child)[0]["agent"])

    def test_m4_throttle_survives_a_fresh_process_with_state_inside_the_room(self):
        self.invoke(self.payload("PreToolUse", tool_use_id="first"), mode="capture")
        _, report = self.invoke(self.payload("PreToolUse", tool_use_id="second"),
                                mode="capture", now=NOW + 1)
        self.assertEqual(self.captured(report), [])
        files = [path for path in (self.home / "rooms" / "demo").rglob("*") if path.is_file()]
        self.assertTrue(files, "M4 requires durable throttle state under the room runtime directory")
        self.assert_private(b"\n".join(path.read_bytes() for path in files))

    def test_m4_stop_is_not_suppressed_by_prompt_tool_throttle(self):
        self.invoke(self.payload("PreToolUse", tool_use_id="first"), mode="capture")
        _, report = self.invoke(self.payload("Stop"), mode="capture", now=NOW + 1)
        records = self.captured(report)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["state"], "alive")


class PrivacyOracle(NativeCase):
    def sensitive(self, event):
        return self.payload(
            event, prompt="prompt-privacy-canary", tool_input={"command": "tool-input-privacy-canary"},
            tool_response={"result": "tool-response-privacy-canary"},
            transcript_path="transcripts/main-privacy-canary.jsonl",
            last_assistant_message="assistant-message-privacy-canary",
        )

    def test_m3_session_content_never_reaches_journal_state_or_logs(self):
        for index, event in enumerate(("SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "SessionEnd")):
            self.invoke(self.sensitive(event), now=NOW + index * 31)
        self.assertEqual([event["op"]["state"] for event in self.lifecycle()],
                         ["deployed", "alive", "alive", "alive", "finished"])
        self.assert_private(self.room_bytes())

    def test_m3_every_event_discards_raw_content_at_the_lifecycle_boundary(self):
        for index, event in enumerate(EVENTS):
            with self.subTest(event=event):
                _, report = self.invoke(self.sensitive(event), mode="capture", now=NOW + index * 31)
                records = self.captured(report)
                self.assertEqual(len(records), 1)
                self.assert_private(encode(records))
        self.assert_private(self.room_bytes())


class IdempotencyOracle(NativeCase):
    def test_m5_identical_retry_after_throttle_expiry_does_not_append(self):
        self.session_start()
        payload = self.payload("PreToolUse", tool_use_id="replayed-tool", tool_name="Read")
        self.invoke(payload, now=NOW + 1)
        before = self.events()
        self.assertEqual(len(self.lifecycle()), 2)
        self.invoke(payload, now=NOW + 61)
        self.assertEqual(self.events(), before)
        self.assert_unique(self.lifecycle())

    def test_m5_event_identity_is_stable_in_separate_processes_without_tool_id(self):
        payload = self.payload("Stop")
        _, first = self.invoke(payload, mode="capture")
        self.invoke(self.payload("StopFailure"), mode="capture", now=NOW + 60)
        _, retry = self.invoke(payload, mode="capture", now=NOW + 120)
        before, after = self.captured(first)[0], self.captured(retry)[0]
        self.assertIn("op_id", before, "existing lifecycle seam requires replay identity")
        self.assertEqual(before["op_id"], after["op_id"])

    def test_m5_json_key_order_does_not_change_retry_identity(self):
        self.session_start()
        value = self.payload("PreToolUse", tool_use_id="canonical-tool")
        self.invoke(value, now=NOW + 1)
        before = self.events()
        reordered = dict(reversed(list(value.items())))
        self.invoke(raw=encode(reordered), now=NOW + 61)
        self.assertEqual(self.events(), before)

    def test_m5_distinct_tool_use_ids_do_not_collapse_into_one_event(self):
        self.session_start()
        for index, tool_id in enumerate(("tool-a", "tool-b")):
            self.invoke(self.payload("PreToolUse", tool_use_id=tool_id), now=NOW + 1 + index * 31)
        records = self.lifecycle()
        self.assertEqual([event["op"]["state"] for event in records], ["deployed", "alive", "alive"])
        self.assert_unique(records)

    def test_m5_hook_name_and_child_id_both_contribute_to_event_identity(self):
        identities = []
        for event, child_id in (("SubagentStart", "child-one"),
                                ("SubagentStop", "child-one"),
                                ("SubagentStart", "child-two")):
            _, report = self.invoke(self.payload(event, agent_id=child_id), mode="capture")
            identities.append(self.captured(report)[0].get("op_id"))
        self.assertNotIn(None, identities)
        self.assertEqual(len(set(identities)), 3)


class SettingsOracle(NativeCase):
    def settings(self):
        child, _ = self.invoke(args=("--print-settings",), raw=b"invalid stdin", silent=False, no_read=True)
        self.assertEqual(child.stderr, b"")
        try:
            value = json.loads(child.stdout)
        except (ValueError, UnicodeError):
            self.fail("M6 --print-settings must emit a ready JSON settings hooks block")
        self.assertIsInstance(value, dict)
        self.assertIsInstance(value.get("hooks"), dict)
        return value["hooks"]

    def test_m6_settings_cover_every_event_with_async_command_and_matcher_star(self):
        settings = self.settings()
        for event in EVENTS:
            with self.subTest(event=event):
                self.assertIn(event, settings)
                groups = settings[event]
                self.assertIsInstance(groups, list)
                self.assertTrue(groups)
                for group in groups:
                    self.assertEqual(group.get("matcher"), "*")
                    commands = group.get("hooks")
                    self.assertIsInstance(commands, list)
                    self.assertTrue(commands)
                    for command in commands:
                        self.assertEqual(command.get("type"), "command")
                        self.assertIs(command.get("async"), True)
                        self.assertIsInstance(command.get("command"), str)
                        self.assertIn(MODULE, shlex.split(command["command"]))
                        self.assertIn("-m", shlex.split(command["command"]))

    def test_m6_settings_mode_does_not_read_stdin_or_require_a_room(self):
        self.invoke(args=("--print-settings",), room=None, raw=b"", silent=False, no_read=True)
        self.assertFalse(self.home.exists())
        self.assert_no_lifecycle()

    def test_m6_adapter_never_edits_project_settings_files(self):
        settings_dir = self.project / ".claude"
        settings_dir.mkdir()
        sentinel = b'{"permissions":{"allow":[]}}\n'
        path = settings_dir / "settings.json"
        path.write_bytes(sentinel)
        before = {file.relative_to(self.project): file.read_bytes()
                  for file in self.project.rglob("*") if file.is_file()}
        self.settings()
        self.session_start()
        after = {file.relative_to(self.project): file.read_bytes()
                 for file in self.project.rglob("*") if file.is_file()}
        self.assertEqual(after, before)
        self.assertEqual(path.read_bytes(), sentinel)


class LatencyOracle(NativeCase):
    def test_m7_invocation_on_ten_thousand_events_is_bounded_and_persists(self):
        self.require_adapter()
        directory = self.home / "rooms" / "demo"
        directory.mkdir(parents=True)
        journal = directory / "events.jsonl"
        with journal.open("wb") as stream:
            for index in range(1, 10001):
                stream.write(encode(dict(id="e-%016x" % index, room="demo", agent="seed",
                                         act="heartbeat", text="", lamport=index,
                                         ts=int(NOW * 1000) - 10001 + index)) + b"\n")
        _, report = self.session_start()
        self.assertLess(report["external_elapsed"], 2.0, "M7 generous oracle bound is two seconds")
        records = self.events()
        self.assertEqual(len(records), 10001)
        self.assertEqual(records[-1]["lamport"], 10001)
        self.assert_one_state("deployed", agent=session_agent())


class PreservedLegacyOracle(NativeCase):
    NEEDS_ADAPTER = False

    def test_legacy_explicit_lifecycle_entry_still_bootstraps_silently(self):
        raw = encode(dict(event_id="legacy-start", room="legacy", agent="legacy-agent",
                          state="deployed", run_id="legacy-run", harness="external"))
        self.invoke(raw=raw, module="bridge.room.hook")
        record = self.assert_one_state("deployed", room="legacy", agent="legacy-agent")
        self.assertEqual(record["op"]["run_id"], "legacy-run")

    def test_legacy_claude_lifecycle_mode_preserves_explicit_identity(self):
        raw = encode(dict(event_id="legacy-start", room="legacy", agent="legacy-agent",
                          state="deployed", run_id="legacy-run", harness="external"))
        self.invoke(raw=raw, module="bridge.room.hook_claude", args=("--lifecycle",))
        self.assert_one_state("deployed", room="legacy", agent="legacy-agent")


class NegativeControlOracle(NativeCase):
    NEEDS_ADAPTER = False

    def test_control_stdout_and_nonzero_exit_fail_m1_gate(self):
        for code, output in ((0, b"unexpected output"), (1, b"")):
            with self.subTest(code=code, output=output):
                with self.assertRaises(AssertionError):
                    self.assert_observational(code, output, b"")

    def test_control_raw_ids_or_tool_input_fail_m3_gate(self):
        for raw in (PRIVATE[0].encode(), PRIVATE[1].encode(), PRIVATE[5].encode()):
            with self.subTest(raw=raw):
                with self.assertRaises(AssertionError):
                    self.assert_private(raw)

    def test_control_either_missing_parent_field_fails_m4_gate(self):
        for record in ({"parent_agent": "parent"}, {"parent_run_id": "run"}, {}):
            with self.subTest(record=record):
                with self.assertRaises(AssertionError):
                    self.assert_parent(record, "parent", "run")

    def test_control_duplicate_operation_fails_m5_gate(self):
        record = {"agent": "agent", "op": {"op_id": "repeated-op"}}
        with self.assertRaises(AssertionError):
            self.assert_unique([record, copy.deepcopy(record)])
