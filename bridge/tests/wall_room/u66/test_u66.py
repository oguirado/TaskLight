"""Behavioral oracle for plan operations crossing the wall relay; stdlib only."""
import copy
import hashlib
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from bridge.plan.conformance import check_conformance
from bridge.plan.fold import fold_plan
from bridge.plan.errors import PlanError
from bridge.plan.ops import validate_op_shape
from bridge.plan.template import validate_template
from bridge.room import app, mcp, store
from bridge.wall import room_relay as relay
from bridge.wall.emit import redact
from bridge.tests.wall_room import support as S

ROOT = Path(__file__).resolve().parents[4]
HEX_ID = "0123456789abcdef0123456789abcdef"
RUN_IDS = (HEX_ID + "-exec-a", HEX_ID + "-exec-b")


def web_template():
    raw = json.loads((ROOT / "templates/planning/web-app.json").read_text(encoding="utf-8"))
    return validate_template(raw)


def event(**op):
    return S.event(1, act="op", op=dict(kind="plan.open", **op))


def run_event(kind, run_id, lamport=1):
    op = dict(kind=kind, run_id=run_id, op_id="run-op-%04d" % lamport)
    if kind == "agent.lifecycle":
        op.update(state="deployed", harness="external")
    else:
        op.update(task_id="T01", micro_id="T01.M01")
    return S.event(lamport, act="op", op=op)


