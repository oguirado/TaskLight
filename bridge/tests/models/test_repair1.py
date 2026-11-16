"""U48 repair loop 1 (A-U48r1): relay watchdog, transport total budget, nested-JSON store refusal.
Loopback-only fakes, tmp CW_HOME, stdlib only."""
import json, os, pathlib, socket, threading, time
from . import support as S
from bridge.models import store as ST
from bridge.models import transport as T

SLACK = 0.6


def _body():
    return {"model": "m-fake", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 16}


# ---------------------------------------------------------------- 1. relay watchdog
class _Hang:
    """Transport whose first `hang` calls wait on an Event nobody sets during the test."""

    def __init__(self, case, hang=1):
        self.release = threading.Event()
        case.addCleanup(self.release.set)
        self.n, self.hang = 0, hang

    def _maybe_hang(self):
        self.n += 1
        if self.n <= self.hang:
            self.release.wait()
            return True
        return False

    def generate(self, endpoint, key, body, deadline, cancel, **kw):
        return "late" if self._maybe_hang() else "ok"

    def probe(self, endpoint, key, timeout_s, **kw):
        self._maybe_hang()
        return None


TO = {"probe_ms": 300, "local_generate_ms": 300, "remote_generate_ms": 300}


class RelayWatchdog(S.Base):
    def rig(self, tr):
        S.write_store(self.home, [S.ep(None, id="fake", base_url="http://127.0.0.1:9/v1")])
        return S.RelayRig(self, self.home, transport=tr, timeouts=TO)

    def frames_for(self, rig, rid):
        with rig.lock:
            return [f for f in rig.frames if f.get("rid") == rid]

    def test_never_settling_generate_single_timeout_then_next_served(self):
        tr = _Hang(self)
        rig = self.rig(tr)
        t0 = time.monotonic()
        f = rig.ask(S.gen("g1"), timeout=3.0)
        self.assertEqual((f["t"], f.get("code")), ("model_nack", "timeout"))
        self.assertLess(time.monotonic() - t0, 0.3 + SLACK + 0.5)
        r = rig.ask(S.gen("g2"), timeout=3.0)
        self.assertEqual((r["t"], r.get("text")), ("model_result", "ok"))
        tr.release.set()                                        # late outcome of g1 must be discarded
        rig.quiet(0.4)
        self.assertEqual(len(self.frames_for(rig, "g1")), 1)

    def test_never_settling_probe_single_terminal_then_next_served(self):
        tr = _Hang(self)
        rig = self.rig(tr)
        t0 = time.monotonic()
        h = rig.ask(S.probe_frame("p1"), timeout=3.0)
        # spec: probe failures map to model_health; a timeout is state offline (not a nack)
        self.assertEqual((h["t"], h.get("state")), ("model_health", "offline"))
        self.assertLess(time.monotonic() - t0, 0.3 + SLACK + 0.5)
        h2 = rig.ask(S.probe_frame("p2"), timeout=3.0)
        self.assertEqual((h2["t"], h2.get("state")), ("model_health", "available"))
        tr.release.set()
        rig.quiet(0.4)
        self.assertEqual(len(self.frames_for(rig, "p1")), 1)

    def test_abandoned_workers_are_capped(self):
        tr = _Hang(self, hang=10 ** 6)
        rig = self.rig(tr)
        codes = [rig.ask(S.gen("h%d" % i), timeout=3.0).get("code") for i in range(4)]
        self.assertEqual(codes[:2], ["timeout", "timeout"])
        self.assertIn("busy", codes[2:])
        alive = [t for t in threading.enumerate() if t.name == "model-relay-worker"]
        self.assertLessEqual(len(alive), 2)
        tr.release.set()
        tr.hang = 0
        time.sleep(0.2)
        self.assertEqual(rig.ask(S.gen("ok"), timeout=3.0).get("text"), "ok")

    def test_bad_timeout_config_rejected(self):
        mod = S.relay_mod()
        for bad in ({"probe_ms": 0}, {"local_generate_ms": -5}, {"remote_generate_ms": float("nan")},
                    {"probe_ms": float("inf")}, {"probe_ms": "300"}, {"probe_ms": True}):
            with self.assertRaises(ValueError, msg=repr(bad)):
                mod.ModelRelay({}, lambda f: None, home=str(self.home), timeouts=bad)


