"""Native host end-to-end (subprocess `bridge.wall.native_host`) against loopback fakes. Acceptance 1, 2, 3, 8, 10-12, 15, 16."""
import json, os, struct, time
from . import support as S
from bridge.wall import emit as E

ROOMS = {"allow": [{"room": "demo", "tier": "private"}, {"room": "ops", "tier": "standard"}], "agent": "wall-user"}


class Gate(S.Base):
    """Old behaviour must survive when `models` is absent or invalid (GREEN controls)."""

    def start(self, models):
        cfg = S.models_cfg(self.tmp, models)
        h = S.MHost(cfg, S.env_for(self.home))
        self.addCleanup(h.stop)
        f = h.read_frame()
        self.assertEqual(f["t"], "hello")
        return h

    def test_no_models_key_no_model_hello_and_model_frame_fatal(self):
        h = self.start(None)
        self.assertEqual(h.drain(0.6), [])
        h.send({"t": "model_list", "v": 1, "rid": "r1"})
        self.assertEqual(h.wait(), 2, h.stderr_text()[-300:])
        self.assertEqual(h.rest(), b"")

    def test_invalid_models_values_leave_relay_off(self):
        for bad in ([], "x", {"home": 5}, {"zzz": 1}, None):
            with self.subTest(models=bad):
                cfg = S.models_cfg(self.tmp, bad, name="c.json")
                h = S.MHost(cfg, S.env_for(self.home))
                try:
                    self.assertEqual(h.read_frame()["t"], "hello")
                    self.assertEqual(h.drain(0.4), [])
                    h.send(S.list_frame())
                    self.assertEqual(h.wait(), 2)
                    self.assertEqual(h.rest(), b"")
                finally:
                    h.stop()

    def test_bye_and_ping_unchanged_without_models(self):
        h = self.start(None)
        h.send({"t": "ping", "v": 1})
        self.assertTrue(h.alive_for(0.4))
        h.send({"t": "bye", "v": 1})
        self.assertEqual(h.wait(), 0)
        self.assertEqual(h.rest(), b"")

    def test_every_model_frame_fatal_without_models(self):
        for fr in (S.probe_frame(), S.gen(), S.cancel_frame()):
            h = self.start(None)
            h.send(fr)
            self.assertEqual(h.wait(), 2, fr["t"])
            h.stop()


class Hello(S.Base):
    def test_hello_then_model_hello_exact(self):
        f = self.fake()
        h = self.host([S.ep(f, id="loc"), S.ep("https://api.example.invalid/v1", id="rem",
                                              kind="remote-openai-compatible")], {"rem": S.KEY_CANARY})
        first = h.read_frame()
        second = h.read_frame()
        self.assertEqual(first["t"], "hello")
        self.assertEqual(set(second), {"t", "v", "endpoints"})
        self.assertEqual((second["t"], second["v"]), ("model_hello", 1))
        for e in second["endpoints"]:
            self.assertEqual(set(e), {"id", "kind", "label", "model", "loopback", "has_key", "allow_private"})
        self.assertEqual([(e["id"], e["loopback"], e["has_key"]) for e in second["endpoints"]],
                         [("loc", True, False), ("rem", False, True)])
        self.assertEqual(h.drain(0.5), [], "nothing else is volunteered")
        raw = json.dumps(first) + json.dumps(second)
        for needle in (S.KEY_CANARY, "base_url", str(f.port), "127.0.0.1", "api.example.invalid"):
            self.assertNotIn(needle, raw)

    def test_no_model_frame_before_hello(self):
        h = self.host([S.ep(None, base_url="http://127.0.0.1:9/v1")])
        self.assertEqual(h.read_frame()["t"], "hello")
        frames = [h.read_frame()] + h.drain(0.3)
        self.assertEqual([f["t"] for f in frames], ["model_hello"])

    def test_room_hello_sits_between(self):
        h = self.host([S.ep(None, base_url="http://127.0.0.1:9/v1")], rooms=ROOMS)
        ts = [h.read_frame()["t"] for _ in range(3)]
        self.assertEqual(ts, ["hello", "room_hello", "model_hello"])

    def test_empty_and_missing_store(self):
        h = self.host()
        h.read_frame()
        self.assertEqual(h.read_frame()["endpoints"], [])

    def test_refused_store_hello_has_no_endpoints(self):
        h = self.host([S.ep(None, base_url="http://127.0.0.1:9/v1")], file_mode=0o644)
        h.read_frame()
        self.assertEqual(h.read_frame()["endpoints"], [])
        self.assertEqual(h.drain(0.3), [])

    def test_models_home_beats_env_and_env_beats_default(self):
        S.write_store(self.home, [S.ep(None, id="from-env", base_url="http://127.0.0.1:9/v1")])
        other = self.tmp / "other"
        S.write_store(other, [S.ep(None, id="from-cfg", base_url="http://127.0.0.1:9/v1")])
        S.write_store(self.home / "fakehome" / ".context-wall", [S.ep(None, id="from-default", base_url="http://127.0.0.1:9/v1")])
        for models, env, want in (({"home": str(other)}, S.env_for(self.home), "from-cfg"),
                                  ({}, S.env_for(self.home), "from-env"),
                                  ({}, S.env_for(self.home, CW_HOME=""), "from-default")):
            cfg = S.models_cfg(self.tmp, models, name="c.json")
            h = S.MHost(cfg, env)
            try:
                h.read_frame()
                self.assertEqual([e["id"] for e in h.read_frame()["endpoints"]], [want])
            finally:
                h.stop()

    def test_model_list_rereads_and_echoes_rid(self):
        f = self.fake()
        h = self.start(endpoints=[S.ep(f, id="one")])
        S.write_store(self.home, [S.ep(f, id="one"), S.ep(f, id="two")])
        h.send(S.list_frame("L9"))
        r = self.expect(h, "L9")
        self.assertEqual((r["t"], [e["id"] for e in r["endpoints"]]), ("model_hello", ["one", "two"]))
        self.assertEqual(set(r), {"t", "v", "endpoints", "rid"})


