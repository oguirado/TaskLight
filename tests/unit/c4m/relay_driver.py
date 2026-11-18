"""Emit real replay pages from a disposable on-disk journal."""
import json
from pathlib import Path
import sys
import tempfile
from unittest import mock

from bridge.room import store
from bridge.tests.room.c4m.support import OLD_CAP, ROOM, invoke, offline_room, outcome
from bridge.wall import room_relay

HERE = Path(__file__).resolve().parent
FLOOR = "ONLY_ON_DEVICE"
AGENT = "reviewer"


def open_plan(template, title, phase, task_type, identity, brief):
    return invoke("plan_create", agent=AGENT, title=title, template_id=template,
                  brief=brief, op_id=identity, tasks=[
                      {"key": "work", "title": title + " task", "phase": phase,
                       "type": task_type, "accept": "Verify the outcome",
                       "microtasks": [{"text": "Check the result"}]},
                  ])


def replay(home, start, fail_at=None):
    frames = []

    def send(frame):
        if frame["t"] == "room_event" and frame["event"]["lamport"] == fail_at:
            return False
        frames.append(frame)
        return True

    relay = room_relay.RoomRelay({"agent": AGENT, "rooms": [{"room": ROOM, "floor": FLOOR}]},
                                 send, home=home, clock=lambda: 0.0)
    pages = []
    cursor = start
    for number in range(1, 5):
        request = {"t": "room_sync", "v": 1, "rid": f"l{number}", "since": {ROOM: cursor}}
        frames.clear()
        relay.handle(request)
        pages.append({"request": request, "frames": list(frames)})
        if not frames:
            break
        marker = frames[-1]
        if marker["t"] != "room_synced" or not marker["more"]:
            break
        if marker["upto"] <= cursor:
            raise AssertionError("replay continuation failed to advance")
        cursor = marker["upto"]
    else:
        raise AssertionError("replay exceeded the fixture page budget")
    return pages


def fixture(home, cross_boundary):
    first = open_plan("blank", "Legacy plan", "execute", "task", "open-legacy",
                      {"goal": "Preserve old history"})
    task = invoke("plan_get")["tasks"][0]
    invoke("task_update", agent=AGENT, task_id=task["id"], base_rev=task["rev"],
           state="cancelled", op_id="cancel-legacy")
    active = invoke("plan_get")["plan"]
    invoke("plan_close", agent=AGENT, base_rev=active["rev"], op_id="close-legacy")

    journal = home / "rooms" / ROOM / "events.jsonl"
    old_events = store.read_checked(ROOM)[0]
    last = old_events[-1]["lamport"]
    gap = last + 2
    # Install valid old records until the real relay must paginate.
    with journal.open("ab") as stream:
        for clock in range(last + 1, 504):
            event = {"id": f"e-{0x100000 + clock:016x}", "room": ROOM, "agent": AGENT,
                     "lamport": clock, "ts": 1_800_000_000_000, "act": "heartbeat",
                     "text": ("x" * 4096 if clock == gap else "legacy heartbeat")}
            stream.write(json.dumps(event).encode() + b"\n")
        target = OLD_CAP if cross_boundary else OLD_CAP - 65_536
        remaining = target - stream.tell()
        for _ in range(remaining // 65_536):
            stream.write(b" " * 65_535 + b"\n")
        fragment = remaining % 65_536
        if fragment:
            stream.write(b" " * (fragment - 1) + b"\n")
    if journal.stat().st_size != target:
        raise AssertionError("incorrect legacy journal size")
    prefix = journal.read_bytes()
    new = outcome(lambda: open_plan(
        "cli-library", "Current plan", "api-design", "api-surface", "open-current",
        {"target-audience": "Operators", "public-interface": "Command line",
         "compatibility-target": "Stable release"}))
    if "code" in new:
        return {"write": new}
    if not journal.read_bytes().startswith(prefix):
        raise AssertionError("the append replaced the legacy prefix")

    saved = first["opened_lamport"] + 1
    with mock.patch.dict(room_relay.ROOM_LIMITS, {"FRAME_MAX": 4096}):
        complete = replay(home, 0)
        resumed = replay(home, saved)
        failed = replay(home, saved, fail_at=gap + 1)
    history = [{"id": e["id"], "lamport": e["lamport"]} for e in store.read_checked(ROOM)[0]]
    ids = ("blank", "cli-library")
    return {
        "write": {"ok": True}, "first": first["opened_lamport"],
        "current": new["reply"]["opened_lamport"], "gap": gap, "saved": saved,
        "history": history, "complete": complete, "resumed": resumed, "failed": failed,
        "templates": [invoke("get_template", template_id=key)["template"] for key in ids],
    }


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(dir=HERE) as entry:
        with offline_room(Path(entry)) as home:
            print(json.dumps(fixture(home, sys.argv[1] == "cross-boundary")))
