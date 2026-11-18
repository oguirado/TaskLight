"""Observational Claude Code hooks, reduced to hashed lifecycle identities."""

import time

_STARTED = time.monotonic()

import hashlib
import itertools
import json
import math
import os
import re
import sys
import tempfile

_INPUT_MAX = 65536
_ALIVE_SECONDS = 15
_COUNTER = itertools.count()
_EVENTS = {
    "SessionStart": "deployed",
    "SessionEnd": "finished",
    "SubagentStart": "deployed",
    "SubagentStop": "finished",
    "Stop": "alive",
    "StopFailure": "failed",
    "UserPromptSubmit": "alive",
    "PreToolUse": "alive",
}
_THROTTLED = {"UserPromptSubmit", "PreToolUse"}
_REASONS = {"clear", "resume", "logout", "prompt_input_exit", "other"}


def _digest(value, length=64):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False)


def _string(value):
    return isinstance(value, str) and bool(value)


def _room(payload):
    # A supplied but invalid environment value must never select another room.
    if "TASKLIGHT_ROOM" in os.environ:
        return os.environ["TASKLIGHT_ROOM"]
    cwd = payload.get("cwd")
    if not _string(cwd):
        return None
    directory = os.path.abspath(cwd)
    for _ in range(8):
        try:
            with open(os.path.join(directory, ".tasklight.json"), "rb") as stream:
                raw = stream.read(_INPUT_MAX + 1)
        except FileNotFoundError:
            parent = os.path.dirname(directory)
            if parent == directory:
                break
            directory = parent
            continue
        # The nearest configuration is authoritative, even when malformed.
        if len(raw) > _INPUT_MAX:
            return None
        from bridge.room.hook import _unique, _invalid_constant
        config = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
                            parse_constant=_invalid_constant)
        return config.get("room") if isinstance(config, dict) else None
    return None


def _lifecycle(payload):
    if not isinstance(payload, dict):
        return None
    event = payload.get("hook_event_name")
    session = payload.get("session_id")
    if not _string(event) or event not in _EVENTS or not _string(session):
        return None
    parent = "cc-" + _digest(session, 10)
    parent_run = "cc-" + _digest(session, 16)
    agent, run_id = parent, parent_run
    child = event in {"SubagentStart", "SubagentStop"} or (
        event not in {"SessionStart", "SessionEnd"} and payload.get("agent_id") is not None)
    if child:
        native_id, agent_type = payload.get("agent_id"), payload.get("agent_type")
        if not _string(native_id):
            return None
        # C1cq: an odd, non-ASCII or missing agent_type never hides a sub-agent.
        prefix = ""
        if _string(agent_type):
            prefix = re.sub(r"[^a-z0-9]+", "-", agent_type.lower()).strip("-")[:24].rstrip("-")
        if not prefix:
            prefix = "agent"
        agent = prefix + "-" + _digest(native_id, 8)
        run_id = "cc-" + _digest(native_id, 16) + "-" + _digest(session, 10)
    # The single stdin event gets process ordinal zero, also on exact replay.
    # A canonical fingerprint additionally distinguishes separate prompts/turns
    # without a tool-use ID. Only the digest crosses the lifecycle boundary.
    tool_id = payload.get("tool_use_id")
    occurrence = (tool_id if _string(tool_id)
                  else [next(_COUNTER), _digest(_canonical(payload))])
    event_id = _digest(_canonical([event, session, payload.get("agent_id"), occurrence]))
    value = {"event_id": event_id, "agent": agent, "run_id": run_id,
             "harness": "claude-code", "state": _EVENTS[event]}
    if event == "SubagentStart":
        value.update(parent_agent=parent, parent_run_id=parent_run)
    if event == "SessionEnd":
        reason = payload.get("reason")
        if isinstance(reason, str) and reason in _REASONS:
            value["reason"] = reason
    return event, value


def _save_timestamp(path, now):
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix=".claude-native-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(_canonical({"last_alive": now}) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _heartbeat(value, deadline):
    from bridge.room import _lock
    from bridge.room.ext import cleanup
    from bridge.room.hook import _execute

    directory = os.path.join(cleanup.room_directory(value["room"], create=True), "runtime")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    key = _digest(_canonical([value["agent"], value["run_id"]]))
    path = os.path.join(directory, "claude-native-" + key + ".json")
    fd = os.open(path + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        with deadline.wait():
            _lock.lock_exclusive(fd)
        try:
            last = None
            try:
                with open(path, "rb") as stream:
                    raw = stream.read(257)
                if len(raw) > 256:
                    return
                last = json.loads(raw)["last_alive"]
                if (isinstance(last, bool) or not isinstance(last, (int, float))
                        or not math.isfinite(last)):
                    return
            except FileNotFoundError:
                pass
            now = time.time()
            if last is not None and now - last < _ALIVE_SECONDS:
                return
            deadline.check()
            result = _execute(_canonical(value).encode("utf-8"), deadline)
            receipt = result.get("untrusted") if isinstance(result, dict) else None
            if isinstance(receipt, dict) and receipt.get("ok") is True:
                _save_timestamp(path, now)
        finally:
            _lock.unlock(fd)
    finally:
        os.close(fd)


def _settings():
    command = {"type": "command", "command": "python3 -m bridge.room.hook_claude_native",
               "async": True}
    return {"hooks": {event: [{"matcher": "*", "hooks": [dict(command)]}]
                      for event in _EVENTS}}


def main():
    # Reuse the established deadline, parser guards, bootstrap and lifecycle
    # dispatch. This adapter never opens or appends the room journal itself.
    try:
        from bridge.room.hook import _Deadline, _execute, _unique, _invalid_constant
        if sys.argv[1:] == ["--print-settings"]:
            print(json.dumps(_settings(), indent=2))
            return 0
        if sys.argv[1:]:
            return 0
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
            from bridge.room import store
            store._check_room(room)
            value["room"] = room
            if event not in {"SessionStart", "SessionEnd"} and _string(payload.get("agent_id")):
                try:
                    # Optional type metadata can change between hooks. Reuse
                    # the run's admitted identity without a separate registry.
                    with deadline.wait():
                        records, _ = store.read(room)
                        earliest = min(
                            (record for record in records
                             if isinstance(record, dict) and record.get("act") == "op"
                             and isinstance(record.get("agent"), str)
                             and store.AGENT_RE.fullmatch(record["agent"])
                             and store._is_int(record.get("lamport"))
                             and record["lamport"] > 0
                             and isinstance(record.get("op"), dict)
                             and record["op"].get("kind") == "agent.lifecycle"
                             and record["op"].get("run_id") == value["run_id"]),
                            key=lambda record: record["lamport"], default=None,
                        )
                    if earliest is not None:
                        value["agent"] = earliest["agent"]
                except Exception:
                    # Lookup is best effort; keep the computed identity.
                    pass
            if event in _THROTTLED:
                _heartbeat(value, deadline)
            else:
                _execute(_canonical(value).encode("utf-8"), deadline)
    except BaseException:
        # Include the deadline sentinel and imports in this observational fence.
        # Deliberately omit diagnostics rather than echo any untrusted content.
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
