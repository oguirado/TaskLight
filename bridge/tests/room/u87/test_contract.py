"""U87 acceptance and mutation oracles. Production files are never rewritten."""
import ast
import copy
import hashlib
import importlib
import io
import json
from contextlib import redirect_stdout
from unittest.mock import patch

from .support import (
    APP, ROOT, TOOLS, AdapterOutput, BaseCase, FutureCase, assert_error, assert_micro_array,
    assert_schemas, assert_shared, assert_structural, call, child, cli_call, create_args, deterministic,
    dispatch_spy, fixture, journal, kind, rpc, seed_plan, task, tree_bytes, write_template,
)


class DiscoveryOracle(FutureCase):
    def test_a1_tools_complete_object_and_no_writes(self):
        write_template(self.home)
        before = tree_bytes(self.home)
        rc, payload, raw, err = cli_call(["tools"])
        self.assertEqual(rc, 0)
        self.assertEqual(err, "")
        self.assertEqual(payload, rpc("tools/list")["result"])
        self.assertEqual(set(payload), {"tools"})
        baseline = json.loads((APP.parent.parent / "tests/room/u87/expected.json").read_text())["_tools"]
        core = [t for t in payload["tools"] if t["name"] in TOOLS]
        # A-C9: pin the clarified creation-status and task-shape descriptions.
        descriptions = {
            "plan_create": ("Create a plan from a template; tasks is a list of objects with required key, title, type and phase. "
                            "plan_get returns a list of task records with id; callers can key by task id. Success returns created: true, plan_id, opened_lamport and conformance, "
                            "even with findings. strict rejection keeps its error code and says created: false in detail."),
            "plan_get": "Read the active plan projection; tasks is a list of records with id, which callers can key by task id. plan_create takes tasks as a list with required key.",
        }
        self.assertEqual([(t["name"], t["description"]) for t in core],
                         [(t["name"], descriptions.get(t["name"], t["description"])) for t in baseline])
        self.assertEqual(core[:6], baseline[:6], "legacy descriptors must remain exact")
        self.assertTrue(raw.endswith("\n"))
        self.assertEqual(tree_bytes(self.home), before)
        self.assertEqual(len(payload["tools"]), len({t["name"] for t in payload["tools"]}))
        for descriptor in payload["tools"]:
            self.assertTrue({"name", "description", "inputSchema"} <= set(descriptor))
            self.assertIsInstance(descriptor["description"], str)
        assert_schemas(payload["tools"])

    def test_a1_cli_only_startup(self):
        self._fresh("cli-first", "ok")

    def test_a1_real_module_discovery_and_call(self):
        write_template(self.home)
        before = tree_bytes(self.home)
        discovery = child("-m", "bridge.room", "tools")
        self.assertEqual(discovery.returncode, 0, discovery.stderr.decode())
        self.assertEqual(discovery.stderr, b"")
        self.assertEqual(len(discovery.stdout.splitlines()), 1)
        self.assertTrue(discovery.stdout.endswith(b"\n"))
        self.assertEqual(json.loads(discovery.stdout), rpc("tools/list")["result"])
        called = child("-m", "bridge.room", "call", "list_templates", "--json", "{}")
        self.assertEqual(called.returncode, 0, called.stderr.decode())
        self.assertEqual(called.stderr, b"")
        self.assertEqual(len(called.stdout.splitlines()), 1)
        self.assertTrue(called.stdout.endswith(b"\n"))
        self.assertEqual(json.loads(called.stdout), call("mcp", "list_templates", {})[1])
        self.assertEqual(tree_bytes(self.home), before)

    def _fresh(self, order, outcome):
        result = child("-m", "bridge.tests.room.u87.probe", "fresh", str(self.home), order, outcome)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        value = json.loads(result.stdout)
        self.assertEqual(value["cli_discovery"][0], 0)
        self.assertEqual(value["cli_discovery"][1], value["mcp_discovery"])
        names = [d["name"] for d in value["mcp_discovery"]["tools"]]
        self.assertEqual(names.count("u87_probe"), 1)
        self.assertTrue(value["duplicate_rejected"])
        if order == "cli-first":
            self.assertFalse(value["cli_loaded_mcp"], "CLI startup must not import MCP")
        self.assertEqual(value["cli_probe"], value["mcp_probe"])
        if outcome == "ok":
            self.assertEqual(value["cli_probe"], [0, {"untrusted": {"probe": True}}])
        elif outcome == "room":
            from bridge.room.store import RoomError
            assert_error(value["cli_probe"], "stale_rev", str(RoomError("stale_rev", "probe")))
        else:
            assert_error(value["cli_probe"], "internal")
            self.assertEqual(value["cli_probe"][1], {"ok": False, "code": "internal"})
            self.assertNotIn("u87 private exception text", result.stdout.decode())
            self.assertNotIn("Traceback", result.stderr.decode())
            self.assertNotIn("u87 private exception text", value["cli_stderr"])
            self.assertNotIn("Traceback", value["cli_stderr"])
        return value

    def test_a7_cli_first_synthetic_extension(self):
        self._fresh("cli-first", "ok")

    def test_a7_mcp_first_synthetic_extension(self):
        self._fresh("mcp-first", "ok")

    def test_a7_room_error_detail_cli_first(self):
        self._fresh("cli-first", "room")

    def test_a7_room_error_detail_mcp_first(self):
        self._fresh("mcp-first", "room")

    def test_a9_unexpected_exception_sanitized(self):
        self._fresh("cli-first", "internal")


