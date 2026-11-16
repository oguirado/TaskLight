"""Exercise installer CLI behavior with isolated homes and an in-memory registry."""
import base64
import builtins
import contextlib
from collections import namedtuple
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from bridge import install
from bridge.wall.emit import load_config
from bridge.wall.room_relay import load_room_config

HOST = "com.contextwall.bridge"
EXT = "abcdefghijklmnopabcdefghijklmnop"
HERE = Path(__file__).resolve().parent
DESTINATIONS = {
    "linux": {
        "chrome": ".config/google-chrome/NativeMessagingHosts",
        "chromium": ".config/chromium/NativeMessagingHosts",
        "edge": ".config/microsoft-edge/NativeMessagingHosts",
        "brave": ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    },
    "darwin": {
        "chrome": "Library/Application Support/Google/Chrome/NativeMessagingHosts",
        "chromium": "Library/Application Support/Chromium/NativeMessagingHosts",
        "edge": "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
        "brave": "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    },
    "win32": {browser: "TaskLight/native" for browser in ("chrome", "chromium", "edge", "brave")},
}
VENDORS = {
    "chrome": r"Google\Chrome", "chromium": "Chromium",
    "edge": r"Microsoft\Edge", "brave": r"BraveSoftware\Brave-Browser",
}


class Key:
    def __init__(self, registry, path):
        self.registry, self.path = registry, path

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def Close(self):
        pass


class Registry(types.ModuleType):
    """Small winreg-compatible fake; no access to the operating-system registry."""
    HKEY_CURRENT_USER = "HKCU"
    REG_SZ = 1
    KEY_READ = 0x20019
    KEY_WRITE = 0x20006
    KEY_SET_VALUE = 2
    KEY_QUERY_VALUE = 1
    KEY_ALL_ACCESS = 0xF003F

    def __init__(self):
        super().__init__("winreg")
        self.values = {}

    def _path(self, root, subkey):
        parent = root.path if isinstance(root, Key) else root
        return parent + ("\\" + subkey if subkey else "")

    def CreateKey(self, root, subkey):
        path = self._path(root, subkey)
        self.values.setdefault(path, {})
        return Key(self, path)

    def CreateKeyEx(self, root, subkey, reserved=0, access=KEY_WRITE):
        return self.CreateKey(root, subkey)

    def OpenKey(self, root, subkey, reserved=0, access=KEY_READ):
        path = self._path(root, subkey)
        if path not in self.values:
            raise FileNotFoundError(path)
        return Key(self, path)

    OpenKeyEx = OpenKey

    def SetValueEx(self, key, name, reserved, kind, value):
        self.values[key.path][name or ""] = (value, kind)

    def SetValue(self, root, subkey, kind, value):
        self.SetValueEx(self.CreateKey(root, subkey), "", 0, kind, value)

    def QueryValueEx(self, key, name):
        try:
            return self.values[key.path][name or ""]
        except KeyError:
            raise FileNotFoundError(name) from None

    def QueryValue(self, root, subkey):
        return self.QueryValueEx(self.OpenKey(root, subkey), "")[0]

    def DeleteValue(self, key, name):
        if (name or "") not in self.values[key.path]:
            raise FileNotFoundError(name)
        del self.values[key.path][name or ""]

    def DeleteKey(self, root, subkey):
        path = self._path(root, subkey)
        if path not in self.values:
            raise FileNotFoundError(path)
        del self.values[path]

    def CloseKey(self, key):
        pass

    def EnumValue(self, key, index):
        try:
            name, (value, kind) = list(self.values[key.path].items())[index]
            return name, value, kind
        except IndexError:
            raise OSError("no more values") from None

    def QueryInfoKey(self, key):
        return 0, len(self.values[key.path]), 0


class Installer(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sandbox-", dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.local = self.root / "local-data"
        self.home.mkdir()
        self.registry = Registry()

    def invoke(self, *args, platform="linux", version=None, executable=None, cw_home=None):
        env = {"HOME": str(self.home), "USERPROFILE": str(self.home),
               "LOCALAPPDATA": str(self.local)}
        if cw_home is not None:
            env["CW_HOME"] = str(cw_home)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, env, clear=True))
            stack.enter_context(patch.object(Path, "home", return_value=self.home))
            stack.enter_context(patch.object(sys, "platform", platform))
            stack.enter_context(patch.dict(sys.modules, {"winreg": self.registry}))
            # Also supports a platform-conditional module-level winreg import.
            stack.enter_context(patch.object(install, "winreg", self.registry, create=True))
            if version is not None:
                stack.enter_context(patch.object(sys, "version_info",
                    namedtuple("VersionInfo", "major minor micro releaselevel serial")(*version, "final", 0)))
            if executable is not None:
                stack.enter_context(patch.object(sys, "executable", str(executable)))
            stack.enter_context(contextlib.redirect_stdout(out))
            stack.enter_context(contextlib.redirect_stderr(err))
            try:
                rc = install.main(list(args))
            except SystemExit as exc:
                rc = exc.code
        return rc, out.getvalue() + err.getvalue()

    def apply(self, *args, **kwargs):
        rc, output = self.invoke("--apply", "--extension-id", EXT, *args, **kwargs)
        self.assertEqual(rc, 0, "supported installation must succeed: " + output)

    def base(self, platform="linux", browser="chrome"):
        return (self.local if platform == "win32" else self.home) / DESTINATIONS[platform][browser]

    def manifest(self, platform="linux", browser="chrome"):
        path = self.base(platform, browser) / (HOST + ".json")
        self.assertTrue(path.is_file(), "manifest must use the specified browser destination")
        return json.loads(path.read_text(encoding="utf-8"))

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes()
                for p in self.root.rglob("*") if p.is_file()}

    def config(self, path):
        self.assertTrue(path.is_file(), "apply must bootstrap a host config")
        data = load_config(str(path))
        self.assertIsNotNone(data, "generated config must pass the existing load_config")
        self.assertEqual(data["extensionId"], EXT)
        self.assertIsNotNone(load_room_config(data), "room allow-list must initialize the host relay")
        return data

    def test_a1_default_browser_is_chrome(self):
        self.apply()
        self.assertEqual(self.manifest()["name"], HOST)

    def test_a3_posix_launcher_interpreter_config_mode_and_origin(self):
        for platform in ("linux", "darwin"):
            with self.subTest(platform=platform):
                cfg = self.root / "config with spaces ' quoted.json"
                python = self.root / "interpreter with spaces ' $literal" / "python"
                self.apply("--config", str(cfg), platform=platform, executable=python)
                manifest = self.manifest(platform)
                launcher = self.base(platform) / (HOST + ".host.sh")
                self.assertEqual(manifest["path"], str(launcher))
                self.assertEqual(manifest["allowed_origins"], ["chrome-extension://" + EXT + "/"])
                text = launcher.read_text(encoding="utf-8")
                self.assertIn("exec " + shlex.quote(str(python)), text)
                self.assertIn("-I", text)
                self.assertIn("--config", text)
                # Parse shell words without executing the synthetic interpreter.
                words = shlex.split(text, comments=True)
                self.assertTrue(str(cfg) in words or any(str(cfg) in word for word in words))
                self.assertEqual(stat.S_IMODE(launcher.stat().st_mode), 0o700)

    def test_a3_default_launcher_pins_installing_interpreter(self):
        python = self.root / "Python Runtime" / "python"
        self.apply(executable=python)
        text = Path(self.manifest()["path"]).read_text(encoding="utf-8")
        self.assertIn("exec " + shlex.quote(str(python)), text)

    def test_a3_default_launcher_private_executable_mode(self):
        self.apply()
        launcher = Path(self.manifest()["path"])
        self.assertEqual(stat.S_IMODE(launcher.stat().st_mode), 0o700)

    def test_m1_posix_does_not_import_windows_registry(self):
        original_import = builtins.__import__

        def guarded(name, *args, **kwargs):
            self.assertNotEqual(name, "winreg", "winreg is Windows-only")
            return original_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", side_effect=guarded):
            self.apply()

    def test_a2_remove_preserves_replaced_foreign_registry_value(self):
        self.apply("--browser", "chrome", platform="win32")
        key = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST
        foreign = ("foreign-manifest.json", self.registry.REG_SZ)
        self.registry.values.setdefault(key, {})[""] = foreign
        self.invoke("--remove", "--extension-id", EXT, "--browser", "chrome", platform="win32")
        self.assertEqual(self.registry.values.get(key, {}).get(""), foreign)

    def test_a4_requested_rooms_config_created_once(self):
        path = self.root / "config" / "wall.config.json"
        args = ("--config", str(path), "--room", "alpha:private", "--room", "beta:standard", "--room", "gamma")
        self.apply(*args)
        data = self.config(path)
        self.assertEqual(data["rooms"]["allow"], [
            {"room": "alpha", "tier": "private"}, {"room": "beta", "tier": "standard"},
            {"room": "gamma", "tier": "private"}])
        data["projects"] = [{"projectId": "edited", "tier": "private", "roots": []}]
        edited = json.dumps(data, indent=3) + "\n"
        path.write_text(edited, encoding="utf-8")
        self.apply(*args)
        self.assertEqual(path.read_text(encoding="utf-8"), edited)

    def test_a4_cw_home_default_config_and_demo_room(self):
        cw_home = self.root / "state"
        self.apply(cw_home=cw_home)
        cfg = cw_home / "wall.config.json"
        data = self.config(cfg)
        self.assertEqual(data["rooms"]["allow"], [{"room": "demo", "tier": "private"}])
        text = Path(self.manifest()["path"]).read_text(encoding="utf-8")
        self.assertIn("--config", text)
        self.assertIn(str(cfg), text)

    def test_a4_home_fallback_config(self):
        self.apply()
        self.config(self.home / ".context-wall" / "wall.config.json")

    def test_a4_existing_config_never_overwritten_even_if_invalid(self):
        cfg = self.root / "existing.json"
        cfg.write_bytes(b"user-owned: not JSON\n")
        self.invoke("--apply", "--extension-id", EXT, "--config", str(cfg))
        self.assertEqual(cfg.read_bytes(), b"user-owned: not JSON\n")

    def test_a5_key_file_derives_origin_and_config_id(self):
        # Fixed valid Ed25519 DER SPKI, encoded just like the demo public key.
        der = bytes.fromhex("302a300506032b6570032100") + bytes(range(32))
        key = self.root / "public.b64"
        key.write_bytes(base64.b64encode(der))
        expected = "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(der).hexdigest()[:32])
        rc, output = self.invoke("--apply", "--key-file", str(key))
        self.assertEqual(rc, 0, output)
        self.assertEqual(self.manifest()["allowed_origins"], ["chrome-extension://" + expected + "/"])
        cfg = self.home / ".context-wall" / "wall.config.json"
        self.assertTrue(cfg.is_file())
        data = load_config(str(cfg))
        self.assertIsNotNone(data)
        self.assertEqual(data["extensionId"], expected)

    def test_a5_unreadable_or_invalid_base64_key_refused_without_writes(self):
        for raw in (None, b"%%% invalid base64 %%%"):
            with self.subTest(raw=raw):
                key = self.root / "key.b64"
                if raw is not None:
                    key.write_bytes(raw)
                before = self.snapshot()
                rc, _ = self.invoke("--apply", "--key-file", str(key))
                self.assertEqual(rc, 2)
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(self.registry.values, {})

    @unittest.skip("A-U82a: superseded; without an id the installer uses the dev manifest id (R29)")
    def test_a6_apply_without_id_refused_without_writes(self):
        for platform in DESTINATIONS:
            with self.subTest(platform=platform):
                before = self.snapshot()
                rc, _ = self.invoke("--apply", platform=platform)
                self.assertEqual(rc, 2, "apply must not silently use the obsolete pinned ID")
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(self.registry.values, {})

    def test_a6_old_python_refused_one_line_without_writes(self):
        before = self.snapshot()
        rc, output = self.invoke("--apply", "--extension-id", EXT, version=(3, 9, 19))
        self.assertEqual(rc, 3, "unsupported Python must fail before any installation write")
        self.assertEqual(len(output.strip().splitlines()), 1)
        self.assertIn("3.10", output)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.registry.values, {})

    def test_m5_old_python_dry_run_also_refused(self):
        rc, output = self.invoke(version=(3, 9, 19))
        self.assertEqual(rc, 3)
        self.assertEqual(len(output.strip().splitlines()), 1)
        self.assertEqual(self.snapshot(), {})

    def test_m5_minimum_python_accepted(self):
        rc, output = self.invoke("--extension-id", EXT, version=(3, 10, 0))
        self.assertEqual(rc, 0, output)
        self.assertEqual(self.snapshot(), {})

    def test_m4_no_id_dry_run_explains_extensions_page(self):
        rc, output = self.invoke()
        self.assertEqual(rc, 0)
        self.assertIn("chrome://extensions", output)
        self.assertEqual(self.snapshot(), {})
        self.assertEqual(self.registry.values, {})

    def test_m6_dry_run_with_new_options_writes_nothing(self):
        for platform in DESTINATIONS:
            with self.subTest(platform=platform):
                rc, output = self.invoke("--extension-id", EXT, "--browser", "brave", "--room", "demo:private",
                                         "--config", str(self.root / "config.json"), platform=platform)
                self.assertEqual(rc, 0, output)
                self.assertEqual(self.snapshot(), {})
                self.assertEqual(self.registry.values, {})

    def test_m6_conflicting_modes_and_unknown_flags_no_writes(self):
        for args in (("--apply", "--remove"), ("--bogus",)):
            with self.subTest(args=args):
                rc, _ = self.invoke(*args, "--extension-id", EXT)
                self.assertEqual(rc, 2)
                self.assertEqual(self.snapshot(), {})
                self.assertEqual(self.registry.values, {})

    def test_m1_invalid_browser_refused(self):
        rc, _ = self.invoke("--apply", "--extension-id", EXT, "--browser", "other")
        self.assertEqual(rc, 2)
        self.assertEqual(self.snapshot(), {})

    def test_m4_invalid_ids_no_writes(self):
        for bad in ("a" * 31, "a" * 33, "q" * 32, "A" * 32, "*", "", "a" * 31 + "\n"):
            with self.subTest(bad=bad):
                rc, _ = self.invoke("--apply", "--extension-id", bad)
                self.assertEqual(rc, 2)
                self.assertEqual(self.snapshot(), {})

    def test_m3_hostile_rooms_refused_without_writes(self):
        for room in ("../escape", "demo:unknown", "demo\nother", ":private"):
            with self.subTest(room=room):
                rc, _ = self.invoke("--apply", "--extension-id", EXT, "--room", room)
                self.assertEqual(rc, 2)
                self.assertEqual(self.snapshot(), {})
                self.assertEqual(self.registry.values, {})

    def test_m6_remove_owned_install_preserves_config_and_unrelated_file(self):
        self.apply()
        manifest = self.base() / (HOST + ".json")
        launcher = Path(self.manifest()["path"])
        unrelated = self.base() / "other-host.json"
        unrelated.write_bytes(b"unrelated")
        cfg = self.home / ".context-wall" / "wall.config.json"
        if cfg.exists():
            cfg.write_bytes(b"user edited config")
        before_cfg = cfg.read_bytes() if cfg.exists() else None
        rc, _ = self.invoke("--remove")
        self.assertEqual(rc, 0)
        self.assertFalse(manifest.exists())
        self.assertFalse(launcher.exists())
        self.assertEqual(unrelated.read_bytes(), b"unrelated")
        if before_cfg is not None:
            self.assertEqual(cfg.read_bytes(), before_cfg)
        self.assertEqual(self.invoke("--remove", "--extension-id", EXT)[0], 0)

    def test_m6_foreign_or_malformed_manifest_preserved(self):
        base = self.base()
        base.mkdir(parents=True)
        path = base / (HOST + ".json")
        for content in (b"{not json", json.dumps({"name": "foreign"}).encode()):
            with self.subTest(content=content):
                path.write_bytes(content)
                before = self.snapshot()
                self.assertEqual(self.invoke("--apply", "--extension-id", EXT)[0], 2)
                self.assertEqual(self.snapshot(), before)
                self.invoke("--remove", "--extension-id", EXT)
                self.assertEqual(self.snapshot(), before)

    def test_m6_foreign_launcher_refused_and_preserved(self):
        self.apply()
        launcher = Path(self.manifest()["path"])
        launcher.write_bytes(b"foreign launcher\n")
        before = self.snapshot()
        self.assertEqual(self.invoke("--apply", "--extension-id", EXT)[0], 2)
        self.assertEqual(self.snapshot(), before)
        self.invoke("--remove", "--extension-id", EXT)
        self.assertEqual(launcher.read_bytes(), b"foreign launcher\n")

    def test_m6_tampered_manifest_cannot_delete_unrelated_target(self):
        self.apply()
        path = self.base() / (HOST + ".json")
        data = self.manifest()
        target = self.root / "important.txt"
        target.write_bytes(b"keep")
        data["path"] = str(target)
        path.write_text(json.dumps(data), encoding="utf-8")
        before = self.snapshot()
        self.invoke("--remove", "--extension-id", EXT)
        self.assertEqual(self.snapshot(), before)


