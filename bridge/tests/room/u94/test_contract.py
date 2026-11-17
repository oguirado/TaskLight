"""U94 M1-M5 and A1-A4/A8 public tool contracts."""
import ast
import copy
import inspect
import json
import subprocess
import sys
from unittest.mock import patch

from bridge.plan.fold import empty_projection, fold_plan
from bridge.room import ext, store
from .support import (Case, HERE, ROOT, call, event, expected_history, history_events,
                      memory_event, tree)


class Discovery(Case):
    def test_a1_discovery_once_complete_schemas_and_no_writes(self):
        from bridge.room import mcp
        before = tree(self.tmp)
        ext.load()
        ext.load()
        for name, keys, required in (
            ("room_export", {"room", "agent", "what"}, {"room", "agent", "what"}),
            ("memory_history", {"room", "agent", "section", "limit"}, {"room", "agent", "section"}),
        ):
            found = [t for t in ext.EXT_TOOLS if t["name"] == name]
            self.assertEqual(len(found), 1)
            self.assertEqual(sum(t["name"] == name for t in mcp.TOOLS), 1)
            schema = found[0]["inputSchema"]
            self.assertEqual(schema["type"], "object")
            self.assertEqual(set(schema["properties"]), keys)
            self.assertEqual(set(schema["required"]), required)
            self.assertIs(schema["additionalProperties"], False)
            for field in required:
                self.assertEqual(schema["properties"][field]["type"], "string")
            if name == "room_export":
                self.assertEqual(set(schema["properties"]["what"]["enum"]), {"plan", "memory"})
            else:
                limit = schema["properties"]["limit"]
                self.assertEqual((limit["type"], limit["minimum"], limit["maximum"], limit["default"]),
                                 ("integer", 1, 500, 100))
        self.assertEqual(tree(self.tmp), before)

    def test_m6_first_import_and_discovery_have_no_filesystem_side_effects(self):
        before = tree(self.tmp)
        script = """import socket, subprocess, time
from unittest.mock import patch
with patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')), \
     patch.object(time, 'sleep', side_effect=AssertionError('sleep forbidden')), \
     patch.object(subprocess, 'Popen', side_effect=AssertionError('model process forbidden')):
    from bridge.room import ext
    ext.load()
"""
        completed = subprocess.run([sys.executable, "-c", script], cwd=ROOT,
                                   capture_output=True, text=True, timeout=10, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(tree(self.tmp), before)

    def test_m1_existing_tool_descriptors_unchanged(self):
        from bridge.room import mcp
        old = json.loads((HERE / "legacy_tools.json").read_text())
        current = {t["name"]: t for t in mcp.TOOLS}
        for tool in old:
            # A-U109c: (a) preserve descriptors except the specified optional fence, M2/M4.
            actual = copy.deepcopy(current[tool["name"]])
            if tool["name"] in ("task_release", "microtask_set"):
                schema = actual["inputSchema"]
                self.assertNotIn("claim_lamport", schema["required"])
                self.assertEqual(schema["properties"].pop("claim_lamport"),
                                 {"type": "integer", "minimum": 1, "maximum": 9007199254740991})
            # A-U140r1: SPEC_U140 (review B3) optional plan-generation fence, exact schema checked.
            fence = actual['inputSchema'].get('properties', {}).pop('expected_opened_lamport', None)
            if fence is not None:
                self.assertNotIn('expected_opened_lamport', actual['inputSchema'].get('required', []))
                self.assertEqual((fence.get('type'), fence.get('minimum')), ('integer', 1))
            self.assertEqual(actual, tool)

    def test_m1_extension_import_boundary(self):
        from bridge.room.ext import export as exports
        for node in ast.walk(ast.parse(inspect.getsource(exports))):
            if isinstance(node, ast.ImportFrom):
                if node.level:
                    self.assertEqual(node.level, 1)
                    self.assertIn(node.module, (None,))
                elif node.module and node.module.startswith("bridge"):
                    self.assertTrue(node.module in ("bridge.room", "bridge.room.store", "bridge.room.ext")
                                    or node.module.startswith("bridge.plan"))
                    if node.module == "bridge.room":
                        self.assertEqual({a.name for a in node.names}, {"store"})
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.startswith("bridge"):
                        self.assertTrue(alias.name == "bridge.room.store" or alias.name.startswith("bridge.plan"))


class ExportContract(Case):
    def test_a1_both_exports_byte_exact_and_repeated_reads_unchanged(self):
        journal = self.seed()
        before = tree(self.tmp)
        projection = fold_plan(store.read("demo")[0])
        for what in ("plan", "memory"):
            first = self.export(what)
            self.assert_export(first, projection, what)
            self.assertEqual(first, self.export(what))
        self.history()
        self.assertEqual(tree(self.tmp), before)
        self.assertEqual(journal.read_bytes(), before["home/rooms/demo/events.jsonl"][1])

    def test_a1_mcp_wraps_equivalent_data(self):
        from bridge.room import mcp
        self.seed()
        direct = self.export()
        messages = []
        with patch.object(mcp, "_send", side_effect=messages.append):
            mcp._handle(17, "tools/call", {"name": "room_export", "arguments":
                                          {"room": "demo", "agent": "reader", "what": "memory"}})
        self.assertEqual(len(messages), 1)
        result = messages[0]["result"]
        self.assertFalse(result["isError"])
        self.assertEqual(json.loads(result["content"][0]["text"]), {"untrusted": direct})

    def test_a1_frozen_cli_call_matches_mcp_when_u87_is_integrated(self):
        cli = ast.parse((ROOT / "bridge/room/__main__.py").read_text())
        if not any(isinstance(n, ast.Constant) and n.value == "call" for n in ast.walk(cli)):
            self.skipTest("U87 generic CLI call hook AUSENTE; upstream integration")
        self.seed()
        direct = self.export()
        completed = subprocess.run(
            [sys.executable, "-m", "bridge.room", "call", "room_export", "--json",
             json.dumps(dict(room="demo", agent="reader", what="memory"))],
            cwd=ROOT, capture_output=True, text=True, timeout=10, check=False)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        payload = json.loads(completed.stdout)
        # The CLI's JSON envelope belongs to U87; compare the data it carries.
        if "untrusted" in payload:
            payload = payload["untrusted"]
        self.assertEqual(payload, direct)

    def test_a3_empty_room_renderers_and_no_room_creation(self):
        before = tree(self.tmp)
        for what in ("plan", "memory"):
            self.assert_export(self.export(what), empty_projection(), what)
        self.assertEqual(self.history(), {"section": "goal", "versions": []})
        self.assertFalse((self.home / "rooms/demo").exists())
        self.assertEqual(tree(self.tmp), before)

    def test_a3_memory_without_plan(self):
        values = [memory_event(3, "café\nsecond line", 0)]
        self.seed(values)
        projection = fold_plan(values)
        self.assertIsNone(projection["plan"])
        self.assert_export(self.export("memory"), projection, "memory")
        self.assert_export(self.export("plan"), projection, "plan")

    def test_m2_one_captured_prefix_per_tool(self):
        self.seed()
        for invoke in (self.export, self.history):
            with patch.object(store, "read", wraps=store.read) as reader:
                invoke()
            self.assertEqual(reader.call_count, 1)

    def test_m2_reads_invoke_no_model_process(self):
        self.seed()
        with patch.object(subprocess, "Popen", side_effect=AssertionError("process launch forbidden")):
            self.export()
            self.history()

    def test_m2_torn_final_line_is_not_an_export_revision_or_history_version(self):
        tail = json.dumps(memory_event(99, "torn poison", 9)).encode()
        self.seed(tail=tail)
        before = tree(self.tmp)
        projection = fold_plan(store.read("demo")[0])
        self.assertEqual(projection["last_lamport"], 9)
        self.assert_export(self.export(), projection, "memory")
        self.assertEqual(self.history(), expected_history())
        self.assertEqual(tree(self.tmp), before)

    def test_m3_export_rev_is_fold_head_not_last_section_update(self):
        values = history_events() + [memory_event(15, "rejected", 0)]
        self.seed(values)
        projection = fold_plan(values)
        self.assertEqual(projection["last_lamport"], 15)
        self.assertEqual(projection["memory"]["goal"]["rev"], 9)
        self.assert_export(self.export(), projection, "memory")


class HistoryContract(Case):
    def test_a2_exact_history_rejects_duplicates_replays_stale_and_other_sections(self):
        self.seed()
        self.assertEqual(self.history(), expected_history())

    def test_a2_limit_two_keeps_latest(self):
        self.seed()
        expected = expected_history()
        expected["versions"] = expected["versions"][:2]
        self.assertEqual(self.history(limit=2), expected)

    def test_a2_history_survives_plan_closure(self):
        values = history_events(closed=True)
        self.seed(values)
        self.assertEqual(fold_plan(values)["plan"]["state"], "closed")
        self.assertEqual(self.history(), expected_history())

    def test_a3_unwritten_valid_section(self):
        self.seed()
        self.assertEqual(self.history("unwritten"), {"section": "unwritten", "versions": []})

    def test_m4_same_text_is_still_an_accepted_version(self):
        self.seed([memory_event(1, "", 0), memory_event(2, "", 1, by="bob")])
        self.assertEqual([v["rev"] for v in self.history()["versions"]], [2, 1])

    def test_m4_default_100_and_inclusive_limit_boundaries(self):
        self.seed([memory_event(i, str(i), i - 1) for i in range(1, 506)])
        for supplied, count in (({}, 100), ({"limit": 1}, 1), ({"limit": 500}, 500)):
            result = self.history(**supplied)
            self.assertEqual(set(result), {"section", "versions"})
            self.assertEqual([v["rev"] for v in result["versions"]], list(range(505, 505 - count, -1)))


class Arguments(Case):
    def reject(self, name, args, code="bad_args"):
        ext.load()
        before = tree(self.tmp)
        with self.assertRaises(store.RoomError) as caught:
            ext.EXT_DISPATCH[name](args)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(tree(self.tmp), before)

    def test_a4_hostile_room_and_agent(self):
        for name, tail in (("room_export", {"what": "memory"}),
                           ("memory_history", {"section": "goal"})):
            for room in ("../escape", "", "Demo", "x" * 49, None):
                with self.subTest(name=name, room=room):
                    self.reject(name, dict(room=room, agent="reader", **tail), "bad_room")
            for agent in ("../escape", "", "Reader", "x" * 49, None):
                with self.subTest(name=name, agent=agent):
                    self.reject(name, dict(room="demo", agent=agent, **tail), "bad_agent")

    def test_a4_invalid_limits_including_amendment(self):
        for limit in (True, False, 0, -1, 501, None, 1.5, "10", [], {}):
            with self.subTest(limit=limit):
                self.reject("memory_history", dict(room="demo", agent="reader", section="goal", limit=limit))

    def test_a4_invalid_what_and_extra_destination(self):
        for what in ("../../keys", "", "PLAN", None, 1, True):
            with self.subTest(what=what):
                self.reject("room_export", dict(room="demo", agent="reader", what=what))
        self.reject("room_export", dict(room="demo", agent="reader", what="memory", out="rooms/demo"))
        self.reject("memory_history", dict(room="demo", agent="reader", section="goal", out="rooms/demo"))

    def test_m5_every_missing_required_argument(self):
        for name, complete in (("room_export", dict(room="demo", agent="reader", what="memory")),
                               ("memory_history", dict(room="demo", agent="reader", section="goal"))):
            for key in complete:
                with self.subTest(name=name, missing=key):
                    args = dict(complete)
                    del args[key]
                    self.reject(name, args)

    def test_m5_section_syntax_matches_memory_set(self):
        from bridge.plan.errors import PlanError
        from bridge.plan.ops import validate_op_shape
        for section in ("", "../goal", "Goal", "goal space", "a_b", "a" * 49, None, 2):
            with self.subTest(section=section):
                with self.assertRaises(PlanError):
                    validate_op_shape(dict(kind="memory.set", section=section, text="", base_rev=0))
                self.reject("memory_history", dict(room="demo", agent="reader", section=section))

    def test_m5_valid_section_boundaries(self):
        for section in ("a", "a-b", "a" * 48):
            with self.subTest(section=section):
                self.assertEqual(self.history(section), dict(section=section, versions=[]))


class NegativeControls(Case):
    def test_a8_current_only_history_mutant_fails_a2_assertion(self):
        ext.load()
        expected = expected_history()
        mutant = copy.deepcopy(expected)
        mutant["versions"] = mutant["versions"][:1]
        with patch.dict(ext.EXT_DISPATCH, {"memory_history": lambda args: mutant}):
            with self.assertRaises(AssertionError):
                HistoryContract.test_a2_exact_history_rejects_duplicates_replays_stale_and_other_sections(self)

    def test_a8_missing_export_newline_mutant_fails_a1_assertion(self):
        ext.load()
        from bridge.plan.markdown import render_memory_md
        projection = fold_plan(history_events())
        from bridge.plan.markdown import render_plan_md

        def mutant(args):
            renderer = render_plan_md if args["what"] == "plan" else render_memory_md
            text = renderer(projection)
            if args["what"] == "memory":
                text = text.rstrip("\n")
            return dict(format="markdown", text=text, rev=projection["last_lamport"])

        with patch.dict(ext.EXT_DISPATCH, {"room_export": mutant}):
            with self.assertRaises(AssertionError):
                ExportContract.test_a1_both_exports_byte_exact_and_repeated_reads_unchanged(self)

    def test_fixture_gate_accepted_revisions_and_rejected_stale_are_real(self):
        values = history_events()
        self.seed(values)
        parsed, malformed = store.read("demo")
        self.assertEqual(malformed, 0)
        self.assertEqual(len(parsed), len(values))
        projection = fold_plan(parsed)
        self.assertEqual(projection["memory"]["goal"]["text"], "")
        self.assertEqual(projection["memory"]["goal"]["rev"], 9)
        self.assertEqual([(x["lamport"], x["code"]) for x in projection["rejected"]], [(6, "stale_rev")])
        for rev, text in ((3, "first"), (5, "second"), (9, "")):
            prefix = fold_plan([e for e in values if e["lamport"] <= rev])
            self.assertEqual((prefix["memory"]["goal"]["rev"], prefix["memory"]["goal"]["text"]), (rev, text))
