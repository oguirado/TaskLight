"""Deterministic C7b fixtures for the real bridge, journal, MCP and CLI."""
import hashlib
import os
from pathlib import Path
from unittest import mock

from bridge.room import app, store
from bridge.tests.room.c7 import support as c7

ROOT = c7.ROOT
HERE = Path(__file__).resolve().parent
ARTIFACT = "artifacts/report.txt"
ROOM = "demo"
REVIEWER = {"room": ROOM, "agent": "reviewer"}
WORKER = {"room": ROOM, "agent": "worker", "run_id": "worker-run"}
NO_REFERENCE = "path is not a recorded receipt or evidence path"


def digest(data):
    return hashlib.sha256(data).hexdigest()


class RoomCase(c7.RoomCase):
    def setUp(self):
        self.enterContext(mock.patch.object(c7, "HERE", HERE))
        super().setUp()

    def dispatch(self, name, args):
        with c7.bounded():
            return c7.unwrap(app.dispatch(name, args))

    def mcp_ok(self, name, args):
        response, data = self.mcp_call(name, args)
        self.assertFalse(response.get("isError", False), data)
        return data

    def open_plan(self, title="Review plan"):
        created = self.dispatch("plan_create", {
            **REVIEWER, "title": title, "template_id": "blank", "brief": {"goal": title},
            "tasks": [{"key": "review", "title": title + " task", "phase": "plan",
                       "type": "task", "accept": "Record the review decision"}],
        })
        return created["opened_lamport"]

    def lifecycle(self, state, **fields):
        return self.dispatch("agent_lifecycle", {**WORKER, "state": state, **fields})

    def terminal(self, state="finished", **fields):
        worker = {key: fields.pop(key) for key in ("room", "agent", "run_id") if key in fields}
        self.lifecycle("deployed", **worker)
        return self.lifecycle(state, **worker, **fields)

    def record_receipt(self, path=ARTIFACT, **fields):
        return self.terminal(result={"verdict": "OK", "receipt": path}, **fields)

    def record_evidence(self, expected_hash, path=ARTIFACT, **fields):
        return self.terminal(result={
            "verdict": "OK", "evidence": [{"path": path, "sha256": expected_hash}],
        }, **fields)

    def assert_room_error(self, fn, code=None, detail=None):
        with self.assertRaises(store.RoomError) as caught:
            fn()
        error = caught.exception
        if code is not None:
            self.assertEqual(error.code, code)
        if detail is not None:
            self.assertEqual(str(error).removeprefix(error.code + ": "), detail)


class ProjectCase(RoomCase):
    def setUp(self):
        super().setUp()
        self.project = self.home / "project"
        (self.project / "artifacts").mkdir(parents=True)
        original_cwd = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, original_cwd)
        self.addCleanup(os.fchdir, original_cwd)
        os.chdir(self.project)

    def write_artifact(self, data, path=ARTIFACT):
        (self.project / path).write_bytes(data)
        return digest(data)