def destination_case(platform, browser):
    def test(self):
        self.apply("--browser", browser, platform=platform)
        self.assertEqual(self.manifest(platform, browser)["name"], HOST)
        hits = list(self.root.rglob(HOST + ".json"))
        self.assertEqual(hits, [self.base(platform, browser) / (HOST + ".json")])
    return test


def windows_case(browser):
    def test(self):
        key_path = "HKCU\\Software\\" + VENDORS[browser] + "\\NativeMessagingHosts\\" + HOST
        # Unrelated values in the SAME key and in another key must survive.
        self.registry.values[key_path] = {"other": ("preserve", self.registry.REG_SZ)}
        other_path = "HKCU\\Software\\OtherVendor\\NativeMessagingHosts\\other.host"
        self.registry.values[other_path] = {"": ("unrelated", self.registry.REG_SZ)}
        args = ("--browser", browser)
        python = self.root / "Python Runtime" / "python.exe"
        self.apply(*args, platform="win32", executable=python)
        manifest_path = self.base("win32", browser) / (HOST + ".json")
        manifest = self.manifest("win32", browser)
        launcher = self.base("win32", browser) / (HOST + ".host.bat")
        self.assertEqual(manifest["path"], str(launcher))
        self.assertTrue(launcher.is_file(), "Windows requires a batch launcher")
        text = launcher.read_text(encoding="utf-8")
        self.assertIn('"' + str(python) + '" -I -c', text)
        self.assertIn("--config", text)
        self.assertIn("bridge.wall", text)
        self.assertIn("host", text)
        self.assertEqual(manifest["allowed_origins"], ["chrome-extension://" + EXT + "/"])
        self.assertEqual(self.registry.values.get(key_path, {}).get(""), (str(manifest_path), self.registry.REG_SZ))
        rc, output = self.invoke("--remove", "--extension-id", EXT, *args, platform="win32", executable=python)
        self.assertEqual(rc, 0, output)
        self.assertFalse(manifest_path.exists())
        self.assertFalse(launcher.exists())
        self.assertEqual(self.registry.values.get(key_path), {"other": ("preserve", self.registry.REG_SZ)})
        self.assertEqual(self.registry.values.get(other_path), {"": ("unrelated", self.registry.REG_SZ)})
    return test


for _platform, _browsers in DESTINATIONS.items():
    for _browser in _browsers:
        setattr(Installer, "test_a1_destination_" + _platform + "_" + _browser,
                destination_case(_platform, _browser))
for _browser in VENDORS:
    setattr(Installer, "test_a2_windows_round_trip_" + _browser, windows_case(_browser))


if __name__ == "__main__":
    unittest.main()
