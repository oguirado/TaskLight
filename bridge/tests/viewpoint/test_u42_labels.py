"""U42 capsule labels: agent slug `<capsule>-agent` (+ `-2`, `-3` for overlapping runs of one capsule),
title `<Capsule> · <goal>`, `[<Capsule>]` titles kept as is (observer goals and context-wall MCP posts).
Oracle amendment A-U42b: capsules are arXiv, Gemini, GitHub, Wikipedia (no ChatGPT); goal, then target names, then
url/href/host fields of the run JSON; no match -> bare "<goal>" title and "viewpoint-agent"."""
import contextlib, io, json, unittest
from bridge.tests.viewpoint.support import *

DOT = "·"
GOALS = [
    ("run-arxiv", "Search arXiv for AI agent", "arxiv-agent", "arXiv"),
    ("run-github", "Search GitHub for context wall", "github-agent", "GitHub"),
    ("run-gemini", "Open the Gemini models page", "gemini-agent", "Gemini"),
    ("run-wiki", "Search Wikipedia for Google DeepMind", "wikipedia-agent", "Wikipedia"),
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

    def test_chatgpt_is_not_a_capsule(self):
        # Oracle amendment A-U42b: ChatGPT/OpenAI no longer map to a capsule.
        self.run_builder().intent("1", goal="Ask ChatGPT about on-device AI", name="Message ChatGPT")
        self.make().poll()
        e = self.events()[0]
        self.assertEqual(e["agent"], "viewpoint-agent")
        self.assertEqual(e["plan"]["title"], "Ask ChatGPT about on-device AI")

    def test_deepmind_google_text_is_gemini(self):
        self.run_builder().intent("1", goal="Open deepmind.google/models/gemini/")
        self.make().poll()
        self.assertEqual({e["agent"] for e in self.events()}, {"gemini-agent"})

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

    def test_unknown_capsule_is_bare_goal(self):
        # Oracle amendment A-U42b: no capsule -> title is just the goal (no "ViewPoint ·" prefix).
        self.run_builder().intent("1", goal="Open the settings page", name="Settings")
        self.make().poll()
        e = self.events()[0]
        self.assertEqual(e["agent"], "viewpoint-agent")
        self.assertEqual(e["plan"]["title"], "Open the settings page")

    def test_tagged_goal_kept_as_is(self):
        self.run_builder().intent("1", goal="[GitHub] Ask about on-device AI")
        self.make().poll()
        e = self.events()[0]
        self.assertEqual(e["agent"], "github-agent")
        self.assertEqual(e["plan"]["title"], "[GitHub] Ask about on-device AI")

    def test_title_stays_capped(self):
        self.run_builder().intent("1", goal="Search GitHub " + "x" * 300)
        self.make().poll()
        t = self.events()[0]["plan"]["title"]
        self.assertLessEqual(len(t), 120)
        self.assertTrue(t.startswith("GitHub %s Search GitHub" % DOT))

    def test_later_steps_keep_the_slug_and_title(self):
        b = self.run_builder().intent("1", goal="Search GitHub about on-device AI")
        o = self.make(); o.poll()
        b.intent("2", goal="Search GitHub about on-device AI", name="Copy response").receipt("1").receipt("2")
        b.report(rc=0, verdict="BROWSER_BOUNDED_ACTIONS_VERIFIED"); o.poll()
        evs = self.events()
        self.assertEqual({e["agent"] for e in evs}, {"github-agent"})
        self.assertEqual({e["plan"]["title"] for e in evs if e["act"] == "plan"},
                         {"GitHub %s Search GitHub about on-device AI" % DOT})


class PlanBC(Base):
    """Oracle amendment A-U42b: plan B capsule MDN, plan C capsule Hugging Face."""

    def test_mdn_from_goal_and_host(self):
        self.run_builder("a").intent("1", goal="Search MDN for fetch")
        self.run_builder("b").intent("1", goal="Search", name="Search",
                                     extra={"url": "https://developer.mozilla.org/en-US/"})
        self.make().poll()
        self.assertEqual(plans_by_agent(self.events()),
                         {"mdn-agent": "MDN %s Search MDN for fetch" % DOT, "mdn-agent-2": "MDN %s Search" % DOT})

    def test_hugging_face_from_goal_and_host(self):
        from bridge.room.store import AGENT_RE
        self.run_builder("a").intent("1", goal="Search Hugging Face for gemma")
        self.run_builder("b").intent("1", goal="Search models", name="Search", extra={"host": "huggingface.co"})
        self.make().poll()
        got = plans_by_agent(self.events())
        self.assertEqual(got, {"hugging-face-agent": "Hugging Face %s Search Hugging Face for gemma" % DOT,
                               "hugging-face-agent-2": "Hugging Face %s Search models" % DOT})
        for a in got:
            self.assertTrue(AGENT_RE.fullmatch(a), a)

    def test_mdn_is_a_whole_word(self):
        self.run_builder().intent("1", goal="Run cmdnet tool", name="Run")
        self.make().poll()
        self.assertEqual({e["agent"] for e in self.events()}, {"viewpoint-agent"})


class UrlCapsules(Base):
    """Oracle amendment A-U42b: goal and target names say nothing -> url/href/host fields of the run JSON."""

    def plan(self):
        evs = [e for e in self.events() if e["act"] == "plan"]
        self.assertEqual(len(evs), 1)
        return evs[0]["agent"], evs[0]["plan"]["title"]

    def test_url_in_intent(self):
        self.run_builder().intent("1", goal="Search term or terms", name="Search",
                                  extra={"page": {"url": "https://arxiv.org/search/?query=AI+agent"}})
        self.make().poll()
        self.assertEqual(self.plan(), ("arxiv-agent", "arXiv %s Search term or terms" % DOT))

    def test_href_in_dispatch(self):
        b = self.run_builder()
        b.raw("dispatch-mw-1.json", {"proposal": {"context": {"href": "https://github.com/search?q=x"}}})
        b.intent("1", goal="Search or jump to", name="Search")
        self.make().poll()
        self.assertEqual(self.plan(), ("github-agent", "GitHub %s Search or jump to" % DOT))

    def test_host_field_in_receipt(self):
        b = self.run_builder().receipt("0", raw={"verification": {"status": "verified"}, "host": "deepmind.google"})
        b.intent("1", goal="Open the models page", name="Models")
        self.make().poll()
        self.assertEqual(self.plan()[0], "gemini-agent")

    def test_subdomain_host_in_report_only_run(self):
        b = self.run_builder()
        b.raw("report.json", {"rc": 0, "verdict_code": "PASS", "moves": [], "start_url": "https://en.wikipedia.org/wiki/X"})
        o = self.make(); o.prime()
        self.assertEqual(o._meta[b.run_id]["capsule"], "Wikipedia")

    def test_goal_wins_over_url(self):
        self.run_builder().intent("1", goal="Search Wikipedia", name="Search Wikipedia",
                                  extra={"url": "https://github.com/"})
        self.make().poll()
        self.assertEqual(self.plan()[0], "wikipedia-agent")

    def test_unknown_or_lookalike_host_is_bare_goal(self):
        self.run_builder("a").intent("1", goal="Search", name="Search",
                                     extra={"url": "https://notgithub.com.evil.example/x", "host": "chatgpt.com"})
        self.make().poll()
        self.assertEqual(self.plan(), ("viewpoint-agent", "Search"))

    def test_host_only_in_non_url_field_is_ignored(self):
        self.run_builder().intent("1", goal="Search stories by title, url or author", name="Search",
                                  extra={"note": "https://github.com/"})
        self.make().poll()
        self.assertEqual(self.plan()[0], "viewpoint-agent")

    def test_overlapping_unknown_runs_get_suffixes(self):
        self.run_builder("u1").intent("1", goal="Search")
        self.run_builder("u2").intent("1", goal="Search")
        self.make().poll()
        self.assertEqual({e["agent"] for e in self.events()}, {"viewpoint-agent", "viewpoint-agent-2"})


class Concurrency(Base):
    def test_three_concurrent_runs_of_one_capsule(self):
        for rid in ("c1", "c2", "c3"):
            self.run_builder(rid).intent("1", goal="Search GitHub something")
        self.make().poll()
        self.assertEqual({e["agent"] for e in self.events()},
                         {"github-agent", "github-agent-2", "github-agent-3"})

    def test_suffix_follows_start_order_not_run_id(self):
        self.run_builder("zzz").intent("1", goal="Search GitHub a", mtime=BASE + 5)
        self.run_builder("aaa").intent("1", goal="Search GitHub b", mtime=BASE + 50)
        self.make().poll()
        got = plans_by_agent(self.events())
        self.assertEqual(got["github-agent"], "GitHub %s Search GitHub a" % DOT)
        self.assertEqual(got["github-agent-2"], "GitHub %s Search GitHub b" % DOT)

    def test_different_capsules_do_not_collide(self):
        self.run_builder("a").intent("1", goal="Search GitHub a")
        self.run_builder("b").intent("1", goal="Ask Gemini b")
        self.make().poll()
        self.assertEqual({e["agent"] for e in self.events()}, {"github-agent", "gemini-agent"})

    def test_finished_run_frees_its_slug(self):
        b1 = self.run_builder("first").intent("1", goal="Search GitHub a", mtime=BASE + 1)
        b1.receipt("1", mtime=BASE + 2).report(rc=0, verdict="BROWSER_BOUNDED_ACTIONS_VERIFIED")
        self.run_builder("second").intent("1", goal="Search GitHub b", mtime=BASE + 500)
        self.make().poll()
        self.assertEqual({e["agent"] for e in self.events()}, {"github-agent"})

    def test_live_second_run_while_first_open_gets_suffix(self):
        self.run_builder("first").intent("1", goal="Search GitHub a")
        o = self.make(); o.poll()
        self.run_builder("second").intent("1", goal="Search GitHub b", mtime=BASE + 500)
        o.poll()
        got = plans_by_agent(self.events())
        self.assertEqual(set(got), {"github-agent", "github-agent-2"})
        self.assertEqual(got["github-agent-2"], "GitHub %s Search GitHub b" % DOT)

    def test_restart_keeps_slugs(self):
        b1 = self.run_builder("c1").intent("1", goal="Search GitHub a")
        b2 = self.run_builder("c2").intent("1", goal="Search GitHub b")
        self.make().poll()
        before = plans_by_agent(self.events())
        b2.intent("2", goal="Search GitHub b", name="next")
        b1.intent("2", goal="Search GitHub a", name="next")
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
                "room": "viewpoint", "agent": "github-helper", "title": "[GitHub] Summarise the answer",
                "steps": [{"text": "read"}]}})
        reply = json.loads(buf.getvalue().strip().splitlines()[-1])
        self.assertNotIn("error", reply)
        self.run_builder().intent("1", goal="Search GitHub about on-device AI")
        self.make().poll()
        got = plans_by_agent(self.events())
        self.assertEqual(got["github-helper"], "[GitHub] Summarise the answer")
        self.assertEqual(got["github-agent"], "GitHub %s Search GitHub about on-device AI" % DOT)


