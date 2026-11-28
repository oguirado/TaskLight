"""Shared helpers for the U33 oracle. Stdlib only."""
import json, os, pathlib, shutil, subprocess, sys, tempfile, time, unittest

from bridge.tests.pipe_support import read_pipe

HERE = pathlib.Path(__file__).resolve().parent
BRIDGE = HERE.parent.parent
REPO = BRIDGE.parent
BASE_TS = 1700000000000

# `-I` drops cwd and PYTHONPATH, so `python3 -I -m bridge.room` cannot find the
# namespace package `bridge` even with cwd=repo. We keep `-I` and put REPO on sys.path
# explicitly, then run the module as __main__ (same behaviour as -m).
RUNNER = (
    "import sys, runpy; sys.path.insert(0, %r); mod = sys.argv[1]; sys.argv = [mod] + sys.argv[2:]; "
    "runpy.run_module(mod, run_name='__main__', alter_sys=True)" % str(REPO)
)


def clean_env(home=None, **extra):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("PYTHON") and not k.startswith("CW_")}
    if home is not None:
        env["CW_HOME"] = str(home)
    env.update(extra)
    return env


def run_module(mod, args=(), home=None, stdin=b"", env=None, timeout=30, cwd=None, **extra):
    if isinstance(stdin, str):
        stdin = stdin.encode()
    return subprocess.run([sys.executable, "-I", "-c", RUNNER, mod, *map(str, args)], input=stdin,
                          capture_output=True, cwd=str(cwd or REPO), timeout=timeout,
                          env=env if env is not None else clean_env(home, **extra))


def run_cli(args, home, **kw):
    return run_module("bridge.room", args, home=home, **kw)


def run_py(code, *args, home=None, timeout=60):
    pre = "import sys; sys.path.insert(0, %r); " % str(REPO)
    return subprocess.run([sys.executable, "-I", "-c", pre + code, *map(str, args)],
                          capture_output=True, cwd=str(REPO), env=clean_env(home), timeout=timeout)


def popen_py(code, *args, home=None):
    pre = "import sys; sys.path.insert(0, %r); " % str(REPO)
    return subprocess.Popen([sys.executable, "-I", "-c", pre + code, *map(str, args)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(REPO),
                            env=clean_env(home))


def jout(cp):
    """Parse the single JSON object a CLI printed on stdout."""
    text = cp.stdout.decode("utf-8")
    return json.loads(text)


def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class Clock:
    def __init__(self, start=BASE_TS, step=1):
        self.t, self.step = start, step

    def __call__(self):
        v = self.t
        self.t += self.step
        return v


def room_dir(home, room):
    return pathlib.Path(home) / "rooms" / room


def events_path(home, room):
    return room_dir(home, room) / "events.jsonl"


def mk_event(lamport, room="r1", agent="a1", act="heartbeat", text="x", **extra):
    ev = {"id": "e-%016x" % (0xABC000 + lamport), "lamport": lamport, "ts": BASE_TS + lamport,
          "room": room, "agent": agent, "act": act, "text": text}
    ev.update(extra)
    return ev


def seed(home, room, events=(), raw_lines=(), raw_tail=b""):
    """Write a room file directly (independent of store). Order: events, then raw_lines, then tail."""
    d = room_dir(home, room)
    d.mkdir(parents=True, exist_ok=True)
    with open(d / "events.jsonl", "ab") as f:
        for e in events:
            f.write((canon(e) + "\n").encode("utf-8"))
        for r in raw_lines:
            f.write(r if isinstance(r, bytes) else r.encode("utf-8"))
            f.write(b"\n")
        f.write(raw_tail)
    return d / "events.jsonl"


def file_events(home, room):
    out = []
    p = events_path(home, room)
    if not p.exists():
        return out
    for line in p.read_bytes().split(b"\n"):
        if line.strip():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def find_events(payload):
    """Tolerant extraction of an event list from a tool/CLI payload."""
    if isinstance(payload, list):
        return payload
    for k in ("events", "inbox", "items"):
        if isinstance(payload.get(k), list):
            return payload[k]
    return []


def ids_of(items):
    return {(i["id"] if isinstance(i, dict) else i) for i in items}


class RoomCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="u33-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.home = self.tmp / "cw"          # intentionally not created: store must create it
        self.clock = Clock()

    def post(self, room="r1", agent="a1", act="heartbeat", text="x", **kw):
        from bridge.room import store
        kw.setdefault("home", self.home)
        kw.setdefault("clock", self.clock)
        return store.post(room, agent, act, text, **kw)

    def make_file(self, name="note.txt", data=b"hello\n", sub=None):
        d = self.tmp / (sub or "files")
        d.mkdir(parents=True, exist_ok=True)
        p = d / name
        p.write_bytes(data)
        return p


class McpClient:
    def __init__(self, home, **extra):
        self.proc = subprocess.Popen([sys.executable, "-I", "-c", RUNNER, "bridge.room.mcp"],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, cwd=str(REPO),
                                     env=clean_env(home, **extra))
        self.buf = b""
        self.next_id = 1

    def send_raw(self, data):
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def send(self, obj):
        self.send_raw((json.dumps(obj) + "\n").encode())

    def recv(self, timeout=10.0):
        end = time.monotonic() + timeout
        fd = self.proc.stdout.fileno()
        while b"\n" not in self.buf:
            chunk = read_pipe(fd, 65536, end)
            if chunk is None:
                return None
            if not chunk:
                if self.buf:
                    line, self.buf = self.buf, b""
                    return json.loads(line)
                return None
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return json.loads(line)

    def request(self, method, params=None, id=None, timeout=10.0):
        if id is None:
            id = self.next_id
            self.next_id += 1
        msg = {"jsonrpc": "2.0", "id": id, "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)
        while True:
            r = self.recv(timeout)
            if r is None:
                raise AssertionError("no response to %s id=%r" % (method, id))
            if r.get("id") == id:
                return r

    def initialize(self):
        r = self.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                        "clientInfo": {"name": "t", "version": "0"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return r

    def call(self, tool, args, timeout=10.0):
        r = self.request("tools/call", {"name": tool, "arguments": args}, timeout=timeout)
        return r["result"]

    @staticmethod
    def payload(result):
        return json.loads(result["content"][0]["text"])

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
            self.proc.wait()
        for s in (self.proc.stdout, self.proc.stderr):
            try:
                s.close()
            except Exception:
                pass


class McpCase(RoomCase):
    def client(self, **extra):
        c = McpClient(self.home, **extra)
        self.addCleanup(c.close)
        return c
