"""U70 installer: Native Messaging host registration for Chrome-family browsers.

Dry run by default (prints, writes nothing). --apply installs the manifest,
an executable host launcher, a host config (when missing) and, on Windows,
the HKCU registry value; --remove deletes only what --apply wrote.
"""
import base64
import binascii
import hashlib
import json
import os
import re
import shlex
import sys
from pathlib import Path

HOST_NAME = "com.contextwall.bridge"
# Legacy constant kept for import compatibility.
PINNED_ID = "nnmhdaibaopekhjcpnekgdpeaaojclof"
# A-U82a: default extension id when neither --extension-id nor --key-file
# is given (M2 dev id, not the legacy pinned constant).
DEFAULT_DEV_ID = "anackbeighghafbocgepfflkiciklmpf"
DESCRIPTION = "Context Wall bridge native host"

# Injectable seam for Windows registry access. On Windows the real winreg is
# imported lazily by _get_winreg(); tests replace this attribute with a fake.
winreg = None

BROWSERS = ("chrome", "chromium", "edge", "brave")
_LINUX_SUBDIRS = {
    "chrome": "google-chrome",
    "chromium": "chromium",
    "edge": "microsoft-edge",
    "brave": "BraveSoftware/Brave-Browser",
}
_DARWIN_SUBDIRS = {
    "chrome": "Google/Chrome",
    "chromium": "Chromium",
    "edge": "Microsoft Edge",
    "brave": "BraveSoftware/Brave-Browser",
}
_VENDOR_PATHS = {
    "chrome": r"Google\Chrome",
    "chromium": r"Chromium",
    "edge": r"Microsoft\Edge",
    "brave": r"BraveSoftware\Brave-Browser",
}
# Same shape as bridge.room.store.ROOM_RE (duplicated so this module stays
# stdlib-only and importable on Windows, where bridge.room.store is not).
_ROOM_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
_ROOM_TIERS = ("private", "standard")


def _valid_id(s):
    return isinstance(s, str) and len(s) == 32 and all("a" <= c <= "p" for c in s)


def _home():
    h = os.environ.get("HOME")
    return Path(h) if h else Path.home()


def _is_win():
    return sys.platform.startswith("win")


def _get_winreg():
    mod = globals().get("winreg")
    if mod is not None:
        return mod
    mod = sys.modules.get("winreg")
    if mod is not None:
        return mod
    import winreg as real_winreg
    return real_winreg


def _manifest_dir(browser):
    platform = sys.platform
    if platform.startswith("win"):
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            local = str(_home() / "AppData" / "Local")
        return Path(local) / "TaskLight" / "native"
    if platform == "darwin":
        return (_home() / "Library" / "Application Support"
                / _DARWIN_SUBDIRS[browser] / "NativeMessagingHosts")
    return _home() / ".config" / _LINUX_SUBDIRS[browser] / "NativeMessagingHosts"


def _bridge_dir():
    return Path(__file__).resolve().parent


def _default_config_path():
    cw = os.environ.get("CW_HOME")
    if cw:
        return Path(cw) / "wall.config.json"
    # Mirror bridge.room.store._home(None) without importing its storage
    # dependencies into the standalone installer.
    return Path(os.path.expanduser("~")) / ".context-wall" / "wall.config.json"


def _resolve_config(value):
    p = Path(value).expanduser()
    if not p.is_absolute():
        p = Path.cwd() / p
    return p


def _launcher_name():
    return HOST_NAME + (".host.bat" if _is_win() else ".host.sh")


def _host_code(bridge_dir):
    # U38 G3: the repo root (parent of bridge/) goes on the import path so
    # `bridge.wall.room_relay` can import `bridge.room` (python3 -m
    # bridge.wall host semantics).
    repo_root = Path(bridge_dir).resolve().parent
    return ("import sys, runpy; "
            "sys.path.insert(0, %r); "
            "sys.argv = ['wall', 'host'] + sys.argv[1:]; "
            "runpy.run_module('bridge.wall', run_name='__main__', "
            "alter_sys=True)" % str(repo_root))


def _posix_launcher_text(bridge_dir, executable, config_path):
    return ("#!/bin/sh\n"
            "# Context Wall bridge native host launcher (generated).\n"
            "exec " + shlex.quote(executable) + " -I -c "
            + shlex.quote(_host_code(bridge_dir))
            + " --config " + shlex.quote(str(config_path)) + " \"$@\"\n")


def _bat_launcher_text(bridge_dir, executable, config_path):
    # cmd expands percent variables even inside quotes. Escape every literal,
    # but keep %* intact so arguments supplied by the browser are forwarded.
    executable = executable.replace("%", "%%")
    code = _host_code(bridge_dir).replace("%", "%%")
    config = str(config_path).replace("%", "%%")
    return ("@echo off\n"
            + '"' + executable + '" -I -c "' + code
            + '" --config "' + config + '" %*\n')


