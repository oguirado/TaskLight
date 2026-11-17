"""Read-only Python half of cross-language fold and inventory comparisons."""
import json
import socket
import sys
import time
from unittest import mock

from bridge.room import app  # Loads the same lifecycle validator as admission.
from bridge.room.ext.inventory import derive_inventory
from .support import FIXTURE, NOW, TEMPLATES, StopRule, bounded, fold


def main():
    raw = sys.stdin.buffer.read(131073)
    if len(raw) > 131072:
        raise ValueError("bounded probe input exceeded")
    request = json.loads(raw)
    with mock.patch.object(socket, "socket", side_effect=StopRule("network forbidden")), \
            mock.patch.object(socket, "create_connection", side_effect=StopRule("network forbidden")), \
            mock.patch.object(time, "sleep", side_effect=StopRule("real wait forbidden")), bounded():
        events = request.get("events", FIXTURE["seed"])
        if request["what"] == "fold":
            result = fold(events)
        elif request["what"] == "inventory":
            result = derive_inventory("demo", events, NOW, templates=TEMPLATES)
        else:
            raise ValueError("unknown read-only probe action")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
