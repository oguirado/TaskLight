"""Observe a CLI child's lifecycle without capturing its streams or command."""

import argparse
import json
import math
import os
import secrets
import signal
import stat
import subprocess
import sys
import time

from bridge.plan.errors import PlanError
from bridge.plan.ops import validate_op_shape
from bridge.room import app, store
from .lifecycle import validate_result


RESULT_FILE_MAX_BYTES = 65536
SHUTDOWN_GRACE = 2.0
RESULT_GRACE = 2.0
POLL_INTERVAL = 0.125


def _validate_metadata(metadata):
    store._check_room(metadata["room"])
    store._check_agent(metadata["agent"])
    if metadata.get("parent_agent") == metadata["agent"]:
        raise ValueError("an agent cannot be its own parent")
    validate_op_shape({"kind": "agent.lifecycle", "op_id": "supervise-check",
                       "state": "deployed",
                       **{key: value for key, value in metadata.items()
                          if key not in ("room", "agent")}})


def _arguments(argv):
    parser = argparse.ArgumentParser(prog="tasklight run", allow_abbrev=False)
    parser.add_argument("--room", required=True)
    parser.add_argument("--agent", required=True)
    parser.add_argument("--harness")
    parser.add_argument("--parent")
    parser.add_argument("--parent-run")
    parser.add_argument("--run-id")
    parser.add_argument("--beat", type=float, default=15)
    parser.add_argument("--result-file")
    parser.add_argument("--wall-s", type=float)
    parser.add_argument("--no-group", action="store_true")
    if "--" not in argv:
        parser.error("a -- separator and child command are required")
    separator = argv.index("--")
    options = parser.parse_args(argv[:separator])
    command = argv[separator + 1:]
    if not command or not command[0]:
        parser.error("a child command is required after --")
    if not math.isfinite(options.beat) or not 2 <= options.beat <= 300:
        parser.error("--beat must be between 2 and 300 seconds")
    if options.wall_s is not None and (not math.isfinite(options.wall_s) or options.wall_s <= 0):
        parser.error("--wall-s must be positive and finite")
    if (options.parent is None) != (options.parent_run is None):
        parser.error("--parent and --parent-run must be supplied together")
    metadata = {"room": options.room, "agent": options.agent,
                "run_id": options.run_id if options.run_id is not None else secrets.token_hex(16)}
    if options.harness is not None:
        metadata["harness"] = options.harness
    if options.parent is not None:
        metadata.update(parent_agent=options.parent, parent_run_id=options.parent_run)
    try:
        # Validate the same schema as the dispatcher, before bootstrap or launch.
        _validate_metadata(metadata)
    except (store.RoomError, PlanError, ValueError):
        parser.error("invalid lifecycle identity or harness")
    return metadata, options, command


class _Lifecycle:
    def __init__(self, metadata):
        self.metadata = metadata
        self.reported_loss = False
        try:
            self.pin = app.session_pin_from_env()
            self.pin_error = False
        except Exception:
            self.pin = None
            self.pin_error = True

    def emit(self, state, reason=None, result=None):
        try:
            if self.pin_error:
                raise store.RoomError("bad_args", "invalid lifecycle session pin")
            args = dict(self.metadata, state=state, op_id=secrets.token_hex(16))
            if reason is not None:
                args["reason"] = reason
            if result is not None:
                args["result"] = result
            app.dispatch("agent_lifecycle", args, pin=self.pin)
        except Exception:
            # Never include the exception, child argv, environment or output.
            if not self.reported_loss:
                self.reported_loss = True
                try:
                    sys.stderr.write("tasklight run: lifecycle recording unavailable\n")
                    sys.stderr.flush()
                except Exception:
                    pass


