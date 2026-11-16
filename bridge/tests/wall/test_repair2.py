"""Repair loop 2 regression tests (review HOLD, DISP_03 BLOCKING items only)."""
import importlib, io, json, os, pathlib, select, subprocess, sys, time, unittest
from unittest import mock
from . import support as S

E = importlib.import_module("bridge.wall.emit")
O = importlib.import_module("bridge.wall.observers")
H = importlib.import_module("bridge.wall.native_host")


class FakeWindowCtx:
    def __init__(self, path):
        self.path = path

    def tail(self, path, n):
        raw = pathlib.Path(self.path).read_text().split("\n")
        if raw and raw[-1] == "":
            raw.pop()
        return {"lines": raw[-n:], "line_count": len(raw), "cut": False}


class Rec:
    def __init__(self):
        self.calls = []

    def __call__(self, project, kind, text, source="agent", **kw):
        self.calls.append((kind, text, source))
        return {"ok": True, "rc": 0, "seq": len(self.calls), "sha256": "0" * 64}


class G1TranscriptKind(S.Base):
    def test_non_string_kind_becomes_output(self):
        for bad in ("[]", "{}", '["output"]', '{"a":1}', "5", "null", "true"):
            t = self.tmp / ("t%d.jsonl" % abs(hash(bad)))
            t.write_text("seed\n")
            rec = Rec()
            ob = O.TranscriptObserver("api", [str(t)], ctx=FakeWindowCtx(str(t)), emit_fn=rec)
            ob.poll()
            with open(t, "a") as fh:
                fh.write('{"kind":%s,"text":"hello"}\n' % bad)
            ob.poll()
            self.assertEqual(rec.calls, [("output", "hello", "agent")], bad)

    def test_non_string_kind_fallback_path_without_ctx(self):
        t = self.tmp / "nc.jsonl"
        t.write_text("")
        rec = Rec()
        ob = O.TranscriptObserver("api", [str(t)], emit_fn=rec)
        ob.poll()
        with open(t, "a") as fh:
            fh.write('{"kind":[],"text":"hello"}\n')
        ob.poll()
        self.assertEqual([c[:2] for c in rec.calls], [("output", "hello")])


def cmd(args, home):
    return subprocess.run([sys.executable, "-I", str(S.INSTALL), *args], capture_output=True,
                          env=S.clean_env(HOME=str(home)), timeout=30)


class G2InstallOwnership(S.Base):
    def setUp(self):
        super().setUp()
        self.home = self.tmp / "home"
        self.home.mkdir()

    def _nm_dir(self):
        # Learn where the installer writes, then undo it.
        self.assertEqual(cmd(["--apply", "--extension-id", S.PINNED_ID], self.home).returncode, 0)
        m = list(self.home.rglob(S.HOST_NAME + ".json"))
        self.assertEqual(len(m), 1)
        d = m[0].parent
        manifest = json.loads(m[0].read_text())
        self.assertEqual(cmd(["--remove"], self.home).returncode, 0)
        self.assertEqual(list(self.home.rglob(S.HOST_NAME + "*")), [])
        return d, manifest

    def test_apply_does_not_overwrite_foreign_launcher(self):
        d, manifest = self._nm_dir()
        launcher = pathlib.Path(manifest["path"])
        launcher.write_text("#!/bin/sh\necho MINE_DO_NOT_TOUCH\n")
        cmd(["--apply", "--extension-id", S.PINNED_ID], self.home)
        self.assertEqual(launcher.read_text(), "#!/bin/sh\necho MINE_DO_NOT_TOUCH\n")

    def test_remove_keeps_foreign_manifest_with_same_name(self):
        d, manifest = self._nm_dir()
        foreign = dict(manifest, path=str(self.home / "other-host.sh"),
                       description="someone else's host")
        mp = d / (S.HOST_NAME + ".json")
        mp.write_text(json.dumps(foreign))
        cmd(["--remove"], self.home)
        self.assertTrue(mp.exists(), "--remove deleted a manifest it never wrote")
        self.assertEqual(json.loads(mp.read_text()), foreign)


class G3SpoolMemory(S.Base):
    def test_huge_newline_free_spool_record_is_bounded(self):
        cfg = self.cfg()
        with open(S.spool_dir(cfg) / "api.jsonl", "wb") as fh:
            chunk = b"x" * (1 << 20)
            for _ in range(128):
                fh.write(chunk)
        h = S.start_host(self, cfg)
        self.assertEqual(h.read_frame(10)["t"], "hello")
        time.sleep(2.0)
        self.assertIsNone(h.p.poll(), "host died")
        hwm = None
        with open("/proc/%d/status" % h.p.pid) as f:
            for line in f:
                if line.startswith("VmHWM:"):
                    hwm = int(line.split()[1])
        self.assertIsNotNone(hwm)
        self.assertLess(hwm, 64 * 1024, "host peak RSS %d kB on a 128 MiB record" % hwm)


class _FdStdin:
    def __init__(self, fd):
        self._fd = fd

    def fileno(self):
        return self._fd


class G4FatalBeforePoll(S.Base):
    def test_no_event_after_fatal_buffered_input(self):
        cfg = self.cfg()
        spool = S.spool_dir(cfg) / "api.jsonl"
        line = E.canonical_json({"source": "agent", "projectId": "api", "sourceSeq": 1,
                                 "ts": S.TS, "kind": "output", "text": "late-event"})
        r, w = os.pipe()
        self.addCleanup(lambda: [os.close(x) for x in (r, w) if x >= 0])
        real = select.select
        fired = []

        def hooked(rl, wl, xl, timeout=None):
            if not fired:
                fired.append(1)
                with open(spool, "ab") as fh:
                    fh.write(line.encode() + b"\n")
                bad = b"{bad json"
                os.write(w, len(bad).to_bytes(4, "little") + bad)
            return real(rl, wl, xl, timeout)

        out = io.BytesIO()
        with mock.patch.object(select, "select", hooked):
            rc = H.main(["--config", cfg, S.ORIGIN], stdin=_FdStdin(r), stdout=out,
                        stderr=io.StringIO())
        self.assertEqual(rc, 2)
        self.assertNotIn(b"late-event", out.getvalue())


if __name__ == "__main__":
    unittest.main()
