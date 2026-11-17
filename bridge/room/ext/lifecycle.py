"""Harness-recorded lifecycle, serialized by the room journal's own lock."""
import json
import os
import secrets
import tempfile

from bridge.plan.ops import check_arguments
from . import register
from bridge.plan.errors import PlanError
from bridge.plan.fold import apply_op_event, fold_plan
from bridge.plan.limits import TITLE_MAX
from bridge.plan.ops import (
    LIFECYCLE_REASON_MAX, RESULT_VERDICTS, validate_op_shape, validate_result,
)
from bridge.room import _lock, store


RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["verdict"],
    "properties": {
        "verdict": {"type": "string", "enum": list(RESULT_VERDICTS)},
        "summary": {"type": "string", "maxLength": 2000},
        "receipt": {"type": "string", "maxLength": 512},
        "evidence": {"type": "array", "maxItems": 32, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["path", "sha256"], "properties": {
                "path": {"type": "string", "maxLength": 512},
                "sha256": {"type": "string", "pattern": "^[0-9a-fA-F]{64}$"},
            },
        }},
    },
}


# The store also enforces the legacy op byte cap while reading the journal.
# Validate bounded result data separately, then reuse its complete envelope
# checks on a detached legacy op. Never remove result bytes from stored events.
_legacy_event_validator = getattr(store._is_valid_event, "_legacy_validator", store._is_valid_event)


def _valid_result_event(event):
    op = event.get("op") if isinstance(event, dict) else None
    if not isinstance(op, dict) or op.get("kind") != "agent.lifecycle" or "result" not in op:
        return _legacy_event_validator(event)
    try:
        validate_op_shape(op)
    except (PlanError, ValueError, TypeError, RecursionError):
        return False
    base = {key: value for key, value in op.items() if key != "result"}
    return _legacy_event_validator(dict(event, op=base))


_valid_result_event._legacy_validator = _legacy_event_validator
store._is_valid_event = _valid_result_event


def agent_lifecycle(args: dict) -> dict:
    required = {"room", "agent", "state", "run_id"}
    allowed = required | {"swarm", "harness", "reason", "op_id", "parent_agent", "parent_run_id", "result"}
    check_arguments(args, allowed, required, error=store.RoomError)
    room, agent = args["room"], args["agent"]
    store._check_room(room)
    store._check_agent(agent)
    op = {"kind": "agent.lifecycle"}
    op.update((key, value) for key, value in args.items() if key not in ("room", "agent"))
    if "op_id" not in op:
        op["op_id"] = secrets.token_hex(16)
    try:
        op = validate_op_shape(op)
    except PlanError as exc:
        raise store.RoomError(exc.code, str(exc)) from exc
    result = _commit(room, agent, op)
    if op["state"] in ("failed", "finished"):
        # Every transport enters here. Keep lifecycle persistence and cleanup
        # completion distinct; exact retries revisit unfinished cleanup.
        from bridge.room import app
        from . import cleanup
        result["cleanup"] = cleanup.terminal(app, args, op["op_id"], result["lamport"])
        if result["cleanup"]["status"] == "pending":
            # The mailbox retains transient errors instead of caching a partial
            # cleanup as the final result of the immutable terminal envelope.
            raise cleanup.Pending(result)
    return result


def _read_noops(path):
    try:
        with open(path, encoding="utf-8") as stream:
            receipts = json.load(stream)
    except FileNotFoundError:
        return {}
    except (ValueError, UnicodeError) as exc:
        raise store.RoomError("internal", "invalid lifecycle replay receipts") from exc
    if not isinstance(receipts, dict) or any(
        not isinstance(receipt, dict)
        or not isinstance(receipt.get("op"), dict)
        or type(receipt.get("lamport")) is not int
        or receipt["lamport"] < 1
        for receipt in receipts.values()
    ):
        raise store.RoomError("internal", "invalid lifecycle replay receipts")
    return receipts


