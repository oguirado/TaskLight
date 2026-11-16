"""transport.py against loopback fakes: pinned loopback, redirects, error mapping, caps, deadline, cancel."""
import json, socket, threading, time
from . import support as S
from bridge.models import transport as T


def body(content="hi", **kw):
    b = {"model": "m-fake", "messages": [{"role": "user", "content": content}], "max_tokens": 16}
    b.update(kw)
    return b


class Base(S.Base):
    def gen(self, fake, key=None, b=None, secs=5.0, cancel=None, resolver=None, **epkw):
        e = S.ep(fake, **epkw)
        return T.generate(e, key, b or body(), time.monotonic() + secs, cancel or threading.Event(),
                          resolver=resolver)

    def prb(self, fake, key=None, secs=2.0, resolver=None, **epkw):
        return T.probe(S.ep(fake, **epkw), key, secs, resolver=resolver)

    def code(self, fn):
        with self.assertRaises(T.TransportError) as cm:
            fn()
        return cm.exception


class Wire(Base):
    def test_probe_get_models_and_generate_post(self):
        f = self.fake()
        f.content = "héllo  \n wörld "
        self.prb(f)
        out = self.gen(f)
        self.assertEqual(out, "héllo  \n wörld ")                       # verbatim
        g, p = f.requests
        self.assertEqual((g["method"], g["path"]), ("GET", "/v1/models"))
        self.assertEqual((p["method"], p["path"]), ("POST", "/v1/chat/completions"))
        self.assertIn("application/json", p["headers"]["content-type"])
        self.assertIs(p["json"]["stream"], False)
        self.assertEqual(p["json"]["messages"], body()["messages"])
        self.assertEqual(p["json"]["max_tokens"], 16)

    def test_authorization_only_when_key(self):
        f = self.fake()
        self.gen(f)
        self.prb(f)
        self.assertTrue(all("authorization" not in r["headers"] for r in f.requests))
        self.gen(f, key=S.KEY_CANARY)
        self.prb(f, key=S.KEY_CANARY)
        for r in f.requests[2:]:
            self.assertEqual(r["headers"]["authorization"], "Bearer " + S.KEY_CANARY)

    def test_errors_never_carry_key_or_prompt(self):
        f = self.fake()
        f.reply(500, b"nope " + S.KEY_CANARY.encode())
        e = self.code(lambda: self.gen(f, key=S.KEY_CANARY, b=body(S.PROMPT_CANARY)))
        for s in (str(e), repr(e), repr(e.args)):
            self.assertNotIn(S.KEY_CANARY, s)
            self.assertNotIn(S.PROMPT_CANARY, s)

    def test_pinned_resolution_keeps_host_header(self):
        f = self.fake()
        calls = []

        def res(host, port, *a, **k):
            calls.append(host)
            return S.resolver_to("127.0.0.1")(host, port)
        e = S.ep("http://localhost:%d/v1" % f.port)
        T.probe(e, None, 2.0, resolver=res)
        self.assertEqual(f.requests[0]["headers"]["host"], "localhost:%d" % f.port)
        self.assertEqual(calls, ["localhost"], "exactly one resolution per request (pinned, no re-resolve)")
        T.generate(e, None, body(), time.monotonic() + 3, threading.Event(), resolver=res)
        self.assertEqual(calls, ["localhost", "localhost"])


class Loopback(Base):
    def test_check_loopback(self):
        self.assertEqual(T.check_loopback("localhost", 80, resolver=S.resolver_to("127.0.0.1")), ["127.0.0.1"])
        e = self.code(lambda: T.check_loopback("x.invalid", 80, resolver=S.resolver_to(S.NOT_LOOPBACK)))
        self.assertEqual(e.code, "not_loopback")
        e = self.code(lambda: T.check_loopback("x.invalid", 80, resolver=S.resolver_to("127.0.0.1", S.NOT_LOOPBACK)))
        self.assertEqual(e.code, "not_loopback")

    def test_non_loopback_never_connects_probe_and_generate(self):
        f = self.fake()
        e = S.ep("http://fake.invalid:%d/v1" % f.port)
        res = S.resolver_to(S.NOT_LOOPBACK)
        self.assertEqual(self.code(lambda: T.probe(e, None, 2.0, resolver=res)).code, "not_loopback")
        self.assertEqual(self.code(lambda: T.generate(e, None, body(), time.monotonic() + 3, threading.Event(),
                                                      resolver=res)).code, "not_loopback")
        self.assertEqual((f.conns, f.requests), (0, []))

    def test_mixed_result_refused_even_when_loopback_first(self):
        f = self.fake()
        e = S.ep("http://mixed.invalid:%d/v1" % f.port)
        for order in (("127.0.0.1", S.NOT_LOOPBACK), (S.NOT_LOOPBACK, "127.0.0.1")):
            res = S.resolver_to(*order)
            self.assertEqual(self.code(lambda: T.probe(e, None, 2.0, resolver=res)).code, "not_loopback")
        self.assertEqual(f.conns, 0)

    def test_remote_http_refused_before_connect(self):
        f = self.fake()
        e = S.ep(f, kind="remote-openai-compatible")                     # http:// remote
        self.code(lambda: T.probe(e, "k", 2.0))
        self.code(lambda: T.generate(e, "k", body(), time.monotonic() + 3, threading.Event()))
        self.assertEqual(f.conns, 0)

    def test_remote_tls_failure_is_offline(self):
        f = self.fake()                                                 # plain HTTP listener answering a TLS client
        e = S.ep("https://127.0.0.1:%d/v1" % f.port, kind="remote-openai-compatible")
        self.assertEqual(self.code(lambda: T.probe(e, "k", 2.0)).code, "offline")
        self.assertEqual(self.code(lambda: T.generate(e, "k", body(), time.monotonic() + 3, threading.Event())).code,
                         "offline")