class ParityOracle(FutureCase):
    def parity(self, name):
        from bridge.room import store
        outcomes, journals, spies, batch_hashes = [], [], [], []
        for adapter in ("cli", "mcp"):
            home = self.tmp / adapter
            # A-U121c: capture caller order/local keys for exact durable batch hashes, M3.
            with deterministic(home), patch.object(store, "post_ops", wraps=store.post_ops) as batches:
                args = fixture(home, name)
                if name == "plan_close":
                    # A-U109c: (a) both adapters explicitly cancel open work before close, M6/M7.
                    prepared = call(adapter, "task_update", dict(room="demo", agent="worker",
                                    task_id="T01", base_rev=2, state="cancelled"))
                    self.assertEqual(prepared[0], 0)
                    self.assertEqual(prepared[1]["untrusted"]["rev"], 3)
                    self.assertEqual(prepared[1]["untrusted"]["task"]["state"], "cancelled")
                with dispatch_spy(name, args) as seen:
                    result = call(adapter, name, args)
                spies.append(seen)
                outcomes.append(result)
                journals.append(journal(home))
                batch_hashes.append([
                    hashlib.sha256(json.dumps(
                        {"strict": c.kwargs.get("strict", False), "ops": c.args[2]},
                        sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                        allow_nan=False).encode("utf-8")).hexdigest()
                    for c in batches.call_args_list])
        self.assertEqual(batch_hashes[0], batch_hashes[1])
        self.assertEqual(outcomes[0], outcomes[1], "complete decoded payload differs")
        self.assertEqual(outcomes[0][0], 0, outcomes)
        self.assertEqual(journals[0], journals[1], "complete journal bytes differ")
        expected = json.loads((APP.parent.parent / "tests/room/u87/expected.json").read_text())[name]
        if name == "plan_close":
            # A-U109c: (a) account exactly for the prerequisite event, retaining byte parity, M6/M7.
            expected["payload"]["untrusted"]["rev"] = 4
            for path, text in expected["journals"].items():
                lines = text.splitlines()
                closing = json.loads(lines[-1])
                cancellation = copy.deepcopy(closing)
                cancellation["op"] = dict(kind="task.set", task_id="T01",
                                           base_rev=2, state="cancelled")
                closing.update(id="e-0000000000000004", lamport=4)
                encode = lambda ev: json.dumps(ev, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                expected["journals"][path] = "\n".join(lines[:-1] + [encode(cancellation), encode(closing)]) + "\n"
        # A-U121c: add only required comparison metadata to the frozen byte expectation, M3.
        pending = iter(batch_hashes[0])
        recorded = {}
        for path, text in expected["journals"].items():
            events = [json.loads(line) for line in text.splitlines()]
            for event in events:
                if "batch" in event:
                    members = tuple(event["batch"]["member_ids"])
                    if members not in recorded:
                        recorded[members] = next(pending)
                    event["batch"]["request_sha256"] = recorded[members]
            expected["journals"][path] = "".join(
                json.dumps(event, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=False) + "\n" for event in events)
        self.assertEqual(list(pending), [])
        if name == "plan_create":  # A-C9: creation reply now pins explicit status and the original plan fence.
            expected["payload"]["untrusted"].update(created=True, opened_lamport=1)
        self.assertEqual(outcomes[0][1], expected["payload"], "pre-U87 successful payload changed")
        self.assertEqual({p: b.decode() for p, b in journals[0].items()}, expected["journals"],
                         "pre-U87 committed journal changed")
        assert_shared(*spies)
        if name in TOOLS[:6]:
            self.assertNotIn("untrusted", outcomes[0][1], "legacy envelope changed")
        else:
            self.assertEqual(set(outcomes[0][1]), {"untrusted"})
        if name == "list_templates":
            self.assertIn("templates", outcomes[0][1]["untrusted"])
        return spies[0] & spies[1]

    def test_a2_same_dispatcher_for_every_tool(self):
        shared = None
        for name in TOOLS:
            with self.subTest(tool=name):
                # Each pair has fresh fixture roots, independent of earlier tools.
                original = self.tmp
                self.tmp = original / name
                try:
                    observed = self.parity(name)
                finally:
                    self.tmp = original
                shared = observed if shared is None else shared & observed
        self.assertTrue(shared, "every tool must share the application dispatch entry")


def parity_test(name):
    def test(self):
        self.parity(name)
    return test


for _name in TOOLS:
    setattr(ParityOracle, "test_a2_" + _name, parity_test(_name))


class ErrorOracle(FutureCase):
    def rejects(self, name, args, code, prepare=None, detail=None):
        results = []
        for adapter in ("cli", "mcp"):
            home = self.tmp / adapter
            with deterministic(home):
                write_template(home)
                if prepare:
                    prepare(home)
                before = journal(home)
                result = call(adapter, name, args)
                assert_error(result, code, detail)
                self.assertIsInstance(result[1].get("detail"), str)
                self.assertTrue(result[1]["detail"], "RoomError requires nonempty detail")
                self.assertEqual(journal(home), before, "rejection appended journal bytes")
                results.append(result)
        self.assertEqual(*results, "adapter errors differ")
        return results[0][1]

    def test_a3_empty_room_no_plan(self):
        from bridge.room.store import RoomError
        self.rejects("plan_get", {"room": "demo"}, "no_plan", detail=str(RoomError("no_plan", "no active plan")))

    def test_a3_stale_microtask_detail_and_no_append(self):
        payload = self.rejects("microtask_add", dict(room="demo", agent="worker", task_id="T01",
                               text="Check", base_rev=0), "stale_rev", prepare=seed_plan)
        self.assertIn("stale task rev", payload.get("detail", ""))

    def test_a4_handler_bad_args_exits_three(self):
        self.rejects("next_work", dict(room="demo", agent="worker", limit=-1), "bad_args", prepare=seed_plan)

    def test_a6_hostile_task_no_append(self):
        value = task(**{"__proto__": {"admin": True}})
        self.rejects("plan_create", create_args(tasks=[value]), "bad_op")

    def test_a6_path_traversal_no_outside_directory(self):
        self.rejects("plan_get", {"room": "../escape"}, "bad_room")
        self.assertFalse(any(p.name == "escape" for p in self.tmp.rglob("*")))

    def test_a6_tool_names_and_json_remain_data(self):
        marker = self.tmp / "executed"
        hostile_name = "__import__('pathlib').Path(%r).touch()" % str(marker)
        rc, payload, _, _ = cli_call(["call", hostile_name, "--json", "{}"])
        self.assertEqual((rc, payload), (2, {"ok": False, "code": "bad_args"}))
        seed_plan(self.home)
        text = "$(touch %s)" % marker.relative_to(ROOT)
        for adapter in ("cli", "mcp"):
            result = call(adapter, "memory_set", dict(room="demo", agent="worker", section="notes",
                          text=text, base_rev=0, op_id="hostile_01"))
            self.assertEqual(result[0], 0, result)
        self.assertFalse(marker.exists())

    def test_a5_template_membership_dependencies_and_cycles(self):
        cases = [
            ([task(type="unknown")], "bad_op"), ([task(phase="unknown")], "bad_op"),
            ([task(deps=["missing"])], "not_found"), ([task(deps=["first"])], "dep_cycle"),
            ([task(deps=["second"]), task("second", deps=["first"])], "dep_cycle"),
            ([task(deps=["second", "second"]), task("second")], "bad_op"),
            ([task(), task()], "bad_op"),
        ]
        for index, (tasks, code) in enumerate(cases):
            with self.subTest(index=index):
                self.rejects("plan_create", create_args(tasks=tasks), code)


def syntax_test(argv):
    def test(self):
        before = tree_bytes(self.home)
        rc, value, _, _ = cli_call(argv)
        self.assertEqual((rc, value), (2, {"ok": False, "code": "bad_args"}))
        self.assertEqual(tree_bytes(self.home), before)
    return test


for _label, _argv in (
        ("malformed", ["call", "plan_get", "--json", "["]),
        ("array", ["call", "plan_get", "--json", "[]"]),
        ("null", ["call", "plan_get", "--json", "null"]),
        ("scalar", ["call", "plan_get", "--json", "1"]),
        ("missing_json", ["call", "plan_get"]),
        ("missing_tool", ["call", "--json", "{}"]),
        ("unknown_tool", ["call", "unknown_u87", "--json", "{}"]),
        ("extra_arg", ["call", "plan_get", "--json", "{}", "unexpected"])):
    setattr(ErrorOracle, "test_a4_syntax_" + _label, syntax_test(_argv))


def missing_test(name):
    def test(self):
        code = "bad_args" if name in TOOLS[:6] else "bad_op"
        self.rejects(name, {}, code)
    return test


for _name in TOOLS:
    if _name != "list_templates":
        setattr(ErrorOracle, "test_a4_missing_" + _name, missing_test(_name))


# Reuse the assertion helper without inheriting unittest test methods.
class BoundaryOracle(FutureCase):
    rejects = ErrorOracle.rejects

    def test_a5_all_schema_paths(self):
        assert_schemas(rpc("tools/list")["result"]["tools"])

    def test_a5_null_microtask_arrays_normalize_to_omission(self):
        for name in ("plan_create", "task_add"):
            for adapter in ("cli", "mcp"):
                outcomes = []
                logs = []
                for mode in ("absent", "null"):
                    home = self.tmp / name / adapter / mode
                    with deterministic(home):
                        write_template(home)
                        if name == "plan_create":
                            value = task()
                            value.pop("microtasks")
                            if mode == "null":
                                value["microtasks"] = None
                            args = create_args(tasks=[value])
                        else:
                            seed_plan(home)
                            args = dict(room="demo", agent="worker", title="Task", type="action", phase="start", accept="Pass")
                            if mode == "null":
                                args["microtasks"] = None
                        result = call(adapter, name, args)
                        self.assertEqual(result[0], 0, result)
                        outcomes.append(result)
                        logs.append(journal(home))
                self.assertEqual(*outcomes)
                self.assertEqual(*logs, "null arrays must be omitted before committed-op validation")

    def test_a5_nested_microtask_unknown_keys_and_required_text(self):
        for name in ("plan_create", "task_add"):
            for index, microtask in enumerate(({}, {"text": 1}, {"text": "Check", "accept": 1}, {"text": "Check", "extra": True})):
                with self.subTest(tool=name, microtask=microtask):
                    if name == "plan_create":
                        args = create_args(tasks=[task(microtasks=[microtask])])
                        prepare = None
                    else:
                        args = dict(room="demo", agent="worker", title="Task", type="action", phase="start", accept="Pass",
                                    microtasks=[microtask])
                        prepare = seed_plan
                    # Independent room roots for each rejected fixture.
                    original = self.tmp
                    self.tmp = original / (name + str(index))
                    try:
                        self.rejects(name, args, "bad_op", prepare=prepare)
                    finally:
                        self.tmp = original

    def test_a5_task_add_dependencies_use_ids(self):
        args = dict(room="demo", agent="worker", title="Later", type="action", phase="start", accept="Pass", deps=["first"])
        self.rejects("task_add", args, "bad_op", prepare=seed_plan)
        for adapter in ("cli", "mcp"):
            home = self.tmp / (adapter + "-valid")
            with deterministic(home):
                seed_plan(home)
                result = call(adapter, "task_add", dict(args, deps=["T01"]))
                self.assertEqual(result[0], 0, result)
                self.assertEqual(result[1]["untrusted"]["task"]["deps"], ["T01"])


def boundary_fixture(home, surface, field, value):
    write_template(home)
    if surface == "create":
        args = create_args()
        item = args["tasks"][0]
    else:
        seed_plan(home, count=10 if field == "deps" else 1)
        args = fixture_args = dict(room="demo", agent="worker", title="Task", type="action", phase="start", accept="Pass")
        item = fixture_args
    if field == "tasks":
        args["tasks"] = [task("k%d" % i) for i in range(value)]
    elif field == "deps":
        if surface == "create":
            args["tasks"] += [task("dep%d" % i) for i in range(value)]
            item[field] = ["dep%d" % i for i in range(value)]
        else:
            item[field] = ["T%02d" % (i + 1) for i in range(value)]
    elif field == "microtasks":
        item[field] = [{"text": "Check"} for _ in range(value)]
    elif field.startswith("micro_"):
        item["microtasks"] = [{"text": "Check", field[6:]: value}]
    else:
        item[field] = value
    return ("plan_create" if surface == "create" else "task_add"), args


def boundary_test(surface, field, value, expected):
    def test(self):
        results = []
        for adapter in ("cli", "mcp"):
            home = self.tmp / adapter
            with deterministic(home):
                name, args = boundary_fixture(home, surface, field, value)
                before = journal(home)
                schema = next(t["inputSchema"] for t in rpc("tools/list")["result"]["tools"] if t["name"] == name)
                if expected is None:
                    assert_structural(schema, args)
                elif expected == "limit_exceeded":
                    with self.assertRaises(AssertionError):
                        assert_structural(schema, args)
                result = call(adapter, name, args)
                if expected:
                    assert_error(result, expected)
                    self.assertTrue(result[1].get("detail"), "RoomError requires detail")
                    self.assertEqual(journal(home), before)
                else:
                    self.assertEqual(result[0], 0, result)
                results.append(result)
        self.assertEqual(*results)
    return test


_BOUNDARIES = [
    ("title", "x" * 120, "x" * 121), ("accept", "x" * 160, "x" * 161),
    ("estimate", "x" * 32, "x" * 33), ("deps", 8, 9), ("microtasks", 12, 13),
    ("micro_text", "x" * 80, "x" * 81), ("micro_accept", "x" * 160, "x" * 161),
]
for _surface in ("create", "add"):
    for _field, _maximum, _overflow in _BOUNDARIES:
        setattr(BoundaryOracle, "test_a5_%s_%s_maximum" % (_surface, _field), boundary_test(_surface, _field, _maximum, None))
        setattr(BoundaryOracle, "test_a5_%s_%s_overflow" % (_surface, _field), boundary_test(_surface, _field, _overflow, "limit_exceeded"))
    for _field, _value in (("title", ""), ("micro_text", ""), ("micro_accept", None), ("accept", None)):
        setattr(BoundaryOracle, "test_a5_%s_%s_invalid" % (_surface, _field), boundary_test(_surface, _field, _value, "bad_op"))
    for _field in ("assignee", "estimate"):
        setattr(BoundaryOracle, "test_a5_%s_%s_nullable" % (_surface, _field), boundary_test(_surface, _field, None, None))
for _value, _code, _label in ((40, None, "maximum"), (41, "limit_exceeded", "overflow"), (0, "bad_op", "empty")):
    setattr(BoundaryOracle, "test_a5_create_tasks_" + _label, boundary_test("create", "tasks", _value, _code))
for _field, _cap in (("title", 120), ("micro_text", 80)):
    setattr(BoundaryOracle, "test_a5_unicode_%s_maximum" % _field,
            boundary_test("create", _field, "😀" * _cap, None))
    setattr(BoundaryOracle, "test_a5_unicode_%s_overflow" % _field,
            boundary_test("create", _field, "😀" * (_cap + 1), "limit_exceeded"))


def standalone_test(field, value, expected):
    def test(self):
        if expected:
            def prepare(home):
                seed_plan(home)
            # seed_plan task.add is the second event, so current task rev is two.
            args = dict(room="demo", agent="worker", task_id="T01", base_rev=2, text="Check")
            args[field] = value
            self.rejects("microtask_add", args, expected, prepare=prepare)
        else:
            results = []
            for adapter in ("cli", "mcp"):
                home = self.tmp / adapter
                with deterministic(home):
                    args = fixture(home, "microtask_add")
                    args[field] = value
                    schema = next(t["inputSchema"] for t in rpc("tools/list")["result"]["tools"] if t["name"] == "microtask_add")
                    assert_structural(schema, args)
                    result = call(adapter, "microtask_add", args)
                    self.assertEqual(result[0], 0, result)
                    results.append(result)
            self.assertEqual(*results)
    return test


for _field, _value, _code, _label in (
        ("text", "x" * 80, None, "text_maximum"), ("text", "x" * 81, "limit_exceeded", "text_overflow"),
        ("text", "", "bad_op", "empty_text"), ("accept", "x" * 160, None, "accept_maximum"),
        ("accept", "x" * 161, "limit_exceeded", "accept_overflow"), ("accept", None, "bad_op", "null_accept")):
    setattr(BoundaryOracle, "test_a5_standalone_" + _label, standalone_test(_field, _value, _code))


class MutationOracle(FutureCase):
    def test_a8_remove_dispatch_from_each_adapter(self):
        cli = importlib.import_module("bridge.room.__main__")
        mcp = importlib.import_module("bridge.room.mcp")
        for adapter in ("cli", "mcp"):
            with dispatch_spy("list_templates", {}) as healthy:
                reference = call(adapter, "list_templates", {})
            self.assertEqual(reference[0], 0)
            self.assertTrue(healthy, "restored adapter does not enter application dispatch")

            def bypass_cli(argv):
                print(json.dumps(reference[1]))
                return 0

            def bypass_mcp(id_, params):
                mcp._result(id_, mcp._tool_result(reference[1]))

            target, attribute, replacement = ((cli, "main", bypass_cli) if adapter == "cli"
                                                else (mcp, "_handle_call", bypass_mcp))
            with patch.object(target, attribute, replacement):
                with dispatch_spy("list_templates", {}) as mutated:
                    self.assertEqual(call(adapter, "list_templates", {}), reference)
                with self.assertRaisesRegex(AssertionError, "same application dispatcher"):
                    assert_shared(healthy, mutated)
            with dispatch_spy("list_templates", {}) as restored:
                self.assertEqual(call(adapter, "list_templates", {}), reference)
            assert_shared(healthy, restored)

    def test_a8_remove_nested_items(self):
        tools = rpc("tools/list")["result"]["tools"]
        assert_schemas(tools)
        mutated = copy.deepcopy(tools)
        schema = next(t["inputSchema"] for t in mutated if t["name"] == "plan_create")
        micro = schema["properties"]["tasks"]["items"]["properties"]["microtasks"]
        del kind(micro, "array")["items"]
        with self.assertRaises(AssertionError):
            assert_schemas(mutated)
        assert_schemas(rpc("tools/list")["result"]["tools"])

    def test_a8_strip_detail(self):
        from bridge.room import mcp
        from bridge.room.store import RoomError
        expected = str(RoomError("no_plan", "no active plan"))
        reference = call("mcp", "plan_get", {"room": "demo"})
        assert_error(reference, "no_plan", expected)
        original = mcp._tool_result

        def strip(payload, *args, **kwargs):
            payload = copy.deepcopy(payload)
            payload.pop("detail", None)
            return original(payload, *args, **kwargs)
        with patch.object(mcp, "_tool_result", strip):
            with self.assertRaisesRegex(AssertionError, "detail"):
                assert_error(call("mcp", "plan_get", {"room": "demo"}), "no_plan", expected)
        assert_error(call("mcp", "plan_get", {"room": "demo"}), "no_plan", expected)

    def test_a8_omit_extension_dispatch(self):
        result = child("-m", "bridge.tests.room.u87.probe", "extension-mutation", str(self.home))
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), {"healthy": True, "mutant_rejected": True, "restored": True})


