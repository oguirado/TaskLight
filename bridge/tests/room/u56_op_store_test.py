"""U56 storage oracle: real JSONL, public operations, no substitute reducer."""
import copy
import inspect
import os
import json
import functools
from pathlib import Path
from unittest import mock

from bridge.room import store
from . import support

KINDS = frozenset({"plan.open", "plan.close", "plan.phase", "task.add", "task.set",
                   "task.claim", "task.release", "micro.add", "micro.set", "memory.set"})
ROOT = Path(__file__).resolve().parents[3]


def opening(**fields):
    tpl = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
    return dict(kind="plan.open", template_id=tpl["id"], template_hash=tpl["hash"],
                title="Oracle plan", brief={"goal": "Deliver"}, phase="start", **fields)


def adding(**fields):
    return dict({"kind": "task.add", "title": "Action", "type": "action", "phase": "start",
                 "accept": "Checked", "microtasks": [{"text": "First", "accept": "Checked"}]}, **fields)


def memory(**fields):
    return dict({"kind": "memory.set", "section": "notes", "text": "Decision", "base_rev": 0}, **fields)


def event(n, op, **fields):
    return support.mk_event(n, room="oracle", agent="alice", act="op", text="", op=op, ts=fields.pop("ts", 1000 + n), **fields)


class OpCase(support.RoomCase):
    """Helpers assert additive APIs before calling them: missing behavior is a failure."""
    def setUp(self):
        super().setUp()
        # Supply the shared fixture through U55's documented templates keyword.
        # Real validation/application still run; no substitute reducer is installed.
        import bridge.plan as api
        from bridge.plan import fold
        tpl = json.loads((ROOT / "fixtures/plan/templates.v1.json").read_text())["templates"][0]
        for name in ("fold_plan", "apply_op_event"):
            original = getattr(fold, name)
            def with_templates(*args, _original=original, **kwargs):
                kwargs.setdefault("templates", {tpl["id"]: copy.deepcopy(tpl)})
                return _original(*args, **kwargs)
            wrapped = functools.wraps(original)(with_templates)
            # Cover both qualified calls and already-imported public function aliases.
            for module in (fold, api, store):
                for alias, value in list(vars(module).items()):
                    if value is original:
                        patcher = mock.patch.object(module, alias, wrapped)
                        patcher.start()
                        self.addCleanup(patcher.stop)

    def require_post(self):
        self.assertIn("op", inspect.signature(store.post).parameters,
                      "U56 missing behavior: post() must accept the op keyword")

    def send(self, op, *, agent="alice", clock=None, **kw):
        self.require_post()
        return store.post("oracle", agent, "op", "", op=op, home=self.home,
                          clock=clock or self.clock, **kw)

    def batch(self, ops, **kw):
        fn = getattr(store, "post_ops", None)
        self.assertTrue(callable(fn), "U56 missing behavior: atomic post_ops() API")
        return fn("oracle", "alice", ops, home=self.home, clock=self.clock, **kw)

    def raw(self):
        p = support.events_path(self.home, "oracle")
        return p.read_bytes() if p.exists() else b""

    def seed_plan(self, *ops):
        support.seed(self.home, "oracle", [event(1, opening())] +
                     [event(n, op) for n, op in enumerate(ops, 2)])

    def reject(self, code, op, **kw):
        before = self.raw()
        with self.assertRaises(store.RoomError) as cm:
            self.send(op, **kw)
        self.assertEqual(cm.exception.code, code)
        self.assertEqual(self.raw(), before, "refused operation changed the log")
        # Nonblocking acquisition proves release without risking a hanging post.
        lock = support.room_dir(self.home, "oracle") / "events.lock"
        if lock.exists():
            fd = os.open(lock, os.O_RDWR)
            try:
                try:
                    store.fcntl.flock(fd, store.fcntl.LOCK_EX | store.fcntl.LOCK_NB)
                except BlockingIOError:
                    self.fail("refused operation retained the exclusive room lock")
            finally:
                os.close(fd)

    def reject_static(self, code, op):
        self.require_post()
        with mock.patch.object(store, "_ensure_dirs", side_effect=AssertionError("invalid op reached directory creation")), \
             mock.patch.object(store.fcntl, "flock", side_effect=AssertionError("invalid op reached flock")):
            with self.assertRaises(store.RoomError) as cm:
                self.send(op)
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(support.room_dir(self.home, "oracle").exists())


