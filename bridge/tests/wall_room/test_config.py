import unittest
from . import support as S


class Limits(S.Base):
    def test_room_limits_exact(self):
        self.assertEqual(self.mod().ROOM_LIMITS, {"FRAME_MAX": 65536, "TEXT_MAX_BYTES": 4096,
                                                  "REPLAY_MAX": 500, "POSTS_PER_SEC": 2, "ROOMS_MAX": 12})


class LoadRoomConfig(S.Base):
    def load(self, cfg):
        return self.mod().load_room_config(cfg)

    def test_valid_maps_tier_to_floor(self):
        c = self.load(S.rcfg_dict(rooms=(("demo", "private"), ("team-1", "standard")), orchestrator="orch"))
        self.assertIsInstance(c, dict)
        self.assertEqual(c["rooms"], [{"room": "demo", "floor": "ONLY_ON_DEVICE"},
                                      {"room": "team-1", "floor": "PREFER_ON_DEVICE"}])
        self.assertEqual(c["agent"], "wall-user")
        self.assertEqual(c["orchestrator"], "orch")

    def test_optional_fields_default_none(self):
        c = self.load(S.rcfg_dict())
        self.assertIsNone(c.get("orchestrator"))
        self.assertIsNone(c.get("home"))

    def test_home_passed_through(self):
        c = self.load(S.rcfg_dict(home="/tmp/some-home"))
        self.assertEqual(c["home"], "/tmp/some-home")

    def test_extra_top_level_keys_ignored(self):
        cfg = S.rcfg_dict()
        cfg["projects"] = []
        self.assertIsNotNone(self.load(cfg))

    def test_rooms_max_boundary(self):
        ok = tuple(("r%d" % i, "private") for i in range(12))
        self.assertEqual(len(self.load(S.rcfg_dict(rooms=ok))["rooms"]), 12)
        self.assertIsNone(self.load(S.rcfg_dict(rooms=ok + (("r12", "private"),))))

    def test_bad_slugs_none(self):
        for bad in ("", "Demo", "-demo", "de mo", "de_mo", "../x", "a/b", "x" * 49, "démo", "demo\n"):
            with self.subTest(room=bad):
                self.assertIsNone(self.load(S.rcfg_dict(rooms=((bad, "private"),))))

    def test_slug_48_chars_ok(self):
        self.assertIsNotNone(self.load(S.rcfg_dict(rooms=(("a" + "b" * 47, "private"),))))

    def test_bad_tier_none(self):
        for bad in ("public", "PRIVATE", "", None, 1, "only_on_device"):
            with self.subTest(tier=bad):
                self.assertIsNone(self.load({"rooms": {"allow": [{"room": "demo", "tier": bad}], "agent": "wall-user"}}))

    def test_bad_agent_none(self):
        for bad in ("", "Wall", "wall user", None, 3, "-x"):
            with self.subTest(agent=bad):
                self.assertIsNone(self.load({"rooms": {"allow": [{"room": "demo", "tier": "private"}], "agent": bad}}))

    def test_missing_agent_none(self):
        self.assertIsNone(self.load({"rooms": {"allow": [{"room": "demo", "tier": "private"}]}}))

    def test_bad_orchestrator_none(self):
        for bad in ("Bad Agent", 5, ""):
            with self.subTest(o=bad):
                self.assertIsNone(self.load(S.rcfg_dict(orchestrator=bad)))

    def test_bad_home_none(self):
        for bad in ("", 5, ["x"]):
            with self.subTest(h=bad):
                self.assertIsNone(self.load(S.rcfg_dict(home=bad)))

    def test_structure_none(self):
        good = {"room": "demo", "tier": "private"}
        cases = [None, [], "x", {}, {"rooms": None}, {"rooms": []}, {"rooms": {}},
                 {"rooms": {"agent": "wall-user"}},
                 {"rooms": {"allow": [], "agent": "wall-user"}},
                 {"rooms": {"allow": "demo", "agent": "wall-user"}},
                 {"rooms": {"allow": [good, "x"], "agent": "wall-user"}},
                 {"rooms": {"allow": [{"room": "demo"}], "agent": "wall-user"}},
                 {"rooms": {"allow": [{"tier": "private"}], "agent": "wall-user"}},
                 {"rooms": {"allow": [dict(good, extra=1)], "agent": "wall-user"}},
                 {"rooms": {"allow": [good, good], "agent": "wall-user"}},
                 {"rooms": {"allow": [good], "agent": "wall-user", "bogus": 1}}]
        for c in cases:
            with self.subTest(cfg=c):
                self.assertIsNone(self.load(c))

    def test_does_not_mutate_input(self):
        import copy
        cfg = S.rcfg_dict(orchestrator="orch")
        before = copy.deepcopy(cfg)
        self.load(cfg)
        self.assertEqual(cfg, before)
