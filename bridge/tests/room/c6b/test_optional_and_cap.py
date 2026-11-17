"""A-C6b: optional fields stay passive, validated data; file limits use bytes."""
import copy
import io
import itertools
import json
from contextlib import redirect_stderr
from unittest import mock

from bridge.room import app, store
from bridge.room.ext import supervise
from ..c6 import test_supervise
from ..c6.support import RESULT, RoomCase


class OptionalAndCapOracle(RoomCase):
    def test_verdict_only_is_returned_by_wait_agents_on_both_transports(self):
        result = {"verdict": "OK"}
        for state in ("finished", "failed"):
            agent = "worker-" + state
            self.life(agent=agent, state=state, result=result,
                      parent_agent="leader", parent_run_id="leader-run")
        args = {"room": "demo", "parent": "leader", "since_lamport": 0}
        response, data = self.mcp_call("wait_agents", args)
        code, cli_data, stderr = self.cli_call("wait_agents", args)
        self.assertFalse(response.get("isError", False))
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(cli_data, data)
        self.assertEqual([row["state"] for row in data["events"]], ["finished", "failed"])
        self.assertEqual([row["result"] for row in data["events"]], [result, result])
        self.assertEqual(self.direct_wait(parent="leader", since_lamport=0), data)

    def test_every_optional_field_combination_survives_replay(self):
        fields = ("summary", "receipt", "evidence")
        for count in range(len(fields) + 1):
            for subset in itertools.combinations(fields, count):
                with self.subTest(fields=subset):
                    result = {"verdict": "ADMIT", **{key: copy.deepcopy(RESULT[key]) for key in subset}}
                    agent = "worker-" + str(next(self.seq))
                    self.life(agent=agent, state="finished", result=result)
                    reply = self.direct_wait(agents=[agent])
                    self.assertEqual(reply["events"][0]["result"], result)
                    self.assertEqual(self.events()[-1]["op"]["result"], result)

    def test_missing_verdict_is_bad_args_without_appending(self):
        before = self.raw()
        for result in ({}, {"summary": "done"}, {"receipt": "artifacts/result.json"}, {"evidence": []}):
            with self.subTest(result=result):
                with self.assertRaises(store.RoomError) as caught:
                    app.dispatch("agent_lifecycle", dict(room="demo", agent="worker", run_id="r1",
                        state="finished", op_id="missing-verdict", result=result))
                self.assertEqual(caught.exception.code, "bad_args")
                self.assertEqual(self.raw(), before)

    def test_present_optional_fields_and_unknown_keys_still_validate(self):
        invalid = ({"summary": None}, {"summary": "s" * 2001}, {"receipt": False},
                   {"receipt": "p" * 513}, {"evidence": None}, {"evidence": [{}]},
                   {"evidence": [{"path": "artifacts/e", "sha256": "bad"}]}, {"unknown": True})
        before = self.raw()
        for fields in invalid:
            with self.subTest(fields=fields):
                with self.assertRaises(store.RoomError) as caught:
                    app.dispatch("agent_lifecycle", dict(room="demo", agent="worker", run_id="r1",
                        state="failed", op_id="invalid-optional", result={"verdict": "FAIL", **fields}))
                self.assertEqual(caught.exception.code, "bad_args")
                self.assertEqual(self.raw(), before)

    def test_tool_schema_requires_only_verdict(self):
        tool = next(tool for tool in app.list_tools() if tool["name"] == "agent_lifecycle")
        schema = tool["inputSchema"]["properties"]["result"]
        self.assertEqual(schema["required"], ["verdict"])
        self.assertFalse(schema["additionalProperties"])

    def test_result_file_with_only_verdict_is_attached(self):
        result = {"verdict": "OK"}
        terminal, stderr, _ = test_supervise.SupervisorOracle.supervise(self, contents=json.dumps(result))
        self.assertEqual(terminal["op"].get("result"), result)
        self.assertEqual(stderr, "")

    def payload(self, size, *, unicode=False):
        result = dict(RESULT, summary="é" * 2000) if unicode else RESULT
        encoded = json.dumps(result, ensure_ascii=False).encode("utf-8")
        return result, encoded + b" " * (size - len(encoded))

    def test_exact_byte_cap_is_accepted(self):
        result, payload = self.payload(65536, unicode=True)
        self.assertEqual(len(payload), 65536)
        terminal, stderr, _ = test_supervise.SupervisorOracle.supervise(self, contents=payload)
        self.assertEqual(terminal["op"].get("result"), result)
        self.assertEqual(stderr, "")

    def check_oversize(self, code, *, unicode=False):
        _, payload = self.payload(65537, unicode=unicode)
        self.assertEqual(len(payload), 65537)
        if unicode:
            self.assertLess(len(payload.decode("utf-8")), 65536)
        terminal, stderr, _ = test_supervise.SupervisorOracle.supervise(self, code=code, contents=payload)
        self.assertFalse("result" in terminal["op"])
        self.assertEqual(len(stderr.splitlines()), 1)
        self.assertNotIn("artifacts/", stderr)
        reply = self.direct_wait(agents=["worker"])
        self.assertEqual(len(reply["events"]), 1)
        self.assertNotIn("result", reply["events"][0])

    def test_oversize_file_keeps_finished_event(self):
        self.check_oversize(0)

    def test_oversize_file_keeps_failed_event_and_exit_status(self):
        self.check_oversize(7)

    def test_cap_counts_utf8_bytes_instead_of_characters(self):
        self.check_oversize(0, unicode=True)

    def test_result_reader_never_requests_unbounded_input(self):
        opened = mock.MagicMock()
        opened.__enter__.return_value = opened
        opened.read.return_value = b" " * 65537
        stderr = io.StringIO()
        with mock.patch("builtins.open", return_value=opened), redirect_stderr(stderr):
            self.assertIsNone(supervise._read_result("results/worker.json"))
        opened.read.assert_called_once_with(65537)
        self.assertEqual(len(stderr.getvalue().splitlines()), 1)