class ReportOnlyRun(Base):
    """A-U42b live finding (02:40 burst): a report-only run closed the previous run's card with its own verdict."""

    def test_report_only_run_does_not_close_previous_card(self):
        b1 = self.run_builder("first").intent("1", goal="Filter by name", name="Filter by name", mtime=BASE + 1)
        b1.receipt("1", mtime=BASE + 2)
        b1.raw("report.json", {"rc": 6, "verdict_code": "MW_SLOT_LENGTH_TEXT_OF_UNAVAILABLE", "moves": []}, mtime=BASE + 3)
        o = self.make(); o.poll()
        self.run_builder("second").raw("report.json", {"rc": 6, "verdict_code": "MW_BROWSER_FOCUS", "moves": []},
                                       mtime=BASE + 6)
        o.poll()
        closes = [(e["agent"], e["text"]) for e in self.events() if e["act"] == "close"]
        self.assertEqual(closes, [("viewpoint-agent", "MW_SLOT_LENGTH_TEXT_OF_UNAVAILABLE (rc 6)")])
        self.make().poll()  # restart: still nothing new
        self.assertEqual(len([e for e in self.events() if e["act"] == "close"]), 1)

    def test_report_only_run_alone_posts_nothing(self):
        self.run_builder().raw("report.json", {"rc": 6, "verdict_code": "MW_BROWSER_FOCUS", "moves": []})
        self.make().poll()
        self.assertEqual(self.events(), [])


