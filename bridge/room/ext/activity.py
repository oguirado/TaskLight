"""Persist execution activity through the room's locked operation pipeline."""
import secrets

from . import register
from bridge.room import store


def activity_beat(args: dict) -> dict:
    allowed = {"room", "agent", "task_id", "micro_id", "run_id", "note", "op_id"}
    if not isinstance(args, dict) or set(args) - allowed:
        raise store.RoomError("bad_args", "invalid activity arguments")
    if not all(isinstance(args.get(key), str) for key in ("room", "agent")):
        raise store.RoomError("bad_args", "room and agent must be strings")
    op = {"kind": "activity.beat"}
    for key in ("task_id", "micro_id", "run_id", "note", "op_id"):
        if key in args:
            op[key] = args[key]
    if "op_id" not in op:
        op["op_id"] = secrets.token_hex(16)
    committed = store.post(args["room"], args["agent"], "op", "", op=op)
    return {"ok": True, "lamport": committed["lamport"], "beat_ts": committed["ts"]}


register({
    "name": "activity_beat",
    "description": "Record an execution activity beat for assigned active work.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "room": {"type": "string"},
            "agent": {"type": "string"},
            "task_id": {"type": "string"},
            "micro_id": {"type": "string"},
            "run_id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
            "note": {"type": "string", "maxLength": 240},
            "op_id": {"type": "string"},
        },
        "required": ["room", "agent", "task_id", "run_id"],
        "additionalProperties": False,
    },
}, activity_beat)