class Dispatch(S.Base):
    def test_probe_generate_roundtrip_and_frame_sizes(self):
        f = self.fake()
        f.content = "héllo"
        h = self.start(endpoints=[S.ep(f)])
        h.send(S.probe_frame("p1"))
        p = self.expect(h, "p1")
        self.assertEqual(p, {"t": "model_health", "v": 1, "rid": "p1", "id": "fake", "state": "available", "rung": 2})
        h.send(S.gen("g1"))
        r = self.expect(h, "g1")
        self.assertEqual(r, {"t": "model_result", "v": 1, "rid": "g1", "text": "héllo"})
        h.send(S.gen("g2", id="nope"))
        n = self.expect(h, "g2")
        self.assertEqual(n, {"t": "model_nack", "v": 1, "rid": "g2", "code": "unknown_endpoint"})
        self.assertTrue(all(sz <= 65536 for sz in h.sizes))
        h.send({"t": "bye", "v": 1})
        self.assertEqual(h.wait(), 0)
        self.assertEqual(h.rest(), b"")

    def test_frame_cap_through_the_real_host(self):
        f = self.fake()
        rid = "cap"
        base = len(json.dumps({"t": "model_result", "v": 1, "rid": rid, "text": ""}, separators=(",", ":")).encode())
        fit = 65536 - base
        h = self.start(endpoints=[S.ep(f)])
        f.content = "a" * fit
        h.send(S.gen(rid))
        r = self.expect(h, rid)
        self.assertEqual((r["t"], len(r["text"])), ("model_result", fit))
        self.assertEqual(h.sizes[-1], 65536)
        f.content = "a" * (fit + 1)
        h.send(S.gen(rid))
        self.assertEqual(self.expect(h, rid)["code"], "reply_too_large")
        self.assertTrue(h.alive_for(0.2))

    def test_too_large_request_zero_fake_requests(self):
        f = self.fake()
        h = self.start(endpoints=[S.ep(f)])
        h.send(S.gen("big", messages=[{"role": "user", "content": "a" * 49200}]))
        self.assertEqual(self.expect(h, "big")["code"], "too_large")
        self.assertEqual((f.conns, f.requests), (0, []))

    def test_busy_second_generate(self):
        f = self.fake()
        f.reply(200, S.chat_body("slow"), delay=1.2)
        h = self.start(endpoints=[S.ep(f)])
        h.send(S.gen("a"))
        f.wait_requests(1)
        h.send(S.gen("b"))
        self.assertEqual(self.expect(h, "b")["code"], "busy")
        self.assertEqual(self.expect(h, "a")["t"], "model_result")

    def test_spool_events_flow_during_in_flight_request(self):
        f = self.fake()
        f.reply(200, S.chat_body("late"), delay=2.0)
        h = self.start(endpoints=[S.ep(f)])
        cfg = str(self.tmp / "wall.config.json")
        h.send(S.gen("slow"))
        self.assertTrue(f.wait_requests(1))
        t0 = time.monotonic()
        import sys as _s; _s.modules["bridge.wall.emit"].emit("api", "output", "during-flight", "agent", config=cfg, _clock=S.W.CLOCK)
        ev, seen = h.read_until(lambda x: x["t"] == "event", 1.5)
        self.assertEqual(ev["payload"]["text"], "during-flight")
        self.assertLess(time.monotonic() - t0, 1.5)
        self.assertFalse([x for x in seen if x.get("rid") == "slow"], "event observed before the reply")
        self.assertEqual(self.expect(h, "slow", 5)["t"], "model_result")

    def test_cancel_over_the_wire(self):
        f = self.fake()
        f.reply(200, S.chat_body("late"), delay=2.0)
        h = self.start(endpoints=[S.ep(f)])
        h.send(S.gen("a"))
        self.assertTrue(f.wait_requests(1))
        h.send(S.cancel_frame("a"))
        t0 = time.monotonic()
        n = self.expect(h, "a", 1.2)
        self.assertEqual((n["t"], n["code"]), ("model_nack", "cancelled"))
        self.assertLessEqual(time.monotonic() - t0, 1.0)
        h.send(S.cancel_frame("not-there"))
        late = h.drain(2.8)
        self.assertEqual([x for x in late if x.get("rid") == "a"], [], "late result discarded")
        self.assertEqual([x for x in late if x.get("rid") == "not-there"], [])
        self.assertTrue(h.alive_for(0.1))

    def test_bye_with_request_in_flight(self):
        f = self.fake()
        f.reply(200, S.chat_body("late"), delay=5.0)
        h = self.start(endpoints=[S.ep(f)])
        h.send(S.gen("a"))
        f.wait_requests(1)
        t0 = time.monotonic()
        h.send({"t": "bye", "v": 1})
        self.assertEqual(h.wait(2.0), 0)
        self.assertLess(time.monotonic() - t0, 2.0)
        self.assertEqual(h.rest(), b"")

    def test_stdin_eof_with_request_in_flight(self):
        f = self.fake()
        f.reply(200, S.chat_body("late"), delay=5.0)
        h = self.start(endpoints=[S.ep(f)])
        h.send(S.gen("a"))
        f.wait_requests(1)
        h.close_stdin()
        self.assertEqual(h.wait(2.5), 0)

    def test_policy_over_the_wire(self):
        f = self.fake()
        h = self.start(endpoints=[S.ep(f, id="loc"), S.ep("https://127.0.0.1:%d/v1" % f.port, id="rem",
                                                          kind="remote-openai-compatible"),
                                  S.ep(f, id="off", enabled=False), S.ep(f, id="priv", allow_private=True)],
                       keys={"rem": "k"})
        for rid, id_, tier, code in (("a", "loc", "private", "policy"), ("b", "rem", "private", "policy"),
                                     ("c", "rem", "shared", "policy"), ("d", "off", "standard", "policy")):
            h.send(S.gen(rid, id=id_, tier=tier))
            self.assertEqual(self.expect(h, rid)["code"], code, rid)
        self.assertEqual((f.conns, f.requests), (0, []))
        h.send(S.gen("ok", id="priv", tier="private"))
        self.assertEqual(self.expect(h, "ok")["t"], "model_result")

    def test_loopback_resolution_end_to_end_local_name(self):
        f = self.fake()
        h = self.start(endpoints=[S.ep("http://localhost:%d/v1" % f.port)])
        h.send(S.probe_frame("p"))
        self.assertIn(self.expect(h, "p")["state"], ("available", "offline"))   # localhost may be ::1-only on odd hosts


