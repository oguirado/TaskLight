"""M2/M3/M6: original request identity and atomic batch simulation."""
import copy
from unittest.mock import patch

from bridge.room import store
from bridge.tests.room.u121.support import RoomCase, canonical, digest, memory


class BatchTests(RoomCase):
    def ops(self):
        return [memory(), memory("memory0002", text="Other", section="other")]

    def test_m3_batch_hash_covers_original_order_and_strict(self):
        ops = self.ops()
        events = self.batch(ops)
        expected = digest({"strict": False, "ops": ops})
        self.assertEqual([e["batch"].get("request_sha256") for e in events], [expected] * len(ops))
        self.assertEqual([e["batch"]["member_ids"] for e in events], [[e["id"] for e in events]] * len(ops))
        self.assertTrue(all("request_sha256" not in e["op"] for e in events))

    def test_a2_batch_replay_preserves_receipts_without_fold_or_capacity(self):
        ops = self.ops()
        first = self.batch(ops)
        before = self.snapshot()
        reordered_keys = [dict(reversed(list(op.items()))) for op in ops]
        with patch.object(store, "fold_plan", side_effect=AssertionError("replay refolded")), \
             patch.object(store, "CAP", len(self.raw())):
            retry = self.batch(reordered_keys)
        self.assertEqual(retry, [dict(e, replayed=True) for e in first])
        self.assertEqual(self.snapshot(), before)
        for key in ("member_ids", "key_map", "conformance", "rev"):
            self.assertEqual(retry[0]["batch"].get(key), first[0]["batch"].get(key))

    def test_a5_strict_success_preserves_conformance_and_replay(self):
        ops = self.ops()
        first = self.batch(ops, strict=True)
        self.assertEqual(first[0]["batch"]["conformance"], {"ok": True, "findings": []})
        before = self.snapshot()
        self.assertEqual(self.batch(ops, strict=True), [dict(e, replayed=True) for e in first])
        self.assertEqual(self.snapshot(), before)

    def test_m3_one_unverifiable_member_blocks_batch_replay(self):
        ops = self.ops()
        self.batch(ops)
        events = self.events()
        events[-1]["batch"].pop("request_sha256", None)
        self.path.write_bytes(b"".join(canonical(e) + b"\n" for e in events))
        self.conflict(lambda: self.batch(ops))

    def test_a3_changing_local_keys_conflicts_before_remapping(self):
        ops = [dict(kind="task.add", op_id="creator001", key="local", title="New", type="action",
                    phase="start", microtasks=[dict(text="Step")])]
        self.batch(ops)
        self.conflict(lambda: self.batch([dict(ops[0], key="different")]))

    def test_m3_legacy_batch_missing_hash_is_not_replay_evidence(self):
        ops = self.ops()
        self.batch(ops)
        events = self.events()
        for event in events:
            if "batch" in event:
                event["batch"].pop("request_sha256", None)
        self.path.write_bytes(b"".join(canonical(e) + b"\n" for e in events))
        self.conflict(lambda: self.batch(ops))

    def test_a3_distinct_agents_can_reuse_batch_identity(self):
        first = self.batch([memory()])
        second = self.batch([memory(section="other")], agent="executor-b")
        self.assertNotEqual(first[0]["id"], second[0]["id"])
        self.assertEqual(second[0]["agent"], "executor-b")

    def test_a3_duplicate_intra_batch_identity_refuses(self):
        self.conflict(lambda: self.batch([memory(), memory(text="changed", section="other")]))

    def test_a5_fresh_batch_folds_prior_history_once(self):
        with patch.object(store, "fold_plan", wraps=store.fold_plan) as fold:
            events = self.batch(self.ops())
        self.assertEqual(len(events), 2)
        self.assertEqual(fold.call_count, 1, "fresh batch refolded prior history")

    def test_m6_each_simulation_receives_isolated_state(self):
        real_apply = store.apply_op_event
        previous_outputs = []
        reused_inputs = []
        def observe(state, event, **kwargs):
            reused_inputs.append(any(state is old for old in previous_outputs))
            result = real_apply(state, event, **kwargs)
            previous_outputs.append(result[0])
            return result
        with patch.object(store, "apply_op_event", side_effect=observe):
            self.batch(self.ops())
        self.assertEqual(len(previous_outputs), 2)
        self.assertEqual(reused_inputs, [False, False], "simulation reused a prior member's mutable state directly")

    def test_a5_local_keys_dependencies_revisions_and_simulation_identity(self):
        ops = [dict(kind="task.add", op_id="child0001", _local_key="child", title="Child", type="action",
                    phase="start", accept="Checked", deps=["root"], microtasks=[dict(text="Child step")]),
               dict(kind="task.add", op_id="root00001", key="root", title="Root", type="action",
                    phase="start", accept="Checked", microtasks=[dict(text="Root step")]),
               dict(kind="task.set", op_id="edit00001", task_id="root", base_rev=1, title="Edited")]
        supplied = copy.deepcopy(ops)
        simulated = []
        real_apply = store.apply_op_event
        def observe(state, event, **kwargs):
            simulated.append(copy.deepcopy(event))
            return real_apply(state, event, **kwargs)
        with patch.object(store, "apply_op_event", side_effect=observe):
            events = self.batch(ops)
        self.assertEqual(ops, supplied, "caller objects mutated")
        self.assertEqual([e["op"]["op_id"] for e in events], ["root00001", "child0001", "edit00001"])
        self.assertEqual(events[0]["batch"]["key_map"], {"root": "T02", "child": "T03"})
        self.assertEqual(events[1]["op"]["deps"], ["T02"])
        self.assertEqual(events[2]["op"]["task_id"], "T02")
        self.assertEqual(events[2]["op"]["base_rev"], events[0]["lamport"])
        for actual, simulated_event in zip(events, simulated):
            for field in ("id", "lamport", "ts", "room", "agent", "op"):
                self.assertEqual(actual[field], simulated_event[field])
        self.assertEqual(self.projection()["rejected"], [])
        before = self.snapshot()
        self.assertEqual(self.batch(supplied), [dict(e, replayed=True) for e in events])
        self.assertEqual(self.snapshot(), before)

    def test_m3_hash_precedes_local_key_rewrite_and_revision_healing(self):
        ops = [dict(kind="task.add", op_id="creator001", key="new", title="New", type="action",
                    phase="start", microtasks=[dict(text="Step")]),
               dict(kind="task.set", op_id="edit00001", task_id="new", base_rev=1, title="Updated")]
        events = self.batch(ops)
        self.assertEqual(events[0]["batch"].get("request_sha256"), digest(dict(strict=False, ops=ops)))
        self.assertNotEqual(events[1]["op"]["base_rev"], 1)
        self.assertNotIn("key", events[0]["op"])

    def test_a5_invalid_final_member_is_atomic_even_without_strict(self):
        self.refuse(lambda: self.batch([memory(), dict(kind="micro.set", micro_id="T02.M01", state="done")]),
                    "not_found")

    def test_a5_strict_conformance_refusal_is_atomic(self):
        with patch.object(store, "check_conformance", return_value={"ok": False, "findings": ["fixture rejection"]}):
            self.refuse(lambda: self.batch(self.ops(), strict=True), "not_conformant")

    def test_m6_nonstrict_conformance_findings_are_recorded(self):
        report = {"ok": False, "findings": ["fixture finding"]}
        with patch.object(store, "check_conformance", return_value=report):
            events = self.batch(self.ops(), strict=False)
        self.assertEqual(events[0]["batch"]["conformance"], report)
        self.assertEqual([e["id"] for e in self.events()[-2:]], [e["id"] for e in events])