def _open_regular_result(path, flags):
    # Inspect the opened descriptor, preventing path replacement races. Opening
    # a FIFO without a writer must return promptly before rejecting its type.
    descriptor = os.open(path, flags | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("result file must be regular")
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def _read_result(path, *, warn=True):
    if path is None:
        return None
    try:
        with open(path, "rb", opener=_open_regular_result) as stream:
            # A sentinel byte distinguishes the inclusive limit from overflow.
            payload = stream.read(RESULT_FILE_MAX_BYTES + 1)
        if len(payload) > RESULT_FILE_MAX_BYTES:
            raise ValueError("result file exceeds byte limit")
        return validate_result(json.loads(payload.decode("utf-8")))
    except (OSError, ValueError, UnicodeError, PlanError, RecursionError):
        if warn:
            _warn_result()
        return None


def _warn_result():
    _warn("tasklight run: result file missing or invalid; result omitted\n")


def _warn(warning):
    stderr = sys.stderr
    if stderr is not None:
        try:
            if stderr is sys.__stderr__:
                # A buffered write retried at interpreter shutdown could
                # replace the child's exit status.
                os.write(stderr.fileno(), warning.encode("ascii"))
            else:
                stderr.write(warning)
                stderr.flush()
        except (OSError, ValueError):
            pass


class _Result:
    def __init__(self, path):
        self.path = path
        self.value = None
        self.deadline = None
        self.next_read = None

    def observe_exit(self, now):
        if self.path is not None and self.deadline is None:
            self.deadline = now + RESULT_GRACE
            self.next_read = now
        if self.next_read is not None and now >= self.next_read:
            self.value = _read_result(self.path, warn=False)
            if self.value is None and now < self.deadline:
                self.next_read = min(self.deadline, now + POLL_INTERVAL)
            else:
                self.next_read = None
                if self.value is None:
                    _warn_result()

    def finish(self):
        self.observe_exit(time.monotonic())
        while self.next_read is not None:
            time.sleep(max(0, self.next_read - time.monotonic()))
            self.observe_exit(time.monotonic())
        return self.value


def _signal_child(child, number, *, group):
    try:
        if group:
            os.killpg(child.pid, number)
        else:
            # The foreground opt-out shares the wrapper's process group.
            child.send_signal(number)
    except ProcessLookupError:
        pass


def _group_has_live_members(pgid):
    # On Linux a killed orphan can remain a zombie until its adopter reaps it.
    # Inspect process states while the unreaped leader still pins the group ID.
    try:
        with os.scandir("/proc") as entries:
            for entry in entries:
                if not entry.name.isdecimal():
                    continue
                try:
                    with open(os.path.join(entry.path, "stat"), "rb") as stream:
                        fields = stream.read().rpartition(b") ")[2].split()
                except (FileNotFoundError, ProcessLookupError, PermissionError):
                    continue
                if len(fields) >= 4 and fields[0] not in (b"Z", b"X"):
                    if int(fields[2]) == pgid and int(fields[3]) == pgid:
                        return True
    except OSError:
        return None
    return False


def _cancellation(signals, wall, observed_at):
    if signals:
        received_at, number = signals[0]
        if received_at <= observed_at and (wall is None or received_at <= wall):
            return number, "wrapper:" + signal.Signals(number).name
    if wall is not None and observed_at >= wall:
        return signal.SIGTERM, "wall_timeout"
    return None, None


def _wait_for_child(child, options, spawned_at, lifecycle, signals, result):
    next_beat = spawned_at + options.beat
    wall = spawned_at + options.wall_s if options.wall_s is not None else None
    group = not options.no_group
    reason, escalation = None, None
    killed = False

    while True:
        code = None
        if group:
            try:
                # poll()/wait() would release the leader's PID before we can
                # safely signal descendants still using it as their group ID.
                exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            except ChildProcessError:
                # There is no kernel child to pin, so never signal its group.
                group = False
                continue
            exited = exited is not None
        else:
            code = child.poll()
            exited = code is not None

        # Recording a heartbeat can delay the first observation of an exit.
        # Resolve cancellation against the spawn-based deadline before reaping.
        now = time.monotonic()
        if reason is None:
            number, reason = _cancellation(signals, wall, now)
            if reason is not None and (group or not exited):
                if group or options.no_group:
                    _signal_child(child, number, group=group)
                    escalation = time.monotonic() + SHUTDOWN_GRACE
                else:
                    return child.wait(), reason

        if exited:
            if not group:
                return code, reason
            if reason is None:
                return child.wait(), None
            result.observe_exit(now)
            # If procfs is unavailable, reap once the group KILL has
            # been sent and the leader has exited.
            if killed and (not sys.platform.startswith("linux")
                           or _group_has_live_members(child.pid) is not True):
                return child.wait(), reason
        elif reason is None and now >= next_beat:
            lifecycle.emit("alive")
            next_beat += options.beat
            if next_beat <= time.monotonic():
                next_beat = time.monotonic() + options.beat

        if escalation is not None and now >= escalation:
            _signal_child(child, signal.SIGKILL, group=group)
            if not group:
                return child.wait(), reason
            killed, escalation = True, None
            continue

        if killed:
            deadline = now + POLL_INTERVAL
        elif escalation is not None:
            deadline = escalation
        else:
            deadline = next_beat if wall is None else min(next_beat, wall)
        if result.next_read is not None:
            deadline = min(deadline, result.next_read)
        delay = max(0, deadline - time.monotonic())
        if group:
            time.sleep(min(POLL_INTERVAL, delay))
        else:
            try:
                timeout = min(POLL_INTERVAL, delay) if options.no_group else delay
                code = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                continue
            if reason is None:
                _, reason = _cancellation(signals, wall, time.monotonic())
            return code, reason


def main(argv=None):
    metadata, options, command = _arguments(list(sys.argv[1:] if argv is None else argv))
    lifecycle = _Lifecycle(metadata)
    signals = []
    previous_handlers = {}

    def remember_signal(number, _frame):
        if not signals:
            signals.append((time.monotonic(), number))

    try:
        # Install before deployment/launch so startup signals are not lost.
        for number in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[number] = signal.signal(number, remember_signal)
        lifecycle.emit("deployed")
        try:
            # Inherit the actual descriptors: preserve binary streams, stdin,
            # terminal behavior, and every argument after the separator.
            child = subprocess.Popen(command, shell=False, start_new_session=not options.no_group)
        except OSError as exc:
            code = 127 if isinstance(exc, FileNotFoundError) else 126
            lifecycle.emit("failed", "exit:" + str(code))
            _warn("tasklight run: child could not start\n")
            return code
        spawned_at = time.monotonic()
        lifecycle.emit("alive")
        result = _Result(options.result_file)
        code, reason = _wait_for_child(child, options, spawned_at, lifecycle, signals, result)
        value = result.finish()
        if code < 0:
            try:
                name = signal.Signals(-code).name
            except ValueError:
                # Intermediate real-time signals have no Signals enum member.
                name = signal.strsignal(-code) or str(-code)
            lifecycle.emit("failed", reason or "signal:" + name, result=value)
            return 128 - code
        lifecycle.emit("failed" if reason or code else "finished",
                       reason or "exit:" + str(code), result=value)
        return code
    finally:
        # No background heartbeat survives the wait or terminal lifecycle event.
        for number, handler in previous_handlers.items():
            signal.signal(number, handler)
