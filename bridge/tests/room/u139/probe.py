"""Real lifecycle calls in a disposable interpreter, including lost replies."""
import json
import os
import socket
import sys
from unittest import mock

from bridge.room import store
from bridge.room.ext.lifecycle import agent_lifecycle


def main():
    request = json.load(sys.stdin)
    with mock.patch.object(store.time, "time", return_value=request["now"] / 1000), \
         mock.patch.object(socket, "socket", side_effect=AssertionError("network forbidden")), \
         mock.patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")):
        try:
            result = agent_lifecycle(request["args"])
        except store.RoomError as exc:
            result = {"ok": False, "code": exc.code}
    if request.get("crash_after_backend"):
        # This is the consumer gap: the backend returned, but no completion
        # record or response is written. Bypass normal interpreter cleanup.
        if result != request["expected"]:
            raise AssertionError("crash prerequisite: backend did not return the throttled result")
        os._exit(0)
    json.dump(result, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
