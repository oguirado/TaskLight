"""store.py: layout, perms, atomic writes, validation, refusal (acceptance 7), limits."""
import ctypes
import json, os, pathlib, stat
from ctypes import wintypes
from types import SimpleNamespace
from unittest import mock
from . import support as S
from bridge.models import _windows_acl, store

OK = dict(S.ep(None, id="a1", base_url="http://127.0.0.1:8080/v1"))


def mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)


from bridge.tests.xplat_support import PrivatePermissionsOracle, windows_filesystem


class WindowsStore(S.Base):
    def test_windows_creation_attributes_pass_native_pointer_to_ctypes(self):
        owner_sid = ctypes.create_unicode_buffer("S-1-5-21")
        descriptor = ctypes.create_string_buffer(16)
        address = ctypes.addressof(descriptor)
        pointer_values = []

        class Structure(ctypes.Structure):
            def __init__(self, length, pointer, inherit):
                pointer_values.append(pointer)
                super().__init__(length, pointer, inherit)

        def sid_string(_sid, result):
            ctypes.cast(result, ctypes.POINTER(wintypes.LPWSTR))[0] = ctypes.cast(owner_sid, wintypes.LPWSTR)
            return True

        def descriptor_from_string(_sddl, _revision, result, _size):
            ctypes.cast(result, ctypes.POINTER(ctypes.c_void_p))[0] = address
            return True

        bindings = {"ConvertSidToStringSidW": sid_string,
                    "ConvertStringSecurityDescriptorToSecurityDescriptorW": descriptor_from_string}
        class ObservedCtypes(SimpleNamespace):
            def __getattr__(self, name):
                return getattr(ctypes, name)

        permissions = _windows_acl.PrivatePermissions.__new__(_windows_acl.PrivatePermissions)
        permissions.ctypes = ObservedCtypes(Structure=Structure)
        permissions.types = wintypes
        permissions.security = object()
        with mock.patch.object(permissions, "_bind", side_effect=lambda _lib, name, *_: bindings[name]), \
                mock.patch.object(permissions, "_user_sid"), mock.patch.object(permissions, "_free") as free:
            with permissions._creation_attributes() as pointer:
                attributes = pointer._obj
                self.assertEqual(attributes.descriptor, address)
                self.assertEqual(attributes.length, ctypes.sizeof(type(attributes)))
                self.assertFalse(attributes.inherit)
                free.assert_called_once()
        self.assertEqual(pointer_values, [address])
        self.assertEqual([call.args[0].value for call in free.call_args_list],
                         [ctypes.addressof(owner_sid), address])

    def test_windows_store_reads_and_writes_under_canonical_home(self):
        store.save_endpoints(self.home, [OK])
        alias = self.home.with_name("HOME~1")
        acl = SimpleNamespace(available=lambda: True, PrivatePermissions=PrivatePermissionsOracle)
        with mock.patch.object(store, "_windows_acl", acl):
            with windows_filesystem(alias=(alias, self.home)):
                self.assertEqual(store.load(alias)["endpoints"], [OK])
                store.set_key(alias, "a1", "private-value")
            with windows_filesystem(alias, alias=(alias, self.home)):
                self.assertTrue(store.load(alias)["refused"])
                with self.assertRaises(ValueError):
                    store.save_endpoints(alias, [])
        self.assertFalse(alias.exists())
        self.assertEqual(store.load(self.home)["keys"], {"a1": "private-value"})

    def test_windows_load_refusal_has_no_platform_unavailable_message(self):
        store.save_endpoints(self.home, [OK])
        (self.home / "models" / "endpoints.json").chmod(0o644)
        acl = SimpleNamespace(available=lambda: True, PrivatePermissions=PrivatePermissionsOracle)
        with windows_filesystem(), mock.patch.object(store, "_windows_acl", acl):
            with self.assertRaises(store._Refused) as exc:
                store._load_windows(self.home)
        self.assertEqual(exc.exception.args, ())

    def test_windows_write_refusal_reports_invalid_store(self):
        store.save_endpoints(self.home, [OK])
        path = self.home / "models" / "endpoints.json"
        before = path.read_bytes()
        path.chmod(0o644)
        acl = SimpleNamespace(available=lambda: True, PrivatePermissions=PrivatePermissionsOracle)
        with windows_filesystem(), mock.patch.object(store, "_windows_acl", acl):
            with self.assertRaises(ValueError) as exc:
                store.save_endpoints(self.home, [])
        self.assertEqual(str(exc.exception), "store refused (endpoints.json/keys.json mode, owner, type or content)")
        self.assertEqual(path.read_bytes(), before)

    def test_windows_store_refuses_when_private_permissions_cannot_be_verified(self):
        store.save_endpoints(self.home, [OK])
        path = self.home / "models" / "endpoints.json"
        before = path.read_bytes()
        with windows_filesystem():
            self.assertEqual(store.load(self.home), {"endpoints": [], "keys": {}, "refused": True})
            with self.assertRaisesRegex(ValueError, "verify private model store"):
                store.save_endpoints(self.home, [])
        self.assertEqual(path.read_bytes(), before)


    def test_windows_store_checks_owner_and_private_permissions(self):
        acl = mock.Mock(available=lambda: True, PrivatePermissions=PrivatePermissionsOracle)
        with windows_filesystem(), mock.patch.object(store, "_windows_acl", acl):
            store.save_endpoints(self.home, [OK])
            store.set_key(self.home, "a1", "private-value")
            self.assertEqual(store.load(self.home)["keys"], {"a1": "private-value"})
            path = self.home / "models" / "keys.json"
            path.chmod(0o644)
            self.assertTrue(store.load(self.home)["refused"])
            path.chmod(0o600)
            with windows_filesystem(path):
                self.assertTrue(store.load(self.home)["refused"])


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
