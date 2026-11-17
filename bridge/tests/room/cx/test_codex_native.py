"""SPEC_CX M1-M5: entry, mappings, stable identities and hostile inputs."""

import json

from .support import (
    AGENT_TYPE, CHILD, EVENTS, IGNORED, LIMIT, MODULE, NOW, SESSION,
    NativeCase, child_agent, child_run, encode, parent_agent, parent_run,
)


class EntryOracle(NativeCase):
    def test_m1_callable_main_is_silent_and_zero(self):
        report = self.invoke(callable_main=True)
        self.assertEqual(len(report["calls"]), 1)
        self.assertEqual(report["calls"][0]["state"], "deployed")

    def test_m1_module_entry_uses_existing_lifecycle_executor(self):
        report = self.invoke()
        self.assertEqual(len(report["calls"]), 1)
        value = report["calls"][0]
        self.assertEqual(value["room"], "demo")
        self.assertEqual(value["harness"], "codex")
        self.assertEqual(value["agent"], parent_agent())
        self.assertEqual(value["run_id"], parent_run())

    def test_m1_no_direct_journal_access(self):
        # The probe replaces the established executor with a success receipt.
        # Any journal open outside that executor is recorded as a violation.
        report = self.invoke()
        self.assertEqual(len(report["calls"]), 1)
        self.assertEqual(list(self.home.rglob("events.jsonl")), [])

    def test_m1_real_dispatch_bootstraps_and_persists(self):
        self.invoke(mode="real")
        records = self.records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["agent"], parent_agent())
        self.assertEqual(records[0]["op"]["state"], "deployed")

    def test_m1_environment_room_overrides_project(self):
        self.config(self.project, {"room": "project-room"})
        report = self.invoke(room="environment-room")
        self.assertEqual([value["room"] for value in report["calls"]], ["environment-room"])

    def test_m1_nearest_project_room_wins(self):
        self.config(self.project.parent, {"room": "near-room"})
        self.config(self.project.parents[2], {"room": "far-room"})
        report = self.invoke(room=None)
        self.assertEqual([value["room"] for value in report["calls"]], ["near-room"])

    def test_m1_cwd_project_configuration_is_discovered(self):
        self.config(self.project, {"room": "cwd-room"})
        report = self.invoke(room=None)
        self.assertEqual([value["room"] for value in report["calls"]], ["cwd-room"])

    def test_m1_last_of_eight_directories_is_discovered(self):
        self.config(self.project.parents[6], {"room": "edge-room"})
        report = self.invoke(room=None)
        self.assertEqual([value["room"] for value in report["calls"]], ["edge-room"])

    def test_m1_ninth_directory_is_not_discovered(self):
        self.config(self.project.parents[7], {"room": "outside-room"})
        self.assert_skipped(room=None)

    def test_m1_missing_room_skips_without_writes(self):
        # An empty authoritative config isolates the fixture from ancestor
        # configuration belonging to whoever runs the public test suite.
        self.config(self.tmp, {})
        self.assert_skipped(room=None)

    def test_m1_missing_cwd_without_environment_room_skips(self):
        payload = self.payload()
        del payload["cwd"]
        self.assert_skipped(payload, room=None)

    def test_m1_invalid_environment_never_falls_back(self):
        self.config(self.project, {"room": "fallback-room"})
        for room in ("", "Invalid Room", "../escape", "UPPERCASE"):
            self.assert_skipped(room=room)

    def test_m1_invalid_nearest_configuration_never_falls_back(self):
        self.config(self.project.parent, {"room": "fallback-room"})
        for raw in (b"{", b"[]", b"{}", b'{"room":4}', b'{"room":"bad room"}',
                    b'{"room":"near-room","room":"other-room"}',
                    b'{"room":"near-room","bad":NaN}', b" " * (LIMIT + 1)):
            (self.project / ".tasklight.json").write_bytes(raw)
            self.assert_skipped(room=None)

    def test_m1_exact_byte_limit_is_accepted(self):
        payload = self.payload("UserPromptSubmit", prompt="")
        payload["prompt"] = "x" * (LIMIT - len(encode(payload)))
        raw = encode(payload)
        self.assertEqual(len(raw), LIMIT)
        report = self.invoke(raw=raw)
        self.assertEqual(len(report["calls"]), 1)
        self.assertEqual(report["calls"][0]["state"], "alive")

    def test_m1_limit_counts_utf8_bytes(self):
        payload = self.payload("UserPromptSubmit", prompt="")
        padding = LIMIT - len(encode(payload))
        payload["prompt"] = "é" * (padding // 2) + "x" * (padding % 2)
        raw = encode(payload)
        self.assertEqual(len(raw), LIMIT)
        self.assertLess(len(raw.decode("utf-8")), LIMIT)
        self.assertEqual(len(self.invoke(raw=raw)["calls"]), 1)

    def test_m5_one_byte_over_limit_is_rejected(self):
        raw = encode(self.payload())
        raw += b" " * (LIMIT + 1 - len(raw))
        self.assertEqual(len(raw), LIMIT + 1)
        self.assert_skipped(raw=raw)

    def test_m1_oversize_stream_read_is_bounded(self):
        raw = encode(self.payload()) + b" " * (LIMIT * 4)
        report = self.assert_skipped(raw=raw)
        self.assertLessEqual(report["consumed"], LIMIT + 1)

    def test_m1_unknown_arguments_are_silent_and_do_not_dispatch(self):
        self.assert_skipped(args=("--unknown-option",))

    def test_m1_store_exception_is_silent_and_zero(self):
        report = self.invoke(mode="store-raise")
        self.assertEqual(len(report["calls"]), 1)

    def test_m1_store_error_receipt_is_silent_and_zero(self):
        report = self.invoke(mode="store-error")
        self.assertEqual(len(report["calls"]), 1)

    def test_m1_deadline_expiration_is_silent_and_zero(self):
        report = self.invoke(mode="deadline")
        self.assertEqual(len(report["calls"]), 1)


class MappingOracle(NativeCase):
    def test_m2_session_end_reason_other_is_kept(self):
        report = self.invoke(self.payload("SessionEnd"))
        self.assertEqual(len(report["calls"]), 1)
        self.assertEqual(report["calls"][0]["state"], "finished")
        self.assertEqual(report["calls"][0]["reason"], "other")

    def test_m2_session_end_without_reason_still_finishes(self):
        payload = self.payload("SessionEnd")
        del payload["reason"]
        report = self.invoke(payload)
        self.assertEqual(len(report["calls"]), 1)
        self.assertEqual(report["calls"][0]["state"], "finished")
        self.assertNotIn("reason", report["calls"][0])

    def test_m2_subagent_start_has_session_parent(self):
        report = self.invoke(self.payload("SubagentStart"))
        self.assertEqual(len(report["calls"]), 1)
        self.assertEqual(report["calls"][0]["parent_agent"], parent_agent())
        self.assertEqual(report["calls"][0]["parent_run_id"], parent_run())

    def test_m2_stop_hook_active_still_means_alive(self):
        report = self.invoke(self.payload("Stop", stop_hook_active=True))
        self.assertEqual([value["state"] for value in report["calls"]], ["alive"])

    def test_m2_stop_and_interrupt_are_not_heartbeat_throttled(self):
        self.invoke(self.payload("UserPromptSubmit"), now=NOW)
        for index, event in enumerate(("Stop", "Interrupt", "Stop", "Interrupt"), 1):
            report = self.invoke(self.payload(event, turn_id="turn-%d" % index), now=NOW + 1)
            self.assertEqual([value["state"] for value in report["calls"]], ["alive"])

    def test_m2_heartbeat_events_share_exact_fifteen_second_window(self):
        first = self.invoke(self.payload("UserPromptSubmit"), now=NOW)
        before = self.invoke(self.payload("PreToolUse", tool_use_id="before-edge"), now=NOW + 14.999)
        edge = self.invoke(self.payload("PreToolUse", tool_use_id="at-edge"), now=NOW + 15)
        self.assertEqual([len(report["calls"]) for report in (first, before, edge)], [1, 0, 1])

    def test_m2_heartbeat_is_independent_per_agent(self):
        parent = self.invoke(self.payload("UserPromptSubmit"), now=NOW)
        child = self.invoke(self.payload("UserPromptSubmit", agent_id=CHILD, agent_type=AGENT_TYPE), now=NOW)
        other = self.invoke(self.payload("PreToolUse", agent_id="second-child", agent_type="reviewer"), now=NOW)
        self.assertEqual([len(report["calls"]) for report in (parent, child, other)], [1, 1, 1])
        self.assertEqual(child["calls"][0]["agent"], child_agent())

    def test_m2_heartbeat_is_independent_per_run(self):
        payload = self.payload("UserPromptSubmit", agent_id=CHILD, agent_type=AGENT_TYPE)
        first = self.invoke(payload, now=NOW)
        payload["session_id"] = "second-native-session"
        second = self.invoke(payload, now=NOW)
        self.assertEqual(len(first["calls"]), 1)
        self.assertEqual(len(second["calls"]), 1)
        self.assertNotEqual(first["calls"][0]["run_id"], second["calls"][0]["run_id"])

    def test_m2_heartbeat_is_independent_per_room(self):
        payload = self.payload("UserPromptSubmit")
        first = self.invoke(payload, room="first-room", now=NOW)
        second = self.invoke(payload, room="second-room", now=NOW)
        self.assertEqual(len(first["calls"]), 1)
        self.assertEqual(len(second["calls"]), 1)

    def test_m2_child_heartbeat_window_survives_fresh_entry_namespace(self):
        payload = self.payload("UserPromptSubmit", agent_id=CHILD, agent_type=AGENT_TYPE)
        self.assertEqual(len(self.invoke(payload, now=NOW)["calls"]), 1)
        self.assertEqual(self.invoke(self.payload("PreToolUse", agent_id=CHILD, agent_type=AGENT_TYPE),
                                     now=NOW + 14)["calls"], [])
        self.assertEqual(len(self.invoke(payload, now=NOW + 15)["calls"]), 1)

    def test_m2_failed_heartbeat_receipt_does_not_consume_window(self):
        payload = self.payload("UserPromptSubmit")
        self.invoke(payload, now=NOW, mode="store-error")
        retry = self.invoke(payload, now=NOW + 1)
        self.assertEqual(len(retry["calls"]), 1)

    def test_m2_heartbeat_store_exception_is_silent_and_retryable(self):
        payload = self.payload("PreToolUse")
        self.invoke(payload, now=NOW, mode="store-raise")
        retry = self.invoke(payload, now=NOW + 1)
        self.assertEqual(len(retry["calls"]), 1)

    def test_m2_child_precompact_is_ignored_even_with_native_identity(self):
        self.assert_skipped(self.payload("PreCompact", agent_id=CHILD, agent_type=AGENT_TYPE))


def mapped_case(event, state):
    def test(self):
        payload = self.payload(event)
        returned_event, value = self.lifecycle(payload)
        self.assertEqual(returned_event, event)
        self.assertEqual(value["state"], state)
        self.assertEqual(value["harness"], "codex")
        report = self.invoke(payload)
        self.assertEqual([item["state"] for item in report["calls"]], [state])
    return test


def ignored_case(event):
    def test(self):
        self.assert_skipped(self.payload(event))
    return test


for _event, _state in EVENTS.items():
    setattr(MappingOracle, "test_m2_event_" + _event, mapped_case(_event, _state))
for _event in IGNORED:
    setattr(MappingOracle, "test_m2_ignored_" + _event, ignored_case(_event))


class IdentityOracle(NativeCase):
    def test_m3_session_identity_has_exact_digest_lengths(self):
        _, value = self.lifecycle(self.payload())
        self.assertEqual(value["agent"], parent_agent())
        self.assertEqual(value["run_id"], parent_run())
        self.assertEqual(value["harness"], "codex")

    def test_m3_child_identity_and_run_include_correct_native_digests(self):
        _, value = self.lifecycle(self.payload("SubagentStart"))
        self.assertEqual(value["agent"], child_agent())
        self.assertEqual(value["run_id"], child_run())

    def test_m3_slug_normalizes_and_bounds_prefix(self):
        cases = (("  Release / QA Reviewer  ", "release-qa-reviewer"),
                 ("ABCDEFGHIJKLMNOPQRSTUVWXYZZ / reviewer", "abcdefghijklmnopqrstuvwx"),
                 ("abcdefghijklmnopqrstuvw- more", "abcdefghijklmnopqrstuvw"),
                 ("É Review / QA", "review-qa"))
        for agent_type, prefix in cases:
            _, value = self.lifecycle(self.payload("SubagentStart", agent_type=agent_type))
            self.assertEqual(value["agent"], child_agent(prefix))

    def test_m3_slug_falls_back_for_missing_empty_non_ascii_or_non_string_type(self):
        for agent_type in ("", "***", "рецензент", None, 12, True, {}, []):
            _, value = self.lifecycle(self.payload("SubagentStart", agent_type=agent_type))
            self.assertEqual(value["agent"], child_agent("agent"))
        payload = self.payload("SubagentStart")
        del payload["agent_type"]
        _, value = self.lifecycle(payload)
        self.assertEqual(value["agent"], child_agent("agent"))

    def test_m3_child_prompt_and_tool_events_use_child_identity(self):
        for event in ("UserPromptSubmit", "PreToolUse"):
            _, value = self.lifecycle(self.payload(event, agent_id=CHILD, agent_type=AGENT_TYPE))
            self.assertEqual(value["agent"], child_agent())
            self.assertEqual(value["run_id"], child_run())

    def test_m3_same_child_in_different_sessions_has_distinct_runs(self):
        _, first = self.lifecycle(self.payload("SubagentStart"))
        _, second = self.lifecycle(self.payload("SubagentStart", session_id="other-session"))
        self.assertEqual(first["agent"], second["agent"])
        self.assertNotEqual(first["run_id"], second["run_id"])
        self.assertEqual(second["parent_agent"], parent_agent("other-session"))

    def test_m3_first_registration_survives_omitted_type_on_heartbeat_and_stop(self):
        self.invoke(self.payload("SubagentStart"), mode="real")
        for event, offset in (("UserPromptSubmit", 1), ("PreToolUse", 16), ("SubagentStop", 17)):
            payload = self.payload(event, agent_id=CHILD)
            payload.pop("agent_type", None)
            self.invoke(payload, mode="real", now=NOW + offset)
        records = self.records()
        # A-CX1: the room's existing alive throttle may drop repeated alive records; identity is what this test pins.
        self.assertGreaterEqual(len(records), 3)
        self.assertEqual({record["agent"] for record in records}, {child_agent()})
        self.assertEqual({record["op"]["run_id"] for record in records}, {child_run()})
        states = [record["op"]["state"] for record in records]
        self.assertEqual((states[0], states[-1]), ("deployed", "finished"))
        self.assertIn("alive", states)

    def test_m3_first_registration_survives_changed_type(self):
        self.invoke(self.payload("SubagentStart"), mode="real")
        self.invoke(self.payload("SubagentStop", agent_type="different-role"), mode="real", now=NOW + 1)
        records = self.records()
        self.assertEqual(len(records), 2)
        self.assertEqual({record["agent"] for record in records}, {child_agent()})

    def test_m3_first_fallback_registration_is_retained_when_type_arrives(self):
        payload = self.payload("SubagentStart")
        del payload["agent_type"]
        self.invoke(payload, mode="real")
        self.invoke(self.payload("SubagentStop"), mode="real", now=NOW + 1)
        self.assertEqual(len(self.records()), 2)
        self.assertEqual({record["agent"] for record in self.records()}, {child_agent("agent")})

    def test_m3_no_native_or_private_fields_cross_lifecycle_boundary(self):
        markers = (SESSION, CHILD, "prompt-secret-canary", "tool-input-secret-canary",
                   "tool-name-secret-canary", "tool-use-secret-canary", "model-secret-canary",
                   "session-secret-canary.jsonl", "child-secret-canary.jsonl", "assistant-secret-canary",
                   str(self.project))
        for index, event in enumerate(EVENTS):
            report = self.invoke(self.payload(event), now=NOW + index * 16)
            self.assertEqual(len(report["calls"]), 1)
            value = report["calls"][0]
            self.assertLessEqual(set(value), {"event_id", "room", "agent", "run_id", "harness", "state",
                                             "parent_agent", "parent_run_id", "reason"})
            blob = json.dumps(value)
            for marker in markers:
                self.assertNotIn(marker, blob)

    def test_m3_persisted_room_records_never_contain_native_ids_or_content(self):
        for index, event in enumerate(EVENTS):
            self.invoke(self.payload(event), mode="real", now=NOW + index * 16)
        # A-CX1: alive records may be throttled or dropped after termination by the room; privacy is what this test pins.
        self.assertGreaterEqual(len(self.records()), 2)
        blob = b"\n".join(path.read_bytes() for path in self.home.rglob("*") if path.is_file())
        for marker in (SESSION, CHILD, str(self.project), "prompt-secret-canary", "tool-input-secret-canary",
                       "tool-use-secret-canary", "model-secret-canary", "transcripts/", "assistant-secret-canary"):
            self.assertNotIn(marker.encode("utf-8"), blob)


class HostileOracle(NativeCase):
    def test_m5_duplicate_top_level_keys_are_rejected(self):
        raw = encode(self.payload())
        self.assert_skipped(raw=raw[:-1] + b',"session_id":"replacement"}')

    def test_m5_duplicate_nested_keys_are_rejected(self):
        payload = self.payload("PreToolUse")
        payload["tool_input"] = {"duplicate-key-marker": 0}
        raw = encode(payload).replace(b'{"duplicate-key-marker":0}', b'{"key":1,"key":2}')
        self.assert_skipped(raw=raw)

    def test_m5_non_string_session_ids_are_rejected(self):
        for value in (None, True, False, 1, 1.5, [], {}):
            self.assert_skipped(self.payload(session_id=value))

    def test_m5_non_string_child_ids_are_rejected(self):
        for event in ("SubagentStart", "SubagentStop", "UserPromptSubmit", "PreToolUse"):
            for value in (None, True, False, 1, 1.5, [], {}):
                self.assert_skipped(self.payload(event, agent_id=value))

    def test_m5_missing_or_empty_session_id_is_rejected(self):
        payload = self.payload()
        del payload["session_id"]
        self.assert_skipped(payload)
        self.assert_skipped(self.payload(session_id=""))

    def test_m5_missing_or_empty_subagent_id_is_rejected(self):
        for event in ("SubagentStart", "SubagentStop"):
            payload = self.payload(event)
            del payload["agent_id"]
            self.assert_skipped(payload)
            self.assert_skipped(self.payload(event, agent_id=""))

    def test_m5_missing_empty_or_non_string_event_is_rejected(self):
        payload = self.payload()
        del payload["hook_event_name"]
        self.assert_skipped(payload)
        for value in ("", None, True, 1, [], {}):
            self.assert_skipped(self.payload(hook_event_name=value))

    def test_m5_unpaired_surrogate_native_ids_are_silent(self):
        raw = encode(self.payload()).replace(SESSION.encode(), b"\\ud800")
        self.assert_skipped(raw=raw)


def raw_case(raw):
    def test(self):
        self.assert_skipped(raw=raw)
    return test


for _name, _raw in {
    "empty": b"", "truncated": b'{"session_id":', "invalid_utf8": b"\xff",
    "array": b"[]", "null": b"null", "string": b'"SessionStart"', "number": b"42",
    "boolean": b"true", "multiple_objects": b"{}\n{}", "trailing_garbage": b"{} garbage",
    "deeply_nested": b"[" * 1500,
}.items():
    setattr(HostileOracle, "test_m5_json_" + _name, raw_case(_raw))


def constant_case(constant):
    def test(self):
        raw = encode(self.payload())
        self.assert_skipped(raw=raw[:-1] + b',"hostile_constant":' + constant + b"}")
    return test


for _name, _constant in (("nan", b"NaN"), ("infinity", b"Infinity"), ("negative_infinity", b"-Infinity")):
    setattr(HostileOracle, "test_m5_json_" + _name, constant_case(_constant))