class StopSignal(Base):
    """A-U42b live finding: SIGTERM delivered while poll() runs was swallowed by its `except Exception`."""

    def test_sigterm_during_poll_exits_0(self):
        import signal
        from unittest import mock
        from bridge.viewpoint import __main__ as cli
        from bridge.viewpoint.observer import ViewpointObserver
        self.run_builder().intent("1")
        real = ViewpointObserver._discover_runs

        def discover(obs):
            # Raise the registered handler on both platforms. Windows
            # os.kill(SIGTERM) terminates the test process without dispatch.
            signal.raise_signal(signal.SIGTERM)
            return real(obs)

        sleeps = []

        def fake_sleep(s):
            sleeps.append(s)
            if len(sleeps) > 3:
                raise AssertionError("SIGTERM swallowed: watch loop kept polling")

        old = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
        try:
            with mock.patch.object(ViewpointObserver, "_discover_runs", discover), \
                 mock.patch.object(cli.time, "sleep", fake_sleep), \
                 contextlib.redirect_stderr(io.StringIO()):
                rc = cli.main(["watch", "--root", str(self.root), "--interval", "0.01"])
        finally:
            for s, h in old.items():
                signal.signal(s, h)
        self.assertEqual(rc, 0)
        self.assertEqual(sleeps, [])


if __name__ == "__main__":
    unittest.main()
