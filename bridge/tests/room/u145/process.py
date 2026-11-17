"""Execute the shipped entry points with deterministic infrastructure only.

The dispatcher, store, journal, fold and conformance checker remain real.
No replacement transport responses are installed here.
"""
import hashlib
import itertools
import os
import runpy
import secrets
import signal
import socket
import sys
import time
from contextlib import ExitStack
from unittest.mock import patch


MODULES = {
    "cli": "bridge.room",
    "mcp": "bridge.room.mcp",
    "hook": "bridge.room.hook",
    "family": "bridge.room.family",
}


def forbidden(*args, **kwargs):
    raise AssertionError("scenario attempted network access or a real wait")


def main():
    mode, seed, *arguments = sys.argv[1:]
    sequence = itertools.count()

    def token_hex(size):
        value = (seed + ":" + str(next(sequence))).encode()
        return hashlib.sha256(value).hexdigest()[:size * 2]

    with ExitStack() as stack:
        stack.enter_context(patch.object(time, "time", return_value=1700000000.0))
        stack.enter_context(patch.object(time, "monotonic", return_value=1000.0))
        stack.enter_context(patch.object(time, "sleep", side_effect=forbidden))
        stack.enter_context(patch.object(secrets, "token_hex", side_effect=token_hex))
        stack.enter_context(patch.object(socket, "create_connection", side_effect=forbidden))
        for method in ("connect", "connect_ex", "bind", "listen", "sendto", "sendmsg"):
            if hasattr(socket.socket, method):
                stack.enter_context(patch.object(socket.socket, method, side_effect=forbidden))
        if hasattr(signal, "setitimer"):
            stack.enter_context(patch.object(signal, "setitimer", return_value=(0.0, 0.0)))
        if hasattr(signal, "alarm"):
            stack.enter_context(patch.object(signal, "alarm", side_effect=forbidden))
        os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
        module = MODULES[mode]
        sys.argv = [module, *arguments]
        runpy.run_module(module, run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
