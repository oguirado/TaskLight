"""store.py: layout, perms, atomic writes, validation, refusal (acceptance 7), limits."""
import json, os, pathlib, stat
from . import support as S
from bridge.models import store

OK = dict(S.ep(None, id="a1", base_url="http://127.0.0.1:8080/v1"))


def mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)


class Layout(S.Base):
    def test_save_and_load_roundtrip_with_perms(self):
        old = os.umask(0)
        try:
            store.save_endpoints(self.home, [OK])
            store.set_key(self.home, "a1", "k-value-1")
        finally:
            os.umask(old)
        d = self.home / "models"
        self.assertEqual(mode(d), 0o700)
        self.assertEqual(mode(d / "endpoints.json"), 0o600)
        self.assertEqual(mode(d / "keys.json"), 0o600)
        self.assertEqual(json.loads((d / "endpoints.json").read_text()), {"v": 1, "endpoints": [OK]})
        self.assertEqual(json.loads((d / "keys.json").read_text()), {"v": 1, "keys": {"a1": "k-value-1"}})
        st = store.load(self.home)
        self.assertEqual(st["endpoints"], [OK])
        self.assertEqual(st["keys"], {"a1": "k-value-1"})
        self.assertFalse(st["refused"])
        self.assertNotIn("k-value-1", (d / "endpoints.json").read_text())

    def test_no_temp_files_left_and_atomic_replace(self):
        store.save_endpoints(self.home, [OK])
        first = os.stat(self.home / "models" / "endpoints.json").st_ino
        store.save_endpoints(self.home, [OK, dict(OK, id="a2")])
        self.assertEqual(sorted(p.name for p in (self.home / "models").iterdir()), ["endpoints.json"])
        self.assertNotEqual(first, os.stat(self.home / "models" / "endpoints.json").st_ino, "os.replace swaps the inode")

    def test_missing_store_loads_empty_not_refused(self):
        st = store.load(self.home)
        self.assertEqual((st["endpoints"], st["keys"], st["refused"]), ([], {}, False))

    def test_remove_drops_endpoint_and_key(self):
        store.save_endpoints(self.home, [OK, dict(OK, id="a2")])
        store.set_key(self.home, "a1", "kk")
        store.set_key(self.home, "a2", "k2")
        store.remove(self.home, "a1")
        st = store.load(self.home)
        self.assertEqual([e["id"] for e in st["endpoints"]], ["a2"])
        self.assertEqual(st["keys"], {"a2": "k2"})

    def test_set_key_clear_and_unknown(self):
        store.save_endpoints(self.home, [OK])
        store.set_key(self.home, "a1", "kk")
        store.set_key(self.home, "a1", None)
        self.assertEqual(store.load(self.home)["keys"], {})
        with self.assertRaises(KeyError):
            store.set_key(self.home, "nope", "x")
        with self.assertRaises(KeyError):
            store.remove(self.home, "nope")


class Validation(S.Base):
    def bad(self, **kw):
        e = dict(OK)
        e.update(kw)
        with self.assertRaises(ValueError, msg=repr(kw)):
            store.validate_endpoint(e)
        with self.assertRaises(ValueError, msg=repr(kw)):
            store.save_endpoints(self.home, [e])

    def test_valid_shapes(self):
        store.validate_endpoint(OK)
        store.validate_endpoint(dict(OK, rung=1))
        store.validate_endpoint(dict(OK, base_url="https://localhost:8443/v1"))
        store.validate_endpoint(dict(OK, kind="remote-openai-compatible", base_url="https://api.example.invalid/v1"))
        store.validate_endpoint(dict(OK, id="a" * 32, label="x" * 64, model="m" * 128))

    def test_id(self):
        for i in ("", "A1", "-a", "a_b", "a" * 33, "a b", "é", 7, None):
            self.bad(id=i)

    def test_kind(self):
        for k in ("local", "remote", "", None, "Local-openai-compatible"):
            self.bad(kind=k)

    def test_lengths(self):
        self.bad(label="x" * 65)
        self.bad(model="m" * 129)
        self.bad(model="")
        self.bad(label=5)

    def test_base_url(self):
        for u in ("http://user:pw@127.0.0.1/v1", "http://127.0.0.1/v1?x=1", "http://127.0.0.1/v1#f",
                  "ftp://127.0.0.1/v1", "file:///etc/passwd", "127.0.0.1:80/v1", "", None, "http://"):
            self.bad(base_url=u)

    def test_remote_rules(self):
        r = dict(kind="remote-openai-compatible")
        self.bad(base_url="http://api.example.invalid/v1", **r)
        self.bad(base_url="https://api.example.invalid/v1", allow_private=True, **r)

    def test_bool_and_rung_types(self):
        self.bad(allow_private="no")
        self.bad(enabled=1)
        for r in (0, 4, "2", True, 2.0):
            self.bad(rung=r)

    def test_unknown_keys_refused(self):
        self.bad(api_key="x")

    def test_limits(self):
        many = [dict(OK, id="e%d" % i) for i in range(17)]
        with self.assertRaises(ValueError):
            store.save_endpoints(self.home, many)
        store.save_endpoints(self.home, many[:16])
        self.assertEqual(len(store.load(self.home)["endpoints"]), 16)

    def test_load_rejects_oversize_store(self):
        S.write_store(self.home, [OK])
        (self.home / "models" / "endpoints.json").write_text(json.dumps({"v": 1, "endpoints": [OK], "pad": "x" * 70000}))
        os.chmod(self.home / "models" / "endpoints.json", 0o600)
        self.assertTrue(store.load(self.home)["refused"])

    def test_load_rejects_garbage_json_and_wrong_version(self):
        for body in ("not json", json.dumps({"v": 2, "endpoints": []}), json.dumps({"endpoints": []}), "[]"):
            S.write_store(self.home, [])
            f = self.home / "models" / "endpoints.json"
            f.write_text(body)
            os.chmod(f, 0o600)
            self.assertEqual(store.load(self.home)["endpoints"], [], body)


