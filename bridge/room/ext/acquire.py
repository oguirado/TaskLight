"""Atomic work acquisition and fenced, batched progress reporting.

All mutations go through the room writer. A batch's first operation retains
the caller's identity; its second identity commits to the canonical request.
This uses the existing operation namespace without adding receipt files or
operation kinds, and makes replay independent of later state and evidence.
"""
import copy
import hashlib
import json
import os
import re
import secrets

from . import register
from .admission import admit_work as _admit_work
from bridge.plan.fold import fold_plan
from bridge.plan.limits import (
    EVIDENCE_MAX, MICRO_ID_RE, MICRO_MAX, OP_ID_RE, OUTCOME_MAX,
    TASK_ID_RE, TASKS_MAX, TOOK_MAX,
)
from bridge.room import store


_RUN_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


def _arguments(args, required, optional):
    if (not isinstance(args, dict) or set(args) - required - optional
            or not required <= set(args)):
        raise store.RoomError("bad_args", "invalid work arguments")
    for key in (required | optional) - {"done", "claim_lamport", "expected_opened_lamport"}:
        if key in args and not isinstance(args[key], str):
            raise store.RoomError("bad_args", key + " must be a string")
    if "run_id" in args and not _RUN_ID_RE.fullmatch(args["run_id"]):
        raise store.RoomError("bad_args", "invalid run_id")
    if "expected_opened_lamport" in args:
        store._validate_expected_opened_lamport(args["expected_opened_lamport"])
    store._check_room(args["room"])
    store._check_agent(args["agent"])
    if "op_id" in args and not OP_ID_RE.fullmatch(args["op_id"]):
        raise store.RoomError("bad_op", "invalid op_id")
    for key in ("task_id", "prefer_task"):
        if key in args and not TASK_ID_RE.fullmatch(args[key]):
            raise store.RoomError("bad_op", "invalid " + key)


