"""Real, bounded Python history/CLI oracle; every scratch write stays here."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True


def deny_network(*_args, **_kwargs):
    raise AssertionError("Network forbidden in the memory oracle")


socket.socket = deny_network
request = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix=".scratch-", dir=Path(__file__).parent) as scratch:
    os.environ["CW_HOME"] = scratch
    for room in {event["room"] for event in request["events"]}:
        directory = Path(scratch) / "rooms" / room
        directory.mkdir(parents=True)
        (directory / "events.jsonl").write_text(
            "".join(json.dumps(e) + "\n" for e in request["events"] if e["room"] == room),
            encoding="utf-8",
        )
    before = {str(p.relative_to(scratch)): p.read_bytes()
              for p in Path(scratch).rglob("events.jsonl")}
    if request.get("cli"):
        # Fixed argv, never shell=True; only the documented JSON argument varies.
        child = subprocess.run(
            [sys.executable, "-B", "-c",
             "import runpy,socket,sys; socket.socket=lambda *a,**k: (_ for _ in ()).throw(AssertionError('network forbidden')); "
             "sys.argv=['bridge.room','call','room_export','--json',sys.argv[1]]; "
             "runpy.run_module('bridge.room',run_name='__main__')",
             json.dumps(request["args"], separators=(",", ":"))],
            cwd=ROOT, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            capture_output=True, text=True, timeout=5, check=True,
        )
        result = json.loads(child.stdout)
    else:
        from bridge.room.ext.export import memory_history
        result = memory_history({"room": request.get("room", "demo"),
                                 "agent": "worker-a", "section": request.get("section", "goal"),
                                 "limit": 100})
    after = {str(p.relative_to(scratch)): p.read_bytes()
             for p in Path(scratch).rglob("events.jsonl")}
    if after != before:
        raise AssertionError("Reading memory appended an event")
    if any(p.suffix.lower() == ".md" for p in Path(scratch).rglob("*")):
        raise AssertionError("Memory export must not automatically save a Markdown file")
    json.dump(result, sys.stdout, ensure_ascii=True)