def changed_batch_test(change):
    def test(self):
        ops = self.ops()
        self.batch(ops)
        changed, kwargs = change(copy.deepcopy(ops))
        self.conflict(lambda: self.batch(changed, **kwargs))
    return test


for name, change in {
    "content": lambda ops: ([dict(ops[0], text="hostile"), ops[1]], {}),
    "order": lambda ops: (list(reversed(ops)), {}),
    "count": lambda ops: (ops[:1], {}),
    "additional_member": lambda ops: (ops + [memory("memory0003", section="third")], {}),
    "strict": lambda ops: (ops, {"strict": True}),
    "member_identity": lambda ops: ([ops[0], dict(ops[1], op_id="changed0001")], {}),
}.items():
    setattr(BatchTests, "test_a3_changed_batch_" + name, changed_batch_test(change))


def invalid_test(field, value, batch):
    def test(self):
        op = memory()
        op[field] = value
        self.refuse(lambda: self.batch([op]) if batch else self.post(op), "bad_op")
    return test


for label, field, value in (("forged_hash", "request_sha256", "0" * 64),
                            ("forged_batch", "batch", {"request_sha256": "0" * 64}),
                            ("nan", "base_rev", float("nan")),
                            ("infinity", "base_rev", float("inf")),
                            ("negative_infinity", "base_rev", float("-inf"))):
    for batch in (False, True):
        setattr(BatchTests, "test_a3_" + ("batch_" if batch else "single_") + label,
                invalid_test(field, value, batch))
