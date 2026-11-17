"""Observe a CLI child's lifecycle without capturing its streams or command."""

import argparse
import json
import math
import secrets
import signal
import subprocess
import sys
import time

from bridge.plan.errors import PlanError
from bridge.plan.ops import validate_op_shape
from bridge.room import app, store
from .lifecycle import validate_result


RESULT_FILE_MAX_BYTES = 65536


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
    if "--" not in argv:
        parser.error("a -- separator and child command are required")
    separator = argv.index("--")
    options = parser.parse_args(argv[:separator])
    command = argv[separator + 1:]
    if not command or not command[0]:
        parser.error("a child command is required after --")
    if not math.isfinite(options.beat) or not 2 <= options.beat <= 300:
        parser.error("--beat must be between 2 and 300 seconds")
    if (options.parent is None) != (options.parent_run is None):
        parser.error("--parent and --parent-run must be supplied together")
    if options.parent == options.agent:
        parser.error("an agent cannot be its own parent")

    metadata = {"room": options.room, "agent": options.agent,
                "run_id": options.run_id if options.run_id is not None else secrets.token_hex(16)}
    if options.harness is not None:
        metadata["harness"] = options.harness
    if options.parent is not None:
        metadata.update(parent_agent=options.parent, parent_run_id=options.parent_run)
    try:
        # Validate the same schema as the dispatcher, before bootstrap or launch.
        store._check_room(options.room)
        store._check_agent(options.agent)
        validate_op_shape({"kind": "agent.lifecycle", "op_id": "supervise-check",
                           "state": "deployed",
                           **{key: value for key, value in metadata.items()
                              if key not in ("room", "agent")}})
    except (store.RoomError, PlanError):
        parser.error("invalid lifecycle identity or harness")
    return metadata, options.beat, command, options.result_file


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


def _read_result(path):
    if path is None:
        return None
    try:
        with open(path, "rb") as stream:
            # A sentinel byte distinguishes the inclusive limit from overflow.
            payload = stream.read(RESULT_FILE_MAX_BYTES + 1)
        if len(payload) > RESULT_FILE_MAX_BYTES:
            raise ValueError("result file exceeds byte limit")
        return validate_result(json.loads(payload.decode("utf-8")))
    except (OSError, ValueError, UnicodeError, PlanError, RecursionError):
        sys.stderr.write("tasklight run: result file missing or invalid; result omitted\n")
        sys.stderr.flush()
        return None


def main(argv=None):
    metadata, beat, command, result_file = _arguments(list(sys.argv[1:] if argv is None else argv))
    lifecycle = _Lifecycle(metadata)
    child = None
    pending_signals = []
    previous_handlers = {}

    def forward(number, _frame):
        if child is None:
            pending_signals.append(number)
        else:
            try:
                child.send_signal(number)
            except OSError:
                # The child may have exited between notification and forwarding.
                pass

    try:
        # Install before deployment/launch so startup signals are not lost.
        for number in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[number] = signal.signal(number, forward)
        lifecycle.emit("deployed")
        try:
            # Inherit the actual descriptors: preserve binary streams, stdin,
            # terminal behavior, and every argument after the separator.
            child = subprocess.Popen(command, shell=False)
        except OSError as exc:
            code = 127 if isinstance(exc, FileNotFoundError) else 126
            lifecycle.emit("failed", "exit:" + str(code))
            sys.stderr.write("tasklight run: child could not start\n")
            return code
        for number in pending_signals:
            forward(number, None)

        deadline = time.monotonic() + beat
        while True:
            try:
                code = child.wait(timeout=max(0, deadline - time.monotonic()))
                break
            except subprocess.TimeoutExpired:
                # A child exiting at the deadline must not receive a late beat.
                code = child.poll()
                if code is not None:
                    break
                lifecycle.emit("alive")
                deadline += beat
                now = time.monotonic()
                if deadline <= now:
                    deadline = now + beat

        result = _read_result(result_file)
        if code < 0:
            try:
                name = signal.Signals(-code).name
            except ValueError:
                # Intermediate real-time signals have no Signals enum member.
                name = signal.strsignal(-code) or str(-code)
            lifecycle.emit("failed", "signal:" + name, result=result)
            return 128 - code
        if code:
            lifecycle.emit("failed", "exit:" + str(code), result=result)
        else:
            lifecycle.emit("finished", result=result)
        return code
    finally:
        # No background heartbeat survives the wait or terminal lifecycle event.
        for number, handler in previous_handlers.items():
            signal.signal(number, handler)
