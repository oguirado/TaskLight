"""U48 repair loop 2 (A-U48r2): bounded resolver helpers, unpaired surrogates in stored labels / outbound frames.
Loopback-only fakes, tmp CW_HOME, stdlib only."""
import io, json, struct, threading, time
from . import support as S
from bridge.models import store as ST
from bridge.models import transport as T
from bridge.wall import native_host as nh

SLACK = 0.6
BOUND = 2                                   # documented bound on outstanding resolver helpers
HELPER = "model-transport-resolve"
LONE = "\ud800"


def _helpers():
    return [t for t in threading.enumerate() if t.name == HELPER and t.is_alive()]


def _body():
    return {"model": "m-fake", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 16}


# ---------------------------------------------------------------- 1. resolver helper bound
class ResolverBound(S.Base):
    def test_twenty_never_returning_resolutions_stay_bounded(self):
        ev = threading.Event()
        self.addCleanup(ev.set)

        def hang(host, port, *a, **k):
            ev.wait()
            return []
        e = S.ep("http://fake.invalid:9/v1")
        peak = 0
        for i in range(20):
            t0 = time.monotonic()
            with self.assertRaises(T.TransportError) as cm:
                if i % 2:
                    T.probe(e, None, 0.1, resolver=hang)
                else:
                    T.generate(e, None, _body(), time.monotonic() + 0.1, threading.Event(), resolver=hang)
            self.assertEqual(cm.exception.code, "timeout")
            self.assertLess(time.monotonic() - t0, 0.1 + SLACK)
            peak = max(peak, len(_helpers()))
            self.assertLessEqual(len(_helpers()), BOUND, "call %d" % i)
        self.assertLessEqual(peak, BOUND)
        # releasing the hung resolvers frees the slots: a normal request is served again
        ev.set()
        end = time.monotonic() + 2.0
        while _helpers() and time.monotonic() < end:
            time.sleep(0.01)
        self.assertEqual(_helpers(), [])
        f = self.fake()
        T.probe(S.ep(f), None, 2.0, resolver=S.resolver_to("127.0.0.1"))
        self.assertEqual(T.check_loopback("x.invalid", 9, resolver=S.resolver_to("127.0.0.1")), ["127.0.0.1"])


# ---------------------------------------------------------------- 2. surrogate in the stored label
class SurrogateStore(S.Base):
    def test_validate_rejects_lone_surrogates(self):
        for field in ("label", "model"):
            with self.subTest(field=field):
                e = S.ep(None)
                e[field] = "x" + LONE
                with self.assertRaises(ValueError):
                    ST.validate_endpoint(e)

    def test_load_never_serves_a_surrogate_endpoint(self):
        S.write_store(self.home, [S.ep(None, id="bad", label=LONE), S.ep(None, id="good")])
        st = ST.load(str(self.home))
        self.assertNotIn("bad", [e["id"] for e in st["endpoints"]])
        for e in st["endpoints"]:
            json.dumps(e, ensure_ascii=False).encode("utf-8")

    def test_host_sends_hello_then_valid_model_hello(self):
        h = self.host(endpoints=[S.ep(None, id="bad", label=LONE), S.ep(None, id="good")])
        f = h.read_frame()
        self.assertEqual(f["t"], "hello")
        f, _ = h.read_until(lambda f: f["t"] == "model_hello", timeout=3.0)
        self.assertIsInstance(f["endpoints"], list)
        for e in f["endpoints"]:
            self.assertNotEqual(e["id"], "bad")
        h.err.seek(0)
        self.assertNotIn(b"unencodable", h.err.read())


# ---------------------------------------------------------------- 3. outbound serialization fallback
class SendFallback(S.Base):
    def _host(self, out):
        cfg = S.W.make_config(self.tmp)
        return nh._Host(json.loads(open(cfg).read()), out, io.StringIO())

    def test_lone_surrogate_frame_is_delivered_escaped(self):
        out = io.BytesIO()
        host = self._host(out)
        self.assertTrue(host._send({"t": "x", "v": 1, "s": "a" + LONE + "é"}))
        raw = out.getvalue()
        n = struct.unpack("<I", raw[:4])[0]
        self.assertEqual(n, len(raw) - 4)
        body = raw[4:]
        body.decode("ascii")
        self.assertIn(b"\\ud800", body)
        self.assertEqual(json.loads(body)["s"], "a" + LONE + "é")

    def test_escaped_fallback_counts_the_escaped_bytes(self):
        out = io.BytesIO()
        host = self._host(out)
        # 11,000 lone surrogates: 33,000 chars-ish raw, 66,000 bytes once escaped (> 65,536)
        self.assertFalse(host._send({"t": "x", "v": 1, "s": LONE * 11000}))
        self.assertEqual(out.getvalue(), b"")

    def test_plain_frames_keep_utf8_green_control(self):
        out = io.BytesIO()
        host = self._host(out)
        self.assertTrue(host._send({"t": "x", "v": 1, "s": "é"}))
        self.assertIn("é".encode("utf-8"), out.getvalue())
