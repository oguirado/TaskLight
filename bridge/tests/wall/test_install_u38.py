"""U38 oracle (G3): the generated launcher must import bridge.room (repo root on the import path).

Fail-first: the U09 launcher only puts bridge/ on sys.path and runs module `wall`, so
`bridge.wall.room_relay` (from bridge.room import store) cannot import and the room relay stays off.
"""
import json, pathlib, re, struct, subprocess, sys, unittest
from . import support as S


def _install(home):
    env = S.clean_env(HOME=str(home))
    p = subprocess.run([sys.executable, "-I", str(S.INSTALL), "--apply", "--extension-id", S.PINNED_ID], capture_output=True, env=env, timeout=30)
    assert p.returncode == 0, p.stderr
    hits = list(pathlib.Path(home).rglob(S.HOST_NAME + ".json"))
    assert len(hits) == 1
    return pathlib.Path(json.loads(hits[0].read_text())["path"])


def _frames(raw):
    out, i = [], 0
    while i + 4 <= len(raw):
        (n,) = struct.unpack("<I", raw[i:i + 4])
        out.append(json.loads(raw[i + 4:i + 4 + n]))
        i += 4 + n
    return out


class LauncherImportsRoom(S.Base):
    def setUp(self):
        super().setUp()
        self.home = self.tmp / "home"; self.home.mkdir()
        self.elsewhere = self.tmp / "unrelated_cwd"; self.elsewhere.mkdir()
        self.launcher = _install(self.home)

    def test_launcher_text_puts_repo_root_on_the_import_path(self):
        t = self.launcher.read_text()
        # the repo root itself, not only its bridge/ child
        self.assertRegex(t, re.escape(str(S.REPO)) + r"(?!/bridge)", "launcher must put the repo root (parent of bridge/) on sys.path")
        for tok in ("-I", "wall", "host"):   # existing U09 contract stays
            self.assertIn(tok, t)

    def test_launcher_runs_from_unrelated_cwd_and_the_room_relay_loads(self):
        cw_home = self.tmp / "cwhome"; cw_home.mkdir()
        spool = self.tmp / "spool"; spool.mkdir()
        cfg = {"v": 1, "extensionId": S.PINNED_ID, "spoolDir": str(spool), "projects": [],
               "rooms": {"allow": [{"room": "demo", "tier": "private"}], "agent": "wall-user", "home": str(cw_home)}}
        cfg_path = self.tmp / "wall.config.json"; cfg_path.write_text(json.dumps(cfg))
        bye = json.dumps({"t": "bye", "v": 1}, separators=(",", ":")).encode()
        env = S.clean_env(HOME=str(self.home))
        p = subprocess.run([str(self.launcher), "--config", str(cfg_path), S.ORIGIN],
                           input=struct.pack("<I", len(bye)) + bye, capture_output=True, env=env,
                           cwd=str(self.elsewhere), timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr.decode(errors="replace"))
        frames = _frames(p.stdout)
        self.assertEqual(frames[0]["t"], "hello")
        hellos = [f for f in frames if f.get("t") == "room_hello"]
        self.assertEqual(len(hellos), 1, "room relay did not load (bridge.room import failed): " + repr(frames))
        self.assertEqual(hellos[0]["rooms"][0]["room"], "demo")
        self.assertEqual(hellos[0]["agent"], "wall-user")


if __name__ == "__main__":
    unittest.main()
