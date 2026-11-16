"""bridge/wall/native_host.py changes, driven in-process with fakes (spec 'native_host.py changes')."""
import contextlib, importlib, inspect, io, json, os, struct, threading, time
from unittest import mock
from . import support as S

nh = importlib.import_module("bridge.wall.native_host")


class Dummy:
    def __init__(self):
        self.resynced = 0

    def resync(self):
        self.resynced += 1


class Rel:
    def __init__(self, ret=None, exc=None):
        self.ret, self.exc, self.seen = ret, exc, []

    def handle(self, obj):
        self.seen.append(obj)
        if self.exc:
            raise self.exc
        return self.ret


def body(o):
    return json.dumps(o).encode()


MF = {"t": "model_probe", "v": 1, "rid": "r", "id": "a"}


class HandleFrame(S.Base):
    def test_old_positional_signature_still_works_green_control(self):
        rr = Rel(ret=0)
        self.assertIsNone(nh._handle_frame(Dummy(), body({"t": "room_read", "v": 1}), rr))
        self.assertEqual(len(rr.seen), 1)
        self.assertEqual(nh._handle_frame(Dummy(), body({"t": "bye", "v": 1})), 0)
        self.assertEqual(nh._handle_frame(Dummy(), body(MF)), 2)           # no relay at all: fatal as before

    def test_signature(self):
        self.assertEqual(list(inspect.signature(nh._handle_frame).parameters), ["host", "body", "relay", "model_relay"])
        self.assertEqual(list(inspect.signature(nh._process_buffer).parameters)[:3], ["host", "buf", "relay"])
        self.assertIn("model_relay", inspect.signature(nh._process_buffer).parameters)

    def test_model_frames_go_to_model_relay_only(self):
        m, r = Rel(ret=0), Rel(ret=0)
        self.assertIsNone(nh._handle_frame(Dummy(), body(MF), r, m))
        self.assertEqual((m.seen, r.seen), ([MF], []))
        self.assertIsNone(nh._handle_frame(Dummy(), body({"t": "room_read", "v": 1}), r, m))
        self.assertEqual(len(m.seen), 1)
        self.assertEqual(len(r.seen), 1)
        self.assertIsNone(nh._handle_frame(Dummy(), body({"t": "ping", "v": 1}), r, m))
        self.assertEqual((len(m.seen), len(r.seen)), (1, 1))

    def test_return_value_contract(self):
        self.assertEqual(nh._handle_frame(Dummy(), body(MF), None, Rel(ret=None)), 2)      # falls through to strict check
        self.assertEqual(nh._handle_frame(Dummy(), body(MF), None, Rel(ret=2)), 2)
        self.assertIsNone(nh._handle_frame(Dummy(), body(MF), None, Rel(ret=0)))           # handled; 0 is not a bye
        self.assertIsNone(nh._handle_frame(Dummy(), body(MF), None, Rel(exc=RuntimeError("x"))))
        with self.assertRaises(BrokenPipeError):
            nh._handle_frame(Dummy(), body(MF), None, Rel(exc=BrokenPipeError()))

    def test_no_model_relay_leaves_model_frames_fatal(self):
        self.assertEqual(nh._handle_frame(Dummy(), body(MF), Rel(ret=0), None), 2)
        self.assertEqual(nh._handle_frame(Dummy(), body({"t": "model_list", "v": 1}), None, None), 2)

    def test_only_model_prefix_is_routed(self):
        m = Rel(ret=0)
        for t in ("modelx", "xmodel_probe", "MODEL_probe", "models_list"):
            nh._handle_frame(Dummy(), body({"t": t, "v": 1}), None, m)
        self.assertEqual(m.seen, [])

    def test_process_buffer_passes_it_through(self):
        m = Rel(ret=0)
        buf = bytearray(struct.pack("<I", len(body(MF))) + body(MF))
        self.assertIsNone(nh._process_buffer(Dummy(), buf, None, m))
        self.assertEqual((len(buf), m.seen), (0, [MF]))
        bye = body({"t": "bye", "v": 1})
        buf = bytearray(struct.pack("<I", len(body(MF))) + body(MF) + struct.pack("<I", len(bye)) + bye)
        self.assertEqual(nh._process_buffer(Dummy(), buf, None, m), 0)


