"""bridge/wall/model_relay.py in-process (real transport against loopback fakes, or an injected fake transport)."""
import contextlib, io, json, re, threading, time
from . import support as S
from bridge.models import transport as T

LOCAL = dict(id="fake")


def frames_of(rig, t=None):
    return [f for f in rig.frames if t is None or f["t"] == t]


class Config(S.Base):
    def test_load_model_config(self):
        m = S.relay_mod()
        self.assertIsNone(m.load_model_config({"v": 1}))
        for bad in (None, [], "x", 1, {"home": 5}, {"home": None}, {"extra": 1}, {"home": "/x", "extra": 1}, True):
            with self.subTest(models=bad):
                self.assertIsNone(m.load_model_config({"models": bad}))
        self.assertIsNotNone(m.load_model_config({"models": {}}))
        self.assertEqual(m.load_model_config({"models": {"home": "/some/dir"}})["home"], "/some/dir")

    def test_constants_and_surface(self):
        m = S.relay_mod()
        for name in ("hello_frame", "handle", "poll", "close", "stats"):
            self.assertTrue(callable(getattr(m.ModelRelay, name)), name)

    def test_home_resolution_models_home_over_env(self):
        a, b = self.tmp / "ha", self.tmp / "hb"
        S.write_store(a, [S.ep(None, id="in-a", base_url="http://127.0.0.1:9/v1")])
        S.write_store(b, [S.ep(None, id="in-b", base_url="http://127.0.0.1:9/v1")])
        import os
        old = os.environ.get("CW_HOME")
        os.environ["CW_HOME"] = str(a)
        self.addCleanup(lambda: os.environ.pop("CW_HOME") if old is None else os.environ.__setitem__("CW_HOME", old))
        r = S.relay_mod().ModelRelay({"home": str(b)}, lambda f: True)
        self.addCleanup(r.close)
        self.assertEqual([e["id"] for e in r.hello_frame()["endpoints"]], ["in-b"])
        r2 = S.relay_mod().ModelRelay({}, lambda f: True)
        self.addCleanup(r2.close)
        self.assertEqual([e["id"] for e in r2.hello_frame()["endpoints"]], ["in-a"])


class Hello(S.Base):
    def eps(self, f):
        return [S.ep(f, id="loc", label="Local one"), S.ep("https://api.example.invalid/v1", id="rem",
                                                           kind="remote-openai-compatible", label="Remote one")]

    def test_hello_exact_keys_and_no_leaks(self):
        f = self.fake()
        S.write_store(self.home, self.eps(f), {"rem": S.KEY_CANARY})
        rig = S.RelayRig(self, self.home)
        h = rig.relay.hello_frame()
        self.assertEqual(set(h), {"t", "v", "endpoints"})
        self.assertEqual((h["t"], h["v"]), ("model_hello", 1))
        for e in h["endpoints"]:
            self.assertEqual(set(e), {"id", "kind", "label", "model", "loopback", "has_key", "allow_private"})
        loc, rem = h["endpoints"]
        self.assertEqual((loc["id"], loc["loopback"], loc["has_key"], loc["label"], loc["model"]),
                         ("loc", True, False, "Local one", "m-loc"))
        self.assertEqual((rem["loopback"], rem["has_key"], rem["allow_private"]), (False, True, False))
        raw = json.dumps(h)
        for s in (S.KEY_CANARY, "base_url", str(f.port), "127.0.0.1", "api.example.invalid"):
            self.assertNotIn(s, raw)

    def test_refused_store_gives_empty_list_and_counter(self):
        S.write_store(self.home, self.eps(self.fake()), file_mode=0o644)
        rig = S.RelayRig(self, self.home)
        self.assertEqual(rig.relay.hello_frame()["endpoints"], [])
        self.assertGreaterEqual(rig.relay.stats()["store_refused"], 1)
        self.assertEqual(self.relay_reply(rig, S.probe_frame(id="loc"))["code"], "unknown_endpoint")

    def relay_reply(self, rig, frame):
        return rig.ask(frame)

    def test_missing_store_is_empty_not_refused(self):
        rig = S.RelayRig(self, self.home)
        self.assertEqual(rig.relay.hello_frame()["endpoints"], [])
        self.assertEqual(rig.relay.stats().get("store_refused", 0), 0)

    def test_model_list_rereads_store_and_echoes_rid(self):
        f = self.fake()
        S.write_store(self.home, [S.ep(f, id="one")])
        rig = S.RelayRig(self, self.home)
        S.write_store(self.home, [S.ep(f, id="one"), S.ep(f, id="two")])
        r = rig.ask(S.list_frame("L-1_x"))
        self.assertEqual((r["t"], r["rid"]), ("model_hello", "L-1_x"))
        self.assertEqual(set(r), {"t", "v", "endpoints", "rid"})
        self.assertEqual([e["id"] for e in r["endpoints"]], ["one", "two"])
        self.assertNotIn("rid", rig.relay.hello_frame())

    def test_unknown_endpoint_after_removal_on_disk(self):
        f = self.fake()
        S.write_store(self.home, [S.ep(f)])
        rig = S.RelayRig(self, self.home)
        self.assertEqual(rig.ask(S.probe_frame("a"))["t"], "model_health")
        S.write_store(self.home, [])
        self.assertEqual(rig.ask(S.probe_frame("b"))["code"], "unknown_endpoint")