def _persist_noops(path, receipts):
    # The caller holds events.lock. Publish and sync before acknowledging a
    # no-op, without adding an event or changing the journal's Lamport clock.
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix=".lifecycle-noops-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(receipts, stream, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _commit(room, agent, op):
    # post() cannot suppress successful folds. Share its journal lock and I/O
    # primitives instead, keeping replay, clock, admission and append together.
    from . import cleanup
    rdir = cleanup.room_directory(room, create=True)
    epath = os.path.join(rdir, "events.jsonl")
    npath = os.path.join(rdir, "lifecycle-noops.json")
    lpath = os.path.join(rdir, "events.lock")
    lockfd = os.open(lpath, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            os.chmod(lpath, 0o600)
        except OSError:
            pass
        _lock.lock_exclusive(lockfd)
        try:
            try:
                with open(epath, "rb") as stream:
                    data = stream.read()
            except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
                data = b""
            parsed, _ = store._parse_events_bytes(data)
            noops = _read_noops(npath)
            replay_key = json.dumps([agent, op["op_id"]], separators=(",", ":"))
            if replay_key in noops:
                receipt = noops[replay_key]
                if receipt["op"] != op:
                    raise store.RoomError("bad_op", "op_id conflict")
                return {"ok": True, "lamport": receipt["lamport"]}
            matched = store._op_identity_index(parsed, agent).get(op["op_id"])
            if matched is not None:
                if matched.get("room") != room or matched.get("op") != op or isinstance(matched.get("batch"), dict):
                    raise store.RoomError("bad_op", "op_id conflict")
                return {"ok": True, "lamport": matched["lamport"]}
            # Resolve server time only after acquiring the shared lock. No client
            # clock or process-local liveness/retirement cache is consulted.
            ts = store._resolve_ts(None, True)
            lamport = store._max_lamport_from_bytes(data) + 1
            event = {"id": "e-" + secrets.token_hex(8), "room": room, "agent": agent,
                     "act": "op", "text": "", "op": op, "lamport": lamport, "ts": ts}
            tpl_kw = store._tpl_kw(needed=store._plan_template_ids(parsed))
            try:
                state = fold_plan(parsed, **tpl_kw)
                _, result = apply_op_event(state, event, last_by_agent=store._op_max_activity(parsed), **tpl_kw)
            except PlanError as exc:
                raise store.RoomError(exc.code, str(exc)) from exc
            if result.get("noop"):
                noops[replay_key] = {"op": op, "lamport": result["lamport"]}
                _persist_noops(npath, noops)
                return {"ok": True, "lamport": result["lamport"]}
            separator = b"\n" if data and not data.endswith(b"\n") else b""
            payload = separator + (json.dumps(event, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
            if len(data) + len(payload) > store.CAP:
                raise store.RoomError("room_full", "room file cap exceeded")
            fd = os.open(epath, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
            try:
                try:
                    os.chmod(epath, 0o600)
                except OSError:
                    pass
                store._write_all(fd, payload, len(data))
                try:
                    os.fsync(fd)
                except OSError as exc:
                    try:
                        os.ftruncate(fd, len(data))
                    except OSError:
                        pass
                    raise store.RoomError("internal", str(exc)) from exc
            finally:
                os.close(fd)
            return {"ok": True, "lamport": lamport}
        finally:
            try:
                _lock.unlock(lockfd)
            except OSError:
                pass
    except OSError as exc:
        raise store.RoomError("internal", str(exc)) from exc
    finally:
        os.close(lockfd)


register({
    "name": "agent_lifecycle",
    "description": "Record caller-asserted agent deployment, liveness or termination in a room.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "room": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,47}$"},
            "agent": {"type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,47}$"},
            "state": {"type": "string", "enum": ["deployed", "alive", "finished", "failed"]},
            "run_id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
            "parent_agent": {"type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,47}$"},
            "parent_run_id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
            "swarm": {"type": "string", "minLength": 1, "maxLength": TITLE_MAX},
            "harness": {"type": "string", "minLength": 1, "maxLength": TITLE_MAX},
            "reason": {"type": "string", "maxLength": LIFECYCLE_REASON_MAX},
            "op_id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{8,64}$"},
            "result": RESULT_SCHEMA,
        },
        "required": ["room", "agent", "state", "run_id"],
        "additionalProperties": False,
    },
}, agent_lifecycle)

# Inventory is the read companion to lifecycle, including for app-only callers.
from . import inventory as _inventory
