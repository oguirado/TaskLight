"""Fresh-process handler probe, with fixed time and forbidden network."""
import json
import os
import sys
from bridge.room.ext import acquire
from .support import deterministic

if __name__ == "__main__":
    tool, args = json.load(sys.stdin)
    with deterministic(os.environ["CW_HOME"], "restart"):
        result = getattr(acquire, tool)(args)
    print(json.dumps(result))