class Send(S.Base):
    def test_send_lock_held_around_the_write(self):
        held = []

        class Out:
            def write(s, b):
                held.append(host._send_lock.locked())
                return len(b)

            def flush(s):
                held.append(host._send_lock.locked())
        cfg = S.W.make_config(self.tmp)
        host = nh._Host(json.loads(open(cfg).read()), Out(), io.StringIO())
        self.assertTrue(hasattr(host._send_lock, "acquire") and hasattr(host._send_lock, "release"))
        self.assertTrue(host._send({"t": "x", "v": 1}))
        self.assertTrue(held and all(held), held)
        self.assertFalse(host._send_lock.locked())

    def test_concurrent_sends_never_interleave(self):
        chunks = []

        class Out:
            def write(s, b):
                chunks.append(("w", len(b)))
                time.sleep(0.001)
                return len(b)

            def flush(s):
                time.sleep(0.001)
        cfg = S.W.make_config(self.tmp)
        host = nh._Host(json.loads(open(cfg).read()), Out(), io.StringIO())
        self.assertTrue(hasattr(host, "_send_lock"))
        depth, worst = [0], [0]
        orig = host._send_lock

        class Probe:
            def __enter__(s):
                orig.acquire()
                depth[0] += 1
                worst[0] = max(worst[0], depth[0])

            def __exit__(s, *a):
                depth[0] -= 1
                orig.release()
        host._send_lock = Probe()
        ts = [threading.Thread(target=lambda: [host._send({"t": "x", "v": 1}) for _ in range(20)]) for _ in range(6)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(worst[0], 1)
        self.assertEqual(len(chunks), 120)

    def test_oversize_frame_still_dropped_green_control(self):
        out = io.BytesIO()
        cfg = S.W.make_config(self.tmp)
        host = nh._Host(json.loads(open(cfg).read()), out, io.StringIO())
        self.assertFalse(host._send({"t": "x", "v": 1, "pad": "a" * 70000}))
        self.assertEqual(out.getvalue(), b"")


class Build(S.Base):
    def test_build_model_relay_gated(self):
        for cfg in ({"v": 1}, {"models": []}, {"models": "x"}, {"models": {"home": 3}}, {"models": {"junk": 1}}):
            self.assertIsNone(nh._build_model_relay(cfg, lambda f: True), cfg)

    def test_build_model_relay_with_models(self):
        sent = []
        r = nh._build_model_relay({"models": {"home": str(self.home)}}, sent.append)
        self.assertIsNotNone(r)
        self.addCleanup(r.close)
        self.assertEqual(r.hello_frame()["t"], "model_hello")

    def test_build_never_raises_and_import_failure_is_none(self):
        with mock.patch.object(nh, "ModelRelay", side_effect=RuntimeError("boom"), create=True):
            self.assertIsNone(nh._build_model_relay({"models": {}}, lambda f: True))
        with mock.patch.object(nh, "ModelRelay", None, create=True), \
                mock.patch.object(nh, "load_model_config", None, create=True), \
                mock.patch.dict("sys.modules", {"bridge.wall.model_relay": None}):
            self.assertIsNone(nh._build_model_relay({"models": {}}, lambda f: True))

    def test_model_poll(self):
        nh._model_poll(None)
        class P:
            def __init__(s, e=None): s.n, s.e = 0, e
            def poll(s):
                s.n += 1
                if s.e: raise s.e
        p = P()
        nh._model_poll(p)
        self.assertEqual(p.n, 1)
        nh._model_poll(P(RuntimeError("x")))
        with self.assertRaises(BrokenPipeError):
            nh._model_poll(P(BrokenPipeError()))


class FakeModelRelay:
    def __init__(self):
        self.events, self.handled = [], []

    def hello_frame(self):
        self.events.append("hello_frame")
        return {"t": "model_hello", "v": 1, "endpoints": []}

    def handle(self, obj):
        self.handled.append(obj)
        return 0

    def poll(self):
        self.events.append("poll")

    def close(self):
        self.events.append("close")

    def stats(self):
        return {}


class Out:
    def __init__(self):
        self.data, self.lock = bytearray(), threading.Lock()

    def write(self, b):
        with self.lock:
            self.data.extend(b)
        return len(b)

    def flush(self):
        pass

    def frames(self):
        d, out = bytes(self.data), []
        while len(d) >= 4:
            n = struct.unpack("<I", d[:4])[0]
            out.append(json.loads(d[4:4 + n]))
            d = d[4 + n:]
        return out


class MainWiring(S.Base):
    def run_main(self, feed, fake=True, models=True):
        cfg = S.models_cfg(self.tmp, {} if models else None)
        r, w = os.pipe()
        stdin = os.fdopen(r, "rb", buffering=0)
        self.addCleanup(stdin.close)
        out, res = Out(), {}
        fake = FakeModelRelay() if fake is True else (fake or None)
        patch = mock.patch.object(nh, "_build_model_relay", lambda cfg_, send: fake, create=True)
        patch.start()
        self.addCleanup(patch.stop)
        t = threading.Thread(target=lambda: res.setdefault("rc", nh.main(["--config", cfg, S.ORIGIN], stdin, out,
                                                                         io.StringIO())), daemon=True)
        t.start()
        for raw in feed:
            os.write(w, raw)
            time.sleep(0.15)
        if feed == "eof":
            pass
        return t, w, out, res, fake

    def finish(self, t, w, res, close=False):
        if close:
            os.close(w)
        t.join(3)
        self.assertFalse(t.is_alive(), "main did not exit")
        if not close:
            os.close(w)
        return res["rc"]

    def test_model_hello_follows_hello_and_polls_run(self):
        t, w, out, res, fake = self.run_main([S.frame({"t": "bye", "v": 1})])
        rc = self.finish(t, w, res)
        self.assertEqual(rc, 0)
        fr = out.frames()
        self.assertEqual([f["t"] for f in fr][:2], ["hello", "model_hello"])
        self.assertEqual(fake.events[0], "hello_frame")
        self.assertIn("poll", fake.events)
        self.assertEqual(fake.events[-1], "close")

    def test_close_on_every_exit_path(self):
        for feed, close in (([S.frame({"t": "bye", "v": 1})], False), ([S.frame({"t": "evil", "v": 1})], False),
                            ([], True), ([struct.pack("<I", 70000)], False)):
            with self.subTest(feed=feed[:1], close=close):
                t, w, out, res, fake = self.run_main(feed)
                self.finish(t, w, res, close=close)
                self.assertEqual(fake.events.count("close"), 1)

    def test_frames_reach_model_relay_and_not_fatal(self):
        t, w, out, res, fake = self.run_main([S.frame(MF), S.frame({"t": "bye", "v": 1})])
        self.assertEqual(self.finish(t, w, res), 0)
        self.assertEqual(fake.handled, [MF])

    def test_no_relay_no_model_hello(self):
        t, w, out, res, fake = self.run_main([S.frame({"t": "bye", "v": 1})], fake=False)
        self.assertEqual(self.finish(t, w, res), 0)
        self.assertEqual([f["t"] for f in out.frames()], ["hello"])