class Refusal(S.Base):
    """Acceptance 7: any permission/symlink/ownership defect refuses the whole store."""

    def refused(self):
        st = store.load(self.home)
        self.assertTrue(st["refused"])
        self.assertEqual((st["endpoints"], st["keys"]), ([], {}))

    def test_good_modes_load(self):
        S.write_store(self.home, [OK], {"a1": "kk"})
        st = store.load(self.home)
        self.assertFalse(st["refused"])
        self.assertEqual([e["id"] for e in st["endpoints"]], ["a1"])

    def test_endpoints_file_group_or_world_readable(self):
        for m in (0o644, 0o640, 0o604, 0o660, 0o666):
            S.write_store(self.home, [OK], {"a1": "kk"}, file_mode=0o600)
            os.chmod(self.home / "models" / "endpoints.json", m)
            self.refused()

    def test_keys_file_loose(self):
        S.write_store(self.home, [OK], {"a1": "kk"})
        os.chmod(self.home / "models" / "keys.json", 0o644)
        self.refused()

    def test_directory_loose(self):
        for m in (0o755, 0o750, 0o705):
            S.write_store(self.home, [OK], {"a1": "kk"})
            os.chmod(self.home / "models", m)
            self.refused()

    def test_symlinked_file(self):
        S.write_store(self.home, [OK])
        d = self.home / "models"
        real = self.tmp / "real.json"
        real.write_text((d / "endpoints.json").read_text())
        os.chmod(real, 0o600)
        (d / "endpoints.json").unlink()
        (d / "endpoints.json").symlink_to(real)
        self.refused()

    def test_symlinked_keys_file(self):
        S.write_store(self.home, [OK], {"a1": "kk"})
        d = self.home / "models"
        real = self.tmp / "realkeys.json"
        real.write_text((d / "keys.json").read_text())
        os.chmod(real, 0o600)
        (d / "keys.json").unlink()
        (d / "keys.json").symlink_to(real)
        self.refused()

    def test_symlinked_directory(self):
        S.write_store(self.tmp / "elsewhere", [OK])
        (self.home / "models").symlink_to(self.tmp / "elsewhere" / "models")
        self.refused()

    def test_not_a_regular_file(self):
        S.write_store(self.home, [OK])
        f = self.home / "models" / "endpoints.json"
        f.unlink()
        os.mkfifo(f, 0o600)
        self.refused()

    def test_writes_refuse_on_loose_directory(self):
        S.write_store(self.home, [OK])
        os.chmod(self.home / "models", 0o755)
        with self.assertRaises((ValueError, OSError)):
            store.set_key(self.home, "a1", "kk")
        self.assertFalse((self.home / "models" / "keys.json").exists())

    def test_symlinked_endpoints_target_not_followed_on_write(self):
        S.write_store(self.home, [OK])
        victim = self.tmp / "victim.txt"
        victim.write_text("keep")
        os.chmod(victim, 0o600)
        tmpname = self.home / "models" / "endpoints.json"
        tmpname.unlink()
        tmpname.symlink_to(victim)
        try:
            store.save_endpoints(self.home, [OK])
        except (ValueError, OSError):
            pass
        self.assertEqual(victim.read_text(), "keep")
