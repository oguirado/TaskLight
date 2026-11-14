"""U42 capsule labels: agent slug `<capsule>-agent` (+ `-2`, `-3` for overlapping runs of one capsule),
title `<Capsule> · <goal>`, `[<Capsule>]` titles kept as is (observer goals and context-wall MCP posts)."""
import contextlib, io, json, unittest
from bridge.tests.viewpoint.support import *

DOT = "·"
GOALS = [
    ("run-chatgpt", "Ask ChatGPT about on-device AI", "chatgpt-agent", "ChatGPT"),
    ("run-gemini", "Ask Gemini to compare hybrid inference", "gemini-agent", "Gemini"),
    ("run-wiki", "Search Wikipedia for Firebase", "wikipedia-agent", "Wikipedia"),
    ("run-arxiv", "Find the latest arXiv paper on small language models", "arxiv-agent", "arXiv"),
]


def plans_by_agent(evs):
    out = {}
    for e in evs:
        if e["act"] == "plan":
            out[e["agent"]] = e["plan"]["title"]
    return out


class Capsules(Base):
    def test_replay_goals_map_to_capsule_slugs_and_titles(self):
        for rid, goal, _slug, _cap in GOALS:
            self.run_builder(rid).intent("1", goal=goal)
        self.make().poll()
        got = plans_by_agent(self.events())
        want = {slug: "%s %s %s" % (cap, DOT, goal) for _rid, goal, slug, cap in GOALS}
        self.assertEqual(got, want)

    def test_openai_in_goal_is_chatgpt(self):
        self.run_builder().intent("1", goal="Open the OpenAI playground")
        self.make().poll()
        self.assertEqual({e["agent"] for e in self.events()}, {"chatgpt-agent"})

    def test_target_name_used_when_goal_has_no_capsule(self):
        self.run_builder().intent("1", goal="Ask about hybrid inference", role="textbox", name="Ask Gemini")
        self.make().poll()
        e = self.events()[0]
        self.assertEqual(e["agent"], "gemini-agent")
        self.assertEqual(e["plan"]["title"], "Gemini %s Ask about hybrid inference" % DOT)

    def test_goal_wins_over_target_name(self):
        self.run_builder().intent("1", goal="Search Wikipedia for Gemini", name="Search Wikipedia")
        self.make().poll()
        self.assertEqual(self.events()[0]["agent"], "wikipedia-agent")

    def test_unknown_capsule_is_viewpoint(self):
        self.run_builder().intent("1", goal="Open the settings page", name="Settings")
        self.make().poll()
        e = self.events()[0]
        self.assertEqual(e["agent"], "viewpoint-agent")
        self.assertEqual(e["plan"]["title"], "ViewPoint %s Open the settings page" % DOT)

    def test_tagged_goal_kept_as_is(self):
        self.run_builder().intent("1", goal="[ChatGPT] Ask about on-device AI")
        self.make().poll()
        e = self.events()[0]
        self.assertEqual(e["agent"], "chatgpt-agent")
        self.assertEqual(e["plan"]["title"], "[ChatGPT] Ask about on-device AI")

    def test_title_stays_capped(self):
        self.run_builder().intent("1", goal="Ask ChatGPT " + "x" * 300)
        self.make().poll()
        t = self.events()[0]["plan"]["title"]
        self.assertLessEqual(len(t), 120)
        self.assertTrue(t.startswith("ChatGPT %s Ask ChatGPT" % DOT))

    def test_later_steps_keep_the_slug_and_title(self):
        b = self.run_builder().intent("1", goal="Ask ChatGPT about on-device AI")
        o = self.make(); o.poll()
        b.intent("2", goal="Ask ChatGPT about on-device AI", name="Copy response").receipt("1").receipt("2")
        b.report(rc=0, verdict="BROWSER_BOUNDED_ACTIONS_VERIFIED"); o.poll()
        evs = self.events()
        self.assertEqual({e["agent"] for e in evs}, {"chatgpt-agent"})
        self.assertEqual({e["plan"]["title"] for e in evs if e["act"] == "plan"},
                         {"ChatGPT %s Ask ChatGPT about on-device AI" % DOT})


