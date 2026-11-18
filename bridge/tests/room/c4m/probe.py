"""Fresh interpreter for checking persisted journal and tool replies."""
import json
from pathlib import Path
import sys

from bridge.room import store

from .support import ROOM, invoke, offline_room, outcome


def call(tool, args):
    if tool == "batch":
        return store.post_ops(ROOM, "reviewer", args["ops"])
    if tool == "legacy-evidence":
        return store.post(ROOM, **args)
    return invoke(tool, **args)


if __name__ == "__main__":
    request = json.load(sys.stdin)
    with offline_room(Path(request["root"])):
        replies = [outcome(lambda: call(tool, args)) for tool, args in request["calls"]]
        print(json.dumps({"events": store.read_checked(ROOM)[0], "replies": replies}))
