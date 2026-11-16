"""U48 oracle helpers. Stdlib only. Loopback fakes only; tmp CW_HOME/HOME; canaries built at runtime.
Store fixtures are written directly (never through bridge.models.store) so the fixtures do not depend on the stub."""
import contextlib, importlib, json, os, pathlib, shutil, socket, struct, subprocess, sys, tempfile, threading, time, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from bridge.tests.wall import support as W

REPO = W.REPO
ORIGIN = W.ORIGIN
MAX_FRAME = 65536
KEY_CANARY = "sk-" + "CANARYKEY" + "7f3a91c2d4e5"            # never a literal in source
PROMPT_CANARY = "PROMPT" + "CANARY" + "-b81e44a0-prompt-text"
REPLY_CANARY = "REPLY" + "CANARY" + "-0c5d12ee"

frame = W.frame
NACKS = ("unknown_endpoint needs_setup policy busy too_large not_loopback redirect timeout offline auth rate_limited "
         "rung_unsupported http_error bad_reply reply_too_large cancelled").split()

NOT_LOOPBACK = "192.0.2.1"       # TEST-NET-1, never routed, never connected to


def resolver_to(*ips):
    """getaddrinfo-compatible fake: every name resolves to the given IPs (port echoed)."""
    def r(host, port, *a, **k):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in ips]
    return r


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ---------------------------------------------------------------- fake HTTP runtime
class _Srv(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def get_request(self):
        r = super().get_request()
        self.fake.conns += 1
        return r


class _H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _go(self, method):
        fake = self.server.fake
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        try:
            js = json.loads(body) if body else None
        except ValueError:
            js = None
        req = {"method": method, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()},
               "body": body, "json": js}
        fake.requests.append(req)
        try:
            status, headers, data = (fake.on_get if method == "GET" else fake.on_post)(req)
        except Exception:
            status, headers, data = 500, {}, b"boom"
        if fake.stop.is_set():
            return
        try:
            self.send_response(status)
            headers = dict(headers or {})
            headers.setdefault("Content-Type", "application/json")
            headers["Content-Length"] = str(len(data))
            headers["Connection"] = "close"
            for k, v in headers.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
            self.wfile.flush()
        except OSError:
            pass
        self.close_connection = True

    def do_GET(self):
        self._go("GET")

    def do_POST(self):
        self._go("POST")


def chat_body(content):
    return json.dumps({"choices": [{"index": 0, "message": {"role": "assistant", "content": content}}]}).encode()


class Fake:
    """Programmable OpenAI-compatible fake. .requests, .conns, .post_requests."""

    def __init__(self):
        self.requests, self.conns, self.stop = [], 0, threading.Event()
        self.content = "ok"
        self.on_get = lambda req: (200, {}, b'{"object":"list","data":[]}')
        self.on_post = lambda req: (200, {}, chat_body(self.content))
        self.srv = _Srv(("127.0.0.1", 0), _H)
        self.srv.fake = self
        self.port = self.srv.server_address[1]
        self.t = threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.t.start()

    base_url = property(lambda self: "http://127.0.0.1:%d/v1" % self.port)

    @property
    def posts(self):
        return [r for r in self.requests if r["method"] == "POST"]

    def reply(self, status=200, body=b"", headers=None, delay=0.0, post=True, get=True):
        def h(req):
            if delay:
                self.stop.wait(delay)
            return status, headers or {}, body if isinstance(body, bytes) else body.encode()
        if post:
            self.on_post = h
        if get:
            self.on_get = h

    def wait_requests(self, n=1, timeout=5.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if len(self.requests) >= n:
                return True
            time.sleep(0.01)
        return False

    def close(self):
        self.stop.set()
        self.srv.shutdown()
        self.srv.server_close()


def ep(fake_or_url=None, id="fake", kind="local-openai-compatible", **kw):
    url = fake_or_url.base_url if isinstance(fake_or_url, Fake) else (fake_or_url or "http://127.0.0.1:9/v1")
    e = {"id": id, "kind": kind, "label": "Fake " + id, "base_url": url, "model": "m-" + id,
         "allow_private": False, "enabled": True}
    e.update(kw)
    return e


def write_store(home, endpoints, keys=None, dir_mode=0o700, file_mode=0o600):
    """Direct fixture writer: <home>/models/{endpoints,keys}.json with explicit modes."""
    d = pathlib.Path(home) / "models"
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, dir_mode)
    (d / "endpoints.json").write_text(json.dumps({"v": 1, "endpoints": endpoints}))
    os.chmod(d / "endpoints.json", file_mode)
    if keys is not None:
        (d / "keys.json").write_text(json.dumps({"v": 1, "keys": keys}))
        os.chmod(d / "keys.json", file_mode)
    return d