class Fatal(S.Base):
    BAD = [
        {"t": "model_probe", "v": 1, "rid": "r"}, {"t": "model_probe", "v": 1, "rid": "r", "id": "BAD"},
        {"t": "model_list", "v": 1}, {"t": "model_list", "v": 2, "rid": "r"}, {"t": "model_cancel", "v": 1},
        {"t": "model_result", "v": 1, "rid": "r", "text": "x"}, {"t": "model_hello", "v": 1, "endpoints": []},
        {"t": "model_nack", "v": 1, "rid": "r", "code": "busy"}, {"t": "model_bogus", "v": 1},
        {"t": "model_generate", "v": 1, "rid": "r", "id": "fake", "tier": "standard", "max_tokens": 5, "rung": 3},
        {"t": "model_generate", "v": 1, "rid": "r", "id": "fake", "tier": "nope", "messages": [{"role": "user", "content": "x"}],
         "max_tokens": 5, "rung": 3},
        {"t": "model_generate", "v": 1, "rid": "r", "id": "fake", "tier": "standard", "rung": 1, "max_tokens": 5,
         "messages": [{"role": "user", "content": "x"}]},
    ]

    def test_structural_violations_exit_2_with_nothing_after(self):
        for fr in self.BAD:
            with self.subTest(frame=fr["t"] + str(sorted(fr))[:60]):
                h = self.start(endpoints=[S.ep(None, base_url="http://127.0.0.1:9/v1")])
                h.send(fr)
                self.assertEqual(h.wait(), 2, h.stderr_text()[-200:])
                self.assertEqual(h.rest(), b"")
                h.stop()

    def test_old_fatal_cases_still_fatal_with_relay_on(self):
        for raw in (S.frame({"t": "evil", "v": 1}), S.frame({"t": "ping", "v": 2}), struct.pack("<I", 70000),
                    struct.pack("<I", 8) + b"{notjson"):
            h = self.start(endpoints=[])
            h.send_raw(raw)
            self.assertEqual(h.wait(), 2)
            self.assertEqual(h.rest(), b"")
            h.stop()

    def test_resync_and_ping_still_silent_with_relay_on(self):
        h = self.start(endpoints=[])
        h.send({"t": "ping", "v": 1})
        h.send({"t": "resync", "v": 1})
        self.assertEqual(h.drain(0.5), [])
        self.assertTrue(h.alive_for(0.1))


