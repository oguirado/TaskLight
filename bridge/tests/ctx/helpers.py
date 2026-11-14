"""Shared oracle helpers (stdlib only)."""
import builtins
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
FIXTURES_V1 = os.path.join(REPO, "fixtures", "ctx", "v1")
SCHEMA = "ctx.resp/v1"
ENVELOPE_KEYS = {"schema", "ok", "rc", "verb", "data", "sha256"}
RCS = (0, 2, 4, 6, 7, 124)
HAVE_GIT = shutil.which("git") is not None

from bridge.ctx.paths import Roots  # noqa: E402


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def canon(obj) -> str:
    """Test-side reference canonical JSON (independent of the module under test)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def seal(verb, rc, data, **over):
    r = {"schema": SCHEMA, "ok": rc == 0, "rc": rc, "verb": verb, "data": data,
         "sha256": sha(canon(data).encode("utf-8"))}
    r.update(over)
    return r


def D(resp):
    return resp["data"]


def page_size(lines):
    return sum(len(l.encode("utf-8")) + 1 for l in lines)


def codes(resp):
    return {(e["code"], e["path"]) for e in resp["data"].get("errors", [])}


def assert_envelope(tc, resp, verb, rc=None):
    tc.assertEqual(set(resp), ENVELOPE_KEYS)
    tc.assertEqual(resp["schema"], SCHEMA)
    tc.assertEqual(resp["verb"], verb)
    tc.assertIn(resp["rc"], RCS)
    tc.assertIs(type(resp["rc"]), int)
    tc.assertIs(resp["ok"], resp["rc"] == 0)
    tc.assertEqual(resp["sha256"], sha(canon(resp["data"]).encode("utf-8")))
    if rc is not None:
        tc.assertEqual(resp["rc"], rc)


class TmpCase(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.mkdtemp(prefix="ctxo_")
        self.addCleanup(shutil.rmtree, self._td, True)
        self.base = os.path.realpath(self._td)
        self.root = os.path.join(self.base, "ROOT_DIR")
        os.mkdir(self.root)
        self.outside = os.path.join(self.base, "OUTSIDE_SECRET_DIR")
        os.mkdir(self.outside)
        self.roots = Roots((self.root,))

    def w(self, rel, content=b"", base=None):
        p = os.path.join(base or self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        if isinstance(content, str):
            content = content.encode("utf-8")
        with open(p, "wb") as f:
            f.write(content)
        return p


class Clock:
    """Injected monotonic: first call returns `first`, every later call `later` (seconds)."""
    def __init__(self, first=0.0, later=3600.0):
        self.first, self.later, self.n = first, later, 0

    def __call__(self):
        self.n += 1
        return self.first if self.n == 1 else self.later


class ReadSpy:
    """Records every open()/os.open/scandir/listdir whose path (or realpath) contains marker."""
    def __init__(self, marker):
        self.marker, self.hits, self._p = marker, [], []

    def _rec(self, a):
        if isinstance(a, (str, bytes, os.PathLike)):
            s = os.fsdecode(a)
            if self.marker in s or self.marker in os.path.realpath(s):
                self.hits.append(s)

    def _wrap(self, orig):
        def f(*a, **k):
            if a:
                self._rec(a[0])
            return orig(*a, **k)
        return f

    def __enter__(self):
        for obj, name in ((builtins, "open"), (io, "open"), (os, "open"),
                          (os, "scandir"), (os, "listdir")):
            p = mock.patch.object(obj, name, self._wrap(getattr(obj, name)))
            p.start()
            self._p.append(p)
        return self

    def __exit__(self, *e):
        for p in self._p:
            p.stop()


def run_cli(*args, cwd=None):
    code = ("import sys,runpy;sys.path.insert(0,%r);"
            "runpy.run_module('bridge.ctx',run_name='__main__',alter_sys=True)" % REPO)
    p = subprocess.run([sys.executable, "-I", "-c", code, *args], capture_output=True,
                       cwd=cwd or REPO, timeout=60)
    return p.returncode, p.stdout, p.stderr


GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t"}


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, env=GIT_ENV, check=True,
                          capture_output=True, text=True).stdout.strip()


def clk_tck():
    return os.sysconf("SC_CLK_TCK")


def make_proc(proc_root, pid, comm="proc", starttime_ticks=0, rss_kib=2048, state="S"):
    d = os.path.join(proc_root, str(pid))
    os.makedirs(d, exist_ok=True)
    f = {i: "0" for i in range(3, 53)}
    f[3], f[22] = state, str(starttime_ticks)
    with open(os.path.join(d, "stat"), "w") as fh:
        fh.write("%d (%s) %s\n" % (pid, comm, " ".join(f[i] for i in range(3, 53))))
    with open(os.path.join(d, "status"), "w") as fh:
        fh.write("Name:\t%s\nState:\t%s (x)\nVmRSS:\t%8d kB\n" % (comm, state, rss_kib))