class OpStore(OpCase):
    def test_constants(self):
        self.assertIn("op", store.ACTS)
        self.assertEqual(getattr(store, "OP_KINDS", None), KINDS)
        self.assertEqual(getattr(store, "OP_MAX_BYTES", None), 8192)
        pattern = getattr(store, "OP_ID_RE", None)
        self.assertIsNotNone(pattern)
        self.assertEqual(pattern.pattern, r"[A-Za-z0-9_-]{8,64}")
        self.assertEqual(store.CAP, 16 * 1024 * 1024)  # A-C4m: 16 MiB cap
        self.assertEqual(store.SILENT_AFTER_S, 600)

    def test_all_ten_kinds_persist_canonical_and_fsync(self):
        ops = [opening(), memory(), adding(), adding(deps=["T01"]),
               {"kind": "task.claim", "task_id": "T01"},
               {"kind": "micro.add", "task_id": "T01", "base_rev": 5, "text": "Second"},
               {"kind": "micro.set", "micro_id": "T01.M01", "state": "done", "outcome": "OK",
                "evidence": [{"path": "proof.txt", "sha256": "a" * 64}]},
               {"kind": "task.set", "task_id": "T01", "base_rev": 7,
                "state": None, "reason": None, "estimate": None},
               {"kind": "plan.phase", "base_rev": 1, "phase": "finish"},
               {"kind": "task.release", "task_id": "T01"},
               {"kind": "plan.close", "base_rev": 9, "outcome": "Finished"}]
        events = []
        with mock.patch.object(store.os, "fsync", wraps=store.os.fsync) as sync:
            for n, op in enumerate(ops, 1):
                e = self.send(op)
                self.assertEqual((e["act"], e["lamport"], e["op"]), ("op", n, op))
                self.assertNotIn("replayed", e)
                self.assertTrue(store._is_valid_event(e))
                events.append(e)
            self.assertGreaterEqual(sync.call_count, len(ops))
        self.assertEqual(self.raw(), b"".join((support.canon(e) + "\n").encode() for e in events))
        self.assertEqual(store.read("oracle", home=self.home), (events, 0))
        with mock.patch.object(store.time, "time", return_value=1700000000):
            self.assertEqual(store.status("oracle", home=self.home)["last_by_agent"], {"alice": events[-1]})
        self.assertEqual(set(e["op"]["kind"] for e in events), KINDS)

    def test_no_plan(self):
        self.reject("no_plan", adding())

    def test_plan_exists(self):
        self.seed_plan()
        self.reject("plan_exists", opening())

    def test_unknown_template(self):
        op = opening(); op["template_id"] = "unknown-oracle-template"
        self.reject("unknown_template", op)

    def test_missing_task(self):
        self.seed_plan()
        self.reject("not_found", {"kind": "task.claim", "task_id": "T01"})

    def test_missing_dependency(self):
        self.seed_plan()
        self.reject("not_found", adding(deps=["T02"]))

    def test_task_add_self_cycle(self):
        self.seed_plan()
        self.reject("dep_cycle", adding(deps=["T01"]))

    def test_transitive_cycle(self):
        self.seed_plan(adding(), adding(deps=["T01"]))
        self.reject("dep_cycle", {"kind": "task.set", "task_id": "T01", "base_rev": 2, "deps": ["T02"]})

    def test_task_limit_and_cancelled_ids_consumed(self):
        self.seed_plan(*[adding() for _ in range(40)],
                       {"kind": "task.set", "task_id": "T01", "base_rev": 2, "state": "cancelled"})
        self.reject("limit_exceeded", adding())

    def test_micro_limit(self):
        self.seed_plan(adding(microtasks=[{"text": "Step"}] * 12))
        self.reject("limit_exceeded", {"kind": "micro.add", "task_id": "T01", "base_rev": 2, "text": "Overflow"})

    def test_replay_after_plan_revision_advanced(self):
        self.seed_plan()
        op = adding(op_id="op-retry-01", base_rev=1)
        first = self.send(op)
        self.send({"kind": "plan.phase", "base_rev": 1, "phase": "finish"})
        before = self.raw()
        replay = self.send(copy.deepcopy(op))
        self.assertEqual(replay, dict(first, replayed=True))
        self.assertEqual(self.raw(), before)
        self.assertNotIn("replayed", first)
        replay["text"] = "returned copy"
        self.assertEqual(self.send(op), dict(first, replayed=True))
        self.assertEqual(self.raw(), before)

    def test_changed_payload_replays_first_accepted_event(self):
        self.seed_plan()
        first = self.send(adding(op_id="op-retry-01"))
        before = self.raw()
        self.assertEqual(self.send(adding(op_id="op-retry-01", title="Changed")), dict(first, replayed=True))
        self.assertEqual(self.raw(), before)

    def test_cross_agent_id_is_independent_and_omitted_id_never_replays(self):
        self.seed_plan()
        first = self.send(adding(op_id="op-retry-01"))
        second = self.send(adding(op_id="op-retry-01"), agent="bob")
        third = self.send(adding())
        fourth = self.send(adding())
        self.assertEqual([e["lamport"] for e in (first, second, third, fourth)], [2, 3, 4, 5])
        self.assertEqual(len({e["id"] for e in (first, second, third, fourth)}), 4)
        self.assertTrue(all("replayed" not in e for e in (first, second, third, fourth)))

    def test_memory_before_plan_and_closed_plan_rules(self):
        m = self.send(memory())
        self.assertEqual(m["lamport"], 1)
        p = self.send(opening())
        self.send({"kind": "plan.close", "base_rev": p["lamport"]})
        self.reject("no_plan", adding())
        self.send(memory(base_rev=m["lamport"], text="Retained"))
        self.send(opening())
        self.send(adding())
        self.send({"kind": "micro.set", "micro_id": "T01.M01", "state": "active"})

    def test_markdown_is_never_authoritative(self):
        self.seed_plan(adding())
        for name in ("PLAN.md", "MEMORY.md"):
            (support.room_dir(self.home, "oracle") / name).write_text("untrusted conflicting state")
        self.send({"kind": "task.set", "task_id": "T01", "base_rev": 2, "estimate": "1m"})

    def test_exact_utf8_byte_cap_and_one_over(self):
        op = adding(microtasks=[{"text": "😀" * 80, "accept": "😀" * 80} for _ in range(12)])
        for m in op["microtasks"]:
            while len(support.canon(op).encode()) < 8192 and len(m["accept"]) < 160:
                m["accept"] += "a"
        self.assertEqual(len(support.canon(op).encode()), 8192)
        over = dict(op, title=op["title"] + "a")
        self.assertEqual(len(support.canon(over).encode()), 8193)
        self.reject_static("limit_exceeded", over)
        self.seed_plan()
        self.assertEqual(self.send(op)["op"], op)

    def test_unicode_codepoint_limit_and_ordinary_text(self):
        self.seed_plan()
        self.send(adding(title="😀" * 120))
        self.send(adding(title="<script>\x1bjavascript:"))

    def test_reader_valid_op_corrupt_lines_and_torn_tail(self):
        good = event(1, memory())
        bad = event(2, dict(memory(), unknown=True))
        huge = event(3, memory(text="😀" * 2100))
        support.seed(self.home, "oracle", [good, bad, huge], raw_lines=[b"{invalid"], raw_tail=b'{"torn":')
        self.assertEqual(store.read("oracle", home=self.home), ([good], 3))
        self.assertTrue(self.raw().endswith(b'{"torn":'))

    def test_reader_rejects_contamination_and_hostile_integers(self):
        good = event(1, memory())
        invalid = [dict(good, op=None), dict(good, plan={}), dict(good, step={}),
                   {k: v for k, v in good.items() if k != "op"}]
        for field in ("ts", "lamport"):
            for value in (True, False, 1.5, float("nan"), float("inf"), "1", 9007199254740992):
                invalid.append(dict(good, **{field: value}))
        for e in invalid:
            with self.subTest(event=e):
                self.assertFalse(store._is_valid_event(e))
        self.assertTrue(store._is_valid_event(good))

    def test_room_cap_preserves_file_and_releases_lock(self):
        self.seed_plan()
        before = self.raw()
        with mock.patch.object(store, "CAP", len(before)):
            with self.assertRaises(store.RoomError) as cm:
                self.send(adding())
            self.assertEqual(cm.exception.code, "room_full")
        self.assertEqual(self.raw(), before)
        self.send(adding())

    def test_batch_success_and_retry_do_not_duplicate_members(self):
        ops = [opening(op_id="batch-0001"), memory(), adding()]
        first = self.batch(ops)
        events, malformed = store.read("oracle", home=self.home)
        self.assertEqual(malformed, 0)
        self.assertEqual([e["op"]["kind"] for e in events], [o["kind"] for o in ops])
        self.assertEqual([e["lamport"] for e in events], [1, 2, 3])
        before = self.raw()
        self.batch(copy.deepcopy(ops))
        self.assertEqual(self.raw(), before)
        self.assertIsNotNone(first)

    def test_batch_forward_dependency_resolves_before_commit(self):
        self.batch([opening(), adding(deps=["T02"]), adding()])
        events, malformed = store.read("oracle", home=self.home)
        self.assertEqual((len(events), malformed), (3, 0))
        self.send({"kind": "task.claim", "task_id": "T02"})

    def test_batch_cycle_is_atomic(self):
        before = self.raw()
        with self.assertRaises(store.RoomError) as cm:
            self.batch([opening(), adding(deps=["T02"]), adding(deps=["T01"])])
        self.assertEqual(cm.exception.code, "dep_cycle")
        self.assertEqual(self.raw(), before)

    def test_batch_late_invalid_op_is_atomic(self):
        self.seed_plan()
        before = self.raw()
        with self.assertRaises(store.RoomError) as cm:
            self.batch([adding(), {"kind": "task.claim", "task_id": "T40"}])
        self.assertEqual(cm.exception.code, "not_found")
        self.assertEqual(self.raw(), before)

    def test_batch_strict_conformance_failure_is_atomic(self):
        before = self.raw()
        with self.assertRaises(store.RoomError) as cm:
            # A-U56a: runtime no longer reads fixtures; inject the fixture templates explicitly.
            import json, pathlib
            fx = pathlib.Path(__file__).resolve().parents[3] / "fixtures" / "plan" / "templates.v1.json"
            tpls = {t["id"]: t for t in json.loads(fx.read_text(encoding="utf-8"))["templates"]}
            self.batch([opening(), adding(accept="")], strict=True, templates=tpls)
        self.assertEqual(cm.exception.code, "not_conformant")
        self.assertEqual(self.raw(), before)

    def test_batch_strict_conformant_creation_succeeds(self):
        # A-U56c: strict mode fails closed without templates; inject the fixture templates explicitly.
        import json, pathlib
        fx = pathlib.Path(__file__).resolve().parents[3] / "fixtures" / "plan" / "templates.v1.json"
        tpls = {t["id"]: t for t in json.loads(fx.read_text(encoding="utf-8"))["templates"]}
        self.batch([opening(), memory(), adding()], strict=True, templates=tpls)
        events, malformed = store.read("oracle", home=self.home)
        self.assertEqual((len(events), malformed), (3, 0))

    def test_nested_and_legacy_evidence_remain_independent(self):
        self.seed_plan(adding())
        proof = self.make_file(data=b"proof")
        nested = [{"path": "public-proof.txt", "sha256": "a" * 64}]
        op = {"kind": "micro.set", "micro_id": "T01.M01", "state": "done", "evidence": nested}
        e = self.send(op, evidence=[str(proof)])
        self.assertEqual(e["op"]["evidence"], nested)
        self.assertEqual(e["evidence"][0]["path"], str(proof.resolve()))
        self.assertEqual(store.read("oracle", home=self.home)[0][-1], e)

    def test_batch_capacity_failure_is_atomic(self):
        store.post("oracle", "alice", "heartbeat", "", home=self.home, clock=self.clock)
        before = self.raw()
        # A single opening fits; the full batch does not. Capacity must use the whole batch.
        with mock.patch.object(store, "CAP", len(before) + 900):
            with self.assertRaises(store.RoomError) as cm:
                self.batch([opening()] + [adding() for _ in range(10)])
            self.assertEqual(cm.exception.code, "room_full")
        self.assertEqual(self.raw(), before)


