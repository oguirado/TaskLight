"""Shared helpers for the U37a oracle. Stdlib only. Secrets are planted fakes built at runtime."""
import contextlib, importlib, json, os, pathlib, shutil, subprocess, sys, tempfile, unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
BRIDGE = HERE.parent.parent
REPO = BRIDGE.parent
RELAY_SRC = BRIDGE / "wall" / "room_relay.py"

# Planted fakes (never real credentials). KEY_ASSIGN class of U09 redact() masks the value.
FAKE_VALUE = "planted-fake-value-" + "0042"
FAKE_SECRET = "FAKE_API_KEY=" + FAKE_VALUE
MARKER = "zq9roomtextmarker"  # plain text that must never reach stdout/stderr/logs


def relay_mod():
    return importlib.import_module("bridge.wall.room_relay")


def emit_mod():
    return importlib.import_module("bridge.wall.emit")


def redact_ready():
    """False while bridge.wall.emit.redact is a NotImplementedError stub."""
    try:
        emit_mod().redact("x")
    except NotImplementedError:
        return False
    return True


@contextlib.contextmanager
def patched_redact(fn):
    """Replace redact in bridge.wall.emit and in room_relay (whichever way it was imported)."""
    emit, relay = emit_mod(), relay_mod()
    with contextlib.ExitStack() as st:
        st.enter_context(mock.patch.object(emit, "redact", fn))
        if hasattr(relay, "redact"):
            st.enter_context(mock.patch.object(relay, "redact", fn))
        yield


def residue_redact(text, _disable=frozenset()):
    """Fake redactor that always reports a hit: second pass count > 0 means residue."""
    return text, 1, ["KEY_ASSIGN"]


def identity_redact(text, _disable=frozenset()):
    return text, 0, []


def rcfg_dict(rooms=(("demo", "private"),), agent="wall-user", **extra):
    r = {"allow": [{"room": n, "tier": t} for n, t in rooms], "agent": agent}
    r.update(extra)
    return {"rooms": r}


def event(lamport, room="demo", agent="agent-a", act="step", text="hello", **kw):
    ev = {"id": "e-%016x" % lamport, "lamport": lamport, "ts": 1700000000000 + lamport,
          "room": room, "agent": agent, "act": act, "text": text}
    if act == "step" and "step" not in kw:
        kw["step"] = {"index": 0, "state": "done"}
    ev.update(kw)
    return ev


def write_raw(home, room, events, raw_lines=()):
    d = pathlib.Path(home) / "rooms" / room
    d.mkdir(parents=True, exist_ok=True)
    with open(d / "events.jsonl", "ab") as f:
        for e in events:
            f.write((json.dumps(e, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode())
        for raw in raw_lines:
            f.write(raw)
    return d


class Frames:
    """Fake `send`: collects frames (as dict) in order."""

    def __init__(self, fail=False):
        self.frames, self.fail = [], fail

    def __call__(self, frame):
        if self.fail:
            raise RuntimeError("send failed")
        self.frames.append(json.loads(json.dumps(frame)))  # must be JSON-serialisable
        return None

    def of(self, t):
        return [f for f in self.frames if f.get("t") == t]

    def clear(self):
        del self.frames[:]


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


class Base(unittest.TestCase):
    """use_real_redact=False: redaction is replaced by an identity fake so the test does not
    depend on U09. Classes that assert redaction content set it True (and skip on NotImplementedError)."""
    use_real_redact = False

    def setUp(self):
        if not self.use_real_redact:
            cm = patched_redact(identity_redact)
            cm.__enter__()
            self.addCleanup(cm.__exit__, None, None, None)
        self._tmp = tempfile.mkdtemp(prefix="u37a-")
        self.home = os.path.join(self._tmp, "cwhome")
        os.makedirs(self.home)
        self._env = mock.patch.dict(os.environ, {"CW_HOME": self.home})
        self._env.start()
        self.addCleanup(self._env.stop)
        self.addCleanup(shutil.rmtree, self._tmp, True)
        self.send = Frames()
        self.clock = Clock()

    def mod(self):
        return relay_mod()

    def make_room(self, room="demo", agent="orch"):
        from bridge.room import store
        return store.post(room, agent, "open", "room opened", home=self.home)

    def cfg(self, **kw):
        c = self.mod().load_room_config(rcfg_dict(**kw))
        self.assertIsNotNone(c, "valid config must load")
        return c

    def relay(self, rooms=(("demo", "private"),), create=True, **kw):
        if create:
            for n, _ in rooms:
                self.make_room(n)
        rc = self.cfg(rooms=rooms, **kw)
        return self.mod().RoomRelay(rc, self.send, home=self.home, clock=self.clock)

    def post_frame(self, text="hi", rid="r1", room="demo", **kw):
        f = {"t": "room_post", "v": 1, "rid": rid, "room": room, "act": "question", "text": text}
        f.update(kw)
        return f

    def events_on_disk(self, room="demo"):
        from bridge.room import store
        return store.read(room, 0, home=self.home)[0]