class SanitizeOracle(unittest.TestCase):
    def setUp(self):
        self.digest = web_template()["hash"]

    def test_a1_real_template_hash_survives(self):
        value, count, classes = redact(self.digest)
        self.assertNotEqual(value, self.digest, "fixture must expose the real entropy bug")
        self.assertGreater(count, 0)
        self.assertEqual(set(classes), {"HIGH_ENTROPY"})
        source = event(title="Oracle plan", template_id="web-app", template_hash=self.digest,
                       brief={"goal": "Deliver"}, phase="discovery", op_id="agent-op-0001")
        self.assertEqual(fold_plan([source], templates={"web-app": web_template()})["rejected"], [])
        before = copy.deepcopy(source)
        clean = relay.sanitize_event(source)
        self.assertIsNotNone(clean)
        self.assertEqual(clean["op"]["template_hash"], self.digest)
        self.assertEqual(source, before)

    def test_m1_exemption_is_not_restricted_to_plan_open(self):
        source = event(template_hash=self.digest)
        source["op"]["kind"] = "memory.set"
        clean = relay.sanitize_event(source)
        self.assertIsNotNone(clean)
        self.assertEqual(clean["op"]["template_hash"], self.digest)

    def test_a2_other_redaction_classes_prevent_exemption(self):
        for classes in (["KEY_ASSIGN"], ["HIGH_ENTROPY", "KEY_ASSIGN"],
                        ["EMAIL", "HIGH_ENTROPY"]):
            with self.subTest(classes=classes):
                marker = "[REDACTED:KEY_ASSIGN]"
                def redactor(text, _disable=frozenset()):
                    return (marker, 1, classes) if text == self.digest else (text, 0, [])
                with S.patched_redact(redactor):
                    clean = relay.sanitize_event(event(template_hash=self.digest))
                if clean is not None:
                    self.assertEqual(clean["op"]["template_hash"], marker)
                    self.assertNotIn(self.digest, repr(clean))

    def test_m1_invalid_hashes_keep_existing_redaction(self):
        for value in (self.digest.upper(), self.digest[:-1], self.digest + "a",
                      "g" + self.digest[1:], "prefix-" + self.digest,
                      S.FAKE_SECRET, "b" * 64, "", None, 17):
            with self.subTest(value=value):
                expected = redact(value)[0] if isinstance(value, str) else value
                clean = relay.sanitize_event(event(template_hash=value))
                self.assertIsNotNone(clean)
                self.assertEqual(clean["op"]["template_hash"], expected)

    def test_a3_changed_op_id_gets_exact_deterministic_surrogate(self):
        expected = "h-" + hashlib.sha256(HEX_ID.encode("utf-8")).hexdigest()[:32]
        outputs = [relay.sanitize_event(event(op_id=HEX_ID)) for _ in range(2)]
        for clean in outputs:
            self.assertIsNotNone(clean)
            self.assertEqual(clean["op"]["op_id"], expected)
            self.assertRegex(clean["op"]["op_id"], r"^[A-Za-z0-9_-]{8,64}$")
            self.assertNotIn(HEX_ID, repr(clean))
        self.assertEqual(outputs[0], outputs[1])

    def test_m2_non_entropy_secret_op_ids_use_utf8_surrogate(self):
        originals = (S.FAKE_SECRET, S.FAKE_SECRET + "é")
        outputs = [relay.sanitize_event(event(op_id=value)) for value in originals]
        self.assertTrue(all(clean is not None for clean in outputs))
        expected = ["h-" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]
                    for value in originals]
        self.assertEqual([clean["op"]["op_id"] for clean in outputs], expected)
        self.assertNotIn(S.FAKE_VALUE, repr(outputs))

    def test_a4_clean_op_id_is_unchanged(self):
        source = event(op_id="agent-op-0001")
        self.assertEqual(relay.sanitize_event(source), source)

    def test_u157_run_ids_are_valid_stable_distinct_and_invalid_ids_stay_rejected(self):
        identities = {}
        for run_id in (*RUN_IDS, "r", "r" * 64, HEX_ID * 2):
            expected = (run_id if redact(run_id)[0] == run_id else
                        "h-" + hashlib.sha256(run_id.encode("utf-8")).hexdigest()[:32])
            for kind in ("agent.lifecycle", "activity.beat"):
                with self.subTest(kind=kind, run_id=run_id):
                    source = run_event(kind, run_id)
                    before = copy.deepcopy(source)
                    outputs = [relay.sanitize_event(source) for _ in range(2)]
                    if outputs[0] is not None:
                        identities[(kind, run_id)] = outputs[0]["op"]["run_id"]
                    for clean in outputs:
                        self.assertIsNotNone(clean)
                        self.assertEqual(clean["op"]["run_id"], expected)
                        validate_op_shape(clean["op"])
                    self.assertEqual(outputs[0], outputs[1])
                    self.assertEqual(source, before)
        for run_id in RUN_IDS:
            self.assertNotEqual(redact(run_id)[0], run_id, "fixture must trigger redaction")
            self.assertEqual(identities[("agent.lifecycle", run_id)],
                             identities[("activity.beat", run_id)])
        self.assertNotEqual(identities[("agent.lifecycle", RUN_IDS[0])],
                            identities[("agent.lifecycle", RUN_IDS[1])])
        for kind in ("agent.lifecycle", "activity.beat"):
            for run_id in ("", "x" * 65, HEX_ID * 2 + "x", "bad.id", "bad/id",
                           "run\n", "é", S.FAKE_SECRET, None, 17, True, [], {}):
                with self.subTest(kind=kind, invalid=run_id):
                    clean = relay.sanitize_event(run_event(kind, run_id))
                    if clean is not None:
                        with self.assertRaises(PlanError) as caught:
                            validate_op_shape(clean["op"])
                        self.assertEqual(caught.exception.code, "bad_op")
                        self.assertNotIn(S.FAKE_VALUE, repr(clean))

    def test_u157_only_top_level_run_identity_gets_a_surrogate(self):
        run_id = RUN_IDS[0]
        source = event(run_id=run_id, brief={"run_id": run_id},
                       microtasks=[{"run_id": run_id}], title=run_id + " " + S.FAKE_SECRET)
        clean = relay.sanitize_event(source)
        self.assertIsNotNone(clean)
        self.assertRegex(clean["op"]["run_id"], r"^[A-Za-z0-9_-]{1,64}$")
        self.assertEqual(clean["op"]["brief"]["run_id"], redact(run_id)[0])
        self.assertEqual(clean["op"]["microtasks"][0]["run_id"], redact(run_id)[0])
        self.assertEqual(clean["op"]["title"], redact(source["op"]["title"])[0])
        self.assertNotIn(run_id, repr(clean))
        self.assertNotIn(S.FAKE_VALUE, repr(clean))
        for kind, field in (("agent.lifecycle", "reason"), ("activity.beat", "note")):
            source = run_event(kind, run_id)
            source["op"][field] = run_id + " " + S.FAKE_SECRET
            clean = relay.sanitize_event(source)
            self.assertIsNotNone(clean)
            validate_op_shape(clean["op"])
            self.assertEqual(clean["op"][field], redact(source["op"][field])[0])
        real = redact
        def residue(text, _disable=frozenset()):
            if text in (run_id, "residue"):
                return "residue", 1, ["HIGH_ENTROPY"]
            return real(text)
        with S.patched_redact(residue):
            self.assertIsNone(relay.sanitize_event(run_event("agent.lifecycle", run_id)))

    def test_a6_nested_template_hash_has_no_exemption(self):
        clean = relay.sanitize_event(event(brief={"template_hash": self.digest}))
        self.assertIsNotNone(clean)
        self.assertEqual(clean["op"]["brief"]["template_hash"], redact(self.digest)[0])
        self.assertNotIn(self.digest, repr(clean))

    def test_m4_nested_op_ids_and_list_hashes_have_no_exemption(self):
        source = event(brief={"op_id": HEX_ID},
                       microtasks=[{"template_hash": self.digest, "op_id": HEX_ID}])
        clean = relay.sanitize_event(source)
        self.assertIsNotNone(clean)
        self.assertEqual(clean["op"]["brief"]["op_id"], redact(HEX_ID)[0])
        self.assertEqual(clean["op"]["microtasks"][0],
                         {"template_hash": redact(self.digest)[0],
                          "op_id": redact(HEX_ID)[0]})
        self.assertNotIn(HEX_ID, repr(clean))
        self.assertNotIn(self.digest, repr(clean))

    def test_m6_u58_planted_secret_remains_masked(self):
        clean = relay.sanitize_event(event(op_id=S.FAKE_SECRET, template_hash=S.FAKE_SECRET))
        self.assertIsNotNone(clean)
        self.assertNotIn(S.FAKE_VALUE, repr(clean))
        self.assertEqual(clean["op"]["template_hash"], redact(S.FAKE_SECRET)[0])

    def test_stop_nested_residue_drops_event(self):
        def residue(text, _disable=frozenset()):
            if text in ("poison", "residue"):
                return "residue", 1, ["KEY_ASSIGN"]
            return text, 0, []
        with S.patched_redact(residue):
            self.assertIsNone(relay.sanitize_event(event(brief={"template_hash": "poison"})))
            self.assertIsNone(relay.sanitize_event(event(brief={"op_id": "poison"})))

    def test_stop_redactor_error_does_not_exempt_hash(self):
        real = redact
        def broken(text, _disable=frozenset()):
            if text == self.digest:
                raise ValueError("planted redactor failure")
            return real(text)
        with S.patched_redact(broken):
            self.assertIsNone(relay.sanitize_event(event(template_hash=self.digest)))