class Canary(S.Base):
    def test_no_canary_in_frames_stderr_or_any_argv(self):
        f = self.fake()
        f.content = S.REPLY_CANARY
        with S.ProcSampler(S.KEY_CANARY, S.PROMPT_CANARY) as ps:
            r = S.run_cli(["add", "--id", "fake", "--kind", "local", "--base-url", f.base_url, "--model", "m"], self.home)
            self.assertEqual(r.returncode, 0, r.stderr)
            sk = S.run_cli(["set-key", "--id", "fake"], self.home, stdin=(S.KEY_CANARY + "\n").encode())
            self.assertEqual(sk.returncode, 0, sk.stderr)
            ls = S.run_cli(["list"], self.home)
            pr = S.run_cli(["probe", "--id", "fake"], self.home)
            h = self.start()
            msgs = [{"role": "user", "content": S.PROMPT_CANARY}]
            h.send(S.gen("ok", messages=msgs))
            ok = self.expect(h, "ok")
            f.reply(500, ("e " + S.KEY_CANARY + S.PROMPT_CANARY).encode())
            h.send(S.gen("e500", messages=msgs))
            e5 = self.expect(h, "e500")
            h.send(S.probe_frame("pp"))
            frames = [ok, e5, self.expect(h, "pp")]
            h.send({"t": "bye", "v": 1})
            h.wait()
            tail = h.rest()
        bad = S.run_cli(["set-key", "--id", "fake", "--key", S.KEY_CANARY], self.home)   # deliberate argv, outside sampler
        self.assertEqual(bad.returncode, 2)
        self.assertEqual(ok["text"], S.REPLY_CANARY)
        wire = json.dumps(frames).encode() + tail
        outs = b"".join(x.stdout + x.stderr for x in (r, sk, ls, pr, bad)) + h.stderr_text()
        for c in (S.KEY_CANARY, S.PROMPT_CANARY):
            self.assertNotIn(c.encode(), wire, c)
            self.assertNotIn(c.encode(), outs, c)
        self.assertNotIn(S.REPLY_CANARY.encode(), outs)
        self.assertEqual(ps.hits, [])
        for needle in (str(f.port).encode(), b"127.0.0.1"):
            self.assertNotIn(needle, h.stderr_text())
            self.assertNotIn(needle, wire)
        self.assertNotIn(S.KEY_CANARY.encode(), (self.home / "models" / "endpoints.json").read_bytes())
        self.assertEqual(json.loads((self.home / "models" / "keys.json").read_text())["keys"], {"fake": S.KEY_CANARY})
        # the key did reach the fake as a Bearer header and nowhere else
        self.assertTrue(all(q["headers"].get("authorization") == "Bearer " + S.KEY_CANARY for q in f.requests))