class Structural(S.Base):
    def rig(self):
        S.write_store(self.home, [S.ep(None)])
        return S.RelayRig(self, self.home)

    def test_valid_frames_return_0_and_other_types_none(self):
        r = self.rig()
        for fr in (S.list_frame(), S.probe_frame(), S.gen(), S.gen(rung=1, schema={"type": "object"}),
                   S.gen(rung=2, schema={"type": "object"}), S.cancel_frame("zzz"),
                   S.gen(messages=[{"role": r_, "content": ""} for r_ in ("system", "user", "assistant")] * 10 + [
                       {"role": "user", "content": "x"}, {"role": "user", "content": "y"}]),
                   S.gen(max_tokens=8192), S.gen(rid="A" * 64), S.probe_frame(id="a" * 32), S.probe_frame(id="0")):
            self.assertEqual(r.relay.handle(fr), 0, fr)
            r.quiet(0.05)
        for other in ({"t": "ping", "v": 1}, {"t": "room_read", "v": 1}, {"t": "bye", "v": 1}, {"t": "resync", "v": 1}):
            self.assertIsNone(r.relay.handle(other), other)

    def test_fatal_shapes(self):
        r = self.rig()
        g = S.gen
        long_msgs = [{"role": "user", "content": "x"}] * 33
        bad = [
            {"t": "model_list", "v": 1}, {"t": "model_list", "v": 1, "rid": "a b"}, {"t": "model_list", "v": 1, "rid": ""},
            {"t": "model_list", "v": 1, "rid": "a" * 65}, {"t": "model_list", "v": 1, "rid": 5},
            {"t": "model_list", "v": 2, "rid": "r"}, {"t": "model_list", "v": "1", "rid": "r"},
            {"t": "model_list", "v": True, "rid": "r"}, {"t": "model_list", "v": 1.0, "rid": "r"},
            {"t": "model_list", "v": 1, "rid": "r", "x": 1}, {"t": "model_list", "rid": "r"},
            {"t": "model_probe", "v": 1, "rid": "r"}, {"t": "model_probe", "v": 1, "rid": "r", "id": "UP"},
            {"t": "model_probe", "v": 1, "rid": "r", "id": "a" * 33}, {"t": "model_probe", "v": 1, "rid": "r", "id": ""},
            {"t": "model_probe", "v": 1, "rid": "r", "id": "-a"}, {"t": "model_probe", "v": 1, "rid": "r", "id": 3},
            {"t": "model_probe", "v": 1, "rid": "r", "id": "a", "extra": 1},
            {"t": "model_cancel", "v": 1}, {"t": "model_cancel", "v": 1, "rid": "r", "id": "a"},
            {"t": "model_cancel", "v": 1, "rid": ["r"]},
            g(tier="secret"), g(tier=None), g(tier=1), g(messages=[]), g(messages=long_msgs), g(messages="hi"),
            g(messages=[{"role": "user"}]), g(messages=[{"role": "user", "content": "x", "name": "n"}]),
            g(messages=[{"role": "tool", "content": "x"}]), g(messages=[{"role": "user", "content": 5}]),
            g(messages=[{"role": "user", "content": None}]), g(messages=["x"]),
            g(max_tokens=0), g(max_tokens=8193), g(max_tokens=True), g(max_tokens="9"), g(max_tokens=1.5),
            g(max_tokens=-1), g(rung=0), g(rung=4), g(rung="2"), g(rung=True), g(rung=1),
            g(rung=1, schema="x"), g(rung=1, schema=[1]), g(rung=2, schema=5), g(extra=1),
            g(id="UP"), g(rid="a b"), g(rid=None),
        ]
        no_rung = g()
        del no_rung["rung"]
        no_tok = g()
        del no_tok["max_tokens"]
        bad += [no_rung, no_tok]
        for fr in bad:
            with self.subTest(frame=json.dumps(fr)[:120]):
                self.assertEqual(r.relay.handle(fr), 2)
        self.assertEqual(r.frames, [])

    def test_wrong_direction_frames_are_not_accepted(self):
        r = self.rig()
        for t in ("model_hello", "model_health", "model_result", "model_nack"):
            self.assertIn(r.relay.handle({"t": t, "v": 1, "rid": "r"}), (None, 2), t)
        self.assertIn(r.relay.handle({"t": "model_nope", "v": 1}), (None, 2))

    def test_handle_and_poll_never_raise(self):
        r = self.rig()
        for junk in ({}, {"t": None}, {"t": 5}, {"t": "model_generate"}, {"t": "model_generate", "v": 1, "messages": 5},
                     {"t": "model_generate", "v": 1, "rid": "r", "id": "fake", "tier": "standard",
                      "messages": [{"role": "user", "content": "x"}], "max_tokens": 5, "rung": 3, "schema": {1, 2}}):
            try:
                self.assertIn(r.relay.handle(junk), (None, 0, 2))
            except Exception as e:
                self.fail("handle raised %r for %r" % (e, junk))
        r.relay.poll()
        r.relay.poll()