class Redirect(Base):
    def test_3xx_never_followed(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                other = self.fake()
                f = self.fake()
                f.reply(status, b"", headers={"Location": other.base_url + "/models"})
                self.assertEqual(self.code(lambda: self.prb(f)).code, "redirect")
                self.assertEqual(self.code(lambda: self.gen(f)).code, "redirect")
                self.assertEqual((other.conns, other.requests), (0, []))
                self.assertEqual(len(f.requests), 2)


class Mapping(Base):
    def test_status_mapping(self):
        f = self.fake()
        for status, code in ((401, "auth"), (403, "auth"), (429, "rate_limited"), (500, "http_error"),
                             (503, "http_error"), (404, "http_error"), (418, "http_error")):
            with self.subTest(status=status):
                f.reply(status, b'{"error":"x"}')
                e = self.code(lambda: self.gen(f))
                self.assertEqual((e.code, e.status), (code, status))
                self.assertEqual(self.code(lambda: self.prb(f)).code, code)

    def test_400_422_carry_status_for_the_ladder(self):
        f = self.fake()
        for status in (400, 422):
            f.reply(status, b"{}")
            e = self.code(lambda: self.gen(f))
            self.assertEqual(e.status, status)
            self.assertIn(e.code, ("http_error", "rung_unsupported"))

    def test_bad_reply(self):
        f = self.fake()
        for raw in (b"not json", b"{}", b'{"choices":[]}', b'{"choices":[{}]}', b'{"choices":[{"message":{}}]}',
                    b'{"choices":[{"message":{"content":null}}]}', b'{"choices":[{"message":{"content":5}}]}',
                    b'{"choices":"x"}', b"[]", b""):
            with self.subTest(raw=raw):
                f.reply(200, raw)
                self.assertEqual(self.code(lambda: self.gen(f)).code, "bad_reply")

    def test_reply_cap_one_mib(self):
        f = self.fake()
        f.content = "a" * 900000
        self.assertEqual(len(self.gen(f)), 900000)
        f.content = "a" * (1 << 20)                                      # body now > 1 MiB
        self.assertEqual(self.code(lambda: self.gen(f)).code, "bad_reply")

    def test_offline_cases(self):
        e = S.ep("http://127.0.0.1:%d/v1" % S.free_port())
        self.assertEqual(self.code(lambda: T.probe(e, None, 2.0)).code, "offline")
        self.assertEqual(self.code(lambda: T.generate(e, None, body(), time.monotonic() + 3, threading.Event())).code,
                         "offline")

        def boom(*a, **k):
            raise socket.gaierror(-2, "x")
        self.assertEqual(self.code(lambda: T.probe(e, None, 2.0, resolver=boom)).code, "offline")
        self.assertEqual(self.code(lambda: T.probe(e, None, 2.0, resolver=lambda *a, **k: [])).code, "offline")


class Timing(Base):
    def test_generate_deadline(self):
        f = self.fake()
        f.reply(200, S.chat_body("x"), delay=3.0)
        t0 = time.monotonic()
        e = self.code(lambda: self.gen(f, secs=0.4))
        self.assertEqual(e.code, "timeout")
        self.assertLess(time.monotonic() - t0, 1.5)

    def test_probe_timeout(self):
        f = self.fake()
        f.reply(200, b"{}", delay=3.0)
        t0 = time.monotonic()
        self.assertEqual(self.code(lambda: self.prb(f, secs=0.3)).code, "timeout")
        self.assertLess(time.monotonic() - t0, 1.5)

    def test_expired_deadline_does_not_connect(self):
        f = self.fake()
        e = self.code(lambda: self.gen(f, secs=-1.0))
        self.assertEqual(e.code, "timeout")
        self.assertEqual(f.conns, 0)

    def test_cancel_aborts_within_a_second(self):
        f = self.fake()
        f.reply(200, S.chat_body("x"), delay=3.0)
        ev = threading.Event()
        threading.Timer(0.3, ev.set).start()
        t0 = time.monotonic()
        e = self.code(lambda: self.gen(f, secs=10, cancel=ev))
        self.assertEqual(e.code, "cancelled")
        self.assertLess(time.monotonic() - t0, 1.5)
