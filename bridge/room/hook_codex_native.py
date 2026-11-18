"""Silent Codex native hooks reduced to hashed lifecycle identities."""

import time

_STARTED = time.monotonic()

import hashlib
import itertools
import json
import math
import os
import re
import stat
import sys
import tempfile

_INPUT_MAX = 65536
_ALIVE_SECONDS = 15
_STATE_RETENTION_SECONDS = 24 * 60 * 60
_RUNTIME_ENTRY = re.compile(r"codex-native-[0-9a-f]{64}\.json(?:\.lock)?")
_COUNTER = itertools.count()
_EVENTS = {
    "SessionStart": "deployed",
    "SessionEnd": "finished",
    "SubagentStart": "deployed",
    "SubagentStop": "finished",
    "Stop": "alive",
    "Interrupt": "alive",
    "UserPromptSubmit": "alive",
    "PreToolUse": "alive",
}
_THROTTLED = {"UserPromptSubmit", "PreToolUse"}


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False)


def _digest(value, length=64):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def _string(value):
    return isinstance(value, str) and bool(value)


def _lifecycle(payload):
    if not isinstance(payload, dict):
        return None
    event, session = payload.get("hook_event_name"), payload.get("session_id")
    if not _string(event) or event not in _EVENTS or not _string(session):
        return None
    # A present identity must be a nonempty string, including explicit null.
    if "agent_id" in payload and not _string(payload["agent_id"]):
        return None
    child = event in {"SubagentStart", "SubagentStop"} or (
        event in _THROTTLED and "agent_id" in payload)
    parent = "cx-" + _digest(session, 10)
    parent_run = "cx-" + _digest(session, 16)
    agent, run_id = parent, parent_run
    if child:
        native_id = payload.get("agent_id")
        if not _string(native_id):
            return None
        agent_type = payload.get("agent_type")
        prefix = ""
        if _string(agent_type):
            prefix = re.sub(r"[^a-z0-9]+", "-", agent_type.lower()).strip("-")[:24].rstrip("-")
        agent = (prefix or "agent") + "-" + _digest(native_id, 8)
        run_id = "cx-" + _digest(native_id, 16) + "-" + _digest(session, 10)
    tool_id = payload.get("tool_use_id")
    occurrence = (tool_id if _string(tool_id)
                  else [next(_COUNTER), _digest(_canonical(payload))])
    event_id = _digest(_canonical([event, session, payload.get("agent_id"), occurrence]))
    value = {"event_id": event_id, "agent": agent, "run_id": run_id,
             "harness": "codex", "state": _EVENTS[event]}
    if event == "SubagentStart":
        value.update(parent_agent=parent, parent_run_id=parent_run)
    if event == "SessionEnd" and payload.get("reason") == "other":
        value["reason"] = "other"
    return event, value


def _save_state(path, state):
    fd, temporary = tempfile.mkstemp(prefix=".codex-native-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(_canonical(state) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _load_state(path):
    from bridge.room import store
    from bridge.room.hook import _unique, _invalid_constant

    try:
        with open(path, "rb") as stream:
            raw = stream.read(257)
        if len(raw) > 256:
            return {}
        state = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
                           parse_constant=_invalid_constant)
        if not isinstance(state, dict) or state.keys() - {"agent", "last_alive"}:
            return {}
        if "agent" in state:
            store._check_agent(state["agent"])
        if "last_alive" in state:
            last = state["last_alive"]
            if type(last) not in (int, float) or not math.isfinite(last):
                return {}
        return state
    except (FileNotFoundError, ValueError, OverflowError, RecursionError, store.RoomError):
        return {}


def _prune_runtime(directory, current_path, deadline):
    cutoff = time.time() - _STATE_RETENTION_SECONDS
    try:
        with deadline.wait(), os.scandir(directory) as entries:
            for entry in entries:
                deadline.check()
                if entry.path == current_path or not _RUNTIME_ENTRY.fullmatch(entry.name):
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISREG(info.st_mode) and info.st_mtime < cutoff:
                        os.unlink(entry.path)
                except OSError:
                    continue
    except (OSError, deadline.expiration):
        pass  # Pruning can resume on the next successful state write.


def _dispatch(event, value, deadline):
    from bridge.room import _lock
    from bridge.room.ext import cleanup
    from bridge.room.hook import _execute

    child = value["run_id"].count("-") == 2
    throttled = event in _THROTTLED
    if not child and not throttled:
        return _execute(_canonical(value).encode("utf-8"), deadline)
    directory = os.path.join(cleanup.room_directory(value["room"], create=True), "runtime")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    path = os.path.join(directory, "codex-native-" + _digest(value["run_id"]) + ".json")
    # A stable room lock coordinates state writes with pruning without
    # leaving a separate lock file for each run.
    lock_path = os.path.join(directory, "codex-native.lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        with deadline.wait():
            _lock.lock_exclusive(fd)
        try:
            state = _load_state(path)
            if child and "agent" in state:
                value["agent"] = state["agent"]
            now = time.time()
            if throttled and "last_alive" in state and now - state["last_alive"] < _ALIVE_SECONDS:
                return None
            deadline.check()
            result = _execute(_canonical(value).encode("utf-8"), deadline)
            receipt = result.get("untrusted") if isinstance(result, dict) else None
            if isinstance(receipt, dict) and receipt.get("ok") is True:
                if child:
                    state["agent"] = value["agent"]
                if throttled:
                    state["last_alive"] = now
                _save_state(path, state)
                _prune_runtime(directory, path, deadline)
            return result
        finally:
            _lock.unlock(fd)
    finally:
        os.close(fd)


def _settings():
    hooks = {}
    for event in _EVENTS:
        synchronous = event in {"SessionEnd", "Interrupt"}
        command = {"type": "command", "command": "python3 -m bridge.room.hook_codex_native",
                   "timeout": 3 if synchronous else 10}
        if not synchronous:
            command["async"] = True
        hooks[event] = [{"hooks": [command]}]
    return {"hooks": hooks}


def main():
    try:
        if sys.argv[1:] == ["--print-settings"]:
            print(json.dumps(_settings(), indent=2))
            return 0
        if sys.argv[1:]:
            return 0
        from bridge.room.hook import _Deadline, _unique, _invalid_constant
        from bridge.room.hook_claude_native import _room
        from bridge.room import store

        with _Deadline(_STARTED, reserve=0.2) as deadline:
            with deadline.wait():
                raw = sys.stdin.buffer.read(_INPUT_MAX + 1)
            if len(raw) > _INPUT_MAX:
                return 0
            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
                                 parse_constant=_invalid_constant)
            lifecycle = _lifecycle(payload)
            if lifecycle is None:
                return 0
            event, value = lifecycle
            room = _room(payload)
            if room is None:
                return 0
            store._check_room(room)
            value["room"] = room
            _dispatch(event, value, deadline)
    except BaseException:
        # Observational hooks must stay silent even on expired waits, malformed
        # input, unavailable imports or storage failures. Exit is not a receipt.
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
