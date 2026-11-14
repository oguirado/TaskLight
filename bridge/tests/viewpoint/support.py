"""Shared helpers for the U40 oracle. Stdlib only, synthetic run dirs only."""
import json, os, pathlib, shutil, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
BASE = 1700000000
SECRET = "SECRET-MARKER-9f3a1c77"
RUNNER = ("import sys, runpy; sys.path.insert(0, %r); mod = sys.argv[1]; sys.argv = [mod] + sys.argv[2:]; "
          "runpy.run_module(mod, run_name='__main__', alter_sys=True)" % str(REPO))


def clean_env(home):
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON") and not k.startswith("CW_")}
    env["CW_HOME"] = str(home)
    return env


def run_cli(args, home, timeout=30):
    return subprocess.run([sys.executable, "-I", "-c", RUNNER, "bridge.viewpoint", *map(str, args)],
                          capture_output=True, cwd=str(REPO), env=clean_env(home), timeout=timeout)


def _w(path, obj, mtime=None):
    p = pathlib.Path(path)
    p.write_text(obj if isinstance(obj, str) else json.dumps(obj))
    if mtime is not None:
        os.utime(p, (mtime, mtime))
    return p


class RunBuilder:
    """Writes one synthetic run dir following the SPEC_U40 schema."""

    def __init__(self, root, run_id="abcdef123456"):
        self.run_id = run_id
        self.dir = pathlib.Path(root) / run_id
        self.dir.mkdir(parents=True, exist_ok=True)
        self.t = BASE

    def _tick(self):
        self.t += 10
        return self.t

    def intent(self, pid, goal="find the thing", atype="click", role="link", name="Google DeepMind",
               text=None, mtime=None, extra=None):
        action = {"type": atype}
        if text is not None:
            action["text"] = text
        target = {}
        if role is not None:
            target["role"] = role
        if name is not None:
            target["name"] = name
        target["box"] = [1, 2, 3, 4]
        obj = {"goal": goal, "action": action, "expectation": {"visible": "x"}, "target": target}
        obj.update(extra or {})
        _w(self.dir / ("intent-%s.json" % pid), obj, mtime if mtime is not None else self._tick())
        return self

    def dispatch(self, did="1"):
        _w(self.dir / ("dispatch-mw-%s.json" % did), {"dispatched": True}, self._tick())
        return self

    def receipt(self, pid, status="verified", reason=None, mtime=None, raw=None):
        ver = {"status": status}
        if reason is not None:
            ver["reason"] = reason
        obj = raw if raw is not None else {"action": {"type": "click"}, "target": {"role": "link"},
                                           "verification": ver, "rebound": False}
        _w(self.dir / ("receipt-%s.json" % pid), obj, mtime if mtime is not None else self._tick())
        return self

    def moves(self, n=1):
        _w(self.dir / "moves.json", [{"i": i} for i in range(n)], self._tick())
        return self

    def report(self, rc=0, verdict="PASS"):
        _w(self.dir / "report.json", {"schema": "metaviewer.mw_run/v1", "rc": rc, "verdict_code": verdict,
                                      "moves": [], "attempts": []}, self._tick())
        return self

    def frame(self):
        (self.dir / "frame-1.rgb").write_bytes(b"\x00\x01\x02RAWPIXELS" * 4)
        return self

    def raw(self, name, content, mtime=None):
        _w(self.dir / name, content, mtime if mtime is not None else self._tick())
        return self


def snapshot(root):
    """{relpath: (kind, size, mtime_ns, sha-ish content bytes)} without following symlinks."""
    out = {}
    root = pathlib.Path(root)
    for dp, dns, fns in os.walk(root, followlinks=False):
        for n in dns + fns:
            p = pathlib.Path(dp) / n
            st = p.lstat()
            data = p.read_bytes() if p.is_file() and not p.is_symlink() else b""
            out[str(p.relative_to(root))] = (st.st_mode, st.st_size, st.st_mtime_ns, data)
    return out


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="u40-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.home = self.tmp / "cwhome"
        self.root = self.tmp / "runs"
        self.root.mkdir()
        self._old = os.environ.get("CW_HOME")
        os.environ["CW_HOME"] = str(self.home)
        self.addCleanup(self._restore)
        self.now = [BASE * 1000 + 500000]

    def _restore(self):
        if self._old is None:
            os.environ.pop("CW_HOME", None)
        else:
            os.environ["CW_HOME"] = self._old

    def clock(self):
        self.now[0] += 1
        return self.now[0]

    def run_builder(self, run_id="abcdef123456"):
        return RunBuilder(self.root, run_id)

    def make(self, room="viewpoint", **kw):
        from bridge.viewpoint.observer import ViewpointObserver
        return ViewpointObserver(str(self.root), room, home=str(self.home), clock=self.clock, **kw)

    def events(self, room="viewpoint"):
        from bridge.room import store
        try:
            evs, _ = store.read(room, home=str(self.home))
        except Exception:
            return []
        return evs

    def cursor_path(self):
        return self.home / "observers" / "viewpoint.json"
