"""Bind and repair unit pipeline steps through the shared journal writer."""

from bridge.plan.limits import REASON_MAX
from bridge.plan.ops import check_arguments
from bridge.room import store
from bridge.wall.emit import sanitize_output
from . import register

_COMMON = {
    "room": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,47}$"},
    "agent": {"type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,47}$"},
    "op_id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{8,64}$"},
    "task_id": {"type": "string", "pattern": "^T(0[1-9]|[1-3][0-9]|40)$"},
    "expected_opened_lamport": {"type": "integer", "minimum": 1, "maximum": 2**53 - 1},
}
_BIND = {
    "micro_id": {"type": "string", "pattern": r"^T(0[1-9]|[1-3][0-9]|40)\.M(0[1-9]|1[0-2])$"},
    "result_agent": _COMMON["agent"],
    "result_run_id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
}
_REPAIR = {"reason": {"type": "string", "minLength": 1, "maxLength": REASON_MAX}}


def _post(args, kind, properties):
    fields = _COMMON | properties
    check_arguments(args, fields, fields, code="bad_op", error=store.RoomError)
    op = {"kind": kind, **{key: args[key] for key in fields if key not in ("room", "agent")}}
    from bridge.room import app
    event = app._post_one(args["room"], args["agent"], op, args=args)
    return sanitize_output({"ok": True, "lamport": event["lamport"], "op": event["op"]})


def unit_bind(args: dict) -> dict:
    return _post(args, "unit.bind", _BIND)


def unit_repair(args: dict) -> dict:
    return _post(args, "unit.repair", _REPAIR)


def _register(name, description, properties, handler):
    fields = _COMMON | properties
    register({"name": name, "description": description, "inputSchema": {
        "type": "object", "additionalProperties": False,
        "required": list(fields), "properties": fields,
    }}, handler)


_register("unit_bind", "Bind a pipeline step to a registered run.", _BIND, unit_bind)
_register("unit_repair", "Reset the pipeline from author through import and retain attempt history.",
          _REPAIR, unit_repair)
