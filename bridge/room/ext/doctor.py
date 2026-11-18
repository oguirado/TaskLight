"""Read-only diagnostics for the native harness lifecycle hooks."""

import argparse
import json
import os
from pathlib import Path
import shlex
import stat

from bridge.room import hook_claude_native, hook_codex_native, store
from bridge.room.hook import _invalid_constant, _unique


_HARNESSES = {
    "claude-code": hook_claude_native,
    "codex": hook_codex_native,
}
_HINTS = {
    "invalid_arguments": "Use --help to check the supported harnesses and options.",
    "invalid_room_env": "Set TASKLIGHT_ROOM to a valid room slug or unset it.",
    "invalid_room_config": "Give the nearest .tasklight.json a valid room slug.",
    "unreadable_room_config": "Make the nearest .tasklight.json readable.",
    "room_not_configured": "Set TASKLIGHT_ROOM or add a .tasklight.json with a room slug.",
    "room_missing": "Confirm CW_HOME or start the configured harness to register the room.",
    "room_read_failed": "Check the room journal's permissions and restore a valid journal if needed.",
    "room_full": "Select a fresh room with capacity for new journal events.",
    "journal_capacity_unknown": "Check journal access and rerun the doctor.",
    "invalid_hook_settings": "Correct the harness settings JSON in the indicated scope.",
    "unreadable_hook_settings": "Make the harness settings readable in the indicated scope.",
    "hook_command_missing": "Merge the adapter's --print-settings output into the harness hook settings.",
}


def _add_problem(problems, code, **context):
    problems.append({"code": code, "hint": _HINTS[code], **context})


def _open_regular(path, flags):
    fd = os.open(path, flags | getattr(os, "O_NONBLOCK", 0))
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError("configuration must be a regular file")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _select_room(directories, problems):
    # Match the native adapters' explicit environment precedence and depth.
    source = "TASKLIGHT_ROOM"
    if source in os.environ:
        name = os.environ[source]
        invalid = "invalid_room_env"
    else:
        source = ".tasklight.json"
        invalid = "invalid_room_config"
        for directory in directories[:8]:
            try:
                with open(directory / source, "rb", opener=_open_regular) as stream:
                    raw = stream.read(hook_claude_native._INPUT_MAX + 1)
            except FileNotFoundError:
                continue
            except OSError:
                _add_problem(problems, "unreadable_room_config")
                return None, source
            try:
                config = None
                if len(raw) <= hook_claude_native._INPUT_MAX:
                    config = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
                                        parse_constant=_invalid_constant)
                name = config.get("room") if isinstance(config, dict) else None
            except (ValueError, RecursionError):
                name = None
            break
        else:
            _add_problem(problems, "room_not_configured")
            return None, None

    try:
        store._check_room(name)
    except store.RoomError:
        _add_problem(problems, invalid)
        return None, source
    return name, source


def _inspect_room(harness, room, journal, problems):
    name = room["name"]
    if name is None:
        return None
    room["readable"] = False
    try:
        room["exists"] = store._room_directory_exists(None, name)
    except store.RoomError:
        _add_problem(problems, "room_read_failed")
        return None
    if not room["exists"]:
        _add_problem(problems, "room_missing")
        return None

    try:
        info = os.stat(store._events_path(None, name))
        if stat.S_ISREG(info.st_mode):
            free = max(0, store.CAP - info.st_size)
            journal.update(size_bytes=info.st_size, free_bytes=free, has_space=free > 0,
                           heartbeat_free_bytes=max(0, free - store.SEMANTIC_RESERVE_BYTES))
            if not free:
                _add_problem(problems, "room_full")
    except OSError:
        # The checked reader reports missing, invalid or unreadable storage.
        pass

    try:
        events, _ = store.read_checked(name)
    except store.RoomError:
        _add_problem(problems, "room_read_failed")
        return None
    room["readable"] = True
    if journal["has_space"] is None:
        _add_problem(problems, "journal_capacity_unknown")
    latest = max(
        (event for event in reversed(events)
         if event["act"] == "op" and event["op"]["kind"] == "agent.lifecycle"
         and event["op"].get("harness") == harness),
        key=lambda event: event["lamport"], default=None,
    )
    if latest is None:
        return None
    return {
        "agent": latest["agent"], "run_id": latest["op"]["run_id"],
        "state": latest["op"]["state"], "lamport": latest["lamport"], "ts": latest["ts"],
    }


