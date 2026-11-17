"""Append immutable unit decisions using the existing plan admission path."""
import copy
import json
import os
import secrets

from bridge.plan.ops import check_arguments
from bridge.plan.errors import PlanError
from bridge.plan.ops import validate_op_shape
from bridge.room import store
from bridge.wall.emit import sanitize_output
from . import register

# Extension kinds join the store's static admission inventory at load time.
store.OP_KINDS = store.OP_KINDS | {"unit.decision"}


_legacy_post = getattr(store.post, "_before_decisions", store.post)


def _post(room, agent, act, text, *, op=None, home=None, clock=None, templates=None,
          expected_opened_lamport=store._UNFENCED, **kwargs):
    # Standard decision envelopes share the store's admission/replay primitives.
    # Rich legacy envelopes and all other operation kinds retain their writer.
    if (act != "op" or not isinstance(op, dict) or op.get("kind") != "unit.decision" or kwargs):
        return _legacy_post(room, agent, act, text, op=op, home=home, clock=clock,
                            templates=templates, expected_opened_lamport=expected_opened_lamport, **kwargs)
    store._validate_expected_opened_lamport(expected_opened_lamport)
    store._check_room(room)
    store._check_agent(agent)
    if not isinstance(text, str):
        raise store.RoomError("text_too_long", "text must be string")
    try:
        if len(text.encode("utf-8")) > 4096:
            raise store.RoomError("text_too_long", "text too long")
    except UnicodeEncodeError:
        raise store.RoomError("bad_op", "text must be valid UTF-8") from None
    store._validate_op_static(op)
    op = copy.deepcopy(op)
    request = {"act": act, "text": text, "re": None, "to": None, "evidence": [], "op": op}
    if expected_opened_lamport is not store._UNFENCED:
        request["expected_opened_lamport"] = expected_opened_lamport
    digest = store._request_hash(request)
    ts = store._resolve_ts(clock, True)
    directory = store._ensure_dirs(home, room)
    path = os.path.join(directory, "events.jsonl")
    lockfd = os.open(os.path.join(directory, "events.lock"), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            store._lock.lock_exclusive(lockfd)
        except TimeoutError as exc:
            raise store.RoomError("internal", "room lock timeout") from exc
        try:
            try:
                with open(path, "rb") as stream:
                    data = stream.read()
            except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
                data = b""
            events, _ = store._parse_events_bytes(data)
            store._check_plan_generation(events, expected_opened_lamport, home=home, templates=templates)
            matched = store._op_identity_index(events, agent, room).get(op["op_id"])
            if matched is not None:
                return store._single_replay(matched, digest)
            # Allocate under the journal lock and reject an exhausted generator:
            # duplicate event identities would otherwise erase accepted decisions
            # during replay. Never rewrite an earlier event to repair a collision.
            ids = {event["id"] for event in events}
            for _ in range(len(ids) + 1):
                identity = "e-" + secrets.token_hex(8)
                if identity not in ids:
                    break
            else:
                raise store.RoomError("internal", "event identity allocation failed")
            event = {"id": identity, "lamport": store._max_lamport_from_bytes(data) + 1,
                     "ts": ts, "room": room, "agent": agent, "act": act, "text": text,
                     "op": op, "request_sha256": digest}
            tpl_kw = store._tpl_kw(home, templates, store._plan_template_ids(events))
            try:
                state = store.fold_plan(events, **tpl_kw)
                store.apply_op_event(state, event, last_by_agent=store._op_max_activity(events), **tpl_kw)
            except store.RoomError:
                raise
            except Exception as exc:
                store._raise_op(exc)
            separator = b"\n" if data and not data.endswith(b"\n") else b""
            payload = separator + (json.dumps(event, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
            if len(data) + len(payload) > store._journal_ceiling([event]):
                raise store.RoomError("room_full", "room file cap exceeded")
            fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
            try:
                store._write_all(fd, payload, len(data))
            finally:
                os.close(fd)
            return event
        finally:
            store._lock.unlock(lockfd)
    except OSError as exc:
        raise store.RoomError("internal", str(exc)) from exc
    finally:
        os.close(lockfd)


_post._before_decisions = _legacy_post
store.post = _post


def unit_decide(args: dict) -> dict:
    fields = {"op_id", "task_id", "micro_id", "verdict", "reason", "evidence", "run_id",
              "result_agent", "result_run_id"}
    check_arguments(args, fields | {"room", "agent", "expected_opened_lamport"},
                    ("room", "agent"), code="bad_op", error=store.RoomError)
    store._check_room(args["room"])
    store._check_agent(args["agent"])
    op = {"kind": "unit.decision", **{key: args[key] for key in fields if key in args}}
    # New references are independent of the envelope author. Retain the
    # original same-actor form for existing clients and journal retries.
    if "run_id" in args:
        op["agent"] = args["agent"]
    try:
        op = validate_op_shape(op)
    except PlanError as exc:
        raise store.RoomError(exc.code, str(exc)) from exc
    from bridge.room import app
    try:
        event = app._post_one(args["room"], args["agent"], op, args=args)
    except store.RoomError as exc:
        refs = "agent and run_id" if "run_id" in args else "result_agent and result_run_id"
        details = {
            "unknown decision task": "task_id must identify an existing task in the active plan; unknown decision task",
            "unknown decision microtask": "micro_id must identify a microtask of task_id; unknown decision microtask",
            "unknown result reference": refs + " must identify a stored terminal result; unknown result reference",
        }
        detail = str(exc).removeprefix(exc.code + ": ")
        if exc.code == "bad_op" and detail in details:
            raise store.RoomError(exc.code, details[detail]) from None
        raise
    return sanitize_output({"ok": True, "lamport": event["lamport"], "op": op})


register({
    "name": "unit_decide",
    "description": "Record an ADMIT, HOLD or REJECT decision for a unit in the active plan.",
    "inputSchema": {
        "type": "object", "additionalProperties": False,
        "required": ["room", "agent", "op_id", "task_id", "verdict", "reason"],
        "dependentRequired": {"result_agent": ["result_run_id"], "result_run_id": ["result_agent"]},
        "not": {"required": ["result_agent", "run_id"]},
        "properties": {
            "room": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,47}$"},
            "agent": {"type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,47}$"},
            "op_id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{8,64}$"},
            "task_id": {"type": "string", "pattern": "^T(0[1-9]|[1-3][0-9]|40)$"},
            "micro_id": {"type": "string", "pattern": r"^T(0[1-9]|[1-3][0-9]|40)\.M(0[1-9]|1[0-2])$"},
            "verdict": {"type": "string", "enum": ["ADMIT", "HOLD", "REJECT"]},
            "reason": {"type": "string", "minLength": 1, "maxLength": 240},
            "run_id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
            "result_agent": {"type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,47}$"},
            "result_run_id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
            "evidence": {"type": "array", "minItems": 1, "maxItems": 8, "items": {
                "type": "object", "additionalProperties": False, "required": ["path", "sha256"],
                "properties": {"path": {"type": "string", "minLength": 1, "maxLength": 512},
                               "sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"}},
            }},
            "expected_opened_lamport": {"type": "integer", "minimum": 1, "maximum": 2**53 - 1},
        },
    },
}, unit_decide)