class Policy(S.Base):
    def go(self, e, tier, key=None, **gk):
        f = self.fake()
        e = dict(e, base_url=e["base_url"].replace("{port}", str(f.port)))
        S.write_store(self.home, [e], {e["id"]: key} if key else None)
        rig = S.RelayRig(self, self.home)
        return f, rig.ask(S.gen(id=e["id"], tier=tier, **gk))

    REMOTE = dict(S.ep("https://127.0.0.1:{port}/v1", id="rem", kind="remote-openai-compatible"))

    def test_remote_private_shared_and_disabled_policy_zero_requests(self):
        for tier in ("private", "shared"):
            with self.subTest(tier=tier):
                f, r = self.go(self.REMOTE, tier, key="k")
                self.assertEqual((r["t"], r["code"]), ("model_nack", "policy"))
                self.assertEqual((f.conns, f.requests), (0, []))
        f, r = self.go(dict(self.REMOTE, enabled=False), "standard", key="k")
        self.assertEqual(r["code"], "policy")
        self.assertEqual(f.conns, 0)

    def test_local_private_needs_allow_private(self):
        loc = dict(S.ep("http://127.0.0.1:{port}/v1", id="fake"))
        f, r = self.go(loc, "private")
        self.assertEqual(r["code"], "policy")
        self.assertEqual((f.conns, f.requests), (0, []))
        f, r = self.go(dict(loc, allow_private=True), "private")
        self.assertEqual((r["t"], r["text"]), ("model_result", "ok"))
        self.assertEqual(len(f.posts), 1)

    def test_local_disabled_and_local_standard_shared(self):
        loc = dict(S.ep("http://127.0.0.1:{port}/v1", id="fake"))
        f, r = self.go(dict(loc, enabled=False), "standard")
        self.assertEqual(r["code"], "policy")
        self.assertEqual(f.conns, 0)
        for tier in ("standard", "shared"):
            f, r = self.go(loc, tier)
            self.assertEqual(r["t"], "model_result", tier)

    def test_remote_without_key_needs_setup_zero_requests(self):
        f, r = self.go(self.REMOTE, "standard")
        self.assertEqual(r["code"], "needs_setup")
        self.assertEqual(f.conns, 0)

    def test_remote_with_key_tls_failure_is_offline(self):
        f, r = self.go(self.REMOTE, "standard", key="k")
        self.assertEqual(r["code"], "offline")

    def test_probe_states(self):
        f = self.fake()
        S.write_store(self.home, [S.ep(f, id="up"), S.ep(f, id="off", enabled=False),
                                  S.ep("https://127.0.0.1:%d/v1" % f.port, id="nokey", kind="remote-openai-compatible"),
                                  S.ep("http://127.0.0.1:%d/v1" % S.free_port(), id="dead")])
        rig = S.RelayRig(self, self.home)
        got = {i: rig.ask(S.probe_frame("p-" + i, id=i)) for i in ("up", "off", "nokey", "dead")}
        self.assertEqual([got[i]["state"] for i in ("up", "off", "nokey", "dead")],
                         ["available", "blocked", "needs_setup", "offline"])
        for i, h in got.items():
            self.assertEqual(set(h), {"t", "v", "rid", "id", "state", "rung"})
            self.assertEqual((h["t"], h["id"], h["rid"]), ("model_health", i, "p-" + i))
            self.assertIn(h["rung"], (1, 2, 3))
        self.assertEqual(got["up"]["rung"], 2)                           # safe floor
        self.assertEqual(len(f.requests), 1)                              # blocked / needs_setup never connect


