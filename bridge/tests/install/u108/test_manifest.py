"""Public installer contracts; fixtures stay beneath this test directory."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from bridge import install
from bridge.tests.install.test_install import Registry
from bridge.wall.emit import load_config
from bridge.wall.room_relay import RoomRelay, load_room_config

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
HOST = "com.contextwall.bridge"
EXT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
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
}
VENDORS = {"chrome": r"Google\Chrome", "chromium": "Chromium", "edge": r"Microsoft\Edge", "brave": r"BraveSoftware\Brave-Browser"}


class ManifestOracle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".scratch-", dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home, self.cw, self.local = [self.root / name for name in ("home", "cw", "local")]
        self.home.mkdir()
        self.env = {"HOME": str(self.home), "USERPROFILE": str(self.home),
                    "LOCALAPPDATA": str(self.local), "CW_HOME": str(self.cw),
                    "PATH": os.environ.get("PATH", os.defpath), "PYTHONDONTWRITEBYTECODE": "1"}
        self.registry = Registry()

    def invoke(self, *extra, platform="linux", browser="chrome", mask=0o002):
        args = ["--browser", browser, "--extension-id", EXT, "--room", "my-room:private", *extra]
        out, err = io.StringIO(), io.StringIO()
        previous = os.umask(mask) if os.name == "posix" else None
        try:
            with patch.dict(os.environ, self.env, clear=True), \
                    patch.object(sys, "platform", platform), \
                    patch.object(install, "winreg", self.registry), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = install.main(args)
        finally:
            if previous is not None:
                os.umask(previous)
        return rc, out.getvalue() + err.getvalue()

    def paths(self, platform="linux", browser="chrome"):
        base = self.local / "TaskLight/native" if platform == "win32" else self.home / DESTINATIONS[platform][browser]
        suffix = ".host.bat" if platform == "win32" else ".host.sh"
        return base / (HOST + ".json"), base / (HOST + suffix), self.cw / "wall.config.json"

    def apply(self, **kwargs):
        rc, output = self.invoke("--apply", **kwargs)
        self.assertEqual(rc, 0, output)
        return output

    def snapshot(self):
        result = {}
        for path in self.root.rglob("*"):
            mode = stat.S_IMODE(path.lstat().st_mode)
            if path.is_symlink():
                value = ("symlink", os.readlink(path), mode)
            elif path.is_file():
                value = ("file", path.read_bytes(), mode)
            else:
                value = ("directory", b"", mode)
            result[str(path.relative_to(self.root))] = value
        return result

    def assert_private_manifest(self, manifest):
        self.assertEqual(stat.S_IMODE(manifest.stat().st_mode), 0o600,
                         "M5: a successful apply must leave the manifest at mode 0600")

    def assert_artifacts(self, platform, browser):
        manifest, launcher, config = self.paths(platform, browser)
        self.assertTrue(manifest.is_file())
        self.assertTrue(launcher.is_file())
        self.assertEqual(json.loads(manifest.read_text()), {
            "name": HOST, "description": "Context Wall bridge native host", "path": str(launcher),
            "type": "stdio", "allowed_origins": ["chrome-extension://" + EXT + "/"],
        })
        self.assertEqual(json.loads(config.read_text())["rooms"]["allow"], [{"room": "my-room", "tier": "private"}])
        self.assertIsNotNone(load_room_config(load_config(str(config))))
        return manifest, launcher, config

    def test_a1_preview_is_zero_writes_and_prints_the_manifest(self):
        before = self.snapshot()
        rc, output = self.invoke()
        self.assertEqual(rc, 0, output)
        manifest = json.JSONDecoder().raw_decode(output)[0]
        expected_manifest, launcher, _ = self.paths()
        self.assertEqual(manifest["allowed_origins"], ["chrome-extension://" + EXT + "/"])
        self.assertEqual(manifest["path"], str(launcher))
        self.assertIn("Target: " + str(expected_manifest), output)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.cw.exists())

    def test_a1_existing_config_is_byte_identical_even_when_not_valid_json(self):
        self.cw.mkdir()
        config = self.paths()[2]
        original = b"preserve this existing configuration\n"
        config.write_bytes(original)
        if os.name == "posix":
            config.chmod(0o640)
        before = self.snapshot()
        output = self.apply()
        self.assertEqual(config.read_bytes(), original)
        self.assertEqual(self.snapshot()[str(config.relative_to(self.root))], before[str(config.relative_to(self.root))])
        self.assertIn("preserved", output)

    def test_a1_install_then_reinstall_preserves_custom_existing_config(self):
        self.apply()
        manifest, launcher, config = self.assert_artifacts("linux", "chrome")
        original = config.read_bytes() + b" \n"
        config.write_bytes(original)
        self.apply()
        self.assertEqual(config.read_bytes(), original)
        self.assertTrue(manifest.is_file())
        self.assertTrue(launcher.is_file())

    def test_m3_install_success_reports_no_harness_connection_or_deployment(self):
        output = self.apply()
        self.assertIn("Installed:", output)
        for sentence in re.split(r"[.!?\n]", output):
            if re.search(r"\b(?:no|not|never|cannot|doesn['’]t|isn['’]t|won['’]t)\b", sentence, re.I):
                continue
            self.assertNotRegex(sentence.lower(), r"\b(?:harness|agent)\s+(?:(?:is|has been|successfully|now|already)\s+)*(?:connected|deployed)\b")

    @unittest.skipUnless(os.name == "posix", "POSIX permission-failure injection")
    def test_a5_manifest_permission_oserror_returns_one_without_success(self):
        manifest = self.paths()[0]
        chmod, fchmod, open_fd = os.chmod, os.fchmod, os.open
        reached = []

        def is_manifest(target):
            if isinstance(target, int):
                if not manifest.exists():
                    return False
                return (os.fstat(target).st_dev, os.fstat(target).st_ino) == (manifest.stat().st_dev, manifest.stat().st_ino)
            return Path(target).absolute() == manifest

        def checked_chmod(target, mode, *args, **kwargs):
            if is_manifest(target):
                reached.append(True)
                raise OSError("injected manifest permission failure")
            return chmod(target, mode, *args, **kwargs)

        def checked_fchmod(fd, mode):
            if is_manifest(fd):
                reached.append(True)
                raise OSError("injected manifest permission failure")
            return fchmod(fd, mode)

        def checked_open(target, flags, mode=0o777, *args, **kwargs):
            # Also admit implementations that create an already-private
            # manifest (or its adjacent atomic temporary) with os.open.
            if (not isinstance(target, int) and Path(target).absolute().parent == manifest.parent
                    and Path(target).name != self.paths()[1].name
                    and flags & os.O_CREAT and mode & 0o777 == 0o600):
                reached.append(True)
                raise OSError("injected manifest permission failure")
            return open_fd(target, flags, mode, *args, **kwargs)

        with patch.object(os, "chmod", side_effect=checked_chmod), \
                patch.object(os, "fchmod", side_effect=checked_fchmod), \
                patch.object(os, "open", side_effect=checked_open):
            rc, output = self.invoke("--apply")
        self.assertEqual(rc, 1, "M6: permission enforcement must fail through the existing error path; " + output)
        self.assertTrue(reached, "manifest permission enforcement was never reached")
        self.assertNotIn("Installed:", output)

    def test_a5_foreign_manifest_refused_without_mutation(self):
        manifest, _, _ = self.paths()
        manifest.parent.mkdir(parents=True)
        manifest.write_bytes(b'{"name":"foreign","path":"unrelated"}\n')
        if os.name == "posix":
            manifest.chmod(0o664)
        before = self.snapshot()
        rc, output = self.invoke("--apply")
        self.assertEqual(rc, 2, output)
        self.assertNotIn("Installed:", output)
        self.assertEqual(self.snapshot(), before)

    def test_a5_foreign_launcher_refused_without_mutating_owned_manifest(self):
        self.apply()
        manifest, launcher, config = self.paths()
        launcher.write_bytes(b"foreign launcher: preserve verbatim\n")
        if os.name == "posix":
            launcher.chmod(0o750)
            manifest.chmod(0o664)
        before = self.snapshot()
        rc, output = self.invoke("--apply")
        self.assertEqual(rc, 2, output)
        self.assertNotIn("Installed:", output)
        self.assertEqual(self.snapshot(), before)
        self.assertTrue(config.is_file())

    def test_a5_foreign_launcher_on_fresh_install_stops_before_config_or_manifest(self):
        _, launcher, _ = self.paths()
        launcher.parent.mkdir(parents=True)
        launcher.write_bytes(b"unowned launcher\n")
        before = self.snapshot()
        rc, output = self.invoke("--apply")
        self.assertEqual(rc, 2, output)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.cw.exists())

    @unittest.skipUnless(os.name == "posix", "POSIX manifest symlink refusal")
    def test_a5_amendment_owned_manifest_symlink_is_refused_without_following(self):
        manifest, launcher, config = self.paths()
        rc, output = self.invoke()
        self.assertEqual(rc, 0, output)
        target = self.root / "owned-target.json"
        original = json.dumps(json.JSONDecoder().raw_decode(output)[0]).encode() + b"\n"
        target.write_bytes(original)
        target.chmod(0o664)
        manifest.parent.mkdir(parents=True)
        manifest.symlink_to(target)
        rc, output = self.invoke("--apply")
        self.assertEqual(rc, 2, "Amendment B: symlinked manifest must be refused; " + output)
        self.assertNotIn("Installed:", output)
        self.assertTrue(manifest.is_symlink())
        self.assertEqual(target.read_bytes(), original)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o664)
        self.assertFalse(launcher.exists())
        self.assertFalse(config.exists())

    @unittest.skipUnless(os.name == "posix", "POSIX manifest symlink refusal")
    def test_a5_amendment_dangling_manifest_symlink_is_refused_without_creating_target(self):
        manifest, launcher, config = self.paths()
        target = self.root / "missing-target.json"
        manifest.parent.mkdir(parents=True)
        manifest.symlink_to(target)
        rc, output = self.invoke("--apply")
        self.assertEqual(rc, 2, output)
        self.assertTrue(manifest.is_symlink())
        self.assertFalse(target.exists())
        self.assertFalse(launcher.exists())
        self.assertFalse(config.exists())

    def test_m6_remove_deletes_only_owned_artifacts_and_keeps_config(self):
        self.apply()
        manifest, launcher, config = self.paths()
        before = config.read_bytes()
        rc, output = self.invoke("--remove")
        self.assertEqual(rc, 0, output)
        self.assertFalse(manifest.exists())
        self.assertFalse(launcher.exists())
        self.assertEqual(config.read_bytes(), before)

    def test_m6_remove_preserves_foreign_manifest_and_launcher(self):
        manifest, launcher, _ = self.paths()
        manifest.parent.mkdir(parents=True)
        manifest.write_bytes(b'{"name":"foreign"}')
        launcher.write_bytes(b"foreign launcher")
        before = self.snapshot()
        rc, output = self.invoke("--remove")
        self.assertEqual(rc, 0, output)
        self.assertEqual(self.snapshot(), before)

    def test_m6_remove_keeps_foreign_launcher_beside_owned_manifest(self):
        self.apply()
        manifest, launcher, config = self.paths()
        launcher.write_bytes(b"foreign replacement")
        rc, output = self.invoke("--remove")
        self.assertEqual(rc, 0, output)
        self.assertFalse(manifest.exists())
        self.assertEqual(launcher.read_bytes(), b"foreign replacement")
        self.assertTrue(config.is_file())

    @unittest.skipUnless(os.name == "posix", "POSIX negative control")
    def test_a6_negative_control_rejects_an_insecure_0664_manifest(self):
        manifest = self.root / "insecure-manifest.json"
        manifest.write_text("{}\n")
        manifest.chmod(0o664)
        with self.assertRaisesRegex(AssertionError, "M5"):
            self.assert_private_manifest(manifest)

    def test_a2_mcp_heartbeat_reaches_native_room_relay_with_same_home(self):
        self.apply()
        _, _, config = self.paths()
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "setup-check", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "post_status", "arguments": {
                "room": "my-room", "agent": "setup-check", "text": "Workspace connected"}}},
        ]
        child = subprocess.run(["python3", "-m", "bridge.room.mcp"], cwd=ROOT, env=self.env,
                               input="".join(json.dumps(message) + "\n" for message in messages),
                               capture_output=True, text=True, timeout=5)
        self.assertEqual(child.returncode, 0, child.stderr)
        replies = {reply["id"]: reply for reply in map(json.loads, child.stdout.splitlines())}
        self.assertEqual(replies[1]["result"]["protocolVersion"], "2024-11-05")
        self.assertNotIn("error", replies[2])
        self.assertFalse(replies[2]["result"].get("isError", False))
        payload = json.loads(replies[2]["result"]["content"][0]["text"])
        self.assertIn("event", payload)
        event = payload["event"]
        self.assertEqual(event["act"], "heartbeat")
        self.assertEqual(event["untrusted_text"], "Workspace connected")
        self.assertNotIn("text", event)
        self.assertEqual(event["agent"], "setup-check")
        frames = []
        relay = RoomRelay(load_room_config(load_config(str(config))), frames.append, clock=lambda: 0.0)
        relay.poll()
        self.assertTrue(any(frame.get("t") == "room_event" and frame.get("room") == "my-room"
                            and frame.get("event", {}).get("act") == "heartbeat" for frame in frames), frames)
        self.assertNotIn("deployment", event)


def add_permission_case(platform, browser, mask, reinstall):
    def case(self):
        self.apply(platform=platform, browser=browser, mask=mask)
        manifest, launcher, config = self.assert_artifacts(platform, browser)
        original = config.read_bytes()
        if reinstall:
            manifest.chmod(0o664)
            self.apply(platform=platform, browser=browser, mask=mask)
        self.assert_private_manifest(manifest)
        self.assertEqual(stat.S_IMODE(launcher.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
        self.assertEqual(config.read_bytes(), original)
    state = "reinstall_owned_0664" if reinstall else "fresh"
    name = f"test_a3_{platform}_{browser}_umask_{mask:04o}_{state}"
    setattr(ManifestOracle, name, unittest.skipUnless(os.name == "posix", "POSIX modes only")(case))


for _platform, _browsers in DESTINATIONS.items():
    for _browser in _browsers:
        for _mask in (0o000, 0o002, 0o077):
            for _reinstall in (False, True):
                add_permission_case(_platform, _browser, _mask, _reinstall)


def add_hostile_case(label, flag, value):
    def case(self):
        before = self.snapshot()
        with patch.object(os, "system", side_effect=AssertionError("invalid input must not enter a shell")), \
                patch.object(subprocess, "Popen", side_effect=AssertionError("invalid input must not launch processes")):
            rc, output = self.invoke(flag, value, "--apply")
        self.assertEqual(rc, 2, output)
        self.assertNotIn("Installed:", output)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.cw.exists())
        self.assertFalse(self.paths()[0].parent.exists())
        self.assertFalse((self.root / "escape").exists())
        self.assertFalse((self.root / "injection-marker").exists())
    setattr(ManifestOracle, "test_a4_" + label, case)


for _label, _flag, _value in (
    ("room_traversal", "--room", "../escape:private"),
    ("room_semicolon", "--room", "my-room;touch injection-marker:private"),
    ("room_substitution", "--room", "$(touch injection-marker):private"),
    ("room_bad_tier", "--room", "my-room:invalid"),
    ("extension_semicolon", "--extension-id", EXT + ";touch injection-marker"),
    ("extension_substitution", "--extension-id", "$(touch injection-marker)"),
    ("extension_backticks", "--extension-id", "`touch injection-marker`"),
):
    add_hostile_case(_label, _flag, _value)


def add_windows_case(browser):
    def case(self):
        self.apply(platform="win32", browser=browser)
        manifest, _, config = self.assert_artifacts("win32", browser)
        key = "\\".join(("HKCU", "Software", VENDORS[browser], "NativeMessagingHosts", HOST))
        self.assertEqual(self.registry.values[key][""][0], str(manifest))
        original = config.read_bytes()
        self.apply(platform="win32", browser=browser)
        self.assertEqual(config.read_bytes(), original)
    setattr(ManifestOracle, "test_a3_windows_registry_preserved_" + browser, case)


for _browser in VENDORS:
    add_windows_case(_browser)
