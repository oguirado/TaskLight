"""Oracle amendment A-U43 (C6, live 03:24 take): with cooperative agents posting through the context-wall MCP, the
observer must not add a second card for the same work. A run is skipped (stats merged_skipped) when a cooperative
"<site>-agent" (any site for an unknown-capsule run, the run's own capsule otherwise) was active in the room (plan or
step) within 120 s before the run started and its latest plan shares a content word with the run (goal, target names,
typed text; typed text is compared in memory only)."""
import contextlib, io, unittest
from bridge.tests.viewpoint.support import *

DOT = "·"
ARXIV_STEPS = [{"text": "Open the arXiv search page"}, {"text": "Search for computer use agent"},
               {"text": "Refusal test: URL with query"}]


class Merge(Base):
    def coop(self, agent, title, steps, at_s, act="plan", index=0):
        from bridge.room import store
        ts = (BASE + at_s) * 1000
        if act == "plan":
            store.post("viewpoint", agent, "plan", title, plan={"title": title, "steps": steps},
                       home=str(self.home), clock=lambda: ts)
        else:
            store.post("viewpoint", agent, "step", "step", step={"index": index, "state": "active"},
                       home=str(self.home), clock=lambda: ts)

    def arxiv_run(self, run_id="vp-arxiv", t0=BASE + 10):
        b = self.run_builder(run_id)
        b.intent("1", goal="Search term or terms", role="textbox", name="Search term or terms", mtime=t0)
        b.intent("2", goal="Search term or terms", atype="type", role="textbox", name="Search term or terms",
                 text="computer use agent", mtime=t0 + 5)
        return b

    def observer_agents(self):
        return {e["agent"] for e in self.events() if e.get("id") not in self.coop_ids}

    def setUp(self):
        super().setUp()
        self.coop_ids = set()

    def snapshot_coop(self):
        self.coop_ids = {e["id"] for e in self.events()}

    def test_unknown_capsule_run_merged_into_recent_agent_plan(self):
        self.coop("arxiv-agent", "[arXiv] Search computer use agent", ARXIV_STEPS, at_s=0)
        self.snapshot_coop()
        b = self.arxiv_run()
        o = self.make(); o.poll()
        b.receipt("1").receipt("2").report(rc=0, verdict="BROWSER_BOUNDED_ACTIONS_VERIFIED"); o.poll()
        self.assertEqual(self.observer_agents(), set())
        self.assertEqual(o.stats()["merged_skipped"], 1)
        self.make().poll()  # restart: still no observer card
        self.assertEqual(self.observer_agents(), set())

    def test_typed_text_matches_but_is_never_posted(self):
        self.coop("arxiv-agent", "[arXiv] Find papers", [{"text": "Look for computer use agent papers"}], at_s=0)
        self.snapshot_coop()
        b = self.run_builder("r")
        b.intent("1", goal="Query box", atype="type", role="textbox", name="Query box", text="computer use agent")
        o = self.make(); o.poll()
        self.assertEqual(o.stats()["merged_skipped"], 1)
        self.assertNotIn("computer use agent", "".join(str(e) for e in self.events() if e["id"] not in self.coop_ids))

    def test_no_overlap_keeps_separate_card(self):
        self.coop("github-agent", "[GitHub] Read google-deepmind org", [{"text": "Open the organisation page"}], at_s=0)
        self.snapshot_coop()
        self.arxiv_run()
        o = self.make(); o.poll()
        self.assertEqual(self.observer_agents(), {"viewpoint-agent"})
        self.assertEqual(o.stats()["merged_skipped"], 0)

    def test_stale_agent_plan_keeps_separate_card(self):
        self.coop("arxiv-agent", "[arXiv] Search computer use agent", ARXIV_STEPS, at_s=-200)
        self.snapshot_coop()
        self.arxiv_run()
        self.make().poll()
        self.assertEqual(self.observer_agents(), {"viewpoint-agent"})

    def test_recent_step_activity_keeps_old_plan_current(self):
        self.coop("arxiv-agent", "[arXiv] Search computer use agent", ARXIV_STEPS, at_s=-300)
        self.coop("arxiv-agent", None, None, at_s=-30, act="step", index=1)
        self.snapshot_coop()
        self.arxiv_run()
        self.make().poll()
        self.assertEqual(self.observer_agents(), set())

    def test_known_capsule_does_not_overwrite_agent_card(self):
        self.coop("wikipedia-agent", "[Wikipedia] Search Google DeepMind",
                  [{"text": "Search Wikipedia for Google DeepMind"}, {"text": "Refusal test: fragment URL"}], at_s=0)
        self.snapshot_coop()
        b = self.run_builder("w")
        b.intent("1", goal="Search Wikipedia", role="searchbox", name="Search Wikipedia", mtime=BASE + 10)
        b.receipt("1").report(rc=0, verdict="BROWSER_BOUNDED_ACTIONS_VERIFIED")
        o = self.make(); o.poll()
        self.assertEqual(self.observer_agents(), set())
        plans = [e["plan"]["title"] for e in self.events() if e["act"] == "plan"]
        self.assertEqual(plans, ["[Wikipedia] Search Google DeepMind"])

    def test_known_capsule_ignores_other_sites_agents(self):
        self.coop("arxiv-agent", "[arXiv] Search Wikipedia mirrors", [{"text": "Search Wikipedia mirrors"}], at_s=0)
        self.snapshot_coop()
        self.run_builder("w").intent("1", goal="Search Wikipedia", name="Search Wikipedia", mtime=BASE + 10)
        self.make().poll()
        self.assertEqual(self.observer_agents(), {"wikipedia-agent"})

    def test_observer_own_cards_never_cause_a_merge(self):
        self.run_builder("w").intent("1", goal="Search Wikipedia", name="Search Wikipedia", mtime=BASE + 10)
        o = self.make(); o.poll()
        self.run_builder("u").intent("1", goal="Search terms", name="Search terms", mtime=BASE + 20)
        o.poll()
        self.make().poll()  # also after a restart (observer-style "<Capsule> · " titles are not cooperative)
        self.assertEqual(self.observer_agents(), {"wikipedia-agent", "viewpoint-agent"})
        self.assertEqual(o.stats()["merged_skipped"], 0)

    def test_viewpoint_agent_posts_are_not_cooperative(self):
        self.coop("viewpoint-agent", "[ViewPoint] Search computer use agent", ARXIV_STEPS, at_s=0)
        self.snapshot_coop()
        self.arxiv_run()
        o = self.make(); o.poll()
        self.assertEqual(o.stats()["merged_skipped"], 0)

    def test_cli_stderr_counts_merged_skipped(self):
        self.coop("arxiv-agent", "[arXiv] Search computer use agent", ARXIV_STEPS, at_s=0)
        self.arxiv_run()
        cp = run_cli(["watch", "--root", self.root, "--once"], self.home)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        self.assertIn(b"merged_skipped=1", cp.stderr)


if __name__ == "__main__":
    unittest.main()