class Ladder(S.Base):
    def setUp(self):
        super().setUp()
        self.f = self.fake()

    def rig(self, **epkw):
        S.write_store(self.home, [S.ep(self.f, **epkw)])
        return S.RelayRig(self, self.home)

    def test_rung_bodies(self):
        rig = self.rig()
        schema = {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]}
        self.assertEqual(rig.ask(S.gen("a", rung=1, schema=schema))["t"], "model_result")
        self.assertEqual(rig.ask(S.gen("b", rung=2))["t"], "model_result")
        self.assertEqual(rig.ask(S.gen("c", rung=3))["t"], "model_result")
        b1, b2, b3 = [r["json"] for r in self.f.posts]
        self.assertEqual(b1["response_format"], {"type": "json_schema",
                                                 "json_schema": {"name": "out", "schema": schema, "strict": True}})
        self.assertEqual(b2["response_format"], {"type": "json_object"})
        self.assertNotIn("response_format", b3)
        for b in (b1, b2, b3):
            self.assertEqual((b["model"], b["max_tokens"], b["stream"]), ("m-fake", 64, False))
            self.assertEqual(b["messages"], [{"role": "user", "content": "hello"}])

    def test_400_422_at_rung1_drops_cached_rung(self):
        for status in (400, 422):
            with self.subTest(status=status):
                self.f.reply(status, b'{"error":"no schema"}', get=False)
                rig = self.rig(rung=1)
                self.assertEqual(rig.ask(S.probe_frame("p0"))["rung"], 1)         # store rung
                r = rig.ask(S.gen("g", rung=1, schema={"type": "object"}))
                self.assertEqual((r["t"], r["code"]), ("model_nack", "rung_unsupported"))
                self.assertEqual(rig.ask(S.probe_frame("p1"))["rung"], 2)         # cache dropped to 2

    def test_400_at_other_rungs_is_http_error_and_cache_untouched(self):
        self.f.reply(400, b"{}", get=False)
        rig = self.rig(rung=3)
        for rung in (2, 3):
            self.assertEqual(rig.ask(S.gen("g%d" % rung, rung=rung))["code"], "http_error")
        self.assertEqual(rig.ask(S.probe_frame())["rung"], 3)

    def test_code_mapping_through_relay(self):
        rig = self.rig()
        table = ((401, "auth"), (403, "auth"), (429, "rate_limited"), (500, "http_error"), (404, "http_error"))
        for st, code in table:
            self.f.reply(st, b"{}", get=False)
            self.assertEqual(rig.ask(S.gen("g%d" % st))["code"], code, st)
        for st in (301, 302, 307):
            self.f.reply(st, b"", headers={"Location": "http://127.0.0.1:%d/x" % S.free_port()}, get=False)
            self.assertEqual(rig.ask(S.gen("g%d" % st))["code"], "redirect")
        self.f.reply(200, b"not json", get=False)
        self.assertEqual(rig.ask(S.gen("bad"))["code"], "bad_reply")
        self.f.reply(200, b"x" * ((1 << 20) + 10), get=False)
        self.assertEqual(rig.ask(S.gen("big"))["code"], "bad_reply")

    def test_probe_failure_maps_to_health_not_nack(self):
        rig = self.rig()
        self.f.reply(401, b"{}", post=False)
        h = rig.ask(S.probe_frame("pa"))
        self.assertEqual(h["t"], "model_health")
        self.assertNotEqual(h["state"], "available")
        self.f.reply(302, b"", headers={"Location": "http://127.0.0.1:%d/x" % S.free_port()}, post=False)
        h = rig.ask(S.probe_frame("pb"))
        self.assertEqual(h["t"], "model_health")
        self.assertNotEqual(h["state"], "available")

    def test_probe_redirect_second_server_untouched(self):
        other = self.fake()
        self.f.reply(302, b"", headers={"Location": other.base_url + "/models"})
        rig = self.rig()
        self.assertNotEqual(rig.ask(S.probe_frame())["state"], "available")
        rig.ask(S.gen("g"))
        self.assertEqual((other.conns, other.requests), (0, []))


