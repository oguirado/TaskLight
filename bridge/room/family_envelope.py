"""Closed, passive envelopes for the recipient-owned family channel."""

import hashlib
import json
import math
import re

from bridge.room import store

SCHEMA = "tasklight.family/1"
MAX_REQUEST_BYTES = 65_536
ID_RE = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
ENDPOINT_RE = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
RUN_RE = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
LIFECYCLE = frozenset("agent." + state for state in
                      ("deployed", "alive", "finished", "failed"))
SLICE_TWO = frozenset({"agent.activity", "agent.plan", "task.claim", "task.release", "task.update",
                       "microtask.update", "plan.phase", "plan.close",
                       "work.acquire", "work.report"})
_REQUIRED = frozenset({"schema", "id", "source", "target", "kind", "room",
                       "agent", "payload"})
_OPTIONAL = frozenset({"run_id", "plan_opened", "correlation_id", "after"})


class InvalidEnvelope(ValueError):
    """An invalid message; details never echo untrusted content."""


def _require(condition, detail="invalid envelope"):
    if not condition:
        raise InvalidEnvelope(detail)


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def _constant(value):
    raise InvalidEnvelope("non-finite JSON number")


def _float(value):
    result = float(value)
    _require(math.isfinite(result), "non-finite JSON number")
    return result


def decode(raw):
    """Strict UTF-8 JSON, including nested duplicate and non-finite rejection."""
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=_constant, parse_float=_float)
        # Also reject escaped unpaired surrogates, which cannot be UTF-8 data.
        canonical(value)
        return value
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise InvalidEnvelope("invalid JSON") from exc


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def operation_id(value):
    identity = "\0".join(value[key] for key in ("source", "target", "id"))
    return "fam-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:44]


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _name(value, pattern):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _identity(value, validator):
    try:
        validator(value)
    except store.RoomError as exc:
        raise InvalidEnvelope("invalid identity") from exc


def configuration(raw, endpoint):
    value = decode(raw)
    _require(isinstance(value, dict) and
             set(value) == {"endpoint", "rooms", "sources", "slice"},
             "invalid configuration")
    _require(_name(endpoint, ENDPOINT_RE) and value["endpoint"] == endpoint,
             "invalid endpoint")
    _require(type(value["slice"]) is int and value["slice"] in (1, 2),
             "invalid slice")
    for key in ("rooms", "sources"):
        _require(isinstance(value[key], list), "invalid allowlist")
        for item in value[key]:
            if key == "rooms":
                _identity(item, store._check_room)
            else:
                _require(_name(item, ENDPOINT_RE), "invalid source")
        _require(len(value[key]) == len(set(value[key])), "duplicate allowlist entry")
    return value


def validate(raw, endpoint, filename_id):
    _require(len(raw) <= MAX_REQUEST_BYTES, "request too large")
    value = decode(raw)
    _require(isinstance(value, dict))
    _require(_REQUIRED <= set(value) and not set(value) - _REQUIRED - _OPTIONAL)
    _require(value["schema"] == SCHEMA)
    _require(_name(value["id"], ID_RE) and value["id"] == filename_id,
             "invalid message identity")
    for key in ("source", "target"):
        _require(_name(value[key], ENDPOINT_RE), "invalid endpoint identity")
    _require(value["target"] == endpoint, "wrong recipient")
    _identity(value["room"], store._check_room)
    _identity(value["agent"], store._check_agent)
    kind, payload = value["kind"], value["payload"]
    _require(isinstance(kind, str) and kind in
             LIFECYCLE | SLICE_TWO | {"capabilities", "events.read"},
             "unknown kind")
    _require(isinstance(payload, dict), "payload must be an object")
    if "correlation_id" in value:
        _require(isinstance(value["correlation_id"], str), "invalid correlation")
    if "run_id" in value:
        _require(_name(value["run_id"], RUN_RE), "invalid run identity")
    if "after" in value:
        _require(type(value["after"]) is int and value["after"] >= 0,
                 "invalid cursor")
    if "plan_opened" in value:
        _require(type(value["plan_opened"]) is int and value["plan_opened"] > 0,
                 "invalid plan generation")
    if kind in LIFECYCLE | {"agent.activity", "work.acquire", "work.report"}:
        _require("run_id" in value, "missing run identity")
    if kind == "capabilities":
        _require(not payload, "invalid capabilities payload")
    elif kind in LIFECYCLE:
        _require(not set(payload) - {"swarm", "harness", "reason"},
                 "invalid lifecycle payload")
        _require(all(isinstance(item, str) for item in payload.values()),
                 "invalid lifecycle payload")
    elif kind == "events.read":
        _require("after" in value, "missing cursor")
        _require(not set(payload) - {"limit", "acts", "ops"}, "invalid read payload")
        if "limit" in payload:
            _require(type(payload["limit"]) is int and 1 <= payload["limit"] <= 500,
                     "invalid read limit")
        for key in ("acts", "ops"):
            if key in payload:
                _require(isinstance(payload[key], list) and
                         all(isinstance(item, str) for item in payload[key]),
                         "invalid read filter")
    elif kind == "agent.activity":
        _require("plan_opened" in value, "missing plan generation")
        _require("task_id" in payload and
                 not set(payload) - {"task_id", "micro_id", "note"},
                 "invalid activity payload")
        _require(all(isinstance(item, str) for item in payload.values()),
                 "invalid activity payload")
    else:
        if kind == "agent.plan":
            _require(set(payload) == {"tool", "args"} and
                     isinstance(payload["tool"], str) and
                     payload["tool"] in {"plan_create", "task_add", "microtask_add"} and
                     isinstance(payload["args"], dict), "invalid plan payload")
            if payload["tool"] == "plan_create":
                _require("plan_opened" not in value, "generation forbidden on creation")
            else:
                _require("plan_opened" in value, "missing plan generation")
            arguments = payload["args"]
        else:
            _require("plan_opened" in value, "missing plan generation")
            arguments = payload
        _require(not set(arguments) & {"room", "agent", "run_id", "op_id",
                                       "plan_opened", "expected_opened_lamport"},
                 "payload overrides identity")
    return value