def install_static(name, op, code="bad_op"):
    def test(self):
        self.reject_static(code, copy.deepcopy(op))
    setattr(OpStore, "test_static_" + name, test)


for name, op in [
    ("missing", None), ("array", []), ("kind_unknown", {"kind": "unknown"}),
    ("kind_nonstring", {"kind": []}), ("unknown_key", dict(memory(), surprise=True)),
    ("micro_old_id", {"kind": "micro.set", "id": "T01.M01", "state": "done"}),
    ("micro_forbidden_rev", {"kind": "micro.set", "micro_id": "T01.M01", "state": "done", "base_rev": 2}),
    ("task_forbidden_status", {"kind": "task.set", "task_id": "T01", "base_rev": 2, "status": "blocked"}),
    ("task_forbidden_assignee", {"kind": "task.set", "task_id": "T01", "base_rev": 2, "assignee": "alice"}),
    ("duplicate_dependency", adding(deps=["T01", "T01"])),
    ("title_over", adding(title="x" * 121)), ("accept_over", adding(accept="x" * 161)),
    ("micro_text_over", {"kind": "micro.add", "task_id": "T01", "base_rev": 1, "text": "x" * 81}),
    ("non_json_value", dict(memory(), text={"set"})),
    ("nonstring_key", dict(memory(), **{})),
]:
    if name == "nonstring_key":
        op[1] = "invalid"
    install_static(name, op)