class Caps(S.Base):
    def rig(self, fake, **kw):
        S.write_store(self.home, [S.ep(fake)])
        return S.RelayRig(self, self.home, **kw)

    def test_request_body_cap_48kib_exact(self):
        f = self.fake()
        rig = self.rig(f)

        def msg(n):
            return S.gen("c%d" % n, messages=[{"role": "user", "content": "a" * n}])
        self.assertEqual(rig.ask(msg(1000))["t"], "model_result")
        overhead = len(f.posts[0]["body"]) - 1000
        n_ok = 49152 - overhead
        self.assertEqual(rig.ask(msg(n_ok))["t"], "model_result")
        self.assertEqual(len(f.posts[-1]["body"]), 49152)
        before = len(f.requests)
        r = rig.ask(msg(n_ok + 1))
        self.assertEqual((r["t"], r["code"]), ("model_nack", "too_large"))
        self.assertEqual(len(f.requests), before, "nothing sent")

    def test_model_result_cap_exact(self):
        f = self.fake()
        rid = "cap"
        base = len(json.dumps({"t": "model_result", "v": 1, "rid": rid, "text": ""}, separators=(",", ":")).encode())
        fit = 65536 - base
        rig = self.rig(f)
        f.content = "a" * fit
        r = rig.ask(S.gen(rid))
        self.assertEqual(r["t"], "model_result")
        self.assertEqual(len(json.dumps(r, separators=(",", ":"), ensure_ascii=False).encode()), 65536)
        self.assertEqual(r["text"], "a" * fit)
        f.content = "a" * (fit + 1)
        rig.frames.clear()
        r = rig.ask(S.gen(rid))
        self.assertEqual((r["t"], r["code"]), ("model_nack", "reply_too_large"))

    def test_result_counts_utf8_bytes_not_chars(self):
        f = self.fake()
        rig = self.rig(f)
        f.content = "é" * 40000                                          # 40k chars = 80k bytes
        self.assertEqual(rig.ask(S.gen("u"))["code"], "reply_too_large")

    def test_result_text_verbatim(self):
        f = self.fake()
        rig = self.rig(f)
        f.content = ' {"a": 1}\n\t"q"   ☃ '
        self.assertEqual(rig.ask(S.gen("v"))["text"], f.content)


