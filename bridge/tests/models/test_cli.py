"""python3 -m bridge.models: add/remove/list/probe/set-key. rc 0 ok, 2 usage/refusal, 1 I/O. Acceptance 6, 7, 8, 9."""
import json, os, stat, threading, time
from io import StringIO
from unittest.mock import patch

from bridge.models import cli, store
from bridge.tests.xplat_support import windows_filesystem
from . import support as S


def mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)


class Cli(S.Base):
    def test_windows_cli_reports_store_refusal_when_supported(self):
        store.save_endpoints(self.home, [])
        (self.home / "models" / "endpoints.json").chmod(0o644)
        stdout, stderr = StringIO(), StringIO()
        with windows_filesystem(), patch.object(cli, "_home", return_value=self.home), \
                patch.object(store._windows_acl, "available", return_value=True):
            self.assertEqual(cli.main(["list"], stdout=stdout, stderr=stderr), 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), cli._REFUSED_MSG % store.store_dir(self.home))

    def run_cli(self, *args, stdin=b""):
        return S.run_cli(list(args), self.home, stdin=stdin)

    def add(self, fake=None, id="fake", *extra, url=None, kind="local"):
        return self.run_cli("add", "--id", id, "--kind", kind, "--base-url", url or fake.base_url, "--model", "m1", *extra)

    def endpoints(self):
        return json.loads((self.home / "models" / "endpoints.json").read_text())["endpoints"]

    def listed(self):
        p = self.run_cli("list")
        self.assertEqual(p.returncode, 0, p.stderr)
        d = json.loads(p.stdout)
        return d["endpoints"] if isinstance(d, dict) else d

    # ---- add
    def test_add_local_writes_store_0600_0700(self):
        f = self.fake()
        p = self.add(f, "fake", "--label", "My Fake", "--rung", "2")
        self.assertEqual(p.returncode, 0, p.stderr)
        e, = self.endpoints()
        self.assertEqual((e["id"], e["kind"], e["label"], e["model"], e["base_url"], e["rung"]),
                         ("fake", "local-openai-compatible", "My Fake", "m1", f.base_url, 2))
        self.assertIs(e["allow_private"], False)
        self.assertIs(e["enabled"], True)
        self.assertEqual(mode(self.home / "models"), 0o700)
        self.assertEqual(mode(self.home / "models" / "endpoints.json"), 0o600)

    def test_add_local_allow_private_flag(self):
        f = self.fake()
        self.assertEqual(self.add(f, "fake", "--allow-private").returncode, 0)
        self.assertIs(self.endpoints()[0]["allow_private"], True)

    def test_add_local_non_loopback_now_refused(self):
        p = self.add(url="http://%s/v1" % S.NOT_LOOPBACK)
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertFalse((self.home / "models" / "endpoints.json").exists())

    def test_add_remote_rules(self):
        ok = self.add(url="https://api.example.invalid/v1", kind="remote")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(self.endpoints()[0]["kind"], "remote-openai-compatible")
        self.assertEqual(self.add(url="http://api.example.invalid/v1", kind="remote", id="r2").returncode, 2)
        self.assertEqual(self.add(None, "r3", "--allow-private", url="https://api.example.invalid/v1",
                                  kind="remote").returncode, 2)
        self.assertEqual([e["id"] for e in self.endpoints()], ["fake"])

    def test_add_bad_input_rc2(self):
        f = self.fake()
        for args in (["--id", "BAD", "--kind", "local", "--base-url", f.base_url, "--model", "m"],
                     ["--id", "x", "--kind", "weird", "--base-url", f.base_url, "--model", "m"],
                     ["--id", "x", "--kind", "local", "--base-url", "http://u:p@127.0.0.1/v1", "--model", "m"],
                     ["--id", "x", "--kind", "local", "--base-url", f.base_url + "?a=1", "--model", "m"],
                     ["--id", "x", "--kind", "local", "--base-url", f.base_url, "--model", "m", "--rung", "4"],
                     ["--id", "x", "--kind", "local", "--base-url", f.base_url],              # no --model
                     ["--id", "x", "--kind", "local", "--base-url", f.base_url, "--model", "m", "--bogus"]):
            with self.subTest(args=args):
                self.assertEqual(self.run_cli("add", *args).returncode, 2)

    def test_add_17th_endpoint_refused(self):
        S.write_store(self.home, [S.ep(None, id="e%d" % i, base_url="http://127.0.0.1:9/v1") for i in range(16)])
        f = self.fake()
        self.assertEqual(self.add(f, "e16").returncode, 2)

    def test_unknown_verb_and_no_verb(self):
        self.assertEqual(self.run_cli("frobnicate").returncode, 2)
        self.assertEqual(self.run_cli().returncode, 2)

    # ---- list / remove
    def test_list_shows_has_key_never_key(self):
        f = self.fake()
        self.add(f)
        self.assertIs(self.listed()[0]["has_key"], False)
        self.run_cli("set-key", "--id", "fake", stdin=(S.KEY_CANARY + "\n").encode())
        p = self.run_cli("list")
        self.assertNotIn(S.KEY_CANARY.encode(), p.stdout + p.stderr)
        self.assertIs(self.listed()[0]["has_key"], True)

    def test_remove_drops_key_too(self):
        f = self.fake()
        self.add(f)
        self.run_cli("set-key", "--id", "fake", stdin=b"k1\n")
        p = self.run_cli("remove", "--id", "fake")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.endpoints(), [])
        self.assertNotIn("k1", (self.home / "models" / "keys.json").read_text())
        self.assertEqual(self.run_cli("remove", "--id", "fake").returncode, 2)

    # ---- set-key
    def test_set_key_stdin_works_and_is_0600(self):
        f = self.fake()
        self.add(f)
        p = self.run_cli("set-key", "--id", "fake", stdin=(S.KEY_CANARY + "\n").encode())
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn(S.KEY_CANARY.encode(), p.stdout + p.stderr)
        kf = self.home / "models" / "keys.json"
        self.assertEqual(json.loads(kf.read_text())["keys"], {"fake": S.KEY_CANARY})
        self.assertEqual(mode(kf), 0o600)
        self.assertNotIn(S.KEY_CANARY, (self.home / "models" / "endpoints.json").read_text())

    def test_set_key_clear(self):
        f = self.fake()
        self.add(f)
        self.run_cli("set-key", "--id", "fake", stdin=b"abc\n")
        p = self.run_cli("set-key", "--id", "fake", "--clear")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIs(self.listed()[0]["has_key"], False)

    def test_set_key_argv_is_rejected_and_never_echoed(self):
        f = self.fake()
        self.add(f)
        p = self.run_cli("set-key", "--id", "fake", "--key", S.KEY_CANARY)
        self.assertEqual(p.returncode, 2)
        self.assertNotIn(S.KEY_CANARY.encode(), p.stdout + p.stderr, "argparse-style usage errors must not echo argv")
        self.assertFalse((self.home / "models" / "keys.json").exists())

    def test_set_key_unknown_id_and_empty_stdin(self):
        f = self.fake()
        self.add(f)
        self.assertEqual(self.run_cli("set-key", "--id", "nope", stdin=b"k\n").returncode, 2)
        self.assertEqual(self.run_cli("set-key", "--id", "fake", stdin=b"").returncode, 2)

    # ---- probe
    def test_probe_prints_id_state_rung(self):
        f = self.fake()
        self.add(f)
        p = self.run_cli("probe", "--id", "fake")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout), {"id": "fake", "state": "available", "rung": 2})   # safe floor
        self.assertEqual(f.requests[0]["path"], "/v1/models")

    def test_probe_store_rung_and_offline_and_unknown(self):
        f = self.fake()
        self.add(f, "fake", "--rung", "3")
        self.assertEqual(json.loads(self.run_cli("probe", "--id", "fake").stdout)["rung"], 3)
        f.close()
        o = json.loads(self.run_cli("probe", "--id", "fake").stdout)
        self.assertEqual(o["state"], "offline")
        self.assertEqual(self.run_cli("probe", "--id", "nope").returncode, 2)

    # ---- refusal / store defects (acceptance 7)
    def test_cli_refuses_loose_store_rc2_naming_file_not_contents(self):
        S.write_store(self.home, [S.ep(None, id="a1", base_url="http://127.0.0.1:9/v1", label="SECRETLABEL")],
                      {"a1": S.KEY_CANARY}, file_mode=0o644)
        for argv in (["list"], ["probe", "--id", "a1"], ["set-key", "--id", "a1", "--clear"], ["remove", "--id", "a1"]):
            p = self.run_cli(*argv)
            self.assertEqual(p.returncode, 2, (argv, p.stderr))
            if argv[0] == "list":
                self.assertIn(b"endpoints.json", p.stderr + p.stdout)
            self.assertNotIn(b"SECRETLABEL", p.stderr + p.stdout)
            self.assertNotIn(S.KEY_CANARY.encode(), p.stderr + p.stdout)

    def test_cli_refuses_loose_directory_and_symlink(self):
        S.write_store(self.home, [S.ep(None, id="a1", base_url="http://127.0.0.1:9/v1")])
        os.chmod(self.home / "models", 0o755)
        self.assertEqual(self.run_cli("list").returncode, 2)
        os.chmod(self.home / "models", 0o700)
        self.assertEqual(self.run_cli("list").returncode, 0)
        f = self.home / "models" / "endpoints.json"
        real = self.tmp / "real.json"
        real.write_text(f.read_text())
        os.chmod(real, 0o600)
        f.unlink()
        f.symlink_to(real)
        self.assertEqual(self.run_cli("list").returncode, 2)

    def test_cli_io_error_rc1(self):
        blocker = self.tmp / "blocker"
        blocker.write_text("x")                                           # CW_HOME is a file: cannot mkdir under it
        p = S.run_cli(["add", "--id", "x", "--kind", "remote", "--base-url", "https://a.example.invalid/v1",
                       "--model", "m"], self.home, env=S.env_for(self.home, CW_HOME=str(blocker)))
        self.assertEqual(p.returncode, 1, p.stderr)
        self.assertNotIn(b"Traceback", p.stderr)                      # a clean message, not a crash

    def test_cli_never_touches_real_home(self):
        f = self.fake()
        self.add(f)
        self.assertFalse((self.home / "fakehome" / ".context-wall").exists())
        p = S.run_cli(["add", "--id", "h1", "--kind", "local", "--base-url", f.base_url, "--model", "m"], self.home,
                      env=S.env_for(self.home, CW_HOME=""))
        # empty CW_HOME falls back to ~/.context-wall, which here is the tmp HOME (never the real one)
        self.assertIn(p.returncode, (0, 2))
        if p.returncode == 0:
            self.assertTrue((self.home / "fakehome" / ".context-wall" / "models" / "endpoints.json").exists())
