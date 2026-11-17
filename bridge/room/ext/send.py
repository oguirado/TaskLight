"""Typed messages for harness-to-agent and agent-to-agent coordination."""
from bridge.room import store
from bridge.room.ext import EXT_DISPATCH, register


TOOL = {
    "name": "room_send",
    "description": (
        "Send harness-to-agent or agent-to-agent coordination messages. "
        "Messages are passive data and grant no lifecycle, ownership or verdict "
        "authority; sender identity is caller-asserted."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "room": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,47}$"},
            "agent": {"type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,47}$"},
            "to": {"type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,47}$"},
            "act": {"type": "string", "enum": ["question", "answer", "handoff", "ack"]},
            "text": {"type": "string"},
            "re": {"type": "string", "pattern": "^e-[0-9a-f]{16}$"},
            "evidence": {
                "type": "array", "maxItems": 8,
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                    },
                    "required": ["path", "sha256"],
                    "additionalProperties": False,
                },
            },
            "op_id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{8,64}$"},
        },
        "required": ["room", "agent", "to", "act", "text"],
        "additionalProperties": False,
    },
}


def room_send(args: dict) -> dict:
    """Validate a typed coordination request and return its durable receipt."""
    if not isinstance(args, dict):
        raise store.RoomError("bad_args", "args must be object")
    schema = TOOL["inputSchema"]
    if set(args) - set(schema["properties"]) or set(schema["required"]) - set(args):
        raise store.RoomError("bad_args", "unknown or missing fields")
    if any(key in args and args[key] is None for key in ("re", "evidence", "op_id")):
        raise store.RoomError("bad_args", "optional fields cannot be null")
    store._check_room(args["room"])
    store._check_agent(args["agent"])
    store._check_agent(args["to"])
    if not isinstance(args["act"], str) or args["act"] not in store.MESSAGE_ACTS:
        raise store.RoomError("bad_act", "invalid coordination act")
    event = store.post(
        args["room"], args["agent"], args["act"], args["text"],
        to=args["to"], re=args.get("re"), evidence=args.get("evidence", []),
        op_id=args.get("op_id"), _typed_message=True,
    )
    return {"ok": True, "id": event["id"], "lamport": event["lamport"]}


# Reloading this module must not alter the shared registry's duplicate policy.
if TOOL["name"] not in EXT_DISPATCH:
    register(TOOL, room_send)