for name, value in [("null", None), ("short", "ab"), ("space", "a b"), ("long", "x" * 65),
                    ("newline", "abcdefgh\n"), ("number", 123)]:
    install_static("op_id_" + name, dict(memory(), op_id=value))
for name, value in [("true", True), ("false", False), ("float", 1.0), ("negative", -1),
                    ("nan", float("nan")), ("infinity", float("inf")),
                    ("negative_infinity", -float("inf")), ("string", "0"), ("unsafe", 9007199254740992)]:
    install_static("revision_" + name, memory(base_rev=value))
for key in ("__proto__", "constructor", "prototype"):
    install_static("dangerous_" + key, dict(memory(), **{key: None}))
    op = opening(); op["brief"] = {key: "data"}
    install_static("nested_" + key, op)
install_static("micro_inline_limit", adding(microtasks=[{"text": "Step"}] * 13), "limit_exceeded")
install_static("evidence_limit", {"kind": "micro.set", "micro_id": "T01.M01", "state": "done",
                               "evidence": [{"path": "proof", "sha256": "a" * 64}] * 9}, "limit_exceeded")


def test_static_cyclic_payload(self):
    op = memory(); op["text"] = op
    self.reject_static("bad_op", op)
OpStore.test_static_cyclic_payload = test_static_cyclic_payload


def install_bad_clock(name, value):
    def test(self):
        self.require_post()
        with self.assertRaises(store.RoomError) as cm:
            self.send(memory(), clock=lambda: value)
        self.assertEqual(cm.exception.code, "bad_op")
        self.assertFalse(support.room_dir(self.home, "oracle").exists())
    setattr(OpStore, "test_hostile_clock_" + name, test)


for name, value in [("bool", True), ("float", 1.0), ("nan", float("nan")),
                    ("infinity", float("inf")), ("string", "1"),
                    ("unsafe", 9007199254740992), ("timestamp_bound", 8640000000000001)]:
    install_bad_clock(name, value)