# ---------------------------------------------------------------- env / subprocess
def env_for(home, **extra):
    h = pathlib.Path(home)
    e = W.clean_env(HOME=str(h / "fakehome"), CW_HOME=str(h))
    e.update(extra)
    return e


CLI_RUN = ("import sys, runpy; sys.path.insert(0, %r); sys.argv = ['bridge.models'] + sys.argv[1:]; "
           "runpy.run_module('bridge.models', run_name='__main__', alter_sys=True)" % str(REPO))
HOST_RUN = ("import sys; sys.path.insert(0, %r); from bridge.wall import native_host; "
            "sys.exit(native_host.main(sys.argv[1:]))" % str(REPO))


def run_cli(args, home, stdin=b"", timeout=20, env=None):
    return subprocess.run([sys.executable, "-I", "-c", CLI_RUN, *args], input=stdin, capture_output=True,
                          env=env or env_for(home), timeout=timeout)


class MHost(W.HostProc):
    """The native host as `bridge.wall.native_host` (so bridge.* absolute imports work)."""

    def __init__(self, cfg, env, origin=ORIGIN):
        self.err = tempfile.TemporaryFile()
        self.p = subprocess.Popen([sys.executable, "-I", "-c", HOST_RUN, "--config", cfg, origin],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err, env=env)
        self.buf, self.sizes, self.raw = b"", [], []

    def read_frame(self, timeout=2.0):
        return W.HostProc.read_frame(self, timeout)

    def read_until(self, pred, timeout=2.0):
        """Read frames until pred(frame) is true; return (frame, all_frames_read)."""
        end = time.monotonic() + timeout
        seen = []
        while True:
            f = self.read_frame(max(0.05, end - time.monotonic()))
            seen.append(f)
            if pred(f):
                return f, seen

    def drain(self, secs=0.5):
        out = []
        end = time.monotonic() + secs
        while True:
            try:
                out.append(self.read_frame(max(0.01, end - time.monotonic())))
            except (W.HostTimeout, W.HostEOF):
                return out


def models_cfg(tmp, models=None, rooms=None, name="wall.config.json", **top):
    path = W.make_config(tmp, name=name)
    data = json.loads(pathlib.Path(path).read_text())
    if models is not None:
        data["models"] = models
    if rooms:
        data["rooms"] = rooms
    data.update(top)
    pathlib.Path(path).write_text(json.dumps(data))
    return path


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="u48_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.home = self.tmp / "cw"
        self.home.mkdir()
        os.chmod(self.home, 0o700)
        (self.tmp / "fakehome").mkdir()

    def fake(self):
        f = Fake()
        self.addCleanup(f.close)
        return f

    def host(self, endpoints=None, keys=None, models=None, rooms=None, **store_kw):
        if endpoints is not None:
            write_store(self.home, endpoints, keys, **store_kw)
        cfg = models_cfg(self.tmp, {} if models is None else models, rooms=rooms)
        h = MHost(cfg, env_for(self.home))
        self.addCleanup(h.stop)
        return h

    def start(self, **kw):
        """Start host, consume hello + model_hello, return host."""
        h = self.host(**kw)
        f = h.read_frame()
        self.assertEqual(f["t"], "hello")
        f, _ = h.read_until(lambda f: f["t"] == "model_hello")
        return h

    def expect(self, h, rid, timeout=2.0):
        f, _ = h.read_until(lambda f: f.get("rid") == rid, timeout)
        return f


