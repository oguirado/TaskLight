"""Shared helpers for the U09 oracle. Stdlib only. Secrets are built at runtime."""
import json, os, pathlib, random, shutil, struct, subprocess, sys, tempfile, time, unittest

from bridge.tests.pipe_support import read_pipe

HERE = pathlib.Path(__file__).resolve().parent
BRIDGE = HERE.parent.parent
REPO = BRIDGE.parent
INSTALL = BRIDGE / "install.py"
PINNED_ID = "nnmhdaibaopekhjcpnekgdpeaaojclof"
ORIGIN = "chrome-extension://" + PINNED_ID + "/"
HOST_NAME = "com.contextwall.bridge"
TS = 1700000000000
SIX_KEYS = {"source", "projectId", "sourceSeq", "ts", "kind", "text"}
CLOCK = lambda: TS  # noqa: E731

RUNNER = (
    "import sys, runpy; sys.path.insert(0, %r); sys.argv = ['wall'] + sys.argv[1:]; "
    "runpy.run_module('wall', run_name='__main__', alter_sys=True)" % str(BRIDGE)
)


def clean_env(**extra):
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON") and k != "XDG_CONFIG_HOME"}
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_SYSTEM"] = os.devnull
    env.update(extra)
    return env


def run_wall(args, env=None, stdin=b"", timeout=30):
    """python3 -I -m wall <args> (bridge/ put on sys.path explicitly because -I drops it)."""
    return subprocess.run([sys.executable, "-I", "-c", RUNNER, *args], input=stdin,
                          capture_output=True, env=env or clean_env(), timeout=timeout)


def run_py(code, *args, env=None, timeout=60):
    pre = "import sys; sys.path.insert(0, %r); " % str(REPO)
    return subprocess.run([sys.executable, "-I", "-c", pre + code, *args], capture_output=True,
                          env=env or clean_env(), timeout=timeout)


def b(*parts):
    return "".join(parts)


def planted():
    """class -> (text, secret substring, accepted markers). Built by concatenation."""
    uuid = "3f2b8c1e" + "-9a4d-4e7b-" + "8c3a-1d5e6f7a8b9c"
    pk = b("-----BEGIN ", "RSA PRIVATE KEY-----\n", "MIIEowIBAAKCAQEA7pQz1xPLANTEDbodyAAAA\nbbbbCCCCddddEEEE\n",
           "-----END ", "RSA PRIVATE KEY-----")
    jwt = b("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk")
    return {
        "PRIVATE_KEY": ("key dump " + pk + " end", "MIIEowIBAAKCAQEA7pQz1xPLANTEDbodyAAAA", ["PRIVATE_KEY"]),
        "BEARER": ("Authorization: Bearer " + "abc123DEF456ghi789", "abc123DEF456ghi789", ["BEARER"]),
        "JWT": ("jwt " + jwt + " seen", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk", ["JWT"]),
        "KEY_ASSIGN": ("MY_SECRET" + "=" + "hunter2hunter2", "hunter2hunter2", ["KEY_ASSIGN"]),
        "URL_CREDS": ("clone https://" + "deploy:" + "s3cretpw" + "@host.example.com/r.git", "s3cretpw", ["URL_CREDS"]),
        "APPCHECK_DEBUG": ("AppCheck debug token: \"" + uuid + "\"", uuid, ["APPCHECK_DEBUG", "KEY_ASSIGN"]),
        "EMAIL": ("contact " + "dev" + "@" + "example.com" + " now", "dev" + "@" + "example.com", ["EMAIL"]),
        "HIGH_ENTROPY": ("build id " + entropy_token(40) + " ok", entropy_token(40), ["HIGH_ENTROPY"]),
    }


def entropy_token(n=40, seed=7):
    alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    r = random.Random(seed)
    return "".join(r.choice(alpha) for _ in range(n))


def make_config(tmp, projects=None, ext_id=PINNED_ID, name="wall.config.json"):
    tmp = pathlib.Path(tmp)
    spool = tmp / "spool"
    spool.mkdir(exist_ok=True)
    projects = projects if projects is not None else [("api", "standard"), ("vault", "private")]
    cfg = {"v": 1, "extensionId": ext_id, "spoolDir": str(spool),
           "projects": [{"projectId": p, "tier": t, "roots": []} for p, t in projects]}
    path = tmp / name
    path.write_text(json.dumps(cfg))
    return str(path)


def spool_dir(cfg):
    return pathlib.Path(json.loads(pathlib.Path(cfg).read_text())["spoolDir"])


def spool_lines(cfg, project):
    p = spool_dir(cfg) / (project + ".jsonl")
    return p.read_bytes().split(b"\n")[:-1] if p.exists() else []


def tree_bytes(d):
    d = pathlib.Path(d)
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="u09_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def cfg(self, **kw):
        return make_config(self.tmp, **kw)


# ---- native frames -------------------------------------------------------
def frame(obj):
    body = json.dumps(obj, separators=(",", ":")).encode()
    return struct.pack("<I", len(body)) + body


class HostEOF(Exception): pass
class HostTimeout(Exception): pass


class HostProc:
    def __init__(self, cfg, origin=ORIGIN, args=None, env=None):
        self.err = tempfile.TemporaryFile()
        argv = args if args is not None else ["host", "--config", cfg] + ([origin] if origin is not None else [])
        self.p = subprocess.Popen([sys.executable, "-I", "-c", RUNNER, *argv], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=self.err, env=env or clean_env())
        self.buf = b""
        self.sizes = []

    def _fill(self, deadline):
        fd = self.p.stdout.fileno()
        d = read_pipe(fd, 1 << 20, deadline)
        if d is None:
            raise HostTimeout()
        if not d:
            raise HostEOF()
        self.buf += d

    def read_frame(self, timeout=6.0):
        dl = time.monotonic() + timeout
        while len(self.buf) < 4:
            self._fill(dl)
        n = struct.unpack("<I", self.buf[:4])[0]
        while len(self.buf) < 4 + n:
            self._fill(dl)
        body, self.buf = self.buf[4:4 + n], self.buf[4 + n:]
        self.sizes.append(n)
        return json.loads(body.decode("utf-8"))

    def send(self, obj):
        self.send_raw(frame(obj))

    def send_raw(self, data):
        self.p.stdin.write(data)
        self.p.stdin.flush()

    def close_stdin(self):
        try:
            self.p.stdin.close()
        except OSError:
            pass

    def wait(self, timeout=6.0):
        try:
            return self.p.wait(timeout)
        except subprocess.TimeoutExpired:
            return None

    def rest(self):
        """All stdout bytes still pending after the process ended (plus buffered)."""
        return self.buf + (self.p.stdout.read() or b"")

    def stderr_text(self):
        self.err.seek(0)
        return self.err.read()

    def alive_for(self, secs=0.6):
        time.sleep(secs)
        return self.p.poll() is None

    def stop(self):
        if self.p.poll() is None:
            self.p.kill()
        self.p.wait()
        for s in (self.p.stdin, self.p.stdout):
            try:
                s.close()
            except OSError:
                pass
        self.err.close()


def start_host(case, cfg, **kw):
    h = HostProc(cfg, **kw)
    case.addCleanup(h.stop)
    return h
