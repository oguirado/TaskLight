import copy
import json
import math
import re

from .errors import PlanError
from .limits import (
    ACCEPT_MAX,
    AGENT_RE,
    DEPS_MAX,
    ESTIMATE_MAX,
    EVIDENCE_MAX,
    MICRO_ID_RE,
    MICRO_MAX,
    MICRO_STATES,
    OP_BYTES_MAX,
    OP_ID_RE,
    OP_KINDS,
    OUTCOME_MAX,
    REASON_MAX,
    SHA256_RE,
    SLUG_RE,
    TASK_ID_RE,
    TASK_TEXT_MAX,
    TITLE_MAX,
    TOOK_MAX,
)

_DANGEROUS = frozenset({"__proto__", "constructor", "prototype"})
_SAFE_MAX = 9007199254740991
_RUN_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
LIFECYCLE_REASON_MAX = 512
LIFECYCLE_STATES = frozenset({"deployed", "alive", "finished", "failed"})


def _bad(msg: str = "") -> PlanError:
    return PlanError("bad_op", msg)


def _limit(msg: str = "") -> PlanError:
    return PlanError("limit_exceeded", msg)


def _is_safe_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and abs(v) <= _SAFE_MAX


def _check_json_safe(obj):
    # Iterative ancestor tracking rejects cycles and excessive nesting before
    # recursive stdlib serialization or deepcopy can see untrusted input.
    # Valid operations contain at most three container levels.
    ancestors = set()
    stack = [(obj, 0, False)]
    while stack:
        value, depth, leaving = stack.pop()
        if leaving:
            ancestors.remove(id(value))
            continue
        if depth > 32:
            raise _bad("excessive nesting")
        if value is None or isinstance(value, (str, bool, int)):
            continue
        if isinstance(value, float):
            if not math.isfinite(value):
                raise _bad("non-finite")
            continue
        if not isinstance(value, (dict, list)):
            raise _bad("non-json value")
        identity = id(value)
        if identity in ancestors:
            raise _bad("cyclic")
        if isinstance(value, dict):
            for key in value:
                if not isinstance(key, str):
                    raise _bad("non-string key")
                if key in _DANGEROUS:
                    raise _bad("dangerous key")
            children = value.values()
        else:
            children = value
        ancestors.add(identity)
        stack.append((value, depth, True))
        stack.extend((child, depth + 1, False) for child in children)


def _check_slug(s):
    if not isinstance(s, str):
        raise _bad("slug type")
    if SLUG_RE.fullmatch(s) is None:
        raise _bad("slug format")


def _check_str_len(s, lo: int, hi: int):
    if not isinstance(s, str):
        raise _bad("string type")
    if not (lo <= len(s) <= hi):
        raise _bad("string length")


def _check_base_rev(v, lo: int):
    if not _is_safe_int(v):
        raise _bad("base_rev int")
    if v < lo:
        raise _bad("base_rev range")


def _check_op_id(op: dict):
    if "op_id" in op:
        v = op["op_id"]
        if not isinstance(v, str) or OP_ID_RE.fullmatch(v) is None:
            raise _bad("op_id")


def _check_unknown(op: dict, allowed):
    for k in op.keys():
        if k not in allowed:
            raise _bad(f"unknown key {k!r}")


