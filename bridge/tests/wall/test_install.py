import json, os, pathlib, subprocess, sys, unittest
from . import support as S


def run(home, *args):
    env = S.clean_env(HOME=str(home))
    return subprocess.run([sys.executable, "-I", str(S.INSTALL), *args], capture_output=True, env=env, timeout=30)


def files(d):
    return sorted(str(p.relative_to(d)) for p in pathlib.Path(d).rglob("*") if p.is_file())


def find_manifest(home):
    hits = [p for p in pathlib.Path(home).rglob(S.HOST_NAME + ".json")]
    return hits[0] if len(hits) == 1 else None


class Installer(S.Base):
    def setUp(self):
        super().setUp()
        self.home = self.tmp / "home"; self.home.mkdir()
        self.bridge_before = S.tree_bytes(S.BRIDGE / "wall")

    def tearDown(self):
        self.assertEqual(S.tree_bytes(S.BRIDGE / "wall"), self.bridge_before)   # installer never writes into the repo

    # W13
    def test_w13_dry_run_default_writes_nothing(self):
        p = run(self.home)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(files(self.home), [])
        out = p.stdout.decode()
        for needle in (S.PINNED_ID, S.HOST_NAME, "NativeMessagingHosts", '"allowed_origins"'):
            self.assertIn(needle, out)
        p2 = run(self.home, "--dry-run") if False else None

    def test_w13_apply_writes_exact_manifest(self):
        p = run(self.home, "--apply")
        self.assertEqual(p.returncode, 0, p.stderr)
        m = find_manifest(self.home)
        self.assertIsNotNone(m, files(self.home))
        self.assertEqual(m.parent.name, "NativeMessagingHosts")
        d = json.loads(m.read_text())
        self.assertEqual(set(d), {"name", "description", "path", "type", "allowed_origins"})
        self.assertEqual(d["name"], S.HOST_NAME)
        self.assertEqual(d["type"], "stdio")
        self.assertEqual(d["allowed_origins"], [S.ORIGIN])          # exactly one origin, no wildcard
        self.assertTrue(os.path.isabs(d["path"]))
        launcher = pathlib.Path(d["path"])
        self.assertTrue(launcher.is_file() and os.access(launcher, os.X_OK), "launcher must exist and be executable")
        t = launcher.read_text()
        for tok in ("-I", "wall", "host"):
            self.assertIn(tok, t)
        self.assertTrue(str(launcher).startswith(str(self.home)) or str(launcher).startswith(str(S.BRIDGE)))
        self.assertEqual(run(self.home, "--apply").returncode, 0)    # re-apply over own file is fine
        self.assertEqual(json.loads(m.read_text()), d)

    def test_custom_extension_id_and_invalid_ids(self):
        good = "a" * 16 + "p" * 16
        self.assertEqual(run(self.home, "--apply", "--extension-id", good).returncode, 0)
        self.assertEqual(json.loads(find_manifest(self.home).read_text())["allowed_origins"],
                         ["chrome-extension://" + good + "/"])
        h2 = self.tmp / "h2"; h2.mkdir()
        for bad in ("a" * 31, "a" * 33, "q" * 32, "*", "A" * 32, ""):
            p = run(h2, "--apply", "--extension-id", bad)
            self.assertEqual(p.returncode, 2, bad)
            self.assertEqual(files(h2), [], bad)

    def test_w13_remove_deletes_only_what_it_wrote(self):
        run(self.home, "--apply")
        m = find_manifest(self.home)
        launcher = pathlib.Path(json.loads(m.read_text())["path"])
        p = run(self.home, "--remove")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertFalse(m.exists())
        self.assertFalse(launcher.exists() and str(launcher).startswith(str(self.home)))
        self.assertEqual(run(self.home, "--remove").returncode, 0)   # nothing to remove: not an error

    def test_w13_foreign_file_refused_and_untouched(self):
        run(self.home, "--apply")
        m = find_manifest(self.home)
        m.unlink()
        foreign = json.dumps({"name": "com.other.host", "description": "mine", "path": "/bin/true", "type": "stdio",
                              "allowed_origins": ["chrome-extension://" + "b" * 32 + "/"]}).encode()
        m.write_bytes(foreign)
        before = S.tree_bytes(self.home)
        p = run(self.home, "--apply")
        self.assertEqual(p.returncode, 2)
        self.assertEqual(S.tree_bytes(self.home), before)
        run(self.home, "--remove")
        self.assertEqual(m.read_bytes(), foreign)                     # --remove never deletes another host's file
        self.assertEqual(S.tree_bytes(self.home), before)

    def test_unparseable_existing_file_is_not_overwritten(self):
        run(self.home, "--apply")
        m = find_manifest(self.home); m.write_bytes(b"{not json")
        self.assertEqual(run(self.home, "--apply").returncode, 2)
        self.assertEqual(m.read_bytes(), b"{not json")

    def test_conflicting_or_unknown_flags(self):
        self.assertEqual(run(self.home, "--apply", "--remove").returncode, 2)
        self.assertEqual(run(self.home, "--bogus").returncode, 2)
        self.assertEqual(files(self.home), [])


if __name__ == "__main__":
    unittest.main()