class FrameOracle(unittest.TestCase):
    def plan_open(self, op_id):
        # A-C5b: supply a complete operation to the checked reader fixture.
        return event(op_id=op_id, title="Oracle plan", template_id="web-app",
                     template_hash=web_template()["hash"])

    def frames(self, source, replay):
        frames = S.Frames()
        config = relay.load_room_config(S.rcfg_dict(rooms=(("demo", "private"),)))
        with tempfile.TemporaryDirectory() as home:
            Path(home, "rooms", "demo").mkdir(parents=True)
            self.deliver(config, frames, source, replay, home)
        actual = frames.of("room_event")
        self.assertEqual(len(actual), 1)
        return actual[0]

    def deliver(self, config, frames, source, replay, home):
        instance = relay.RoomRelay(config, frames, home=home, clock=S.Clock())
        def read(room, since=0, *, home=None):
            return ([copy.deepcopy(source)] if since < source["lamport"] else []), 0
        # A-C5b: fixture uses read_checked
        with mock.patch.object(store, "read_checked", side_effect=read):
            if replay:
                instance.handle({"t": "room_sync", "v": 1, "rid": "u66", "since": {"demo": 0}})
            else:
                self.assertEqual(instance.poll(), 1)
                self.assertEqual(instance.poll(), 0)

    def check_batch(self, replay):
        source = self.plan_open("agent-op-0001")
        source["batch"] = {"key_map": {S.FAKE_SECRET: "T01"},
                           "conformance": {"findings": [{"message": S.FAKE_SECRET}]}}
        before = copy.deepcopy(source)
        frame = self.frames(source, replay)
        self.assertNotIn("batch", frame["event"])
        self.assertNotIn("batch", frame)
        self.assertNotIn(S.FAKE_VALUE, repr(frame))
        expected = copy.deepcopy(source)
        del expected["batch"]
        self.assertEqual(frame, dict(t="room_event", v=1, room="demo", floor="ONLY_ON_DEVICE",
                                     event=expected, **({"rid": "u66"} if replay else {})))
        self.assertEqual(source, before)

    def test_a5_poll_removes_batch_and_preserves_other_fields(self):
        self.check_batch(False)

    def test_a5_sync_removes_batch_and_preserves_other_fields(self):
        self.check_batch(True)

    def test_m3_legacy_event_batch_removed_regardless_of_value(self):
        pairs = []
        for batch in (None, S.FAKE_SECRET, [], {"key_map": {}}):
            for replay in (False, True):
                # A-C5b: use a journal-valid non-op with the same legacy batch.
                source = S.event(1, act="heartbeat", batch=batch)
                frame = self.frames(source, replay)
                expected = dict(source)
                del expected["batch"]
                pairs.append((frame["event"], expected))
        self.assertTrue(all("batch" not in actual for actual, _ in pairs))
        self.assertEqual([actual for actual, _ in pairs], [expected for _, expected in pairs])

    def test_a3_surrogate_is_valid_in_live_and_replay_frames(self):
        expected = "h-" + hashlib.sha256(HEX_ID.encode("utf-8")).hexdigest()[:32]
        frames = [self.frames(self.plan_open(HEX_ID), replay) for replay in (False, True)]
        self.assertEqual([frame["event"]["op"]["op_id"] for frame in frames], [expected] * 2)
        self.assertNotIn(HEX_ID, repr(frames))

    def test_u157_lifecycle_and_beats_share_run_identity_in_live_and_replay(self):
        transported = {}
        for run_id in RUN_IDS:
            for kind in ("agent.lifecycle", "activity.beat"):
                source = run_event(kind, run_id)
                frames = [self.frames(source, replay) for replay in (False, True)]
                for frame in frames:
                    self.assertRegex(frame["event"]["op"]["run_id"], r"^[A-Za-z0-9_-]{1,64}$")
                    validate_op_shape(frame["event"]["op"])
                    self.assertNotIn(run_id, repr(frame))
                self.assertEqual(frames[0]["event"], frames[1]["event"])
                transported[(kind, run_id)] = frames[0]["event"]["op"]["run_id"]
            self.assertEqual(transported[("agent.lifecycle", run_id)],
                             transported[("activity.beat", run_id)])
        self.assertNotEqual(transported[("agent.lifecycle", RUN_IDS[0])],
                            transported[("agent.lifecycle", RUN_IDS[1])])


