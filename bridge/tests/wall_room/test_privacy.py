"""Never log text; stdlib-only; redaction comes from bridge.wall.emit; no spool path."""
import ast, contextlib, io, logging, os, re, subprocess, sys, unittest
from . import support as S

SCENARIO = r'''
import os, sys, json
sys.path.insert(0, %(repo)r)
os.environ["CW_HOME"] = %(home)r
from bridge.room import store
from bridge.wall import room_relay as rr
M = %(marker)r
FAKE = %(fake)r
home = %(home)r
cfg = rr.load_room_config({"rooms": {"allow": [{"room": "demo", "tier": "private"}], "agent": "wall-user"}})
store.post("demo", "orch", "open", "open " + M, home=home)
r = rr.RoomRelay(cfg, lambda f: None, home=home, clock=lambda: 5.0)
r.prime()
store.post("demo", "agent-a", "question", "live " + M + " " + FAKE, home=home)
with open(os.path.join(home, "rooms", "demo", "events.jsonl"), "ab") as f:
    f.write(b"{garbage " + M.encode() + b"\n")
r.poll()
r.handle({"t": "room_sync", "v": 1, "rid": "s", "since": {"demo": 0}})
r.handle({"t": "room_post", "v": 1, "rid": "p", "room": "demo", "act": "question", "text": M + " " + FAKE})
r.handle({"t": "room_post", "v": 1, "rid": "q", "room": "nope", "act": "question", "text": M})
r.handle({"t": "room_post", "v": 1, "rid": "t", "room": "demo", "act": "question", "text": M * 2000})
r.handle({"t": "room_post", "v": 1, "rid": "u", "room": "demo", "act": "question", "text": M, "agent": "x"})
r.handle({"t": "room_post", "v": 1, "rid": "v", "room": "demo", "act": "question", "text": 5})
r.stats()
'''


class NoTextLeaks(S.Base):
    def test_in_process_stdout_stderr_logging(self):
        r = self.relay()
        r.prime()
        out, err = io.StringIO(), io.StringIO()
        with self.assertNoLogs(level=logging.DEBUG), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            logging.getLogger().setLevel(logging.DEBUG)
            from bridge.room import store
            store.post("demo", "agent-a", "question", "live " + S.MARKER, home=self.home)
            S.write_raw(self.home, "demo", [], raw_lines=[b"{bad " + S.MARKER.encode() + b"\n"])
            r.poll()
            r.handle({"t": "room_sync", "v": 1, "rid": "s", "since": {"demo": 0}})
            r.handle(self.post_frame(S.MARKER))
            r.handle(self.post_frame(S.MARKER * 3000, rid="long"))
            r.handle(self.post_frame(S.MARKER, room="nope", rid="n"))
            r.handle(self.post_frame(S.MARKER, rid="bad", agent="x"))
            with S.patched_redact(S.residue_redact):
                r.poll()
                r.handle({"t": "room_sync", "v": 1, "rid": "s2", "since": {"demo": 0}})
            self.send.fail = True
            r.poll()
            r.stats()
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(err.getvalue(), "")

    def test_subprocess_fd_level_silence(self):
        home = os.path.join(self._tmp, "sub")
        os.makedirs(home)
        code = SCENARIO % {"repo": str(S.REPO), "home": home, "marker": S.MARKER, "fake": S.FAKE_SECRET}
        env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON") and not k.startswith("CW_")}
        p = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, env=env, timeout=60,
                           cwd=str(S.REPO))
        self.assertEqual(p.returncode, 0, p.stderr.decode(errors="replace")[-400:])
        self.assertEqual(p.stdout, b"")
        self.assertEqual(p.stderr, b"")


class StaticShape(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = S.RELAY_SRC.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.src)

    def imported_modules(self):
        mods = set()
        for n in ast.walk(self.tree):
            if isinstance(n, ast.Import):
                mods.update(a.name for a in n.names)
            elif isinstance(n, ast.ImportFrom):
                mods.add(("." * n.level) + (n.module or ""))
        return mods

    def test_stdlib_only(self):
        for m in self.imported_modules():
            top = m.split(".")[0]
            if m.startswith(".") or top == "bridge":
                continue
            self.assertIn(top, sys.stdlib_module_names, m)

    def test_redaction_from_bridge_wall_emit(self):
        ok = any(m in ("bridge.wall.emit", ".emit", "bridge.wall", ".") for m in self.imported_modules())
        self.assertTrue(ok, "U37a must take redact from bridge.wall.emit")
        self.assertRegex(self.src, r"\bredact\b")

    def test_reads_through_u33_store(self):
        self.assertTrue(any(m.startswith("bridge.room") or m.startswith("..room") for m in self.imported_modules()),
                        self.imported_modules())

    def test_no_output_or_logging_primitives(self):
        self.assertNotIn("logging", {m.split(".")[0] for m in self.imported_modules()})
        for pat in (r"\bprint\s*\(", r"sys\.std(out|err)", r"\bwarnings\b", r"traceback", r"os\.write\("):
            self.assertIsNone(re.search(pat, self.src), pat)

    def test_does_not_use_u09_spool_emit(self):
        self.assertIsNone(re.search(r"\bemit\.emit\s*\(|import\s+emit\b.*\bemit\s*\(|from\s+\S*emit\s+import[^\n]*\bemit\b",
                                    self.src))

    def test_public_surface(self):
        names = {n.name for n in self.tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
        self.assertLessEqual({"load_room_config", "sanitize_event", "RoomRelay"}, names)
        assigned = {t.id for n in self.tree.body if isinstance(n, ast.Assign) for t in n.targets
                    if isinstance(t, ast.Name)}
        self.assertIn("ROOM_LIMITS", assigned)
