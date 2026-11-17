"""A3 and Amendment C: reference kinds, ownership and answer-driven status."""
import json

from bridge.room import store
from .support import BASE, SendCase, mk_event, seed


class References(SendCase):
    def test_a3_ack_question_then_answer_changes_open_questions(self):
        self.assertIn(self.q["id"], self.open_ids())
        ack = self.send(agent="executor-a", to="harness", act="ack", re=self.q["id"])
        self.assertEqual(self.event(ack["id"])["re"], self.q["id"])
        self.assertIn(self.q["id"], self.open_ids(), "ack is not an answer")
        answer = self.send(agent="executor-a", to="harness", act="answer", re=self.q["id"])
        self.assertEqual(self.event(answer["id"])["re"], self.q["id"])
        self.assertNotIn(self.q["id"], self.open_ids())
        self.assertTrue({"op", "plan", "step", "verdict"}.isdisjoint(self.event(ack["id"])))

    def test_a3_ack_handoff_succeeds_but_answer_handoff_fails(self):
        handoff = self.send(act="handoff")
        self.refuse(dict(BASE, agent="executor-a", act="answer", re=handoff["id"]), "bad_re")
        receipt = self.send(agent="executor-a", to="harness", act="ack", re=handoff["id"])
        self.assertEqual(self.event(receipt["id"])["re"], handoff["id"])
        self.assertNotIn(handoff["id"], {event["id"] for event in
                                      store.status("demo")["handoffs_without_ack"]})

    def test_a3_missing_malformed_unknown_and_cross_room_references(self):
        other = self.send(room="other-room")
        for act in ("answer", "ack"):
            with self.subTest(act=act, missing=True):
                self.refuse(dict(BASE, agent="executor-a", act=act), "bad_re")
            for reference in ("", "not-an-id", 7, [], {}, "e-0000000000000000", other["id"]):
                with self.subTest(act=act, reference=reference):
                    self.refuse(dict(BASE, agent="executor-a", act=act, re=reference), "bad_re")

    def test_a3_non_message_targets_are_rejected_for_every_message_act(self):
        kinds = ("heartbeat", "open", "close", "verdict", "plan", "step", "op")
        extras = {"plan": {"plan": {"title": "T", "steps": [{"text": "s"}]}},
                  "step": {"step": {"index": 0, "state": "pending"}},
                  "op": {"op": {"kind": "activity.beat", "task_id": "T01", "run_id": "run1",
                                     "op_id": "u110-op-a3"}}}  # A-U110a: valid journal op needs op_id
        for index, target_act in enumerate(kinds, start=20):
            target = mk_event(index, room="demo", agent="harness", act=target_act,
                              to="executor-a", **extras.get(target_act, {}))
            seed(self.home, "demo", [target])
            self.assertIn(target["id"], {event["id"] for event in store.read("demo")[0]})
            for act in ("question", "handoff", "answer", "ack"):
                with self.subTest(target=target_act, act=act):
                    self.refuse(dict(BASE, agent="executor-a", act=act, re=target["id"]), "bad_re")

    def test_a3_question_and_handoff_optional_re_is_preserved(self):
        for act in ("question", "handoff"):
            with self.subTest(act=act):
                receipt = self.send(act=act, re=self.q["id"])
                event = self.event(receipt["id"])
                self.assertEqual(event["to"], BASE["to"])
                self.assertEqual(event["re"], self.q["id"])
                self.refuse(dict(BASE, act=act, re="e-ffffffffffffffff"), "bad_re")

    def test_c2_addressed_ack_and_answer_require_target_recipient(self):
        for act in ("ack", "answer"):
            for agent in ("harness", "unrelated"):
                with self.subTest(act=act, agent=agent):
                    self.refuse(dict(BASE, agent=agent, act=act, re=self.q["id"]), "bad_re")
        handoff = self.send(act="handoff")
        self.refuse(dict(BASE, agent="unrelated", act="ack", re=handoff["id"]), "bad_re")

    def test_c2_answer_can_follow_ack_to_question_and_closes_root(self):
        ack = self.send(agent="executor-a", to="harness", act="ack", re=self.q["id"])
        self.assertIn(self.q["id"], self.open_ids())
        self.refuse(dict(BASE, agent="executor-a", act="answer", re=ack["id"]), "bad_re")
        receipt = self.send(agent="harness", to="executor-a", act="answer", re=ack["id"])
        self.assertEqual(self.event(receipt["id"])["re"], ack["id"])
        self.assertNotIn(self.q["id"], self.open_ids())

    def test_c2_multi_ack_chain_is_resolved_without_rewriting_re(self):
        ack = self.send(agent="executor-a", to="harness", act="ack", re=self.q["id"])
        second = mk_event(30, room="demo", agent="harness", act="ack", to="executor-a", re=ack["id"])
        seed(self.home, "demo", [second])
        receipt = self.send(agent="executor-a", to="harness", act="answer", re=second["id"])
        self.assertEqual(self.event(receipt["id"])["re"], second["id"])
        self.assertNotIn(self.q["id"], self.open_ids())

    def test_c2_ack_chain_to_handoff_unknown_or_other_room_is_bad_re(self):
        handoff = self.send(act="handoff")
        other = self.send(room="other-room")
        for index, reference in enumerate((handoff["id"], "e-0000000000000000", other["id"]), start=40):
            ack = mk_event(index, room="demo", agent="harness", act="ack", to="executor-a", re=reference)
            seed(self.home, "demo", [ack])
            with self.subTest(reference=reference):
                self.refuse(dict(BASE, agent="executor-a", act="answer", re=ack["id"]), "bad_re")

    def test_c2_cyclic_ack_chain_is_refused_with_bounded_process(self):
        first = mk_event(50, room="demo", act="ack", to="executor-a", re="e-0000000000abc033")
        second = mk_event(51, room="demo", act="ack", to="executor-a", re=first["id"])
        first["re"] = second["id"]
        seed(self.home, "demo", [first, second])
        before = self.journals()
        args = dict(BASE, agent="executor-a", act="answer", re=first["id"])
        cp = self.cli("call", "room_send", "--json", json.dumps(args))
        self.assertEqual(cp.returncode, 3, cp.stdout)
        self.assertEqual(json.loads(cp.stdout)["code"], "bad_re")
        self.assertEqual(self.journals(), before)

    def test_c1_legacy_post_still_rejects_ack_to_question(self):
        before = self.journals()
        with self.assertRaises(store.RoomError) as caught:
            store.post("demo", "executor-a", "ack", "legacy ack", re=self.q["id"])
        self.assertEqual(caught.exception.code, "bad_re")
        self.assertEqual(self.journals(), before)

    def test_c2_answer_and_ack_reject_other_message_kinds(self):
        answer = self.send(agent="executor-a", to="harness", act="answer", re=self.q["id"])
        ack = self.send(agent="executor-a", to="harness", act="ack", re=self.q["id"])
        for act in ("ack", "answer"):
            self.refuse(dict(BASE, act=act, re=answer["id"]), "bad_re")
        self.refuse(dict(BASE, act="ack", re=ack["id"]), "bad_re")
        # Optional references have no answer/ack target-kind restriction.
        for act in ("question", "handoff"):
            for reference in (answer["id"], ack["id"]):
                receipt = self.send(act=act, re=reference)
                self.assertEqual(self.event(receipt["id"])["re"], reference)

    def test_c2_unaddressed_legacy_question_needs_no_recipient_match(self):
        question = store.post("demo", "legacy", "question", "broadcast question")
        self.send(agent="unrelated", act="ack", re=question["id"])
        self.assertIn(question["id"], self.open_ids())
        self.send(agent="unrelated", act="answer", re=question["id"])
        self.assertNotIn(question["id"], self.open_ids())
