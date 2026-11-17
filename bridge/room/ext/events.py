"""Bounded journal cursor extension."""
import time

from bridge.plan.ops import check_arguments
from bridge.room import store
from bridge.room.ext import register


TOOL = {
    "name": "room_events",
    "description": "Read room journal events after a Lamport cursor.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "room": {"type": "string"},
            "agent": {"type": "string"},
            "after_lamport": {"type": "integer", "minimum": 0},
            "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 100},
            "acts": {"type": "array", "items": {"type": "string"}},
            "ops": {"type": "array", "items": {"type": "string"}},
            "wait_ms": {"type": "integer", "minimum": 0, "maximum": 30000, "default": 0},
        },
        "required": ["room", "agent", "after_lamport"],
        "additionalProperties": False,
    },
}

_ALLOWED = {"room", "agent", "after_lamport", "limit", "acts", "ops", "wait_ms"}


def _project(e):
    item = {
        "id": e["id"],
        "room": e["room"],
        "agent": e["agent"],
        "act": e["act"],
        "text": e["text"],
        "ts": e["ts"],
        "lamport": e["lamport"],
    }
    op = e.get("op")
    if isinstance(op, dict):
        item["op"] = op
    for key in ("to", "re"):
        if key in e:
            item[key] = e[key]
    return item


def handler(args) -> dict:
    if not isinstance(args, dict):
        raise store.RoomError("bad_args", "args must be object")
    if "room" not in args:
        raise store.RoomError("bad_room", "missing room")
    store._check_room(args["room"])
    if "agent" not in args:
        raise store.RoomError("bad_agent", "missing agent")
    store._check_agent(args["agent"])
    check_arguments(args, _ALLOWED, error=store.RoomError)
    if "after_lamport" not in args:
        raise store.RoomError("bad_args", "after_lamport is required")
    after = args["after_lamport"]
    if type(after) is not int or after < 0:
        raise store.RoomError("bad_args", "after_lamport must be an integer >= 0")
    if "limit" in args:
        limit = args["limit"]
        if type(limit) is not int or not (1 <= limit <= 500):
            raise store.RoomError("bad_args", "limit must be an integer in 1-500")
    else:
        limit = 100
    if "wait_ms" in args:
        wait_ms = args["wait_ms"]
        if type(wait_ms) is not int or not (0 <= wait_ms <= 30000):
            raise store.RoomError("bad_args", "wait_ms must be an integer in 0-30000")
    else:
        wait_ms = 0
    acts = None
    if "acts" in args:
        v = args["acts"]
        if not isinstance(v, list) or any(not isinstance(x, str) for x in v):
            raise store.RoomError("bad_args", "acts must be an array of strings")
        acts = set(v)
    ops = None
    if "ops" in args:
        v = args["ops"]
        if not isinstance(v, list) or any(not isinstance(x, str) for x in v):
            raise store.RoomError("bad_args", "ops must be an array of strings")
        ops = set(v)

    room = args["room"]

    deadline = None
    if wait_ms > 0:
        deadline = time.monotonic() + wait_ms / 1000.0

    version = None
    head = 0
    while True:
        if store._journal_stamp(None, room) != version:
            events, head, version = store._read_event_view(None, room, after)
            events = [e for e in events if e["room"] == room]
            if after > head:
                return {
                    "events": [],
                    "next_after": head,
                    "head": head,
                    "has_more": False,
                    "resync": True,
                }
            ordered = sorted(events, key=lambda e: e["lamport"])
            matches = []
            for e in ordered:
                if e["lamport"] <= after:
                    continue
                if acts is not None and e.get("act") not in acts:
                    continue
                if ops is not None:
                    op = e.get("op")
                    if not isinstance(op, dict):
                        continue
                    if op.get("kind") not in ops:
                        continue
                matches.append(e)
            if matches:
                page = matches[:limit]
                has_more = len(matches) > len(page)
                next_after = page[-1]["lamport"] if has_more else head
                return {
                    "events": [_project(e) for e in page],
                    "next_after": next_after,
                    "head": head,
                    "has_more": has_more,
                    "resync": False,
                }
        if wait_ms == 0 or deadline is None:
            return {
                "events": [],
                "next_after": head,
                "head": head,
                "has_more": False,
                "resync": False,
            }
        now = time.monotonic()
        if now >= deadline:
            return {
                "events": [],
                "next_after": head,
                "head": head,
                "has_more": False,
                "resync": False,
            }
        remaining = deadline - now
        poll = 0.05
        if poll > remaining:
            poll = remaining
        if poll <= 0:
            return {
                "events": [],
                "next_after": head,
                "head": head,
                "has_more": False,
                "resync": False,
            }
        time.sleep(poll)


register(TOOL, handler)