def _canonical_bytes(op: dict) -> int:
    try:
        text = json.dumps(op, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        return len(text.encode("utf-8"))
    except (TypeError, ValueError, UnicodeError, RecursionError) as e:
        raise _bad(str(e)) from e


def validate_op_shape(op: object) -> dict:
    if not isinstance(op, dict):
        raise _bad("op must be object")
    _check_json_safe(op)
    # Byte cap must precede field-range validation so oversize payloads report limit_exceeded, not bad_op
    if _canonical_bytes(op) > OP_BYTES_MAX:
        raise _limit("op bytes")
    kind = op.get("kind")
    if not isinstance(kind, str) or (kind not in OP_KINDS and kind not in ("activity.beat", "agent.lifecycle")):
        raise _bad("kind")
    _check_op_id(op)

    if kind == "agent.lifecycle":
        _check_unknown(op, {"kind", "state", "run_id", "swarm", "harness", "reason", "op_id"})
        for req in ("state", "run_id", "op_id"):
            if req not in op:
                raise _bad(f"missing {req}")
        if not isinstance(op["state"], str) or op["state"] not in LIFECYCLE_STATES:
            raise _bad("lifecycle state")
        if not isinstance(op["run_id"], str) or _RUN_ID_RE.fullmatch(op["run_id"]) is None:
            raise _bad("run_id")
        for key in ("swarm", "harness", "reason"):
            if key not in op:
                continue
            value = op[key]
            _check_str_len(value, 0 if key == "reason" else 1,
                           LIFECYCLE_REASON_MAX if key == "reason" else TITLE_MAX)
            if any(ord(ch) < 0x20 or 0x7f <= ord(ch) <= 0x9f
                   or 0xd800 <= ord(ch) <= 0xdfff for ch in value):
                raise _bad(f"{key} controls or surrogate")
            if key != "reason" and not any(not (ch.isspace() or ch == "\ufeff") for ch in value):
                raise _bad(f"{key} blank")

    elif kind == "activity.beat":
        _check_unknown(op, {"kind", "task_id", "micro_id", "run_id", "note", "op_id"})
        for req in ("task_id", "run_id", "op_id"):
            if req not in op:
                raise _bad(f"missing {req}")
        if not isinstance(op["task_id"], str) or TASK_ID_RE.fullmatch(op["task_id"]) is None:
            raise _bad("task_id")
        if not isinstance(op["run_id"], str) or _RUN_ID_RE.fullmatch(op["run_id"]) is None:
            raise _bad("run_id")
        if "micro_id" in op:
            if not isinstance(op["micro_id"], str) or MICRO_ID_RE.fullmatch(op["micro_id"]) is None:
                raise _bad("micro_id")
        if "note" in op:
            _check_str_len(op["note"], 0, 240)
            if re.search(r"[\x00-\x1f\x7f-\x9f]", op["note"]) is not None:
                raise _bad("note controls")

    elif kind == "plan.open":
        _check_unknown(op, {"kind", "op_id", "title", "template_id", "template_hash", "brief", "phase"})
        for req in ("title", "template_id", "template_hash"):
            if req not in op:
                raise _bad(f"missing {req}")
        _check_str_len(op["title"], 1, TITLE_MAX)
        _check_slug(op["template_id"])
        th = op["template_hash"]
        if not isinstance(th, str) or SHA256_RE.fullmatch(th) is None:
            raise _bad("template_hash")
        if "brief" in op:
            b = op["brief"]
            if not isinstance(b, dict):
                raise _bad("brief type")
            # keys already checked for dangerous/string; validate slug + value length
            for k, v in b.items():
                _check_slug(k)
                if not isinstance(v, str):
                    raise _bad("brief value")
                if len(v) > 400:
                    raise _bad("brief value length")
        if "phase" in op:
            _check_slug(op["phase"])

    elif kind == "plan.close":
        _check_unknown(op, {"kind", "op_id", "base_rev", "outcome"})
        if "base_rev" not in op:
            raise _bad("missing base_rev")
        _check_base_rev(op["base_rev"], 1)
        if "outcome" in op:
            if op["outcome"] is None:
                raise _bad("outcome null")
            _check_str_len(op["outcome"], 0, OUTCOME_MAX)

    elif kind == "plan.phase":
        _check_unknown(op, {"kind", "op_id", "base_rev", "phase"})
        if "base_rev" not in op or "phase" not in op:
            raise _bad("missing required")
        _check_base_rev(op["base_rev"], 1)
        _check_slug(op["phase"])

    elif kind == "task.add":
        _check_unknown(op, {"kind", "op_id", "base_rev", "title", "type", "phase", "accept", "deps", "assignee", "estimate", "microtasks"})
        for req in ("title", "type", "phase"):
            if req not in op:
                raise _bad(f"missing {req}")
        _check_str_len(op["title"], 1, TITLE_MAX)
        _check_slug(op["type"])
        _check_slug(op["phase"])
        if "base_rev" in op:
            _check_base_rev(op["base_rev"], 0)
        if "accept" in op:
            if op["accept"] is None:
                raise _bad("accept null")
            _check_str_len(op["accept"], 0, ACCEPT_MAX)
        if "deps" in op:
            deps = op["deps"]
            if not isinstance(deps, list):
                raise _bad("deps type")
            if len(deps) > DEPS_MAX:
                raise _limit("deps cap")
            seen = set()
            for d in deps:
                if not isinstance(d, str) or TASK_ID_RE.fullmatch(d) is None:
                    raise _bad("dep id")
                if d in seen:
                    raise _bad("duplicate dep")
                seen.add(d)
        if "assignee" in op:
            a = op["assignee"]
            if a is not None:
                if not isinstance(a, str) or AGENT_RE.fullmatch(a) is None:
                    raise _bad("assignee")
        if "estimate" in op:
            e = op["estimate"]
            if e is not None:
                if not isinstance(e, str):
                    raise _bad("estimate type")
                if len(e) > ESTIMATE_MAX:
                    raise _bad("estimate length")
        if "microtasks" in op:
            mts = op["microtasks"]
            if not isinstance(mts, list):
                raise _bad("microtasks type")
            if len(mts) > MICRO_MAX:
                raise _limit("microtasks cap")
            for m in mts:
                if not isinstance(m, dict):
                    raise _bad("micro type")
                _check_unknown(m, {"text", "accept"})
                if "text" not in m:
                    raise _bad("micro text missing")
                _check_str_len(m["text"], 1, TASK_TEXT_MAX)
                if "accept" in m:
                    if m["accept"] is None:
                        raise _bad("micro accept null")
                    _check_str_len(m["accept"], 0, ACCEPT_MAX)

    elif kind == "task.set":
        _check_unknown(op, {"kind", "op_id", "task_id", "base_rev", "title", "type", "phase", "accept", "deps", "estimate", "state", "reason"})
        if "task_id" not in op or "base_rev" not in op:
            raise _bad("missing required")
        if not isinstance(op["task_id"], str) or TASK_ID_RE.fullmatch(op["task_id"]) is None:
            raise _bad("task_id")
        _check_base_rev(op["base_rev"], 1)
        mutable = ("title", "type", "phase", "accept", "deps", "estimate", "state", "reason")
        if not any(k in op for k in mutable):
            raise _bad("no mutation")
        if "title" in op:
            _check_str_len(op["title"], 1, TITLE_MAX)
        if "type" in op:
            _check_slug(op["type"])
        if "phase" in op:
            _check_slug(op["phase"])
        if "accept" in op:
            if op["accept"] is None:
                raise _bad("accept null")
            _check_str_len(op["accept"], 0, ACCEPT_MAX)
        if "deps" in op:
            deps = op["deps"]
            if not isinstance(deps, list):
                raise _bad("deps type")
            if len(deps) > DEPS_MAX:
                raise _limit("deps cap")
            seen = set()
            for d in deps:
                if not isinstance(d, str) or TASK_ID_RE.fullmatch(d) is None:
                    raise _bad("dep id")
                if d in seen:
                    raise _bad("duplicate dep")
                seen.add(d)
        if "estimate" in op:
            e = op["estimate"]
            if e is not None:
                if not isinstance(e, str):
                    raise _bad("estimate type")
                if len(e) > ESTIMATE_MAX:
                    raise _bad("estimate length")
        if "state" in op:
            s = op["state"]
            if s is not None and s not in ("blocked", "cancelled"):
                raise _bad("state")
        if "reason" in op:
            r = op["reason"]
            if r is not None:
                if not isinstance(r, str):
                    raise _bad("reason type")
                if len(r) > REASON_MAX:
                    raise _bad("reason length")

    elif kind == "task.claim":
        _check_unknown(op, {"kind", "op_id", "task_id", "base_rev", "takeover"})
        if "task_id" not in op:
            raise _bad("missing task_id")
        if not isinstance(op["task_id"], str) or TASK_ID_RE.fullmatch(op["task_id"]) is None:
            raise _bad("task_id")
        if "base_rev" in op:
            _check_base_rev(op["base_rev"], 1)
        if "takeover" in op:
            if not isinstance(op["takeover"], bool):
                raise _bad("takeover bool")

    elif kind == "task.release":
        _check_unknown(op, {"kind", "op_id", "task_id", "base_rev", "claim_lamport"})
        if "claim_lamport" in op:
            if not _is_safe_int(op["claim_lamport"]) or op["claim_lamport"] <= 0:
                raise _bad("claim_lamport must be a positive safe integer")
        if "task_id" not in op:
            raise _bad("missing task_id")
        if not isinstance(op["task_id"], str) or TASK_ID_RE.fullmatch(op["task_id"]) is None:
            raise _bad("task_id")
        if "base_rev" in op:
            _check_base_rev(op["base_rev"], 1)

    elif kind == "micro.add":
        _check_unknown(op, {"kind", "op_id", "task_id", "base_rev", "text", "accept"})
        for req in ("task_id", "base_rev", "text"):
            if req not in op:
                raise _bad(f"missing {req}")
        if not isinstance(op["task_id"], str) or TASK_ID_RE.fullmatch(op["task_id"]) is None:
            raise _bad("task_id")
        _check_base_rev(op["base_rev"], 1)
        _check_str_len(op["text"], 1, TASK_TEXT_MAX)
        if "accept" in op:
            if op["accept"] is None:
                raise _bad("accept null")
            _check_str_len(op["accept"], 0, ACCEPT_MAX)

    elif kind == "micro.set":
        _check_unknown(op, {"kind", "op_id", "micro_id", "state", "outcome", "took", "evidence", "claim_lamport"})
        if "claim_lamport" in op:
            if not _is_safe_int(op["claim_lamport"]) or op["claim_lamport"] <= 0:
                raise _bad("claim_lamport must be a positive safe integer")
        for req in ("micro_id", "state"):
            if req not in op:
                raise _bad(f"missing {req}")
        if not isinstance(op["micro_id"], str) or MICRO_ID_RE.fullmatch(op["micro_id"]) is None:
            raise _bad("micro_id")
        if not isinstance(op["state"], str) or op["state"] not in MICRO_STATES:
            raise _bad("state")
        if "outcome" in op:
            if op["outcome"] is None:
                raise _bad("outcome null")
            _check_str_len(op["outcome"], 0, OUTCOME_MAX)
        if "took" in op:
            if op["took"] is None:
                raise _bad("took null")
            _check_str_len(op["took"], 0, TOOK_MAX)
        if "evidence" in op:
            ev = op["evidence"]
            if not isinstance(ev, list):
                raise _bad("evidence type")
            if len(ev) > EVIDENCE_MAX:
                raise _limit("evidence cap")
            for item in ev:
                if not isinstance(item, dict):
                    raise _bad("evidence item")
                _check_unknown(item, {"path", "sha256"})
                if "path" not in item or "sha256" not in item:
                    raise _bad("evidence missing")
                if not isinstance(item["path"], str):
                    raise _bad("evidence path type")
                if not (1 <= len(item["path"]) <= 512):
                    raise _bad("evidence path length")
                if not isinstance(item["sha256"], str) or SHA256_RE.fullmatch(item["sha256"]) is None:
                    raise _bad("evidence sha")

    elif kind == "memory.set":
        _check_unknown(op, {"kind", "op_id", "section", "text", "base_rev"})
        for req in ("section", "text", "base_rev"):
            if req not in op:
                raise _bad(f"missing {req}")
        _check_slug(op["section"])
        if not isinstance(op["text"], str):
            raise _bad("text type")
        if len(op["text"]) > 2000:
            raise _bad("text length")
        _check_base_rev(op["base_rev"], 0)

    else:
        raise _bad("unknown kind")

    return copy.deepcopy(op)


def is_valid_op_shape(op: object) -> bool:
    try:
        validate_op_shape(op)
    except Exception:
        return False
    return True
