"""Validate and launch a manifest of supervised TaskLight commands."""

from contextlib import ExitStack
import json
import math
import os
import signal
import subprocess
import sys

from bridge.plan.errors import PlanError
from bridge.room import app, store
from bridge.room.__main__ import _JsonParser, _emit, _refuse
from .supervise import _validate_metadata


_HEADER_FIELDS = {"room", "parent", "parent_run", "lanes"}
_LANE_REQUIRED = {"agent", "run_id", "argv", "result_file"}
_LANE_OPTIONAL = {"harness", "wall_s", "stdin"}
_TERMINAL = ("finished", "failed")
_WAIT_INTERVAL = 0.1


def _lane_command(lane, room, parent, parent_run):
    if (not isinstance(lane, dict) or not _LANE_REQUIRED <= lane.keys()
            or lane.keys() - (_LANE_REQUIRED | _LANE_OPTIONAL)):
        raise ValueError("invalid lane fields")
    agent, run_id = lane["agent"], lane["run_id"]
    metadata = {"room": room, "agent": agent, "run_id": run_id,
                "parent_agent": parent, "parent_run_id": parent_run}
    if "harness" in lane:
        metadata["harness"] = lane["harness"]
    try:
        _validate_metadata(metadata)
    except (PlanError, store.RoomError, ValueError):
        raise ValueError("invalid lifecycle identity or harness") from None
    argv = lane["argv"]
    if (not isinstance(argv, list) or not argv or not argv[0]
            or any(not isinstance(arg, str) or "\x00" in arg for arg in argv)):
        raise ValueError("argv must be a nonempty string array with an executable")
    path = lane["result_file"]
    if not isinstance(path, str) or not path or "\x00" in path:
        raise ValueError("invalid result_file")
    try:
        for arg in (*argv, path):
            os.fsencode(arg)
        canonical_path = os.path.realpath(path)
    except (OSError, ValueError):
        raise ValueError("invalid argv or result_file") from None

    command = [sys.executable, "-m", "bridge.room", "run",
               "--room", room, "--agent", agent, "--run-id", run_id,
               "--parent", parent, "--parent-run", parent_run,
               "--result-file=" + path]
    if "harness" in lane:
        command.append("--harness=" + lane["harness"])
    if "wall_s" in lane:
        limit = lane["wall_s"]
        try:
            valid_limit = type(limit) in (int, float) and math.isfinite(limit) and limit > 0
        except OverflowError:
            valid_limit = False
        if not valid_limit:
            raise ValueError("wall_s must be a positive finite number")
        command += ["--wall-s", str(limit)]
    stdin_mode = lane.get("stdin", "devnull")
    if stdin_mode not in ("devnull", "inherit"):
        raise ValueError("stdin must be devnull or inherit")
    stdin = None if stdin_mode == "inherit" else subprocess.DEVNULL
    command += ["--", *argv]
    return (agent, run_id), canonical_path, (command, stdin)


def _read_manifest(path):
    try:
        with open(path, encoding="utf-8") as stream:
            manifest = json.load(stream)
    except (OSError, ValueError, RecursionError):
        raise ValueError("manifest must be a readable JSON file") from None
    if not isinstance(manifest, dict) or manifest.keys() != _HEADER_FIELDS:
        raise ValueError("manifest requires room, parent, parent_run and lanes")
    room, parent, parent_run = manifest["room"], manifest["parent"], manifest["parent_run"]
    try:
        _validate_metadata({"room": room, "agent": parent, "run_id": parent_run})
    except (PlanError, store.RoomError, ValueError):
        raise ValueError("invalid room or parent identity") from None
    lanes = manifest["lanes"]
    if not isinstance(lanes, list) or not 1 <= len(lanes) <= 64:
        raise ValueError("lanes must contain between 1 and 64 entries")
    pin = app.session_pin_from_env()
    commands, paths = {}, set()
    for index, lane in enumerate(lanes):
        try:
            identity, result_path, command = _lane_command(lane, room, parent, parent_run)
            app.guard_session({"agent": identity[0]}, pin=pin, lifecycle=True)
            if identity in commands:
                raise ValueError("duplicate agent/run_id pair")
            if result_path in paths:
                raise ValueError("duplicate result_file")
        except store.RoomError:
            raise ValueError(f"lanes[{index}]: lifecycle requires a harness session") from None
        except ValueError as exc:
            raise ValueError(f"lanes[{index}]: {exc}") from None
        paths.add(result_path)
        commands[identity] = command
    return room, commands