# ---------------------------------------------------------------- 2. transport total budget
class _RawPeer:
    """Loopback raw TCP peer: reads the request head, then runs `script(conn)`."""

    def __init__(self, case, script):
        self.stop = threading.Event()
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(4)
        self.port = self.srv.getsockname()[1]
        self.script = script
        threading.Thread(target=self._run, daemon=True).start()
        case.addCleanup(self.close)

    def _run(self):
        try:
            conn, _ = self.srv.accept()
        except OSError:
            return
        try:
            conn.settimeout(5)
            buf = b""
            while b"\r\n\r\n" not in buf:
                b = conn.recv(4096)
                if not b:
                    return
                buf += b
            self.script(conn, self.stop)
        except OSError:
            pass
        finally:
            conn.close()

    def close(self):
        self.stop.set()
        self.srv.close()

    base_url = property(lambda self: "http://127.0.0.1:%d/v1" % self.port)


def _trickle_body(conn, stop):
    conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500000\r\n\r\n")
    while not stop.is_set():
        conn.sendall(b" ")
        stop.wait(0.02)


def _trickle_headers(conn, stop):
    conn.sendall(b"HTTP/1.1 200 OK\r\nX-Slow: ")          # one header line, never finished
    while not stop.is_set():
        conn.sendall(b"a")
        stop.wait(0.02)


class TransportBudget(S.Base):
    def timed(self, fn, budget):
        box = {}

        def run():
            try:
                box["ret"] = fn()
            except BaseException as exc:                # noqa: BLE001 - recorded for the assertion
                box["exc"] = exc
            box["el"] = time.monotonic() - t0
        t0 = time.monotonic()
        th = threading.Thread(target=run, daemon=True)  # a red run must not hang the suite
        th.start()
        th.join(budget + SLACK + 2.0)
        self.assertFalse(th.is_alive(), "call still running %.1fs after its deadline" % (SLACK + 2.0))
        exc = box.get("exc")
        self.assertIsInstance(exc, T.TransportError, repr(box))
        self.assertEqual(exc.code, "timeout")
        self.assertLess(box["el"], budget + SLACK)

    def test_trickling_body_generate(self):
        p = _RawPeer(self, _trickle_body)
        e = S.ep(p.base_url)
        self.timed(lambda: T.generate(e, None, _body(), time.monotonic() + 0.5, threading.Event()), 0.5)

    def test_slow_headers_generate(self):
        p = _RawPeer(self, _trickle_headers)
        e = S.ep(p.base_url)
        self.timed(lambda: T.generate(e, None, _body(), time.monotonic() + 0.5, threading.Event()), 0.5)

    def test_slow_headers_probe(self):
        p = _RawPeer(self, _trickle_headers)
        self.timed(lambda: T.probe(S.ep(p.base_url), None, 0.5), 0.5)

    def test_never_returning_resolver(self):
        ev = threading.Event()
        self.addCleanup(ev.set)

        def hang(host, port, *a, **k):
            ev.wait()
            return []
        e = S.ep("http://fake.invalid:9/v1")
        self.timed(lambda: T.generate(e, None, _body(), time.monotonic() + 0.4, threading.Event(), resolver=hang), 0.4)
        self.timed(lambda: T.probe(e, None, 0.4, resolver=hang), 0.4)


# ---------------------------------------------------------------- 3. nested JSON store
def _nested(depth):
    return '{"v":1,"endpoints":' + "[" * depth + "null" + "]" * depth + "}"


# 2000 (the HOLD example) parses on CPython 3.12.3 and is refused by validation; 20000 (40 KB, under the
# 64 KiB store cap) raises RecursionError inside json.loads [MEASURED 2026-11-14].
DEPTHS = (2000, 20000)


class NestedStore(S.Base):
    def plant(self, depth, name="endpoints.json"):
        d = pathlib.Path(self.home) / "models"
        d.mkdir(mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)
        raw = _nested(depth)
        (d / name).write_text(raw if name == "endpoints.json" else raw.replace("endpoints", "keys"))
        os.chmod(d / name, 0o600)

    def test_load_refuses_nested_endpoints(self):
        for depth in DEPTHS:
            with self.subTest(depth=depth):
                self.plant(depth)
                self.assertEqual(ST.load(str(self.home)), {"endpoints": [], "keys": {}, "refused": True})

    def test_load_refuses_nested_keys(self):
        for depth in DEPTHS:
            with self.subTest(depth=depth):
                S.write_store(self.home, [S.ep(None)])
                self.plant(depth, "keys.json")
                self.assertEqual(ST.load(str(self.home)), {"endpoints": [], "keys": {}, "refused": True})

    def test_cli_list_refuses_without_traceback(self):
        for depth in DEPTHS:
            with self.subTest(depth=depth):
                self.plant(depth)
                p = S.run_cli(["list"], self.home)
                err = p.stderr.decode("utf-8", "replace")
                self.assertEqual(p.returncode, 2, err[-400:])
                self.assertNotIn("Traceback", err)
                self.assertNotIn("[[[", err + p.stdout.decode("utf-8", "replace"))
                self.assertIn("endpoints.json", err)