class Timeouts(S.Base):
    def test_generate_and_probe_budgets_injected(self):
        f = self.fake()
        f.reply(200, S.chat_body("x"), delay=2.5)
        S.write_store(self.home, [S.ep(f)])
        rig = S.RelayRig(self, self.home, timeouts={"probe_ms": 200, "local_generate_ms": 300, "remote_generate_ms": 300})
        t0 = time.monotonic()
        self.assertEqual(rig.ask(S.gen("t"))["code"], "timeout")
        self.assertLess(time.monotonic() - t0, 1.5)
        t0 = time.monotonic()
        h = rig.ask(S.probe_frame())
        self.assertEqual((h["t"], h["state"]), ("model_health", "offline"))
        self.assertLess(time.monotonic() - t0, 1.5)

    def test_default_budgets_are_the_frozen_targets(self):
        seen = []
        tr = S.FakeTransport(probe=lambda e, k, t: seen.append(("probe", t)),
                             generate=lambda e, k, b, dl, c: seen.append(("gen", dl - time.monotonic())) or "ok")
        S.write_store(self.home, [S.ep(None, id="loc", base_url="http://127.0.0.1:9/v1")])
        rig = S.RelayRig(self, self.home, transport=tr)
        rig.ask(S.probe_frame("p", id="loc"))
        rig.ask(S.gen("g", id="loc"))
        (_, pt), (_, gd) = seen
        self.assertAlmostEqual(pt, 1.5, delta=0.05)
        self.assertTrue(29.0 < gd <= 30.0, gd)

    def test_remote_budget_is_60s(self):
        seen = []
        tr = S.FakeTransport(generate=lambda e, k, b, dl, c: seen.append(dl - time.monotonic()) or "ok")
        S.write_store(self.home, [S.ep("https://api.example.invalid/v1", id="rem", kind="remote-openai-compatible")],
                      {"rem": "k"})
        rig = S.RelayRig(self, self.home, transport=tr)
        self.assertEqual(rig.ask(S.gen("g", id="rem"))["t"], "model_result")
        self.assertTrue(59.0 < seen[0] <= 60.0, seen)
        self.assertEqual(tr.calls[0][2], "k")                           # key handed to the transport only