def gen(rid="r1", id="fake", tier="standard", messages=None, max_tokens=64, rung=3, schema=None, **extra):
    f = {"t": "model_generate", "v": 1, "rid": rid, "id": id, "tier": tier,
         "messages": messages if messages is not None else [{"role": "user", "content": "hello"}],
         "max_tokens": max_tokens, "rung": rung}
    if schema is not None:
        f["schema"] = schema
    f.update(extra)
    return f


def probe_frame(rid="p1", id="fake"):
    return {"t": "model_probe", "v": 1, "rid": rid, "id": id}


def cancel_frame(rid="r1"):
    return {"t": "model_cancel", "v": 1, "rid": rid}


def list_frame(rid="l1"):
    return {"t": "model_list", "v": 1, "rid": rid}


# ---------------------------------------------------------------- in-process relay
def relay_mod():
    return importlib.import_module("bridge.wall.model_relay")


class RelayRig:
    def __init__(self, case, home, transport=None, timeouts=None, mcfg=None, **kw):
        self.frames, self.lock, self.senders = [], threading.Lock(), []
        self.case = case
        mod = relay_mod()
        kws = dict(home=str(home))
        if transport is not None:
            kws["transport"] = transport
        if timeouts is not None:
            kws["timeouts"] = timeouts
        kws.update(kw)
        self.relay = mod.ModelRelay({} if mcfg is None else mcfg, self._send, **kws)
        case.addCleanup(self.relay.close)

    def _send(self, obj):
        with self.lock:
            self.senders.append(threading.current_thread())
            self.frames.append(json.loads(json.dumps(obj)))
        return True

    def pump(self, pred, timeout=6.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.relay.poll()
            with self.lock:
                for f in self.frames:
                    if pred(f):
                        return f
            time.sleep(0.01)
        return None

    def ask(self, frame, timeout=6.0):
        self.case.assertEqual(self.relay.handle(frame), 0)
        f = self.pump(lambda f: f.get("rid") == frame["rid"], timeout)
        self.case.assertIsNotNone(f, "no reply for %s" % frame["rid"])
        return f

    def quiet(self, secs=0.4):
        end = time.monotonic() + secs
        while time.monotonic() < end:
            self.relay.poll()
            time.sleep(0.01)


class ProcSampler:
    """Background scan of /proc/*/cmdline for secret substrings (acceptance 8: no argv of any process)."""

    def __init__(self, *needles):
        self.needles = [n.encode() for n in needles]
        self.hits, self.stop, self.t = [], threading.Event(), threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            for d in os.listdir("/proc"):
                if d.isdigit():
                    try:
                        c = open("/proc/%s/cmdline" % d, "rb").read()
                    except OSError:
                        continue
                    for n in self.needles:
                        if n in c:
                            self.hits.append((d, n))
            time.sleep(0.005)

    def __enter__(self):
        self.t.start()
        return self

    def __exit__(self, *a):
        time.sleep(0.05)
        self.stop.set()
        self.t.join(2)


class FakeTransport:
    """Injected `transport=` object: records calls, returns/raises per script."""

    def __init__(self, generate=None, probe=None):
        from bridge.models import transport as T
        self.T = T
        self.calls = []
        self._gen = generate or (lambda *a: "ok")
        self._probe = probe or (lambda *a: None)

    def generate(self, endpoint, key, body, deadline, cancel, **kw):
        self.calls.append(("generate", endpoint, key, body))
        return self._gen(endpoint, key, body, deadline, cancel)

    def probe(self, endpoint, key, timeout_s, **kw):
        self.calls.append(("probe", endpoint, key, timeout_s))
        return self._probe(endpoint, key, timeout_s)
