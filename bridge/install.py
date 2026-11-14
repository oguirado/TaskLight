"""U09 installer: Chrome Native Messaging manifest under HOME.

Dry run by default (prints, writes nothing). --apply installs the
manifest and an executable host launcher; --remove deletes only what
--apply wrote.
"""
import json
import os
import shlex
import sys
from pathlib import Path

HOST_NAME = "com.contextwall.bridge"
PINNED_ID = "nnmhdaibaopekhjcpnekgdpeaaojclof"
DESCRIPTION = "Context Wall bridge native host"


def _valid_id(s):
    return isinstance(s, str) and len(s) == 32 and all("a" <= c <= "p" for c in s)


def _home():
    h = os.environ.get("HOME")
    return Path(h) if h else Path.home()


def _manifest_dir(home):
    if sys.platform.startswith("win"):
        return home / "AppData" / "Local" / "google-chrome" / "NativeMessagingHosts"
    return home / ".config" / "google-chrome" / "NativeMessagingHosts"


def _bridge_dir():
    return Path(__file__).resolve().parent


def _launcher_text(bridge_dir):
    # U38 G3: the repo root (parent of bridge/) goes on the import path so
    # `bridge.wall.room_relay` can import `bridge.room` (python3 -m
    # bridge.wall host semantics).
    repo_root = Path(bridge_dir).resolve().parent
    code = ("import sys, runpy; "
            "sys.path.insert(0, %r); "
            "sys.argv = ['wall', 'host'] + sys.argv[1:]; "
            "runpy.run_module('bridge.wall', run_name='__main__', "
            "alter_sys=True)" % str(repo_root))
    return ("#!/bin/sh\n"
            "# Context Wall bridge native host launcher (generated).\n"
            "exec python3 -I -c " + shlex.quote(code) + " \"$@\"\n")


def main(argv=None):
    args = list(sys.argv[1:]) if argv is None else list(argv)
    apply_ = False
    remove = False
    ext = PINNED_ID
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--apply":
            apply_ = True
            i += 1
            continue
        if a == "--remove":
            remove = True
            i += 1
            continue
        if a == "--extension-id":
            if i + 1 >= len(args):
                return 2
            ext = args[i + 1]
            i += 2
            continue
        if a.startswith("--extension-id="):
            ext = a[len("--extension-id="):]
            i += 1
            continue
        return 2
    if apply_ and remove:
        return 2
    if not _valid_id(ext):
        return 2
    home = _home()
    base = _manifest_dir(home)
    mpath = base / (HOST_NAME + ".json")
    launcher = base / (HOST_NAME + ".host.sh")
    origin = "chrome-extension://" + ext + "/"
    manifest = {
        "name": HOST_NAME,
        "description": DESCRIPTION,
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": [origin],
    }
    expected_launcher_text = _launcher_text(_bridge_dir())

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
        try:
            base.mkdir(parents=True, exist_ok=True)
            launcher.write_text(expected_launcher_text,
                                encoding="utf-8")
            os.chmod(launcher, 0o755)
            mpath.write_text(json.dumps(manifest, indent=2) + "\n",
                             encoding="utf-8")
        except OSError:
            return 1
        print("Installed: " + str(mpath))
        print("Launcher:  " + str(launcher))
        print("Pinned extension ID: " + ext)
        return 0
    print(json.dumps(manifest, indent=2))
    print("Target: " + str(mpath))
    print("Pinned extension ID: " + ext)
    return 0


if __name__ == "__main__":
    sys.exit(main())