def _settings_files(harness, directories):
    if harness == "claude-code":
        folder, filename = ".claude", "settings.json"
        user = os.environ.get("CLAUDE_CONFIG_DIR")
    else:
        folder, filename = ".codex", "hooks.json"
        user = os.environ.get("CODEX_HOME")
    user_dir = Path(os.path.expanduser(user)) if user else Path.home() / folder
    for directory in directories:
        path = directory / folder / filename
        if path != user_dir / filename:
            yield "project", path
    yield "user", user_dir / filename


def _matches_command(handler, expected):
    if not isinstance(handler, dict) or handler.get("type") != "command":
        return False
    command = handler.get("command")
    if not isinstance(command, str) or "\n" in command or "\r" in command:
        return False
    try:
        return shlex.split(command) == expected
    except ValueError:
        return False


def _configured_events(path, events, expected):
    def open_settings(filename, flags):
        return _open_regular(filename, flags | getattr(os, "O_NOFOLLOW", 0))

    with open(path, encoding="utf-8", opener=open_settings) as stream:
        settings = json.load(stream, object_pairs_hook=_unique,
                             parse_constant=_invalid_constant)
    hooks = settings.get("hooks", {}) if isinstance(settings, dict) else None
    if not isinstance(hooks, dict):
        raise ValueError("invalid hooks settings")

    for event in events:
        groups = hooks.get(event)
        if not isinstance(groups, list):
            continue
        for group in groups:
            handlers = group.get("hooks") if isinstance(group, dict) else None
            if isinstance(handlers, list) and any(
                _matches_command(handler, expected) for handler in handlers
            ):
                yield event
                break


def _inspect_hooks(harness, directories, problems):
    settings = _HARNESSES[harness]._settings()["hooks"]
    command = settings["SessionStart"][0]["hooks"][0]["command"]
    expected = shlex.split(command)
    events = {}
    for scope, path in _settings_files(harness, directories):
        try:
            found = set(_configured_events(path, settings, expected))
        except FileNotFoundError:
            continue
        except OSError:
            _add_problem(problems, "unreadable_hook_settings", scope=scope)
        except (ValueError, RecursionError):
            _add_problem(problems, "invalid_hook_settings", scope=scope)
        else:
            if found:
                events.setdefault(scope, set()).update(found)
    if not events:
        _add_problem(problems, "hook_command_missing")
    return {"command": command, "installed": bool(events),
            "events": {scope: sorted(found) for scope, found in events.items()}}


def _report(harness, cwd):
    directory = Path(os.path.abspath(cwd))
    directories = (directory, *directory.parents)
    problems = []
    name, source = _select_room(directories, problems)
    room = {"name": name, "source": source, "exists": None, "readable": None}
    journal = {"cap_bytes": store.CAP, "size_bytes": None, "free_bytes": None,
               "has_space": None, "heartbeat_free_bytes": None}
    last = _inspect_room(harness, room, journal, problems)
    hook = _inspect_hooks(harness, directories, problems)
    return {"ok": not problems, "harness": harness, "room": room, "journal": journal,
            "hook": hook, "last_lifecycle": last, "problems": problems}


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, _message):
        problems = []
        _add_problem(problems, "invalid_arguments")
        print(json.dumps({"ok": False, "problems": problems}))
        self.exit(1)


def main(argv=None):
    parser = _ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--harness", choices=_HARNESSES, default="claude-code")
    parser.add_argument("--cwd", default=os.curdir)
    args = parser.parse_args(argv)
    report = _report(args.harness, args.cwd)
    print(json.dumps(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