def _terminal_history(room, identities):
    try:
        os.lstat(store._events_path(None, room))
    except FileNotFoundError:
        return {}
    events, _ = store.read_checked(room)
    terminals = {}
    for event in events:
        if not isinstance(event, dict):
            continue
        op = event.get("op")
        if (not isinstance(op, dict) or op.get("kind") != "agent.lifecycle"
                or op.get("state") not in _TERMINAL
                or not isinstance(op.get("reason", ""), str)):
            continue
        agent, run_id = event.get("agent"), op.get("run_id")
        if isinstance(agent, str) and isinstance(run_id, str):
            identity = agent, run_id
            if identity in identities:
                terminals.setdefault(identity, op)
    return terminals


def _wait_for_wrappers(wrappers, signals):
    exits, notified = {}, set()
    forwarded = False
    for identity, wrapper in wrappers.items():
        while True:
            if signals and not forwarded:
                for target, running in wrappers.items():
                    if target in exits or running.poll() is not None:
                        continue
                    try:
                        running.send_signal(signals[0])
                    except ProcessLookupError:
                        continue
                    notified.add(target)
                forwarded = True
            try:
                # The handler only records the signal. A timed wait lets us
                # forward it outside Popen's wait lock, including while it waits.
                exits[identity] = wrapper.wait(timeout=None if forwarded else _WAIT_INTERVAL)
                break
            except subprocess.TimeoutExpired:
                continue
    return exits, notified


def _wrapper_reason(number):
    return f"wrapper:{signal.Signals(number).name}"


def _run_wave(room, commands, signals):
    try:
        previous = _terminal_history(room, commands)
    except (OSError, store.RoomError):
        return _refuse("room_read_failed")

    # Reserve stdout for the summary. Stream lane output if stderr is open.
    try:
        os.fstat(2)
        stdout, stderr = 2, None
    except OSError:
        stdout = stderr = subprocess.DEVNULL

    wrappers, outcomes = {}, {}
    try:
        for identity, (command, stdin) in commands.items():
            if identity in previous:
                outcomes[identity] = ("skipped", "already_terminal", None)
            elif signals:
                outcomes[identity] = ("failed", _wrapper_reason(signals[0]), None)
            else:
                try:
                    # Only the wave should receive signals to its foreground group.
                    wrappers[identity] = subprocess.Popen(
                        command, shell=False, stdin=stdin, stdout=stdout, stderr=stderr,
                        start_new_session=True,
                    )
                except OSError as exc:
                    code = 127 if isinstance(exc, FileNotFoundError) else 126
                    outcomes[identity] = ("failed", f"exit:{code}", code)
    finally:
        exits, notified = _wait_for_wrappers(wrappers, signals)

    if exits:
        history_error = False
        try:
            terminals = _terminal_history(room, exits)
        except (OSError, store.RoomError):
            terminals, history_error = {}, True
        for identity, code in exits.items():
            terminal = terminals.get(identity)
            exit_code = code if code >= 0 else 128 - code
            if terminal is None:
                if history_error:
                    reason = "room_read_failed"
                elif identity in notified:
                    # A signal can reach a new wrapper before it installs its handlers.
                    reason = _wrapper_reason(signals[0])
                else:
                    reason = "missing_terminal"
                outcomes[identity] = ("failed", reason, exit_code)
            else:
                outcomes[identity] = (terminal["state"], terminal.get("reason"), exit_code)

    rows = []
    for agent, run_id in commands:
        state, reason, code = outcomes[agent, run_id]
        rows.append({"agent": agent, "run_id": run_id, "state": state,
                     "reason": reason, "exit": code})
    _emit({"wave": {"lanes": rows}})
    return 0 if all(row["state"] == "finished" for row in rows) else 1


def main(argv=None):
    parser = _JsonParser(prog="tasklight wave", allow_abbrev=False)
    parser.add_argument("--manifest", required=True)
    options = parser.parse_args(argv)
    signals = []

    def remember_signal(number, _frame):
        if not signals:
            signals.append(number)

    with ExitStack() as handlers:
        for number in (signal.SIGINT, signal.SIGTERM):
            previous = signal.signal(number, remember_signal)
            handlers.callback(signal.signal, number, previous)
        try:
            room, commands = _read_manifest(options.manifest)
        except store.RoomError:
            return _refuse("bad_args", "invalid lifecycle session pin")
        except ValueError as exc:
            return _refuse("bad_args", str(exc))
        return _run_wave(room, commands, signals)
