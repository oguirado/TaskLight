import copy
import json
import math
import re

from .errors import PlanError
from .limits import (
    ACCEPT_MAX,
    AGENT_RE,
    DEPS_MAX,
    DECISION_PATH_MAX,
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
RESULT_VERDICTS = ("ADMIT", "HOLD", "NO_PUDE", "OK", "FAIL")


def validate_result(value):
    """Validate passive terminal data without applying the legacy op byte cap."""
    def text(item, maximum):
        return (isinstance(item, str) and len(item) <= maximum
                and not any(0xd800 <= ord(ch) <= 0xdfff for ch in item))

    def fail(message):
        raise PlanError("bad_args", message)

    if not isinstance(value, dict):
        fail("result must be object")
    if set(value) - {"verdict", "summary", "receipt", "evidence"}:
        fail("result contains unknown args; allowed: verdict, summary, receipt, evidence")
    if "verdict" not in value:
        fail("result.verdict is required")
    if not isinstance(value["verdict"], str) or value["verdict"] not in RESULT_VERDICTS:
        fail("result.verdict must be ADMIT, HOLD, NO_PUDE, OK or FAIL")
    for key, maximum in (("summary", 2000), ("receipt", 512)):
        if key in value and not text(value[key], maximum):
            fail(f"result.{key} must be a valid UTF-8 string of 0-{maximum} chars")
    if "evidence" in value and (not isinstance(value["evidence"], list) or len(value["evidence"]) > 32):
        fail("result.evidence must be an array of 0-32 entries")
    for index, item in enumerate(value.get("evidence", [])):
        label = f"result.evidence[{index}]"
        if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
            fail(label + " must be object with only required keys path, sha256")
        if not text(item["path"], 512):
            fail(label + ".path must be a valid UTF-8 string of 0-512 chars")
        if not isinstance(item["sha256"], str) or re.fullmatch(r"[0-9a-fA-F]{64}", item["sha256"]) is None:
            fail(label + ".sha256 must be 64 hexadecimal chars")
    return copy.deepcopy(value)



def check_arguments(args, allowed, required=(), *, code="bad_args", label="args",
                    error=PlanError, redact_name=None):
    """Validate structural arguments without echoing rejected values or pointers."""
    prefix = f"{label} " if label else ""
    if not isinstance(args, dict):
        raise error(code, prefix + "must be object")
    for key in args:
        if key not in allowed:
            name = "(unsafe name omitted)"
            if isinstance(key, str):
                if re.fullmatch(r"[a-z][a-z0-9_]{0,31}", key):
                    name = repr(key)
                elif redact_name is not None:
                    # Keep established sanitizer markers, never surrounding data.
                    scrubbed = redact_name(key)
                    if isinstance(scrubbed, str) and re.fullmatch(
                            r"[a-z][a-z0-9_]{0,31}=\[REDACTED:[A-Z_]{1,32}\]", scrubbed):
                        name = repr(scrubbed)
            raise error(code, prefix + "contains unknown arg " + name)
    missing = [key for key in required if key not in args]
    if missing:
        detail = prefix + "required keys: " + ", ".join(sorted(missing))
        max_detail = 199
        if len(detail) > max_detail:
            detail = detail[:max_detail - 3] + "..."
        raise error(code, detail)


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


def _check_str_len(s, lo: int, hi: int, name="string"):
    if not isinstance(s, str):
        raise _bad(f"{name} must be a string of {lo}-{hi} chars")
    if not (lo <= len(s) <= hi):
        raise _bad(f"{name} must be {lo}-{hi} chars")


def _check_base_rev(v, lo: int):
    if not _is_safe_int(v):
        raise _bad("base_rev int")
    if v < lo:
        raise _bad("base_rev range")


def _check_op_id(op: dict):
    if "op_id" in op:
        v = op["op_id"]
        if not isinstance(v, str) or OP_ID_RE.fullmatch(v) is None:
            raise _bad("op_id must be 8-64 chars of A-Z a-z 0-9 _ -")


def _check_unknown(op: dict, allowed):
    for k in op:
        if not isinstance(k, str):
            raise _bad("non-string key")
        if k not in allowed:
            name = repr(k) if re.fullmatch(r"[a-z][a-z0-9_]{0,31}", k) else "(unsafe name omitted)"
            raise _bad("unknown key " + name)


def _canonical_bytes(op: dict) -> int:
    try:
        text = json.dumps(op, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        return len(text.encode("utf-8"))
    except (TypeError, ValueError, UnicodeError, RecursionError) as e:
        raise _bad(str(e)) from e


def validate_op_shape(op: object) -> dict:
    # Terminal results have their own limits; preserve the legacy byte cap
    # and error precedence for the remaining operation envelope.
    if isinstance(op, dict) and op.get("kind") == "agent.lifecycle" and "result" in op:
        if op.get("state") not in ("finished", "failed"):
            raise PlanError("bad_args", "result requires state finished or failed")
        result = validate_result(op["result"])
        base = validate_op_shape({key: value for key, value in op.items() if key != "result"})
        base["result"] = result
        return base
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
        _check_unknown(op, {"kind", "state", "run_id", "swarm", "harness", "reason", "op_id", "parent_agent", "parent_run_id"})
        for req in ("state", "run_id", "op_id"):
            if req not in op:
                raise _bad(f"missing {req}")
        if not isinstance(op["state"], str) or op["state"] not in LIFECYCLE_STATES:
            raise _bad("lifecycle state")
        if not isinstance(op["run_id"], str) or _RUN_ID_RE.fullmatch(op["run_id"]) is None:
            raise _bad("run_id")
        if "parent_agent" in op and (not isinstance(op["parent_agent"], str)
                or AGENT_RE.fullmatch(op["parent_agent"]) is None):
            raise _bad("parent_agent")
        if "parent_run_id" in op and (not isinstance(op["parent_run_id"], str)
                or _RUN_ID_RE.fullmatch(op["parent_run_id"]) is None):
            raise _bad("parent_run_id")
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

    elif kind in ("unit.bind", "unit.repair"):
        fields = {"op_id", "task_id", "expected_opened_lamport"}
        fields |= {"micro_id", "result_agent", "result_run_id"} if kind == "unit.bind" else {"reason"}
        optional = {"registration_lamport"} if kind == "unit.bind" else set()
        _check_unknown(op, fields | optional | {"kind"})
        for field in sorted(fields):
            if field not in op:
                raise _bad(f"{field} is required")
        if not isinstance(op["task_id"], str) or TASK_ID_RE.fullmatch(op["task_id"]) is None:
            raise _bad("task_id must be T01-T40")
        if not _is_safe_int(op["expected_opened_lamport"]) or op["expected_opened_lamport"] < 1:
            raise _bad("expected_opened_lamport must be a positive safe integer")
        if kind == "unit.bind":
            if "registration_lamport" in op:
                _check_base_rev(op["registration_lamport"], 1)
            for field, pattern in (("micro_id", MICRO_ID_RE), ("result_agent", AGENT_RE),
                                   ("result_run_id", _RUN_ID_RE)):
                if not isinstance(op[field], str) or pattern.fullmatch(op[field]) is None:
                    raise _bad(f"invalid {field}")
        else:
            _check_str_len(op["reason"], 1, REASON_MAX, "reason")

    elif kind == "unit.decision":
        _check_unknown(op, {"kind", "op_id", "task_id", "micro_id", "verdict", "reason",
                            "evidence", "agent", "run_id", "result_agent", "result_run_id",
                            "binding_lamport"})
        if "binding_lamport" in op:
            _check_base_rev(op["binding_lamport"], 1)
            if not {"micro_id", "result_agent", "result_run_id"} <= op.keys():
                raise _bad("binding_lamport requires a pipeline step and result reference")
        for req in ("op_id", "task_id", "verdict", "reason"):
            if req not in op:
                raise _bad(f"{req} is required")
        if not isinstance(op["task_id"], str) or TASK_ID_RE.fullmatch(op["task_id"]) is None:
            raise _bad("task_id must be T01-T40")
        if "micro_id" in op and (not isinstance(op["micro_id"], str)
                or MICRO_ID_RE.fullmatch(op["micro_id"]) is None):
            raise _bad("micro_id must be T01-T40 followed by .M01-.M12")
        if not isinstance(op["verdict"], str) or op["verdict"] not in ("ADMIT", "HOLD", "REJECT"):
            raise _bad("verdict must be ADMIT, HOLD or REJECT")
        _check_str_len(op["reason"], 1, REASON_MAX, "reason")
        if any(key in op for key in ("agent", "run_id")) and any(
                key in op for key in ("result_agent", "result_run_id")):
            raise _bad("run_id cannot be combined with result_agent or result_run_id")
        for agent_key, run_key in (("agent", "run_id"), ("result_agent", "result_run_id")):
            if (agent_key in op) != (run_key in op):
                raise _bad(f"{agent_key} and {run_key} must occur together")
            if agent_key in op:
                if not isinstance(op[agent_key], str) or AGENT_RE.fullmatch(op[agent_key]) is None:
                    raise _bad(f"{agent_key} must be 1-48 chars of a-z 0-9 . _ -; first char a-z or 0-9")
                if not isinstance(op[run_key], str) or _RUN_ID_RE.fullmatch(op[run_key]) is None:
                    raise _bad(f"{run_key} must be 1-64 chars of A-Z a-z 0-9 _ -")
        if "evidence" in op:
            evidence = op["evidence"]
            if not isinstance(evidence, list) or not 1 <= len(evidence) <= EVIDENCE_MAX:
                raise _bad("evidence must be an array of 1-8 entries")
            for index, item in enumerate(evidence):
                label = f"evidence[{index}]"
                if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
                    raise _bad(label + " must be object with only required keys path, sha256")
                _check_str_len(item["path"], 1, DECISION_PATH_MAX, label + ".path")
                if not isinstance(item["sha256"], str) or SHA256_RE.fullmatch(item["sha256"]) is None:
                    raise _bad(label + ".sha256 must be 64 lowercase hex chars")

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