def _launcher_text(bridge_dir, executable, config_path):
    if _is_win():
        return _bat_launcher_text(bridge_dir, executable, config_path)
    return _posix_launcher_text(bridge_dir, executable, config_path)


def _parse_args(argv):
    opts = {"apply": False, "remove": False, "extension_id": None,
            "key_file": None, "browser": None, "config": None, "rooms": []}
    flags = (("--extension-id", "extension_id"), ("--key-file", "key_file"),
             ("--browser", "browser"), ("--config", "config"),
             ("--room", "rooms"))
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--apply":
            opts["apply"] = True
            i += 1
            continue
        if a == "--remove":
            opts["remove"] = True
            i += 1
            continue
        matched = False
        for flag, key in flags:
            if a == flag:
                if i + 1 >= len(argv):
                    return None
                if key == "rooms":
                    opts["rooms"].append(argv[i + 1])
                else:
                    opts[key] = argv[i + 1]
                i += 2
                matched = True
                break
            if a.startswith(flag + "="):
                value = a[len(flag) + 1:]
                if key == "rooms":
                    opts["rooms"].append(value)
                else:
                    opts[key] = value
                i += 1
                matched = True
                break
        if not matched:
            return None
    return opts


def _derive_id_from_key_file(key_file):
    try:
        raw = Path(key_file).expanduser().read_bytes()
    except OSError:
        return None
    try:
        text = raw.decode("utf-8", "strict")
    except UnicodeDecodeError:
        return None
    compact = "".join(text.split())
    try:
        der = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError):
        return None
    digest = hashlib.sha256(der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def _parse_rooms(values):
    if not values:
        return [{"room": "demo", "tier": "private"}]
    out = []
    seen = set()
    for raw in values:
        parts = raw.split(":")
        if len(parts) == 1:
            name, tier = parts[0], "private"
        elif len(parts) == 2:
            name, tier = parts
        else:
            print("Invalid room specification " + repr(raw) +
                  "; expected room:private or room:standard. Try --room tasklight:private.",
                  file=sys.stderr)
            return None
        suggestion = re.sub(r"[^a-z0-9-]", "-", name.lower()).lstrip("-")[:48] or "room"
        suggested_tier = tier.lower() if tier.lower() in _ROOM_TIERS else "private"
        if not _ROOM_RE.fullmatch(name):
            print("Invalid room " + repr(name) +
                  "; expected [a-z0-9][a-z0-9-]{0,47}. Try --room " +
                  suggestion + ":" + suggested_tier + ".", file=sys.stderr)
            return None
        if tier not in _ROOM_TIERS:
            print("Invalid tier " + repr(tier) +
                  "; expected private or standard. Try --room " +
                  suggestion + ":" + suggested_tier + ".", file=sys.stderr)
            return None
        if name in seen:
            continue
        seen.add(name)
        out.append({"room": name, "tier": tier})
    if not out:
        return None
    return out


def _build_config(ext, rooms, config_path):
    cfg_dir = Path(config_path).parent
    return {
        "v": 1,
        "extensionId": ext,
        "spoolDir": str(cfg_dir / "spool"),
        "projects": [],
        "rooms": {
            "allow": rooms,
            "agent": "wall-user",
            "home": str(cfg_dir),
        },
    }


def _registry_subkey(browser):
    return ("Software\\" + _VENDOR_PATHS[browser]
            + "\\NativeMessagingHosts\\" + HOST_NAME)


def _registry_apply(browser, manifest_path):
    wr = _get_winreg()
    with wr.CreateKey(wr.HKEY_CURRENT_USER, _registry_subkey(browser)) as key:
        wr.SetValueEx(key, "", 0, wr.REG_SZ, str(manifest_path))


def _registry_remove(browser, manifest_path):
    wr = _get_winreg()
    if wr is None:
        return
    try:
        with wr.OpenKey(wr.HKEY_CURRENT_USER, _registry_subkey(browser),
                        0, wr.KEY_QUERY_VALUE | wr.KEY_SET_VALUE) as key:
            try:
                value, _kind = wr.QueryValueEx(key, "")
            except FileNotFoundError:
                return
            if value == str(manifest_path):
                wr.DeleteValue(key, "")
    except FileNotFoundError:
        pass


def main(argv=None):
    # M5: the interpreter running this installer must be >= 3.10.
    if sys.version_info[:2] < (3, 10):
        sys.stdout.write("requires Python >= 3.10\n")
        return 3
    args = list(sys.argv[1:]) if argv is None else list(argv)
    opts = _parse_args(args)
    if opts is None:
        return 2
    apply_ = opts["apply"]
    remove = opts["remove"]
    if apply_ and remove:
        return 2
    browser = opts["browser"] if opts["browser"] is not None else "chrome"
    if browser not in BROWSERS:
        return 2
    rooms = _parse_rooms(opts["rooms"])
    if rooms is None:
        return 2
    # M4: resolve the extension id. An explicit --extension-id wins when
    # both sources are supplied (that combination has no assigned contract).
    ext = None
    if opts["extension_id"] is not None:
        if not _valid_id(opts["extension_id"]):
            return 2
        ext = opts["extension_id"]
    elif opts["key_file"] is not None:
        ext = _derive_id_from_key_file(opts["key_file"])
        if ext is None:
            return 2
    if opts["config"] is not None:
        config_path = _resolve_config(opts["config"])
    else:
        config_path = _default_config_path()
    base = _manifest_dir(browser)
    mpath = base / (HOST_NAME + ".json")
    launcher = base / _launcher_name()
    expected_launcher_text = _launcher_text(
        _bridge_dir(), sys.executable, config_path)

    def _manifest_owned(data):
        # Ours means the exact shape --apply writes, with any valid pinned
        # origin (so an install made with a different --extension-id is
        # still recognised as ours). A same-name file with an unrelated
        # path, description or origin list is foreign and is preserved.
        if not isinstance(data, dict):
            return False
        if set(data.keys()) != {"name", "description", "path", "type",
                                "allowed_origins"}:
            return False
        if data.get("name") != HOST_NAME:
            return False
        if data.get("description") != DESCRIPTION:
            return False
        if data.get("path") != str(launcher):
            return False
        if data.get("type") != "stdio":
            return False
        origins = data.get("allowed_origins")
        if not isinstance(origins, list) or len(origins) != 1:
            return False
        o = origins[0]
        if not isinstance(o, str):
            return False
        prefix = "chrome-extension://"
        if not o.startswith(prefix) or not o.endswith("/"):
            return False
        return _valid_id(o[len(prefix):-1])

    def _launcher_owned():
        # A launcher is ours only when it is the exact generated text at
        # the expected path. Anything else is foreign and must be kept.
        if not os.path.lexists(launcher):
            return False
        try:
            if not launcher.is_file():
                return False
            return launcher.read_text(encoding="utf-8") == expected_launcher_text
        except OSError:
            return False

    if remove:
        if not mpath.is_file():
            return 0
        try:
            data = json.loads(mpath.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return 0
        # Delete the manifest only when it is ours (see _manifest_owned).
        if not _manifest_owned(data):
            return 0
        if _is_win():
            try:
                _registry_remove(browser, mpath)
            except OSError:
                print("Could not remove native host registry value.", file=sys.stderr)
                return 1
        try:
            mpath.unlink()
        except OSError:
            return 1
        # Only delete a launcher we would have written: exact path and
        # verified generated content (F6). Never follow an arbitrary
        # path named in a tampered manifest.
        if data.get("path") == str(launcher) and _launcher_owned():
            try:
                launcher.unlink()
            except OSError:
                pass
        return 0
    # A-U82a: default to the M2 dev id when no id was supplied.
    if ext is None:
        ext = DEFAULT_DEV_ID
    origin = "chrome-extension://" + ext + "/"
    manifest = {
        "name": HOST_NAME,
        "description": DESCRIPTION,
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": [origin],
    }
    if apply_:
        if mpath.is_file():
            try:
                data = json.loads(mpath.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return 2
            if not _manifest_owned(data):
                return 2
        # Never replace a foreign launcher: refuse before writing either
        # file so its bytes are untouched.
        if os.path.lexists(launcher) and not _launcher_owned():
            return 2
        config = _build_config(ext, rooms, config_path)
        config_created = False
        try:
            base.mkdir(parents=True, exist_ok=True)
            launcher.write_text(expected_launcher_text, encoding="utf-8")
            os.chmod(launcher, 0o700)
            mpath.write_text(json.dumps(manifest, indent=2) + "\n",
                             encoding="utf-8")
            # M3: an existing config is never overwritten.
            if not os.path.lexists(config_path):
                config_path.parent.mkdir(parents=True, exist_ok=True)
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
                try:
                    fd = os.open(config_path, flags, 0o600)
                except FileExistsError:
                    pass  # A concurrent installer created it; preserve its content.
                else:
                    with os.fdopen(fd, "w", encoding="utf-8") as stream:
                        stream.write(json.dumps(config, indent=2) + "\n")
                    config_created = True
        except OSError:
            return 1
        if _is_win():
            try:
                _registry_apply(browser, mpath)
            except OSError:
                return 1
        print("Config: " + str(config_path) +
              (" (created)" if config_created else " (preserved)"))
        try:
            configured = json.loads(config_path.read_text(encoding="utf-8"))
            for room in configured["rooms"]["allow"]:
                print("Room: " + room["room"] + " (" + room["tier"] + ")")
        except (OSError, ValueError, KeyError, TypeError):
            print("Rooms: unavailable; check the preserved config with doctor.")
        print("Installed: " + str(mpath))
        print("Launcher:  " + str(launcher))
        print("Extension ID: " + ext)
        return 0
    print(json.dumps(manifest, indent=2))
    print("Target: " + str(mpath))
    print("Extension ID: " + ext)
    print("Load the extension at chrome://extensions (Developer mode, Load unpacked).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