def _request(tool, args):
    identity = args.get("op_id") or secrets.token_hex(16)
    try:
        canonical = json.dumps(
            {"tool": tool, "identity": identity, "request": args},
            sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as exc:
        raise store.RoomError("bad_args", "request must be JSON data") from exc
    return identity, hashlib.sha256(canonical).hexdigest()


def _member_id(identity, digest, index):
    if index == 0:
        return identity
    candidate = digest if index == 1 else hashlib.sha256(
        (digest + ":" + str(index)).encode("ascii")
    ).hexdigest()
    # Keep the root and derived member namespaces disjoint even when a caller
    # supplies a digest-shaped root identity.
    while candidate == identity:
        candidate = hashlib.sha256(candidate.encode("ascii")).hexdigest()
    return candidate


def _identify(ops, identity, digest):
    for index, op in enumerate(ops):
        op["op_id"] = _member_id(identity, digest, index)
    return ops


def _check_receipt(members, identity, digest):
    if (len(members) < 2
            or members[0].get("batch", {}).get("op_id") != identity
            or any(event.get("op", {}).get("op_id") != _member_id(identity, digest, index)
                   for index, event in enumerate(members))):
        raise store.RoomError("bad_op", "op_id conflicts with a different request")


def _snapshot(room, agent, identity, digest, *, expected_opened_lamport=store._UNFENCED):
    """Read and inspect replay under the writer's lock, releasing before post_ops."""
    lockpath = os.path.join(store._room_dir(None, room), "events.lock")
    try:
        fd = os.open(lockpath, os.O_CREAT | os.O_RDWR, 0o600)
    except (FileNotFoundError, NotADirectoryError):
        store._check_plan_generation([], expected_opened_lamport)
        return [], None
    try:
        store._lock.lock_exclusive(fd)
        try:
            events, _ = store._read_all(None, room)
            store._check_plan_generation(events, expected_opened_lamport)
            matched = store._op_identity_index(events, agent).get(identity)
            if matched is None:
                return events, None
            if not isinstance(matched.get("batch"), dict):
                raise store.RoomError("bad_op", "op_id conflict")
            members = store._replay_batch(events, matched, agent)
            _check_receipt(members, identity, digest)
            return events, members
        finally:
            store._lock.unlock(fd)
    finally:
        os.close(fd)


def _work_snapshot(args, identity, digest):
    return _snapshot(args["room"], args["agent"], identity, digest,
                     expected_opened_lamport=args.get("expected_opened_lamport", store._UNFENCED))


def _fold(events):
    return fold_plan(events, **store._tpl_kw(needed=store._plan_template_ids(events)))


def _active(events):
    projection = _fold(events)
    if (projection.get("plan") or {}).get("state") != "active":
        raise store.RoomError("no_plan", "no active plan")
    return projection


def _response(tool, events, members):
    # Recover the committed prefix, never a projection of later progress. This
    # also accounts for unrelated operations committed after our selection.
    last_id = members[-1]["id"]
    end = next((i + 1 for i, event in enumerate(events) if event["id"] == last_id), None)
    if end is None:
        raise store.RoomError("internal", "committed batch missing from journal")
    projection = _fold(events[:end])
    task_id = members[0]["op"]["task_id"]
    task = next(t for t in projection["tasks"] if t["id"] == task_id)
    if tool == "work_acquire":
        return {"task": copy.deepcopy(task),
                "items": [copy.deepcopy(m) for m in task["microtasks"]
                          if m["state"] in ("pending", "active")],
                "claim_lamport": members[0]["lamport"]}
    active = next((m["id"] for m in task["microtasks"] if m["state"] == "active"), None)
    return {"ok": True, "task_id": task_id,
            "done": [event["op"]["micro_id"] for event in members
                     if event["op"].get("state") == "done"],
            "active": active, "lamport": members[-1]["lamport"],
            "replayed": bool(members[0].get("replayed", False))}


def _commit(tool, args, ops, identity, digest):
    fence = ({"expected_opened_lamport": args["expected_opened_lamport"]}
             if "expected_opened_lamport" in args else {})
    members = store.post_ops(
        args["room"], args["agent"], _identify(ops, identity, digest),
        admit=lambda projection: _admit_work(args, projection), **fence)
    # Another request can win between snapshot and writer lock acquisition.
    # The writer returns its original batch; verify content before acknowledging.
    _check_receipt(members, identity, digest)
    events, _ = _snapshot(args["room"], args["agent"], identity, digest)
    return _response(tool, events, members)


def _select(tasks, agent, preferred):
    by_id = {t["id"]: t for t in tasks}
    depths = {}

    def depth(tid, seen):
        if tid in seen:
            return 0
        if tid not in depths:
            deps = by_id.get(tid, {}).get("deps", [])
            depths[tid] = 1 + max(depth(d, seen | {tid}) for d in deps) if deps else 0
        return depths[tid]

    eligible = [t for t in tasks
                if t.get("assignee") in (None, agent)
                and t.get("state") not in ("done", "cancelled", "blocked")
                and t.get("explicit_state") not in ("cancelled", "blocked")
                and t.get("ready")
                and any(m["state"] in ("pending", "active") for m in t["microtasks"])]
    if not eligible:
        return None
    return min(eligible, key=lambda t: (
        t.get("assignee") != agent, t["id"] != preferred,
        depth(t["id"], set()), t["id"],
    ))


def work_acquire(args: dict) -> dict:
    _arguments(args, {"room", "agent"}, {"prefer_task", "op_id", "run_id", "expected_opened_lamport"})
    identity, digest = _request("work_acquire", args)
    conflict = None
    try:
        for _ in range(TASKS_MAX):
            events, replay = _work_snapshot(args, identity, digest)
            if replay is not None:
                return _response("work_acquire", events, replay)
            projection = _active(events)
            _admit_work(args, projection)
            task = _select(projection["tasks"], args["agent"], args.get("prefer_task"))
            if task is None:
                if conflict is not None:
                    break
                return {"task": None, "items": []}
            micro = next((m for m in task["microtasks"] if m["state"] == "active"), None)
            if micro is None:
                micro = next(m for m in task["microtasks"] if m["state"] == "pending")
            ops = [{"kind": "task.claim", "task_id": task["id"], "base_rev": task["rev"]},
                   {"kind": "micro.set", "micro_id": micro["id"], "state": "active"}]
            try:
                return _commit("work_acquire", args, ops, identity, digest)
            except store.RoomError as exc:
                if exc.code not in ("stale_rev", "claimed_by_other"):
                    raise
                conflict = exc
        raise store.RoomError("stale_rev", "acquisition selection conflicted: " + str(conflict))
    except OSError as exc:
        raise store.RoomError("internal", str(exc)) from exc


def _completions(args):
    fence = args["claim_lamport"]
    if not store._is_safe_int(fence) or fence <= 0:
        raise store.RoomError("bad_args", "claim_lamport must be a positive safe integer")
    done = args["done"]
    if not isinstance(done, list) or not 1 <= len(done) <= MICRO_MAX:
        raise store.RoomError("bad_args", "done must be a nonempty bounded array")
    seen = set()
    for member in done:
        required = {"id", "outcome", "evidence"}
        if (not isinstance(member, dict) or set(member) - required - {"took"}
                or not required <= set(member)):
            raise store.RoomError("bad_args", "invalid completion fields")
        for key in ("id", "outcome", "took"):
            if key in member and not isinstance(member[key], str):
                raise store.RoomError("bad_args", key + " must be a string")
        if not MICRO_ID_RE.fullmatch(member["id"]):
            raise store.RoomError("bad_op", "invalid microtask id")
        if member["id"] in seen:
            raise store.RoomError("bad_args", "duplicate completion")
        seen.add(member["id"])
        if not member["outcome"].strip():
            raise store.RoomError("bad_args", "outcome must not be blank")
        if len(member["outcome"]) > OUTCOME_MAX or len(member.get("took", "")) > TOOK_MAX:
            raise store.RoomError("limit_exceeded", "completion text exceeds limit")
        evidence = member["evidence"]
        if (not isinstance(evidence, list) or not 1 <= len(evidence) <= EVIDENCE_MAX
                or not all(isinstance(path, str) for path in evidence)):
            raise store.RoomError("bad_evidence", "evidence must be a nonempty bounded array of paths")


def _report(args, events, identity, digest):
    _completions(args)
    projection = _active(events)
    _admit_work(args, projection)
    task = next((t for t in projection["tasks"] if t["id"] == args["task_id"]), None)
    if task is None:
        raise store.RoomError("not_found", "task " + args["task_id"])
    if task["assignee"] is None:
        raise store.RoomError("not_conformant", "claim task " + task["id"] + " before reporting")
    if task["assignee"] != args["agent"]:
        raise store.RoomError("claimed_by_other", "task belongs to another agent")
    if task["claim_lamport"] != args["claim_lamport"]:
        raise store.RoomError("stale_rev", "stale claim lamport")
    all_micros = {m["id"]: m for t in projection["tasks"] for m in t["microtasks"]}
    for member in args["done"]:
        mid = member["id"]
        if mid not in all_micros:
            raise store.RoomError("not_found", "microtask " + mid)
        if mid.split(".", 1)[0] != task["id"]:
            raise store.RoomError("not_conformant", "completion belongs to another task: " + mid)
        if all_micros[mid]["state"] not in ("pending", "active"):
            raise store.RoomError("not_conformant", "microtask is not unfinished work: " + mid)
    ops = [{"kind": "task.set", "task_id": task["id"],
            "base_rev": task["rev"], "title": task["title"]}]
    rdir = store._room_dir(None, args["room"])
    for member in args["done"]:
        try:
            evidence = store._validate_evidence(member["evidence"], rdir)
        except (OSError, ValueError) as exc:
            raise store.RoomError("bad_evidence", "cannot read evidence") from exc
        op = {"kind": "micro.set", "micro_id": member["id"], "state": "done",
              "claim_lamport": args["claim_lamport"],
              "outcome": member["outcome"], "evidence": evidence}
        if "took" in member:
            op["took"] = member["took"]
        ops.append(op)
    completed = {member["id"] for member in args["done"]}
    remaining = [m for m in task["microtasks"] if m["id"] not in completed]
    active = next((m for m in remaining if m["state"] == "active"), None)
    if active is None:
        pending = next((m for m in remaining if m["state"] == "pending"), None)
        if pending is not None:
            ops.append({"kind": "micro.set", "micro_id": pending["id"], "state": "active",
                        "claim_lamport": args["claim_lamport"]})
    return _commit("work_report", args, ops, identity, digest)


def work_report(args: dict) -> dict:
    _arguments(args, {"room", "agent", "task_id", "claim_lamport", "done"},
               {"op_id", "run_id", "expected_opened_lamport"})
    identity, digest = _request("work_report", args)
    try:
        events, replay = _work_snapshot(args, identity, digest)
        if replay is not None:
            return _response("work_report", events, replay)
        try:
            return _report(args, events, identity, digest)
        except (store.RoomError, OSError):
            # A concurrent exact request may have committed after our snapshot,
            # even if its progress or evidence removal invalidated our preflight.
            events, replay = _work_snapshot(args, identity, digest)
            if replay is not None:
                return _response("work_report", events, replay)
            raise
    except OSError as exc:
        raise store.RoomError("internal", str(exc)) from exc


_ROOM_SCHEMA = {"type": "string", "pattern": "^" + store.ROOM_RE.pattern + "$"}
_AGENT_SCHEMA = {"type": "string", "pattern": "^" + store.AGENT_RE.pattern + "$"}
_TASK_SCHEMA = {"type": "string", "pattern": "^" + TASK_ID_RE.pattern + "$"}
_OP_SCHEMA = {"type": "string", "pattern": "^" + OP_ID_RE.pattern + "$"}
_RUN_SCHEMA = {"type": "string", "pattern": "^" + _RUN_ID_RE.pattern + "$"}
_GENERATION_SCHEMA = {"type": "integer", "minimum": 1, "maximum": store._SAFE_MAX}

register({
    "name": "work_acquire",
    "description": "Atomically claim eligible work and start or retain its first active microtask.",
    "inputSchema": {
        "type": "object",
        "properties": {"room": _ROOM_SCHEMA, "agent": _AGENT_SCHEMA,
                       "prefer_task": _TASK_SCHEMA, "op_id": _OP_SCHEMA,
                       "run_id": _RUN_SCHEMA, "expected_opened_lamport": _GENERATION_SCHEMA},
        "required": ["room", "agent"], "additionalProperties": False,
    },
}, work_acquire)

register({
    "name": "work_report",
    "description": "Complete a batch of owned microtasks with evidence and activate the next pending item.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "room": _ROOM_SCHEMA, "agent": _AGENT_SCHEMA,
            "task_id": _TASK_SCHEMA, "op_id": _OP_SCHEMA,
            "run_id": _RUN_SCHEMA, "expected_opened_lamport": _GENERATION_SCHEMA,
            "claim_lamport": {"type": "integer", "minimum": 1, "maximum": store._SAFE_MAX},
            "done": {"type": "array", "minItems": 1, "maxItems": MICRO_MAX, "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "pattern": "^" + MICRO_ID_RE.pattern + "$"},
                    "outcome": {"type": "string", "minLength": 1, "maxLength": OUTCOME_MAX},
                    "evidence": {"type": "array", "minItems": 1, "maxItems": EVIDENCE_MAX,
                                 "items": {"type": "string"}},
                    "took": {"type": "string", "maxLength": TOOK_MAX},
                },
                "required": ["id", "outcome", "evidence"], "additionalProperties": False,
            }},
        },
        "required": ["room", "agent", "task_id", "claim_lamport", "done"],
        "additionalProperties": False,
    },
}, work_report)
