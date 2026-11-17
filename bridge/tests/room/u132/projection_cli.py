"""Bounded stdin/stdout adapter for differential and fresh-process probes."""
import copy
import json
import os
import sys
from unittest import mock

from bridge.plan.fold import apply_op_event, fold_plan
from bridge.room import app, store
from .support import TEMPLATES, probe


def main():
    request = json.load(sys.stdin)
    mode = request["mode"]
    if mode == "probe":
        result = probe()
    elif mode == "fold":
        result = fold_plan(request["events"], templates=TEMPLATES)
    elif mode == "continue":
        state = copy.deepcopy(request["projection"])
        for event in request["events"]:
            state, _ = apply_op_event(state, event, templates=TEMPLATES)
        result = state
    elif mode == "call":
        with mock.patch.object(store.time, "time", return_value=request["ts"] / 1000):
            try:
                result = app.dispatch("agent_lifecycle", request["args"])
            except store.RoomError as exc:
                result = {"ok": False, "code": exc.code, "detail": str(exc)}
    elif mode == "race":
        # Parent supplies a pipe FD: one-byte release, no timers or polling.
        fd = request["barrier_fd"]
        if os.read(fd, 1) != b"x":
            raise AssertionError("race barrier closed")
        os.close(fd)
        with mock.patch.object(store.time, "time", return_value=request["ts"] / 1000):
            result = app.dispatch("agent_lifecycle", request["args"])
    else:
        raise AssertionError("unknown differential mode")
    json.dump(result, sys.stdout, ensure_ascii=True, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