class PromptOracle(FutureCase):
    def test_amendment_executor_loop_appended_and_existing_entries_exact(self):
        prompts = rpc("prompts/list")["result"]["prompts"]
        # A-U111b: U111 appends swarm_coordinator/swarm_executor after executor_loop (mandated)
        self.assertEqual(prompts[:3], [
            {"name": "plan_from_template", "description": "Plan from template.", "arguments": [
                {"name": "template_id", "description": "Template id.", "required": True},
                {"name": "brief", "description": "Brief text.", "required": True}]},
            {"name": "resume_from_memory", "description": "Resume from memory.", "arguments": [
                {"name": "room", "description": "Room.", "required": True},
                {"name": "agent", "description": "Agent.", "required": False}]},
            {"name": "planning_contract", "description": "TaskLight planning contract for AI agents.", "arguments": [
                {"name": "room", "description": "Room.", "required": False},
                {"name": "agent", "description": "Agent.", "required": False}]},
        ])
        self.assertEqual(prompts[3]["name"], "executor_loop")
        self.assertEqual([(a["name"], a.get("required", False)) for a in prompts[3]["arguments"]],
                         [("room", True), ("agent", True), ("task_id", False)])

    def test_amendment_executor_loop_steering(self):
        for args in ({"room": "demo", "agent": "worker"}, {"room": "demo", "agent": "worker", "task_id": "T01"}):
            reply = rpc("prompts/get", {"name": "executor_loop", "arguments": args})
            self.assertNotIn("error", reply)
            messages = reply["result"]["messages"]
            self.assertTrue(messages)
            self.assertTrue(all(m["content"]["type"] == "text" for m in messages))
            text = "\n".join(m["content"]["text"] for m in messages)
            for token in ("contract", "task_claim", "microtask_set", "active", "activity_beat", "tools/list", "evidence", "done", "blocked", "release"):
                self.assertIn(token, text)
            self.assertRegex(text, r"30\s*(?:s\b|seconds\b)")
            self.assertRegex(text.lower(), r"skip|omit|unavailable|not available|absent|missing")
            self.assertIn("demo", text)
            self.assertIn("worker", text)
            if "task_id" in args:
                self.assertIn("T01", text)
            self.assertLess(text.index("task_claim"), text.index("active"))
            self.assertLess(text.lower().index("contract"), text.index("task_claim"))
            self.assertLess(text.index("active"), text.index("evidence"))
            self.assertEqual(journal(self.home), {})

    def test_amendment_executor_loop_rejects_invalid_slugs(self):
        for args in ({}, {"room": "demo"}, {"agent": "worker"}, {"room": "../x", "agent": "worker"},
                     {"room": "demo", "agent": "BAD"}, {"room": None, "agent": "worker"},
                     {"room": "demo", "agent": []}, {"room": "a" * 49, "agent": "worker"}):
            with self.subTest(args=args):
                reply = rpc("prompts/get", {"name": "executor_loop", "arguments": args})
                self.assertEqual(reply.get("error", {}).get("code"), -32602)
        self.assertEqual(tree_bytes(self.home), {})


