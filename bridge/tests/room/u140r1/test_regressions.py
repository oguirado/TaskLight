"""Generation-bound replay, side-effect-free validation, and discovery regressions."""
import copy
import hashlib
import json
import os
from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bridge.plan import fold_plan
from bridge.room import app, store

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
ROOM = "generation-test"
AGENT = "executor-a"
SAFE_MAX = 9007199254740991
INVALID = (None, 0, -1, "1", False, True, 1.0, SAFE_MAX + 1)
FENCED_TOOLS = (
    "task_add", "task_update", "task_claim", "task_release",
    "microtask_add", "microtask_set", "plan_phase", "plan_close",
)


def digest(request):
    raw = json.dumps(request, sort_keys=True, separators=(",", ":"),
                     ensure_ascii=False, allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


class GenerationCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / "cw"
        self.enterContext(patch.dict(os.environ, {"CW_HOME": str(self.home)}))
        template = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
        self.template = template
        self.templates = {template["id"]: template}
        directory = self.home / "templates"
        directory.mkdir(parents=True)
        (directory / (template["id"] + ".json")).write_text(json.dumps(template))
        self.open_plan()

    def post(self, op, **kwargs):
        return store.post(ROOM, AGENT, "op", "", op=copy.deepcopy(op),
                          home=self.home, templates=self.templates, **kwargs)

    def open_plan(self):
        self.post(dict(kind="plan.open", title="Generation fixture",
                       template_id=self.template["id"], template_hash=self.template["hash"],
                       brief={"goal": "Verify generation-bound replay"}, phase="start"))

    def add_op(self, op_id="generation-add-01"):
        return dict(kind="task.add", title="Guarded work", type="action", phase="start",
                    accept="Verified", microtasks=[{"text": "Execute"}], op_id=op_id)

    def raw(self):
        return (self.home / "rooms" / ROOM / "events.jsonl").read_bytes()

    def projection(self):
        return fold_plan([json.loads(line) for line in self.raw().splitlines()],
                         templates=self.templates)

    @property
    def generation(self):
        return self.projection()["plan"]["opened_lamport"]

    def reopen(self):
        previous = self.generation
        for task in self.projection()["tasks"]:
            self.post(dict(kind="task.set", task_id=task["id"],
                           base_rev=task["rev"], state="cancelled"))
        self.post(dict(kind="plan.close", base_rev=self.projection()["plan"]["rev"]))
        self.open_plan()
        self.assertGreater(self.generation, previous)
        self.assertEqual(self.projection()["rejected"], [])

    def call(self, batch, ops, **kwargs):
        if batch:
            return store.post_ops(ROOM, AGENT, copy.deepcopy(ops), home=self.home,
                                  templates=self.templates, **kwargs)
        return self.post(ops[0], **kwargs)

    def cross_generation(self, batch):
        ops = [self.add_op()]
        if batch:
            ops.append(self.add_op("generation-add-02"))
        self.call(batch, ops, expected_opened_lamport=self.generation)
        self.reopen()
        before = self.raw()
        with self.assertRaises(store.RoomError) as caught:
            self.call(batch, ops, expected_opened_lamport=self.generation)
        self.assertEqual(caught.exception.code, "bad_op")
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.projection()["tasks"], [])

    def test_b1_single_reused_id_cannot_replay_previous_generation(self):
        self.cross_generation(False)

    def test_b1_batch_reused_id_cannot_replay_previous_generation(self):
        self.cross_generation(True)

    def test_b1_dispatcher_claim_cannot_return_previous_generation_receipt(self):
        self.post(self.add_op())
        args = dict(room=ROOM, agent=AGENT, task_id="T01", op_id="generation-claim-01",
                    expected_opened_lamport=self.generation)
        first = app.dispatch("task_claim", args)["untrusted"]
        self.assertFalse(first["replayed"])
        self.assertEqual(first["task"]["assignee"], AGENT)
        self.reopen()
        self.post(self.add_op("generation-new-01"))
        args["expected_opened_lamport"] = self.generation
        before = self.raw()
        with self.assertRaises(store.RoomError) as caught:
            app.dispatch("task_claim", args)
        self.assertEqual(caught.exception.code, "bad_op")
        self.assertEqual(self.raw(), before)
        self.assertIsNone(self.projection()["tasks"][0]["assignee"])

    def test_same_generation_replay_and_unfenced_hashes_remain_stable(self):
        for batch in (False, True):
            for fenced in (False, True):
                with self.subTest(batch=batch, fenced=fenced):
                    ops = [self.add_op("stable-%s-%s-01" % (batch, fenced))]
                    if batch:
                        ops.append(self.add_op("stable-%s-%s-02" % (batch, fenced)))
                    fence = {"expected_opened_lamport": self.generation} if fenced else {}
                    original = self.call(batch, ops, **fence)
                    before = self.raw()
                    replay = self.call(batch, ops, **fence)
                    originals = original if batch else [original]
                    replays = replay if batch else [replay]
                    self.assertEqual(self.raw(), before)
                    self.assertEqual([event["id"] for event in originals],
                                     [event["id"] for event in replays])
                    self.assertTrue(all(event["replayed"] for event in replays))
                    if not fenced:
                        if batch:
                            request = {"strict": False, "ops": ops}
                            actual = original[0]["batch"]["request_sha256"]
                        else:
                            request = dict(act="op", text="", re=None, to=None,
                                           evidence=[], op=ops[0])
                            actual = original["request_sha256"]
                        self.assertEqual(actual, digest(request))

    def invalid_backend(self, batch, typed=False):
        for value in INVALID:
            with self.subTest(value=value, batch=batch, typed=typed), ExitStack() as stack:
                for name in ("_ensure_dirs", "_resolve_ts", "_validate_evidence", "_message_evidence"):
                    stack.enter_context(patch.object(store, name,
                        side_effect=AssertionError("invalid fence reached " + name)))
                with self.assertRaises(store.RoomError) as caught:
                    if batch:
                        store.post_ops("unused", AGENT, [self.add_op()], home=self.home,
                                       expected_opened_lamport=value)
                    else:
                        kwargs = {"_typed_message": True} if typed else {}
                        store.post("unused", AGENT, "question" if typed else "heartbeat", "Check",
                                   evidence=["missing.txt"], home=self.home,
                                   expected_opened_lamport=value, **kwargs)
                self.assertEqual(caught.exception.code, "bad_op")
                self.assertFalse((self.home / "rooms" / "unused").exists())

    def test_b2_invalid_single_fence_precedes_evidence_clock_and_filesystem(self):
        self.invalid_backend(False)

    def test_b2_invalid_typed_fence_precedes_evidence_io(self):
        self.invalid_backend(False, typed=True)

    def test_b2_invalid_batch_fence_precedes_clock_and_filesystem(self):
        self.invalid_backend(True)

    def test_b2_invalid_dispatcher_fence_is_bad_op_even_with_zero_base_rev(self):
        self.post(self.add_op())
        before = self.raw()
        for value in INVALID:
            with self.subTest(value=value):
                with self.assertRaises(store.RoomError) as caught:
                    app.dispatch("task_update", dict(room=ROOM, agent=AGENT,
                        task_id="T01", base_rev=0, title="Changed",
                        expected_opened_lamport=value))
                self.assertEqual(caught.exception.code, "bad_op")
                self.assertEqual(self.raw(), before)

    def test_b2_invalid_post_one_fence_never_reaches_backend(self):
        with patch.object(store, "post", side_effect=AssertionError("backend reached")):
            with self.assertRaises(store.RoomError) as caught:
                app._post_one(ROOM, AGENT, dict(kind="task.set", task_id="T01", base_rev=0),
                              args={"expected_opened_lamport": None})
        self.assertEqual(caught.exception.code, "bad_op")

    def test_positive_safe_integer_boundaries_are_generation_errors(self):
        self.reopen()
        before = self.raw()
        for batch in (False, True):
            for value in (1, SAFE_MAX):
                with self.subTest(batch=batch, value=value):
                    with self.assertRaises(store.RoomError) as caught:
                        self.call(batch, [self.add_op()], expected_opened_lamport=value)
                    self.assertEqual(caught.exception.code, "stale_rev")
                    self.assertEqual(self.raw(), before)


class DiscoverySchemas(unittest.TestCase):
    pass


def schema_case(tool):
    def test(self):
        schemas = {item["name"]: item["inputSchema"] for item in app.list_tools()}
        schema = schemas[tool]
        self.assertEqual(schema["properties"].get("expected_opened_lamport"),
                         {"type": "integer", "minimum": 1, "maximum": SAFE_MAX})
        self.assertNotIn("expected_opened_lamport", schema["required"])
    return test


for tool in FENCED_TOOLS:
    setattr(DiscoverySchemas, "test_b3_optional_bounded_fence_" + tool, schema_case(tool))