class McpOracle(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="u66-", dir=Path(__file__).resolve().parent)
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        env = mock.patch.dict(os.environ, {"CW_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        clock = mock.patch.object(store.time, "time", return_value=1700000000.0)
        clock.start()
        self.addCleanup(clock.stop)
        self.template = web_template()

    def call(self, name, args):
        output = io.StringIO()
        with redirect_stdout(output):
            mcp._handle(1, "tools/call", {"name": name, "arguments": args})
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        reply = json.loads(lines[0])
        self.assertNotIn("error", reply)
        self.assertFalse(reply["result"]["isError"], reply)
        return json.loads(reply["result"]["content"][0]["text"])["untrusted"]

    def args(self, template_id="web-app", room="oracle"):
        return dict(room=room, agent="alice", template_id=template_id, title="Oracle plan",
                    op_id=HEX_ID, brief={"goal": "Deliver", "users": "Developers", "stack": "Python"},
                    tasks=[dict(key="task-" + str(i), title="Task " + str(i), type="feature",
                                phase="discovery", accept="Checks pass",
                                microtasks=[{"text": "Implement", "accept": "Works"},
                                            {"text": "Verify", "accept": "Passes"}])
                           for i in range(1, 4)])

    def events(self, room="oracle"):
        events, malformed = store.read(room, 0, home=self.home)
        self.assertEqual(malformed, 0)
        return events

    def test_a7_persisted_open_declares_discovery(self):
        self.call("plan_create", self.args())
        opens = [e["op"] for e in self.events() if e.get("op", {}).get("kind") == "plan.open"]
        self.assertEqual(len(opens), 1)
        self.assertEqual(opens[0].get("phase"), "discovery")

    def test_a7_plan_get_and_conformance_unchanged(self):
        created = self.call("plan_create", self.args())
        projection = self.call("plan_get", {"room": "oracle"})
        self.assertEqual(projection["plan"]["phase"], "discovery")
        baseline = copy.deepcopy(self.events())
        for e in baseline:
            if e.get("op", {}).get("kind") == "plan.open":
                e["op"].pop("phase", None)
        previous = fold_plan(baseline, templates={"web-app": self.template})
        expected = check_conformance(previous, self.template)
        self.assertEqual(created["conformance"], expected)
        self.assertEqual(self.call("plan_check", {"room": "oracle"})["conformance"], expected)

    def test_m5_readers_without_template_get_same_initial_phase(self):
        self.call("plan_create", self.args())
        projection = fold_plan(self.events())
        self.assertEqual(projection["rejected"], [])
        self.assertIsNotNone(projection["plan"])
        self.assertEqual(projection["plan"]["phase"], "discovery")

    def test_m5_first_declared_phase_is_not_hardcoded(self):
        custom = dict(self.template)
        custom.pop("hash", None)
        custom["id"] = "ordered-phases"
        custom["phases"] = list(reversed(custom["phases"]))
        directory = self.home / "templates"
        directory.mkdir()
        (directory / "ordered-phases.json").write_text(json.dumps(custom), encoding="utf-8")
        self.call("plan_create", self.args(template_id="ordered-phases"))
        opened = next(e["op"] for e in self.events() if e.get("op", {}).get("kind") == "plan.open")
        self.assertEqual(opened.get("phase"), custom["phases"][0]["id"])

    def test_m5_no_phases_omits_phase_at_store_boundary(self):
        # Current template validation requires a phase, and the store rejects
        # tasks without a declared phase. Exercise only the specified MCP op
        # builder with a resolved phase-less fixture, not those other contracts.
        custom = copy.deepcopy(self.template)
        custom["phases"] = []
        class Captured(Exception):
            pass
        with mock.patch.object(app, "_template_by_id", return_value=custom):  # A-U87b: handlers live in bridge.room.app
            with mock.patch.object(store, "post_ops", side_effect=Captured) as post:
                with self.assertRaises(Captured):
                    mcp._do_plan_create(self.args())
        ops = post.call_args.args[2]
        opened = [op for op in ops if op["kind"] == "plan.open"]
        self.assertEqual(len(opened), 1)
        self.assertNotIn("phase", opened[0])

    def test_a8_dispatch_store_sanitize_fold_three_tasks(self):
        self.call("plan_create", self.args())
        raw = self.events()
        original = fold_plan(raw, templates={"web-app": self.template})
        self.assertEqual(original["rejected"], [])
        self.assertEqual(len(original["tasks"]), 3)
        sanitized = [relay.sanitize_event(e) for e in raw]
        self.assertTrue(all(e is not None for e in sanitized))
        folded = fold_plan(sanitized, templates={"web-app": self.template})
        self.assertEqual(folded["rejected"], [], "sanitized operations must still validate")
        self.assertIsNotNone(folded["plan"])
        self.assertEqual(folded["plan"]["state"], "active")
        self.assertEqual(folded["plan"]["template_hash"], self.template["hash"])
        self.assertEqual(len(folded["tasks"]), 3)
        self.assertEqual(folded["tasks"], original["tasks"])