class Flight(S.Base):
    def slow(self, delay=2.0):
        f = self.fake()
        f.reply(200, S.chat_body("late"), delay=delay)
        S.write_store(self.home, [S.ep(f)])
        return f, S.RelayRig(self, self.home)

    def test_busy_and_exactly_one_reply_each(self):
        f, rig = self.slow(1.0)
        self.assertEqual(rig.relay.handle(S.gen("first")), 0)
        self.assertTrue(f.wait_requests(1))
        self.assertEqual(rig.relay.handle(S.gen("second")), 0)
        self.assertEqual(rig.relay.handle(S.probe_frame("third")), 0)
        b2 = rig.pump(lambda x: x.get("rid") == "second", 1.0)
        b3 = rig.pump(lambda x: x.get("rid") == "third", 1.0)
        self.assertEqual((b2["t"], b2["code"]), ("model_nack", "busy"))
        self.assertEqual((b3["t"], b3["code"]), ("model_nack", "busy"))
        r1 = rig.pump(lambda x: x.get("rid") == "first", 4.0)
        self.assertEqual(r1["t"], "model_result")
        rig.quiet(0.2)
        for rid in ("first", "second", "third"):
            self.assertEqual(len([x for x in rig.frames if x.get("rid") == rid]), 1, rid)
        self.assertEqual(len(f.posts), 1)

    def test_free_again_after_completion(self):
        f, rig = self.slow(0.2)
        self.assertEqual(rig.ask(S.gen("a"))["t"], "model_result")
        self.assertEqual(rig.ask(S.gen("b"))["t"], "model_result")

    def test_poll_never_blocks_while_in_flight(self):
        f, rig = self.slow(1.5)
        rig.relay.handle(S.gen("a"))
        f.wait_requests(1)
        worst = 0.0
        for _ in range(20):
            t0 = time.monotonic()
            rig.relay.poll()
            worst = max(worst, time.monotonic() - t0)
            time.sleep(0.02)
        self.assertLess(worst, 0.1)

    def test_handle_returns_immediately(self):
        f, rig = self.slow(1.5)
        t0 = time.monotonic()
        rig.relay.handle(S.gen("a"))
        self.assertLess(time.monotonic() - t0, 0.2)

    def test_results_are_sent_only_from_poll(self):
        f = self.fake()
        S.write_store(self.home, [S.ep(f)])
        rig = S.RelayRig(self, self.home)
        rig.relay.handle(S.gen("a"))
        time.sleep(0.6)                                                   # worker is done; poll not yet called
        self.assertEqual([x for x in rig.frames if x.get("rid") == "a"], [], "worker thread must not send")
        rig.pump(lambda x: x.get("rid") == "a", 2.0)
        self.assertEqual(len([x for x in rig.frames if x.get("rid") == "a"]), 1)
        self.assertEqual(set(rig.senders), {threading.current_thread()})

    def test_cancel_in_flight(self):
        f, rig = self.slow(2.0)
        rig.relay.handle(S.gen("a"))
        self.assertTrue(f.wait_requests(1))
        t0 = time.monotonic()
        self.assertEqual(rig.relay.handle(S.cancel_frame("a")), 0)
        n = rig.pump(lambda x: x.get("rid") == "a", 1.0)
        self.assertIsNotNone(n)
        self.assertLessEqual(time.monotonic() - t0, 1.0)
        self.assertEqual((n["t"], n["code"]), ("model_nack", "cancelled"))
        end = time.monotonic() + 2.6                                      # past the fake's 2 s delay
        while time.monotonic() < end:
            rig.relay.poll()
            time.sleep(0.02)
        self.assertEqual([x["t"] for x in rig.frames if x.get("rid") == "a"], ["model_nack"])

    def test_cancel_unknown_or_finished_rid_is_silent(self):
        f = self.fake()
        S.write_store(self.home, [S.ep(f)])
        rig = S.RelayRig(self, self.home)
        self.assertEqual(rig.relay.handle(S.cancel_frame("nobody")), 0)
        rig.ask(S.gen("done"))
        n = len(rig.frames)
        self.assertEqual(rig.relay.handle(S.cancel_frame("done")), 0)
        rig.quiet(0.3)
        self.assertEqual(len(rig.frames), n)

    def test_cancel_of_other_rid_does_not_cancel_current(self):
        f, rig = self.slow(0.8)
        rig.relay.handle(S.gen("a"))
        f.wait_requests(1)
        rig.relay.handle(S.cancel_frame("zzz"))
        self.assertEqual(rig.pump(lambda x: x.get("rid") == "a", 4.0)["t"], "model_result")

    def test_transport_crash_becomes_a_nack_and_frees_the_slot(self):
        calls = []

        def g(e, k, b, dl, c):
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError(S.KEY_CANARY + S.PROMPT_CANARY)
            return "fine"
        S.write_store(self.home, [S.ep(None, id="fake", base_url="http://127.0.0.1:9/v1")])
        rig = S.RelayRig(self, self.home, transport=S.FakeTransport(generate=g))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            n = rig.ask(S.gen("a"))
            self.assertEqual(n["t"], "model_nack")
            self.assertIn(n["code"], S.NACKS)
            self.assertEqual(rig.ask(S.gen("b"))["text"], "fine")
        self.assertNotIn(S.KEY_CANARY, err.getvalue() + json.dumps(rig.frames))
        self.assertNotIn(S.PROMPT_CANARY, err.getvalue() + json.dumps(rig.frames))

    def test_close_is_prompt_with_request_in_flight_and_threads_are_daemon(self):
        f, rig = self.slow(5.0)
        before = set(threading.enumerate())
        rig.relay.handle(S.gen("a"))
        f.wait_requests(1)
        new = set(threading.enumerate()) - before
        self.assertTrue(new, "a worker thread is expected")
        self.assertTrue(all(t.daemon for t in new))
        t0 = time.monotonic()
        rig.relay.close()
        self.assertLess(time.monotonic() - t0, 1.5)


