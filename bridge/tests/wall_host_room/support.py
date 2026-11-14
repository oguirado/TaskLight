"""Helpers for the U09 AMEND_W oracle. Stdlib only. The host runs in-process (main() in a thread over os.pipe
stdin and a capturing stdout) with RoomRelay / load_room_config replaced by fakes; no real room code is used."""
import contextlib, importlib, json, os, pathlib, shutil, struct, tempfile, threading, time, unittest
from unittest import mock

from bridge.tests.wall import support as W

ORIGIN = W.ORIGIN
RCFG = {"rooms": [{"room": "demo", "floor": "ONLY_ON_DEVICE"}, {"room": "ops", "floor": "PREFER_ON_DEVICE"}],
        "agent": "wall-user", "orchestrator": None, "home": None}
ROOMS_SECTION = {"allow": [{"room": "demo", "tier": "private"}, {"room": "ops", "tier": "standard"}],
                 "agent": "wall-user"}


def host_mod():
    return importlib.import_module("bridge.wall.native_host")


def relay_mod_or_none():
    try:
        return importlib.import_module("bridge.wall.room_relay")
    except ImportError:
        return None


def make_cfg(tmp, rooms=True, **top):
    path = W.make_config(tmp)
    if rooms or top:
        data = json.loads(pathlib.Path(path).read_text())
        if rooms:
            data["rooms"] = dict(ROOMS_SECTION) if rooms is True else rooms
        data.update(top)
        pathlib.Path(path).write_text(json.dumps(data))
    return path


def make_fake(handle=None, poll=None, prime=None, ctor_raises=None):
    """Return a FakeRelay class. handle/poll/prime are callables (self, ...) -> value or raise."""
    class FakeRelay:
        instances = []

        def __init__(self, rcfg, send, *args, **kw):
            if ctor_raises:
                raise ctor_raises
            self.rcfg, self.send, self.kw = rcfg, send, kw
            self.handled, self.polls, self.primes, self.order = [], 0, 0, []
            FakeRelay.instances.append(self)

        def prime(self):
            self.primes += 1
            self.order.append("prime")
            return prime(self) if prime else None

        def poll(self):
            self.polls += 1
            self.order.append("poll")
            return poll(self) if poll else 0

        def handle(self, frame):
            self.handled.append(frame)
            self.order.append("handle")
            return handle(self, frame) if handle else None

        def stats(self):
            return {}
    return FakeRelay


class OutBuf:
    def __init__(self):
        self.data, self.lock = bytearray(), threading.Lock()

    def write(self, b):
        with self.lock:
            self.data.extend(b)
        return len(b)

    def flush(self):
        pass

    def snapshot(self):
        with self.lock:
            return bytes(self.data)


def parse_frames(raw):
    out, i = [], 0
    while i + 4 <= len(raw):
        n = struct.unpack("<I", raw[i:i + 4])[0]
        if i + 4 + n > len(raw):
            break
        out.append(json.loads(raw[i + 4:i + 4 + n].decode("utf-8")))
        i += 4 + n
    return out


class InProcHost:
    def __init__(self, case, cfg, origin=ORIGIN):
        self.case = case
        r, w = os.pipe()
        self.rfd, self.wfd = r, w
        self.stdin = os.fdopen(r, "rb", buffering=0)
        self.out, self.err = OutBuf(), __import__("io").StringIO()
        self.rc, self.done, self.exc = "unset", threading.Event(), None
        argv = ["--config", cfg] + ([origin] if origin else [])

        def run():
            try:
                self.rc = host_mod().main(argv, stdin=self.stdin, stdout=self.out, stderr=self.err)
            except BaseException as e:  # a raising host is a test failure, surfaced via .exc
                self.exc = e
            finally:
                self.done.set()
        self.t = threading.Thread(target=run, daemon=True)
        case.addCleanup(self.stop)
        self.t.start()

    def send(self, obj):
        self.send_raw(W.frame(obj))

    def send_raw(self, data):
        try:
            os.write(self.wfd, data)
        except OSError:
            pass

    def frames(self):
        return parse_frames(self.out.snapshot())

    def wait_frames(self, pred, timeout=5.0):
        dl = time.monotonic() + timeout
        while time.monotonic() < dl:
            fr = [f for f in self.frames() if pred(f)]
            if fr:
                return fr
            time.sleep(0.02)
        return []

    def wait(self, timeout=6.0):
        self.done.wait(timeout)
        self.case.assertIsNone(self.exc, "host raised: %r" % (self.exc,))
        return self.rc if self.done.is_set() else None

    def alive_for(self, secs=0.5):
        self.done.wait(secs)
        return not self.done.is_set()

    def close_stdin(self):
        try:
            os.close(self.wfd)
        except OSError:
            pass

    def stop(self):
        self.close_stdin()
        self.done.wait(3.0)
        try:
            self.stdin.close()
        except OSError:
            pass


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="u09r_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def cfg(self, **kw):
        return make_cfg(self.tmp, **kw)

    def patch_room(self, fake, rcfg=RCFG, load=None, require=True):
        """Patch RoomRelay and load_room_config wherever the host can see them (native_host and room_relay).
        Contract: the host obtains both from bridge.wall.room_relay (module-level names or lazy import)."""
        seen = []

        def fake_load(cfg):
            seen.append(cfg)
            if load is not None:
                return load(cfg)
            return rcfg if isinstance(cfg, dict) and "rooms" in cfg else None
        fake.load_seen = seen
        mods = [m for m in (host_mod(), relay_mod_or_none()) if m is not None]
        patched = 0
        for m in mods:
            for name, val in (("RoomRelay", fake), ("load_room_config", fake_load)):
                if hasattr(m, name):
                    p = mock.patch.object(m, name, val)
                    p.start()
                    self.addCleanup(p.stop)
                    patched += 1
        if require:
            self.assertGreaterEqual(
                patched, 2, "contract: host must use RoomRelay and load_room_config from "
                            "bridge.wall.room_relay (module attrs on native_host or room_relay)")
        return fake

    def start(self, cfg=None, **kw):
        return InProcHost(self, cfg or self.cfg(), **kw)

    def hello(self, h):
        f = h.wait_frames(lambda f: f.get("t") == "hello")
        self.assertTrue(f, "no hello frame")
        return f[0]

    def bye_rc(self, h):
        h.send({"t": "bye", "v": 1})
        return h.wait()
