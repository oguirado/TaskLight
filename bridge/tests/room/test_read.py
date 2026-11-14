"""read / wait / inbox / status, torn and malformed line tolerance."""
import threading, time, unittest

from bridge.room import store
from .support import RoomCase, mk_event, seed, ids_of, BASE_TS


class Read(RoomCase):
    def test_read_since(self):
        for _ in range(4):
            self.post()
        evs, bad = store.read("r1", home=self.home)
        self.assertEqual([e["lamport"] for e in evs], [1, 2, 3, 4])
        self.assertEqual(bad, 0)
        evs, _ = store.read("r1", since=2, home=self.home)
        self.assertEqual([e["lamport"] for e in evs], [3, 4])
        evs, _ = store.read("r1", 4, home=self.home)
        self.assertEqual(evs, [])

    def test_read_returns_events_as_posted(self):
        e = self.post(text="hi")
        evs, _ = store.read("r1", home=self.home)
        self.assertEqual(evs, [e])

    def test_torn_last_line_skipped(self):
        seed(self.home, "r1", [mk_event(1), mk_event(2)], raw_tail=b'{"act":"heartbeat","agent":"a1","id":"e-12')
        evs, bad = store.read("r1", home=self.home)
        self.assertEqual([e["lamport"] for e in evs], [1, 2])

    def test_torn_multibyte_tail_skipped(self):
        seed(self.home, "r1", [mk_event(1)], raw_tail=b'{"text":"\xe6\x97')
        evs, _ = store.read("r1", home=self.home)
        self.assertEqual(len(evs), 1)

    def test_malformed_lines_counted_never_raise(self):
        seed(self.home, "r1", [mk_event(1)], raw_lines=["not json", "[1,2]", b"\xff\xfe\xfd", ""])
        seed(self.home, "r1", [mk_event(2)])
        evs, bad = store.read("r1", home=self.home)
        self.assertEqual([e["lamport"] for e in evs], [1, 2])
        self.assertEqual(bad, 3)                                  # blank line is not counted

    def test_empty_room_file(self):
        seed(self.home, "r1")
        self.assertEqual(store.read("r1", home=self.home), ([], 0))


class Wait(RoomCase):
    def test_returns_existing_match_immediately(self):
        self.post(act="question", agent="a1")
        t = time.time()
        ev = store.wait("r1", 0, act="question", timeout_s=5, poll_s=0.05, home=self.home)
        self.assertEqual(ev["act"], "question")
        self.assertLess(time.time() - t, 2)

    def test_timeout_returns_none(self):
        self.post()
        t = time.time()
        self.assertIsNone(store.wait("r1", 1, timeout_s=0.3, poll_s=0.05, home=self.home))
        self.assertGreaterEqual(time.time() - t, 0.25)
        self.assertLess(time.time() - t, 3)

    def test_since_is_exclusive(self):
        self.post()
        self.assertIsNone(store.wait("r1", 1, timeout_s=0.2, poll_s=0.05, home=self.home))
        self.assertEqual(store.wait("r1", 0, timeout_s=0.2, poll_s=0.05, home=self.home)["lamport"], 1)

    def test_filters(self):
        self.post(agent="a1", act="heartbeat")
        self.post(agent="a2", act="question", to="a3")
        kw = dict(timeout_s=0.2, poll_s=0.05, home=self.home)
        self.assertEqual(store.wait("r1", 0, act="question", **kw)["agent"], "a2")
        self.assertEqual(store.wait("r1", 0, agent="a1", **kw)["lamport"], 1)
        self.assertEqual(store.wait("r1", 0, exclude_agent="a1", **kw)["agent"], "a2")
        self.assertEqual(store.wait("r1", 0, to="a3", **kw)["agent"], "a2")
        self.assertIsNone(store.wait("r1", 0, to="a9", **kw))
        self.assertIsNone(store.wait("r1", 0, act="verdict", **kw))
        self.assertIsNone(store.wait("r1", 0, agent="a1", act="question", **kw))
        self.assertIsNone(store.wait("r1", 0, exclude_agent="a1", agent="a1", **kw))

    def test_wakes_on_later_post(self):
        self.post()
        threading.Timer(0.4, lambda: self.post(agent="a2", act="verdict")).start()
        t = time.time()
        ev = store.wait("r1", 1, act="verdict", timeout_s=10, poll_s=0.05, home=self.home)
        self.assertEqual(ev["agent"], "a2")
        self.assertLess(time.time() - t, 5)

    def test_skips_malformed_lines_while_waiting(self):
        seed(self.home, "r1", [mk_event(1)], raw_lines=["garbage"])
        self.assertIsNone(store.wait("r1", 1, timeout_s=0.2, poll_s=0.05, home=self.home))


class Inbox(RoomCase):
    def test_filter(self):
        q_open = self.post(agent="a1", act="question")                   # to absent -> broadcast
        h_open = self.post(agent="a1", act="handoff")
        to_me = self.post(agent="a1", act="heartbeat", to="me")
        q_me = self.post(agent="a1", act="question", to="me")
        q_other = self.post(agent="a1", act="question", to="other")
        hb = self.post(agent="a1", act="heartbeat")
        step_other = self.post(agent="a1", act="verdict", to="other")
        got = store.inbox("r1", "me", home=self.home)
        self.assertEqual(ids_of(got), {q_open["id"], h_open["id"], to_me["id"], q_me["id"]})
        self.assertNotIn(q_other["id"], ids_of(got))
        self.assertNotIn(hb["id"], ids_of(got))

    def test_since(self):
        self.post(act="question")
        e2 = self.post(act="question")
        got = store.inbox("r1", "me", since=1, home=self.home)
        self.assertEqual([e["id"] for e in got], [e2["id"]])


class Status(RoomCase):
    def test_open_questions_and_handoffs(self):
        q1 = self.post(agent="a1", act="question")
        q2 = self.post(agent="a1", act="question")
        h1 = self.post(agent="a1", act="handoff", to="a2")
        h2 = self.post(agent="a1", act="handoff", to="a2")
        self.post(agent="a2", act="answer", re=q1["id"])
        self.post(agent="a2", act="ack", re=h1["id"])
        s = store.status("r1", home=self.home)
        for k in ("open_questions", "handoffs_without_ack", "last_by_agent", "silent"):
            self.assertIn(k, s)
        self.assertEqual(ids_of(s["open_questions"]), {q2["id"]})
        self.assertEqual(ids_of(s["handoffs_without_ack"]), {h2["id"]})

    def test_last_by_agent_and_silent(self):
        self.post(agent="old-one", clock=lambda: 1000)                   # long ago
        import time
        now = int(time.time() * 1000)
        self.post(agent="fresh", clock=lambda: now)
        s = store.status("r1", home=self.home)
        self.assertEqual(set(s["last_by_agent"]), {"old-one", "fresh"})
        self.assertEqual(set(s["silent"]), {"old-one"})

    def test_empty_lists_when_nothing_open(self):
        self.post(agent="a1")
        s = store.status("r1", home=self.home)
        self.assertEqual(list(s["open_questions"]), [])
        self.assertEqual(list(s["handoffs_without_ack"]), [])


if __name__ == "__main__":
    unittest.main()
