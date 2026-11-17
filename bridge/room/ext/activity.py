"""Persist execution activity through the room's locked operation pipeline."""
import json
import secrets

from bridge.plan.ops import check_arguments
from . import register
from bridge.plan import fold_plan
from bridge.room import store


def activity_beat(args: dict) -> dict:
    allowed = {"room", "agent", "task_id", "micro_id", "run_id", "note", "op_id",
               "expected_opened_lamport"}
    check_arguments(args, allowed, error=store.RoomError)
    for key in ("room", "agent"):
        if key not in args:
            raise store.RoomError("bad_args", key + " is required and must be a string")
        if not isinstance(args[key], str):
            raise store.RoomError("bad_args", key + " must be a string")
    op = {"kind": "activity.beat"}
    for key in ("task_id", "micro_id", "run_id", "note", "op_id"):
        if key in args:
            op[key] = args[key]
    if "op_id" not in op:
        op["op_id"] = secrets.token_hex(16)
    fence = {}
    if "expected_opened_lamport" in args:
        fence["expected_opened_lamport"] = args["expected_opened_lamport"]
    committed = store.post(args["room"], args["agent"], "op", "", op=op, **fence)
    result = {"ok": True, "lamport": committed["lamport"], "beat_ts": committed["ts"]}
    # Recover the disposition at commit, including on replay after a later
    # deployment or termination. Current lifecycle state cannot certify it.
    events, _ = store.read(args["room"])
    prefix = [event for event in events if event["lamport"] <= committed["lamport"]]
    projection = fold_plan(prefix, **store._tpl_kw(needed=store._plan_template_ids(prefix)))
    replay_key = json.dumps([args["agent"], op["op_id"]], separators=(",", ":"))
    receipt = projection["replayed_ops"].get(replay_key)
    if receipt is None:
        raise store.RoomError("internal", "committed activity receipt missing from journal")
    if receipt.get("ignored"):
        result.update(ignored=True, reason=receipt["reason"])
    if committed.get("replayed"):
        result["replayed"] = True
    return result


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
            "expected_opened_lamport": {"type": "integer", "minimum": 1,
                                        "maximum": 2**53 - 1},
        },
        "required": ["room", "agent", "task_id", "run_id"],
        "additionalProperties": False,
    },
}, activity_beat)