class Privacy(S.Base):
    LINE = re.compile(r"^models (model_probe|model_generate) id=[a-z0-9-]+ status=\S+ ms=\d+$")

    def test_log_lines_and_canaries(self):
        f = self.fake()
        S.write_store(self.home, [S.ep(f)], {"fake": S.KEY_CANARY})
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rig = S.RelayRig(self, self.home)
            f.content = S.REPLY_CANARY
            rig.ask(S.probe_frame("p1"))
            ok = rig.ask(S.gen("g1", messages=[{"role": "user", "content": S.PROMPT_CANARY}]))
            f.reply(500, ("err " + S.KEY_CANARY + S.PROMPT_CANARY).encode())
            rig.ask(S.gen("g2", messages=[{"role": "user", "content": S.PROMPT_CANARY}]))
            f.reply(401, b"{}")
            rig.ask(S.gen("g3"))
            rig.ask(S.probe_frame("p2"))
            rig.ask(S.gen("g4", id="nope"))
            rig.relay.stats()
        self.assertEqual(ok["text"], S.REPLY_CANARY)
        log = err.getvalue()
        wire = json.dumps(rig.frames)
        for canary in (S.KEY_CANARY, S.PROMPT_CANARY):
            self.assertNotIn(canary, log)
            self.assertNotIn(canary, wire)
        self.assertNotIn(S.REPLY_CANARY, log)
        for needle in (str(f.port), "127.0.0.1", "http://", "bearer", "authorization"):
            self.assertNotIn(needle, log.lower())
        for line in log.splitlines():
            self.assertRegex(line, self.LINE)
        ids = [l.split()[1] for l in log.splitlines()]
        self.assertGreaterEqual(ids.count("model_generate"), 3)           # g1..g3; g4 (unknown id) may log or not
        self.assertEqual(wire.count(S.REPLY_CANARY), 1)                   # only in the one model_result

    def test_key_reaches_the_fake_as_bearer_only(self):
        f = self.fake()
        S.write_store(self.home, [S.ep(f)], {"fake": S.KEY_CANARY})
        rig = S.RelayRig(self, self.home)
        rig.ask(S.probe_frame("p"))
        rig.ask(S.gen("g"))
        self.assertTrue(all(r["headers"]["authorization"] == "Bearer " + S.KEY_CANARY for r in f.requests))
        self.assertTrue(all(S.KEY_CANARY.encode() not in r["body"] for r in f.requests))

    def test_stats_counters_exist(self):
        f = self.fake()
        S.write_store(self.home, [S.ep(f)])
        rig = S.RelayRig(self, self.home)
        rig.ask(S.gen("g"))
        st = rig.relay.stats()
        self.assertIsInstance(st, dict)
        self.assertIn("store_refused", st)
        self.assertTrue(all(isinstance(v, int) for v in st.values()))
        self.assertNotIn(S.PROMPT_CANARY, json.dumps(st))