class RegressionOracle(BaseCase):
    def test_oracle_application_stdout_control_is_not_vacuous(self):
        output = AdapterOutput()
        with redirect_stdout(output):
            print('adapter output')
        self.assertEqual(output.getvalue(), 'adapter output\n')
        namespace = {}
        exec(compile("def probe():\n    print('forbidden')\n", str(APP), 'exec'), namespace)
        with redirect_stdout(io.StringIO()):
            # A plain capture does not detect app I/O; the guarded capture must.
            namespace['probe']()
        with redirect_stdout(output):
            with self.assertRaisesRegex(AssertionError, 'application performed stdout I/O'):
                namespace['probe']()
        self.assertEqual(output.getvalue(), 'adapter output\n')

    def test_a4_mcp_invalid_envelopes_preserve_rpc_errors(self):
        for params in ([], {"name": "unknown_u87", "arguments": {}}, {"name": "plan_get", "arguments": []},
                       {"name": "plan_get", "arguments": None}, {"name": 1, "arguments": {}}, {"name": "plan_get"}):
            self.assertEqual(rpc("tools/call", params)["error"]["code"], -32602)
        self.assertEqual(tree_bytes(self.home), {})

    def test_a4_real_stdio_malformed_json_and_recovery(self):
        messages = b'not-json\n[]\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n'
        result = child("-m", "bridge.room.mcp", stdin=messages)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        values = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(values[0]["error"]["code"], -32700)
        self.assertEqual(values[1]["error"]["code"], -32600)
        self.assertEqual(values[2]["result"], {})

    def test_a7_missing_modules_skip_and_internal_dependency_propagates(self):
        from bridge.room import ext
        # A-U132c: retain U110 send and include U132 lifecycle and U119 acquire.
        # A-C3c: retain the exact ordered inventory with the snapshot extension.
        # A-C6: retain the exact module inventory with the stateless waiter.
        self.assertEqual(ext.EXT_MODULES, ("events", "activity", "export", "send", "lifecycle", "acquire",
                                           "orchestrator_snapshot", "waiter", "decision", "artifact", "pipeline"))  # A-C8: unit_bind and unit_repair
        with patch.object(ext, "EXT_MODULES", ("u87_intentionally_missing",)):
            self.assertEqual(ext.load(), ext.EXT_TOOLS)
        real_import = importlib.import_module

        def missing_dependency(name, *args, **kwargs):
            if name == "bridge.room.ext.events":
                raise ModuleNotFoundError("missing nested import", name="u87_internal_dependency")
            return real_import(name, *args, **kwargs)
        with patch.object(ext.importlib, "import_module", missing_dependency):
            with self.assertRaises(ModuleNotFoundError) as caught:
                ext.load()
        self.assertEqual(caught.exception.name, "u87_internal_dependency")

    def test_a9_legacy_commands_exact_outputs_and_exits(self):
        from bridge.room import store
        for verb in ("read", "status", "wait"):
            rc, payload, _, _ = cli_call([verb, "--room", "missing"])
            self.assertEqual((rc, payload), (4, {"ok": False, "code": "not_found"}))
        rc, payload, _, _ = cli_call(["post", "--room", "demo", "--agent", "worker", "--act", "heartbeat", "--text", "Ready"])
        self.assertEqual(rc, 0)
        events, _ = store.read("demo")
        self.assertEqual(payload, {"ok": True, "event": events[0]})
        self.assertEqual(cli_call(["read", "--room", "demo", "--json"])[:2], (0, {"events": events, "malformed": 0}))
        self.assertEqual(cli_call(["read", "--room", "demo"])[:2], (0, {"events": events, "malformed": 0}))
        self.assertEqual(cli_call(["status", "--room", "demo"])[:2], (0, store.status("demo")))
        self.assertEqual(cli_call(["wait", "--room", "demo", "--timeout", "0"])[:2], (0, {"ok": True, "event": events[0]}))
        self.assertEqual(cli_call(["wait", "--room", "demo", "--since", "1", "--timeout", "0"])[:2],
                         (124, {"ok": False, "code": "timeout"}))
        self.assertEqual(cli_call(["post", "--room", "demo", "--agent", "worker", "--act", "invalid", "--text", "x"])[:2],
                         (2, {"ok": False, "code": "bad_act"}))

    def test_a9_import_app_silent_and_no_mcp_dependency(self):
        result = child("-m", "bridge.tests.room.u87.probe", "import", str(self.home))
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), {"stdout": "", "stderr": "", "writes": False, "mcp_loaded": False})
        tree = ast.parse(APP.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                self.assertFalse(any(n.name == "bridge.room.mcp" for n in node.names))
            elif isinstance(node, ast.ImportFrom):
                self.assertNotEqual(node.module, "bridge.room.mcp")
                if node.module in ("bridge.room", None):
                    self.assertNotIn("mcp", [n.name for n in node.names])

    def test_m1_initialization_resources_and_prompts_stay_in_mcp(self):
        self.assertEqual(rpc("initialize")["result"]["capabilities"], {"tools": {}, "resources": {}, "prompts": {}})
        self.assertIn("resources", rpc("resources/list")["result"])
        self.assertIn("resourceTemplates", rpc("resources/templates/list")["result"])
        self.assertIn("prompts", rpc("prompts/list")["result"])

    def test_oracle_dispatch_control_is_not_vacuous(self):
        witness = {object()}
        assert_shared(witness, witness)
        with self.assertRaises(AssertionError):
            assert_shared(witness, set())

    def test_oracle_detail_control_is_not_vacuous(self):
        reference = (3, {"ok": False, "code": "stale_rev", "detail": "stale_rev: probe"})
        assert_error(reference, "stale_rev", "stale_rev: probe")
        with self.assertRaises(AssertionError):
            assert_error((3, {"ok": False, "code": "stale_rev"}), "stale_rev", "stale_rev: probe")

    def test_oracle_nested_items_control_is_not_vacuous(self):
        schema = {"type": ["array", "null"], "maxItems": 12, "items": {
            "type": "object", "additionalProperties": False, "required": ["text"], "properties": {
                "text": {"type": "string", "minLength": 1, "maxLength": 80},
                "accept": {"type": "string", "maxLength": 160}}}}
        assert_micro_array(schema)
        del schema["items"]
        with self.assertRaises(AssertionError):
            assert_micro_array(schema)
