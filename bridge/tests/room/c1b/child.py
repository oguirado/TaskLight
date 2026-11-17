"""Small local child programs used by the supervisor contract tests."""
import json
import os
from pathlib import Path
import signal
import sys


def main():
    mode, *args = sys.argv[1:]
    marker = os.environ.get("C1B_CHILD_MARKER")
    if marker:
        Path(marker).write_text("started", encoding="utf-8")
    if mode == "exit":
        os.write(1, b"child-ran\n")
        return int(args[0])
    if mode == "streams":
        data = sys.stdin.buffer.read()
        sys.stdout.buffer.write(b"OUT\x00\xff:" + data)
        sys.stdout.buffer.flush()
        sys.stderr.buffer.write(b"ERR\x00\xfe:" + data[::-1])
        sys.stderr.buffer.flush()
        return 0
    if mode == "argv":
        os.write(1, json.dumps(args, ensure_ascii=False).encode("utf-8"))
        return 0
    if mode == "deployed":
        path = Path(os.environ["CW_HOME"]) / "rooms" / "demo" / "events.jsonl"
        events = [json.loads(line) for line in path.read_text().splitlines()]
        matching = [event for event in events if event.get("agent") == "exec-a"
                    and event.get("op", {}).get("state") == "deployed"]
        if not matching or matching[-1]["op"]["run_id"] != "run-A_1":
            return 94
        os.write(1, b"deployed-before-child\n")
        return 0
    if mode == "privacy":
        os.write(1, b"C1B_STDOUT_SENTINEL")
        os.write(2, b"C1B_STDERR_SENTINEL")
        return 0
    if mode == "self-signal":
        number = getattr(signal, args[0])
        signal.signal(number, signal.SIG_DFL)
        os.kill(os.getpid(), number)
        return 96
    if mode in ("signal", "catch-signal"):
        number = getattr(signal, args[0])
        if mode == "catch-signal":
            signal.signal(number, lambda *_: sys.exit(19))
        else:
            signal.signal(number, signal.SIG_DFL)
        os.write(1, b"CHILD-READY\n")
        # EOF is a cleanup escape if a broken supervisor leaves this child alive.
        # The test keeps stdin open until the signal outcome has been observed.
        sys.stdin.buffer.read()
        return 97
    raise AssertionError("unknown child fixture")


if __name__ == "__main__":
    sys.exit(main())
