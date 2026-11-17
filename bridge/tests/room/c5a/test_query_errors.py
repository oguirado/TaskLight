"""M2-M5 public query errors and healthy/legacy controls through real adapters."""
import json
from unittest import mock

from bridge.plan import template as template_module
from bridge.room import mcp, store
from bridge.room import __main__ as cli
from bridge.wall.emit import sanitize_output
from .support import (BROKEN_JOURNALS, NOW, RAW_RECORD, TRANSPORTS,
                      OracleCase, unwrap)


class QueryErrors(OracleCase):
    def test_m3_cli_agents_list_error_code_is_reported(self):
        self.seed_agent()
        self.break_journal("malformed_json")
        with self.unchanged():
            rc, output, errors = self.cli_call("agents_list", self.args("agents_list"))
        self.assertNotEqual(rc, 0, "M3 broken inventory must fail the CLI call")
        # A-C5a: the CLI keeps its existing convention (JSON error on stdout); stderr is also accepted.
        self.assertIn("room_read_failed", output + errors, "M3 requires the error code in the CLI error output")
        self.assert_private(output + errors)

    def test_m4_since_rev_does_not_hide_a_broken_complete_record(self):
        self.seed_plan()
        self.break_journal("malformed_json")
        with self.unchanged():
            self.query_error("plan_get", "direct", args=dict(room="demo", since_rev=0))

    def test_m4_missing_required_template_is_not_reported_as_no_plan(self):
        self.seed_plan()
        self.template_path.unlink()
        with self.unchanged():
            self.query_error("plan_get", "direct", "template_unavailable")

    def test_m4_template_loader_failure_has_fixed_public_detail(self):
        self.seed_plan()
        original = template_module.load_template

        def unavailable(path):
            if str(path) == str(self.template_path):
                raise RuntimeError(RAW_RECORD + " " + str(self.template_path))
            return original(path)

        with self.unchanged(), mock.patch.object(template_module, "load_template", side_effect=unavailable):
            self.query_error("plan_get", "mcp", "template_unavailable")

    def test_m5_mcp_error_still_passes_through_sanitize_output(self):
        self.seed_agent()
        self.break_journal("malformed_json")
        with self.unchanged(), mock.patch.object(mcp, "sanitize_output", wraps=sanitize_output) as sanitize:
            self.query_error("agents_list", "mcp")
        self.assertTrue(any(isinstance(call.args[0], dict) and
                            call.args[0].get("code") == "room_read_failed"
                            for call in sanitize.call_args_list), "M5 error must use the shared sanitizer")

    def test_m5_cli_error_still_passes_through_sanitize_output(self):
        self.seed_agent()
        self.break_journal("malformed_json")
        with self.unchanged(), mock.patch.object(cli, "sanitize_output", wraps=sanitize_output) as sanitize:
            self.query_error("agents_list", "cli")
        self.assertTrue(any(isinstance(call.args[0], dict) and
                            call.args[0].get("code") == "room_read_failed"
                            for call in sanitize.call_args_list), "M5 CLI error must use the shared sanitizer")

    def test_m3_failed_room_does_not_hide_healthy_room_inventory(self):
        expected = self.seed_agent(room="healthy")
        self.install(b"bad\n")
        with self.unchanged():
            self.query_error("agents_list", "direct")
            self.assertEqual(self.direct("agents_list", self.args("agents_list", "healthy")), expected)

    def test_m4_repaired_template_restores_the_healthy_plan(self):
        expected = self.seed_plan()
        self.template_path.unlink()
        with self.unchanged():
            self.query_error("plan_get", "direct", "template_unavailable")
        self.template_path.write_bytes(self.template_bytes)
        with self.unchanged():
            self.assertEqual(self.direct("plan_get", dict(room="demo")), expected)


def query_case(tool, kind, transport):
    def check(self):
        if tool == "agents_list":
            self.seed_agent()
        else:
            self.seed_plan()
        path = self.break_journal(kind)
        with self.unchanged(), self.io_fault(path, kind):
            self.query_error(tool, transport)
    check.__doc__ = "M3/M4/M5 %s rejects %s via %s." % (tool, kind, transport)
    return check


for _tool in ("agents_list", "plan_get"):
    for _kind in BROKEN_JOURNALS:
        for _transport in TRANSPORTS:
            setattr(QueryErrors, "test_%s_%s_%s" % (_tool, _kind, _transport),
                    query_case(_tool, _kind, _transport))


def template_case(kind, transport):
    def check(self):
        self.seed_plan()
        if kind == "missing":
            self.template_path.unlink()
        elif kind == "corrupt":
            self.template_path.write_bytes(b'{"private":"' + RAW_RECORD.encode() + b'"')
        elif kind == "directory":
            self.template_path.unlink()
            self.template_path.mkdir()
        with self.unchanged(), self.io_fault(self.template_path, kind):
            self.query_error("plan_get", transport, "template_unavailable")
    return check


for _kind in ("missing", "corrupt", "directory", "open_denied", "read_failed"):
    for _transport in TRANSPORTS:
        setattr(QueryErrors, "test_m4_required_template_%s_%s" % (_kind, _transport),
                template_case(_kind, _transport))