class Concurrency(Base):
    def test_three_concurrent_runs_of_one_capsule(self):
        for rid in ("c1", "c2", "c3"):
            self.run_builder(rid).intent("1", goal="Ask ChatGPT something")
        self.make().poll()
        self.assertEqual({e["agent"] for e in self.events()},
                         {"chatgpt-agent", "chatgpt-agent-2", "chatgpt-agent-3"})

    def test_suffix_follows_start_order_not_run_id(self):
        self.run_builder("zzz").intent("1", goal="Ask ChatGPT a", mtime=BASE + 5)
        self.run_builder("aaa").intent("1", goal="Ask ChatGPT b", mtime=BASE + 50)
        self.make().poll()
        got = plans_by_agent(self.events())
        self.assertEqual(got["chatgpt-agent"], "ChatGPT %s Ask ChatGPT a" % DOT)
        self.assertEqual(got["chatgpt-agent-2"], "ChatGPT %s Ask ChatGPT b" % DOT)

    def test_different_capsules_do_not_collide(self):
        self.run_builder("a").intent("1", goal="Ask ChatGPT a")
        self.run_builder("b").intent("1", goal="Ask Gemini b")
        self.make().poll()
        self.assertEqual({e["agent"] for e in self.events()}, {"chatgpt-agent", "gemini-agent"})

    def test_finished_run_frees_its_slug(self):
        b1 = self.run_builder("first").intent("1", goal="Ask ChatGPT a", mtime=BASE + 1)
        b1.receipt("1", mtime=BASE + 2).report(rc=0, verdict="BROWSER_BOUNDED_ACTIONS_VERIFIED")
        self.run_builder("second").intent("1", goal="Ask ChatGPT b", mtime=BASE + 500)
        self.make().poll()
        self.assertEqual({e["agent"] for e in self.events()}, {"chatgpt-agent"})

    def test_live_second_run_while_first_open_gets_suffix(self):
        self.run_builder("first").intent("1", goal="Ask ChatGPT a")
        o = self.make(); o.poll()
        self.run_builder("second").intent("1", goal="Ask ChatGPT b", mtime=BASE + 500)
        o.poll()
        got = plans_by_agent(self.events())
        self.assertEqual(set(got), {"chatgpt-agent", "chatgpt-agent-2"})
        self.assertEqual(got["chatgpt-agent-2"], "ChatGPT %s Ask ChatGPT b" % DOT)

    def test_restart_keeps_slugs(self):
        b1 = self.run_builder("c1").intent("1", goal="Ask ChatGPT a")
        b2 = self.run_builder("c2").intent("1", goal="Ask ChatGPT b")
        self.make().poll()
        before = plans_by_agent(self.events())
        b2.intent("2", goal="Ask ChatGPT b", name="next")
        b1.intent("2", goal="Ask ChatGPT a", name="next")
        self.make().poll()  # fresh observer, same cursor
        after = plans_by_agent(self.events())
        self.assertEqual(before, after)
        steps = [e for e in self.events() if e["act"] == "plan"]
        self.assertEqual(len(steps), 4)

    def test_slugs_are_valid_room_agents(self):
        from bridge.room.store import AGENT_RE
        for i in range(12):
            self.run_builder("r%02d" % i).intent("1", goal="Find an arXiv paper")
        self.make().poll()
        ags = {e["agent"] for e in self.events()}
        self.assertEqual(len(ags), 12)
        for a in ags:
            self.assertTrue(AGENT_RE.fullmatch(a), a)


class McpTitles(Base):
    def test_agent_posted_capsule_title_kept_verbatim(self):
        from bridge.room import mcp
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            mcp._handle_call(1, {"name": "post_plan", "arguments": {
                "room": "viewpoint", "agent": "chatgpt-helper", "title": "[ChatGPT] Summarise the answer",
                "steps": [{"text": "read"}]}})
        reply = json.loads(buf.getvalue().strip().splitlines()[-1])
        self.assertNotIn("error", reply)
        self.run_builder().intent("1", goal="Ask ChatGPT about on-device AI")
        self.make().poll()
        got = plans_by_agent(self.events())
        self.assertEqual(got["chatgpt-helper"], "[ChatGPT] Summarise the answer")
        self.assertEqual(got["chatgpt-agent"], "ChatGPT %s Ask ChatGPT about on-device AI" % DOT)


if __name__ == "__main__":
    unittest.main()