class QueryControls(OracleCase):
    def test_m2_never_created_plan_room_keeps_its_existing_no_plan_error(self):
        with self.unchanged():
            self.expect_room_error(lambda: self.direct("plan_get", dict(room="never-created")),
                                   "no_plan", fixed=False)
        self.assertFalse(self.home.exists())

    def test_m2_never_created_plan_room_keeps_mcp_no_plan(self):
        with self.unchanged():
            result, payload, _ = self.mcp_call("plan_get", dict(room="never-created"))
        self.assertIs(result.get("isError"), True)
        self.assertEqual(payload.get("code"), "no_plan")

    def test_m2_never_created_plan_room_keeps_cli_no_plan(self):
        with self.unchanged():
            rc, output, errors = self.cli_call("plan_get", dict(room="never-created"))
        self.assertNotEqual(rc, 0)
        self.assertIn("no_plan", output + errors)

    def test_m4_healthy_plan_and_inventory_match_mcp_and_cli(self):
        self.seed_plan()
        self.seed_agent()
        for tool in ("plan_get", "agents_list"):
            with self.subTest(tool=tool), self.unchanged():
                args = self.args(tool)
                expected = sanitize_output(self.direct(tool, args))
                result, payload, _ = self.mcp_call(tool, args)
                self.assertIs(result.get("isError"), False)
                self.assertEqual(payload, expected)
                rc, output, errors = self.cli_call(tool, args)
                self.assertEqual(rc, 0)
                self.assertEqual(errors, "")
                self.assertEqual(unwrap(json.loads(output)), expected)

    def test_m1_public_queries_do_not_recreate_a_removed_writer_lock(self):
        self.seed_plan()
        self.seed_agent()
        lock = self.path().parent / "events.lock"
        if lock.exists():
            lock.unlink()
        with self.unchanged():
            self.direct("plan_get", self.args("plan_get"))
            self.direct("agents_list", self.args("agents_list"))
        self.assertFalse(lock.exists(), "M1 query reads must not initialize a writer lock")

    def test_m4_unrelated_invalid_template_does_not_break_a_required_healthy_one(self):
        expected = self.seed_plan()
        (self.template_path.parent / "unrelated.json").write_bytes(b"bad-template")
        with self.unchanged():
            self.assertEqual(self.direct("plan_get", dict(room="demo")), expected)

    def test_m4_since_rev_healthy_projection_is_preserved(self):
        self.seed_plan()
        opened = next(e["lamport"] for e in store.read("demo")[0]
                      if e.get("op", {}).get("kind") == "plan.open")
        with self.unchanged():
            result = self.direct("plan_get", dict(room="demo", since_rev=opened))
        self.assertEqual(result["plan"]["state"], "active")
        self.assertEqual(result["tasks"], [])
        self.assertEqual(result["last_lamport"], opened)

    def test_m6_snapshot_still_rejects_torn_tail_that_checked_queries_accept(self):
        self.seed_agent()
        self.path().write_bytes(self.path().read_bytes() + b'{"unfinished":')
        with self.unchanged():
            self.expect_room_error(lambda: self.direct("orchestrator_snapshot", dict(room="demo")),
                                   "snapshot_unavailable", fixed=False)


def empty_control(data, tool, transport):
    def check(self):
        self.install(data)
        with self.unchanged():
            if transport == "direct":
                if tool == "plan_get":
                    self.expect_room_error(lambda: self.direct(tool, self.args(tool)), "no_plan", fixed=False)
                else:
                    result = self.direct(tool, self.args(tool))
                    self.assertEqual(result["agents"], [])
                    self.assertEqual(result["totals"]["total"], 0)
            elif transport == "mcp":
                result, payload, _ = self.mcp_call(tool, self.args(tool))
                self.assertIs(result.get("isError"), tool == "plan_get")
                if tool == "plan_get":
                    self.assertEqual(payload.get("code"), "no_plan")
                else:
                    self.assertEqual(payload["agents"], [])
                    self.assertEqual(payload["totals"]["total"], 0)
            else:
                rc, output, errors = self.cli_call(tool, self.args(tool))
                if tool == "plan_get":
                    self.assertNotEqual(rc, 0)
                    self.assertIn("no_plan", output + errors)
                else:
                    self.assertEqual(rc, 0)
                    self.assertEqual(unwrap(json.loads(output))["agents"], [])
                    self.assertEqual(unwrap(json.loads(output))["totals"]["total"], 0)
    return check


for _name, _data in (("empty", b""), ("blank", b"\n \t\n")):
    for _tool in ("agents_list", "plan_get"):
        for _transport in TRANSPORTS:
            setattr(QueryControls, "test_m1_%s_%s_%s" % (_name, _tool, _transport),
                    empty_control(_data, _tool, _transport))


def torn_control(tool, transport):
    def check(self):
        expected = self.seed_agent() if tool == "agents_list" else self.seed_plan()
        self.path().write_bytes(self.path().read_bytes() + b'{"text":"\xe6\x97')
        with self.unchanged():
            if transport == "direct":
                actual = self.direct(tool, self.args(tool))
            elif transport == "mcp":
                result, actual, _ = self.mcp_call(tool, self.args(tool))
                self.assertIs(result.get("isError"), False, "M1 torn tail must not cause an error")
                expected = sanitize_output(expected)
            else:
                rc, output, errors = self.cli_call(tool, self.args(tool))
                self.assertEqual(rc, 0, "M1 torn tail must not cause an error")
                self.assertEqual(errors, "")
                actual = unwrap(json.loads(output))
                expected = sanitize_output(expected)
            self.assertEqual(actual, expected)
    return check


for _tool in ("agents_list", "plan_get"):
    for _transport in TRANSPORTS:
        setattr(QueryControls, "test_m1_torn_%s_%s" % (_tool, _transport),
                torn_control(_tool, _transport))


def hostile_control(tool, room):
    def check(self):
        with self.unchanged():
            self.expect_room_error(lambda: self.direct(tool, dict(room=room)), "bad_room", fixed=False)
    return check


for _tool in ("agents_list", "plan_get"):
    for _name, _room in (("traversal", "../escape"), ("non_string", 42), ("control", "bad\nroom")):
        setattr(QueryControls, "test_m2_hostile_%s_%s" % (_tool, _name), hostile_control(_tool, _room))
