import copy
import json
import math
from typing import Iterable, Mapping

from .errors import PlanError
from .limits import AGENT_RE, DECISION_HISTORY_MAX
from .ops import validate_op_shape

_SAFE_MAX = 9007199254740991
_TS_MAX = 8640000000000000
_ACTIVITY_RETIRED = "activity.retired"
# At most 256 opaque IDs per task/microtask scope (520 scopes per plan).
# Saturation seals the scope until plan.open; evicting IDs would admit old runs.
_ACTIVITY_RETIRED_MAX = 256
_ACTIVITY_SEALED = "*"  # Cannot be a valid run_id.


class PlanProjection(dict):
    """Canonical JSON; an absent optional lifecycle map defaults to empty.

    Omit the empty map from legacy JSON. Once a run is recorded, all current
    and retired lifecycle data is an ordinary serialized projection field.
    """

    def __missing__(self, key):
        if key == "agent_lifecycle":
            return {}
        raise KeyError(key)

    def get(self, key, default=None):
        if key == "agent_lifecycle" and key not in self and default is None:
            return {}
        return super().get(key, default)


# Undo records retain references to individual fields, never copies of the
# projection containers. Only fold_plan allocates this private accumulator.
_MISSING = object()
_APPEND = object()


class _FoldAccumulator(PlanProjection):
    _undo = None

    def _apply(self, event, *, templates=None, last_by_agent=None):
        op = _validated_op(event)
        self._undo = []
        try:
            return _apply_op_event(self, event, op, templates=templates,
                                   last_by_agent=last_by_agent)
        except BaseException:
            # Reverse nested writes as well as derived state and retirement.
            for target, key, previous in reversed(self._undo):
                if key is _APPEND:
                    del target[previous:]
                elif previous is _MISSING:
                    target.pop(key, None)
                else:
                    target[key] = previous
            raise
        finally:
            self._undo = None


def _set(state, target, key, value):
    undo = getattr(state, "_undo", None)
    if undo is not None:
        undo.append((target, key, target.get(key, _MISSING)))
    target[key] = value


def _pop(state, target, key):
    if key in target:
        undo = getattr(state, "_undo", None)
        if undo is not None:
            undo.append((target, key, target[key]))
        return target.pop(key)
    return None


def _setdefault(state, target, key, value):
    if key not in target:
        _set(state, target, key, value)
    return target[key]


def _append(state, target, value):
    undo = getattr(state, "_undo", None)
    if undo is not None:
        undo.append((target, _APPEND, len(target)))
    target.append(value)


def _is_safe_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and abs(v) <= _SAFE_MAX


def empty_projection() -> dict:
    return PlanProjection(
        {
            "plan": None,
            "tasks": [],
            "memory": {},
            "archived_plans": [],
            "rollup": {
                "tasks_total": 0,
                "tasks_done": 0,
                "tasks_blocked": 0,
                "tasks_ready": 0,
                "micro_total": 0,
                "micro_done": 0,
                "progress": 0.0,
                "progress_pct": 0,
            },
            "replayed_ops": {},
            "rejected": [],
            "last_lamport": 0,
        }
    )


def _derived(task: dict, by_id: dict):
    explicit = task.get("explicit_state")
    micros = task.get("microtasks", [])
    if explicit == "cancelled":
        state = "cancelled"
    elif explicit == "blocked" or any(m.get("state") == "blocked" for m in micros):
        state = "blocked"
    elif len(micros) > 0 and all(m.get("state") == "done" for m in micros):
        state = "done"
    elif any(m.get("state") in ("active", "done") for m in micros):
        state = "active"
    else:
        state = "pending"
    deps = task.get("deps", [])
    if state in ("done", "cancelled"):
        ready = False
    else:
        ready = True
        for d in deps:
            dep = by_id.get(d)
            if dep is None:
                ready = False
                break
            if dep.get("state") not in ("done", "cancelled"):
                ready = False
                break
    return state, bool(ready)


def _remember_retired(state: dict, scope: str, run_id: str):
    retired = _setdefault(state, state["replayed_ops"], _ACTIVITY_RETIRED, {})
    runs = _setdefault(state, retired, scope, [])
    if _ACTIVITY_SEALED in runs or run_id in runs:
        return
    if run_id == _ACTIVITY_SEALED or len(runs) >= _ACTIVITY_RETIRED_MAX:
        _set(state, retired, scope, [_ACTIVITY_SEALED])
    else:
        _append(state, runs, run_id)


def _is_retired(state: dict, scope: str, run_id: str) -> bool:
    runs = state["replayed_ops"].get(_ACTIVITY_RETIRED, {}).get(scope, [])
    return _ACTIVITY_SEALED in runs or run_id in runs


def _retire_live(state: dict, micro: dict):
    live = _pop(state, micro, "live")
    if live is not None:
        # Replay-cache metadata survives JSON continuation without extending
        # the public task or microtask shape. Run IDs are opaque tokens.
        _remember_retired(state, micro["id"], live["run_id"])


def _retire_task_activity(state: dict, task: dict):
    for micro in task.get("microtasks", []):
        live = micro.get("live")
        if live is not None:
            _remember_retired(state, task["id"], live["run_id"])
        # Include runs whose microtask already left active before this transition.
        runs = state["replayed_ops"].get(_ACTIVITY_RETIRED, {}).get(micro["id"], [])
        for run_id in runs:
            _remember_retired(state, task["id"], run_id)
        _retire_live(state, micro)


def _retire_inactive_activity(state: dict):
    plan = state.get("plan")
    for task in state.get("tasks", []):
        allowed = plan is not None and plan.get("state") == "active" and task.get("state") not in ("blocked", "cancelled")
        if not allowed or any(m.get("live") is not None and task.get("assignee") != m["live"]["agent"] for m in task.get("microtasks", [])):
            _retire_task_activity(state, task)
            continue
        for micro in task.get("microtasks", []):
            live = micro.get("live")
            if live is not None and micro.get("state") != "active":
                _retire_live(state, micro)


def _recompute(state: dict):
    tasks = state.get("tasks", [])
    # First pass: derive states in order (deps may reference later tasks? usually earlier, but recompute iteratively)
    # Use stored states for dependency check: iterate until stable (max 3 passes)
    by_id = {t["id"]: t for t in tasks}
    for _ in range(5):
        changed = False
        for t in tasks:
            s, r = _derived(t, by_id)
            if t.get("state") != s or t.get("ready") != r:
                _set(state, t, "state", s)
                _set(state, t, "ready", r)
                changed = True
        by_id = {t["id"]: t for t in tasks}
        if not changed:
            break
    tasks_total = len(tasks)
    tasks_done = sum(1 for t in tasks if t.get("state") == "done")
    tasks_blocked = sum(1 for t in tasks if t.get("state") == "blocked")
    tasks_ready = sum(1 for t in tasks if t.get("ready"))
    micro_total = 0
    micro_done = 0
    for t in tasks:
        for m in t.get("microtasks", []):
            micro_total += 1
            if m.get("state") == "done":
                micro_done += 1
    if micro_total > 0:
        progress = micro_done / micro_total
    else:
        progress = 0.0
    progress_pct = int(progress * 100)
    _set(state, state, "rollup", {
        "tasks_total": tasks_total,
        "tasks_done": tasks_done,
        "tasks_blocked": tasks_blocked,
        "tasks_ready": tasks_ready,
        "micro_total": micro_total,
        "micro_done": micro_done,
        "progress": float(progress),
        "progress_pct": int(progress_pct),
    })
    _retire_inactive_activity(state)


def _template_for_plan(state: dict, templates):
    plan = state.get("plan")
    if plan is None or templates is None:
        return None
    tid = plan.get("template_id")
    if tid in templates:
        return templates[tid]
    return None


def _phase_ids(tpl: dict):
    try:
        return {p.get("id") for p in tpl.get("phases", []) if isinstance(p, dict)}
    except Exception:
        return set()


def _check_phase_in_template(phase: str, tpl: dict):
    if phase not in _phase_ids(tpl):
        raise PlanError("bad_op", f"unknown phase {phase!r}")


def _find_task(state: dict, task_id: str):
    for t in state.get("tasks", []):
        if t.get("id") == task_id:
            return t
    return None


def _has_cycle(tasks_deps: dict) -> bool:
    # tasks_deps: id -> list deps
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {k: WHITE for k in tasks_deps}

    def dfs(u):
        color[u] = GRAY
        for v in tasks_deps.get(u, []):
            if v not in color:
                continue
            if color[v] == GRAY:
                return True
            if color[v] == WHITE:
                if dfs(v):
                    return True
        color[u] = BLACK
        return False

    for u in list(tasks_deps.keys()):
        if color[u] == WHITE:
            if dfs(u):
                return True
    return False


def _validate_event_envelope(event: dict):
    if not isinstance(event, dict):
        raise PlanError("bad_op", "event must be object")
    # id
    if not isinstance(event.get("id"), str) or not event.get("id"):
        raise PlanError("bad_op", "event id")
    # act
    if event.get("act") != "op":
        raise PlanError("bad_op", "event act")
    # lamport
    lam = event.get("lamport")
    if not _is_safe_int(lam) or lam < 1:
        raise PlanError("bad_op", "event lamport")
    # ts
    ts = event.get("ts")
    if not _is_safe_int(ts) or abs(ts) > _TS_MAX:
        raise PlanError("bad_op", "event ts")
    # agent
    agent = event.get("agent")
    if not isinstance(agent, str) or AGENT_RE.fullmatch(agent) is None:
        raise PlanError("bad_op", "event agent")


def apply_op_event(state: dict, event: dict, *, templates: Mapping[str, dict] | None = None, last_by_agent: Mapping[str, int] | None = None) -> tuple[dict, dict]:
    op = _validated_op(event)
    # Public callers always receive a detached projection and result.
    return _apply_op_event(copy.deepcopy(state), event, op, templates=templates,
                           last_by_agent=last_by_agent)


def _validated_op(event):
    # Envelope + op shape validation (raises bad_op)
    _validate_event_envelope(event)
    if "op" not in event:
        raise PlanError("bad_op", "missing op")
    # validate_op_shape takes the op object; invalid -> bad_op/limit_exceeded
    op = validate_op_shape(event.get("op"))
    # Note: validate_op_shape already deep-copied; use its return
    return op


def _apply_op_event(new, event, op, *, templates=None, last_by_agent=None):
    # The public wrapper clones its input; the private accumulator journals
    # writes to its exclusively owned projection until this operation returns.

    lamport = event["lamport"]
    ts = event["ts"]
    agent = event["agent"]
    kind = op["kind"]
    op_id = op.get("op_id") if "op_id" in op else None

    # Ensure expected keys exist (in case caller passed empty-like)
    for key in ("plan", "tasks", "memory", "agent_lifecycle", "archived_plans", "rollup", "replayed_ops", "rejected", "last_lamport"):
        if key not in new:
            _set(new, new, key, empty_projection()[key])

    # Idempotency: same (agent, op_id) returns first result
    if op_id is not None:
        replay_key = json.dumps([agent, op_id], separators=(",", ":"))
        if replay_key in new.get("replayed_ops", {}):
            cached = copy.deepcopy(new["replayed_ops"][replay_key])
            if kind in ("agent.lifecycle", "unit.decision") or (isinstance(cached, dict) and cached.get("kind") in ("agent.lifecycle", "unit.decision")):
                if not isinstance(cached, dict) or cached.get("op") != op:
                    raise PlanError("bad_op", "op_id conflict")
            # Update last_lamport for replayed
            if lamport > new.get("last_lamport", 0):
                _set(new, new, "last_lamport", lamport)
            result = copy.deepcopy(cached)
            if isinstance(result, dict):
                result["replayed"] = True
            else:
                result = {"replayed": True, "value": result}
            if not new["agent_lifecycle"]:
                _pop(new, new, "agent_lifecycle")
            return PlanProjection(new), result

    plan = new.get("plan")

    def require_active():
        if plan is None or plan.get("state") != "active":
            raise PlanError("no_plan", "no active plan")
        return plan

    result = None

    record = new["agent_lifecycle"].get(agent)
    fenced_beat = (kind == "activity.beat" and record is not None
                   and (op["run_id"] != record["run_id"]
                        or record["lifecycle"] in ("finished", "failed")))

    if kind == "agent.lifecycle":
        # Retain unresolved edges, but never admit a cycle in this room's
        # current parent graph. Admission runs this fold under events.lock.
        parent = op.get("parent_agent")
        visited = {agent}
        while parent is not None:
            if parent in visited:
                raise PlanError("bad_args", "lifecycle parent cycle")
            visited.add(parent)
            parent = new["agent_lifecycle"].get(parent, {}).get("parent_agent")
        run_id, lifecycle = op["run_id"], op["state"]
        retired = list(record["retired_run_ids"]) if record is not None else []
        current = record is not None and record["run_id"] == run_id
        terminal = current and record["lifecycle"] in ("finished", "failed")
        noop = False
        detail = f"agent {agent} run {run_id}"
        if not current:
            if run_id in retired and lifecycle == "alive":
                noop = True
            elif lifecycle != "deployed" or run_id in retired:
                raise PlanError("not_conformant", detail + ": deployment required or run retired")
        elif lifecycle == "alive":
            last_alive = record.get("last_alive_ts")
            noop = (terminal or ts < record["ts"]
                    or (last_alive is not None and ts - last_alive < 30000))
        elif lifecycle == "deployed" or terminal:
            if terminal and lifecycle != record["lifecycle"]:
                raise PlanError("not_conformant", detail + ": terminal run")
            if any(key in op and op[key] != record.get(key)
                   for key in ("swarm", "harness", "reason", "parent_agent", "parent_run_id")):
                raise PlanError("not_conformant", detail + ": conflicting repeat")
            noop = True
        if noop:
            # Successful no-ops reserve their exact payload and original result
            # through the common replay-cache path, including JSON continuation.
            result = {"kind": kind, "op_id": op_id, "lamport": record["lamport"],
                      "noop": True, "op": copy.deepcopy(op)}
        else:
            if not current:
                if record is not None and record["run_id"] not in retired:
                    retired.append(record["run_id"])
                record = {"run_id": run_id, "deployed_ts": ts, "retired_run_ids": retired}
            else:
                record = copy.deepcopy(record)
            for key in ("swarm", "harness", "reason", "parent_agent", "parent_run_id"):
                if key in op:
                    record[key] = op[key]
            record.update(lifecycle=lifecycle, ts=ts, lamport=lamport)
            if lifecycle == "alive":
                record["last_alive_ts"] = ts
            _set(new, new["agent_lifecycle"], agent, record)
            result = {"kind": kind, "op_id": op_id, "lamport": lamport, "op": copy.deepcopy(op)}

    elif fenced_beat:
        # A stale registered run cannot touch execution fields, even without a plan.
        if op["run_id"] == record["run_id"]:
            reason = "terminal_run"
        elif op["run_id"] in record["retired_run_ids"]:
            reason = "retired_run"
        else:
            reason = "run_mismatch"
        result = {"kind": kind, "op_id": op_id, "agent": agent, "beat_ts": ts,
                  "ignored": True, "reason": reason}

    elif kind == "plan.open":
        if plan is not None and plan.get("state") == "active":
            raise PlanError("plan_exists", "plan exists")
        # template verification
        tpl = None
        if templates is not None:
            tid = op["template_id"]
            if tid not in templates:
                raise PlanError("unknown_template", f"unknown template {tid!r}")
            tpl = templates[tid]
            if op["template_hash"] != tpl.get("hash"):
                raise PlanError("bad_op", "template hash mismatch")
            if "phase" in op:
                _check_phase_in_template(op["phase"], tpl)
        new_plan = {
            "id": "p1",
            "title": op["title"],
            "template_id": op["template_id"],
            "template_hash": op["template_hash"],
            "brief": copy.deepcopy(op.get("brief", {})),
            "phase": op.get("phase") if "phase" in op else (tpl["phases"][0]["id"] if tpl is not None and tpl.get("phases") else ""),
            "state": "active",
            "rev": lamport,
            "opened_lamport": lamport,
            "opened_ts": ts,
            "closed_outcome": None,
        }
        # Closed plans were already archived at close time. Reopening only
        # resets per-plan tasks; project memory and replay history survive.
        _set(new, new, "tasks", [])
        # Retirement (including sealed scopes) belongs to the old plan only;
        # preserve ordinary replay receipts while allowing reused task/run IDs.
        _pop(new, new["replayed_ops"], _ACTIVITY_RETIRED)
        _set(new, new, "plan", new_plan)
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    elif kind == "plan.close":
        act = require_active()
        if op["base_rev"] != act.get("rev"):
            raise PlanError("stale_rev", "stale plan rev")
        unfinished = [t["id"] for t in new["tasks"] if t.get("state") not in ("done", "cancelled")]
        if unfinished:
            raise PlanError("not_conformant", "unfinished tasks: " + ", ".join(unfinished))
        _set(new, act, "state", "closed")
        _set(new, act, "rev", lamport)
        _set(new, act, "closed_outcome", op.get("outcome") if "outcome" in op else None)
        tasks_snapshot = new["tasks"]
        _append(new, new["archived_plans"], {
            "id": act["id"],
            "title": act["title"],
            "template_id": act["template_id"],
            "opened_ts": act["opened_ts"],
            "closed_ts": ts,
            "tasks_total": len(tasks_snapshot),
            "tasks_done": sum(t["state"] == "done" for t in tasks_snapshot),
            "outcome": act["closed_outcome"],
        })
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    elif kind == "plan.phase":
        act = require_active()
        if op["base_rev"] != act.get("rev"):
            raise PlanError("stale_rev", "stale plan rev")
        tpl = _template_for_plan(new, templates)
        if tpl is not None:
            _check_phase_in_template(op["phase"], tpl)
        _set(new, act, "phase", op["phase"])
        _set(new, act, "rev", lamport)
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    elif kind == "unit.decision":
        require_active()
        task = _find_task(new, op["task_id"])
        if task is None:
            raise PlanError("bad_op", "unknown decision task")
        if "micro_id" in op and not any(m["id"] == op["micro_id"] for m in task["microtasks"]):
            raise PlanError("bad_op", "unknown decision microtask")
        result_agent = op.get("result_agent", op.get("agent"))
        result_run_id = op.get("result_run_id", op.get("run_id"))
        if result_agent is not None:
            # Resolve any admitted terminal result, including a previous run.
            # Replay receipts are durable and retain the original lifecycle op.
            found = False
            for key, receipt in new["replayed_ops"].items():
                if not isinstance(receipt, dict) or receipt.get("kind") != "agent.lifecycle" or receipt.get("noop"):
                    continue
                source = receipt.get("op", {})
                if (source.get("run_id") == result_run_id
                        and source.get("state") in ("finished", "failed") and "result" in source
                        and json.loads(key)[0] == result_agent):
                    found = True
                    break
            if not found:
                raise PlanError("bad_op", "unknown result reference")
        decision = dict(copy.deepcopy(op), lamport=lamport)
        _set(new, task, "decisions", (task.get("decisions", []) + [decision])[-DECISION_HISTORY_MAX:])
        _set(new, task, "last_decision", decision)
        result = {"kind": kind, "op_id": op_id, "op": copy.deepcopy(op)}

    elif kind == "task.add":
        act = require_active()
        if "base_rev" in op and op["base_rev"] != act.get("rev"):
            raise PlanError("stale_rev", "stale plan rev")
        tpl = _template_for_plan(new, templates)
        if tpl is not None:
            _check_phase_in_template(op["phase"], tpl)
        tasks = new.get("tasks", [])
        if len(tasks) >= 40:
            raise PlanError("limit_exceeded", "tasks cap")
        new_num = len(tasks) + 1
        new_id = f"T{new_num:02d}"
        deps = list(op.get("deps", []))
        # duplicate already rejected in shape, but re-check
        if len(set(deps)) != len(deps):
            raise PlanError("bad_op", "duplicate dep")
        if new_id in deps:
            raise PlanError("dep_cycle", "self dep")
        by_id = {t["id"]: t for t in tasks}
        for d in deps:
            if d not in by_id:
                raise PlanError("not_found", f"dep {d}")
        # transitive check (new node has no dependents, but include for completeness)
        trial = {t["id"]: list(t.get("deps", [])) for t in tasks}
        trial[new_id] = list(deps)
        if _has_cycle(trial):
            raise PlanError("dep_cycle", "dep cycle")
        micros_in = op.get("microtasks", [])
        micros = []
        for idx, m in enumerate(micros_in, 1):
            micros.append({
                "id": f"{new_id}.M{idx:02d}",
                "text": m["text"],
                "accept": m.get("accept", ""),
                "state": "pending",
                "outcome": None,
                "took": None,
                "evidence": [],
                "rev": lamport,
            })
        task = {
            "id": new_id,
            "title": op["title"],
            "type": op["type"],
            "phase": op["phase"],
            "accept": op.get("accept", ""),
            "deps": deps,
            "assignee": op.get("assignee") if "assignee" in op else None,
            "claim_lamport": None,
            "claim_ts": None,
            "estimate": op.get("estimate") if "estimate" in op else None,
            "rev": lamport,
            "explicit_state": None,
            "blocked_reason": None,
            "state": "pending",
            "ready": False,
            "microtasks": micros,
        }
        # normalize estimate/assignee defaults: if key absent -> None
        if "assignee" not in op:
            _set(new, task, "assignee", None)
        if "estimate" not in op:
            _set(new, task, "estimate", None)
        _append(new, tasks, task)
        _set(new, new, "tasks", tasks)
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    elif kind == "task.set":
        act = require_active()
        task = _find_task(new, op["task_id"])
        if task is None:
            raise PlanError("not_found", "task")
        if op["base_rev"] != task.get("rev"):
            raise PlanError("stale_rev", "stale task rev")
        if op.get("state") == "cancelled" and task.get("assignee") not in (None, agent):
            owner = new.get("agent_lifecycle", {}).get(task["assignee"], {})
            if owner.get("lifecycle") not in ("finished", "failed"):
                raise PlanError("claimed_by_other", "claimed")
        tpl = _template_for_plan(new, templates)
        if tpl is not None and "phase" in op:
            _check_phase_in_template(op["phase"], tpl)
        tasks = new.get("tasks", [])
        if "deps" in op:
            deps = list(op["deps"])
            if len(set(deps)) != len(deps):
                raise PlanError("bad_op", "duplicate dep")
            by_id = {t["id"]: t for t in tasks}
            for d in deps:
                if d not in by_id:
                    raise PlanError("not_found", f"dep {d}")
            if op["task_id"] in deps:
                raise PlanError("dep_cycle", "self dep")
            trial = {t["id"]: list(t.get("deps", [])) for t in tasks}
            trial[op["task_id"]] = list(deps)
            if _has_cycle(trial):
                raise PlanError("dep_cycle", "dep cycle")
        # Apply mutations
        if "title" in op:
            _set(new, task, "title", op["title"])
        if "type" in op:
            _set(new, task, "type", op["type"])
        if "phase" in op:
            _set(new, task, "phase", op["phase"])
        if "accept" in op:
            _set(new, task, "accept", op["accept"])
        if "deps" in op:
            _set(new, task, "deps", list(op["deps"]))
        if "estimate" in op:
            _set(new, task, "estimate", op["estimate"])
        if "state" in op:
            _set(new, task, "explicit_state", op["state"])
            if op["state"] is None and "reason" not in op:
                _set(new, task, "blocked_reason", None)
        if "reason" in op:
            _set(new, task, "blocked_reason", op["reason"])
        _set(new, task, "rev", lamport)
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    elif kind == "task.claim":
        act = require_active()
        task = _find_task(new, op["task_id"])
        if task is None:
            raise PlanError("not_found", "task")
        if "base_rev" in op and op["base_rev"] != task.get("rev"):
            raise PlanError("stale_rev", "stale task rev")
        assignee = task.get("assignee")
        if assignee not in (None, agent):
            takeover = op.get("takeover") if "takeover" in op else False
            if takeover is not True:
                raise PlanError("claimed_by_other", "claimed")
            candidates = []
            cts = task.get("claim_ts")
            if cts is not None:
                candidates.append(cts)
            # Accepted beats remain owner activity after their live runs retire,
            # including beats on the owner's other tasks during JSON continuation.
            for receipt in new["replayed_ops"].values():
                if isinstance(receipt, dict) and receipt.get("kind") == "activity.beat" and receipt.get("agent") == assignee and _is_safe_int(receipt.get("beat_ts")):
                    candidates.append(receipt["beat_ts"])
            if last_by_agent is not None:
                v = last_by_agent.get(assignee)
                if v is not None:
                    candidates.append(v)
            if not candidates:
                raise PlanError("claimed_by_other", "no activity")
            last = max(candidates)
            if not (ts - last > 600000):
                raise PlanError("claimed_by_other", "not silent")
        if assignee != agent:
            _retire_task_activity(new, task)
        _set(new, task, "assignee", agent)
        _set(new, task, "claim_lamport", lamport)
        _set(new, task, "claim_ts", ts)
        _set(new, task, "rev", lamport)
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    elif kind == "task.release":
        act = require_active()
        task = _find_task(new, op["task_id"])
        if task is None:
            raise PlanError("not_found", "task")
        if "base_rev" in op and op["base_rev"] != task.get("rev"):
            raise PlanError("stale_rev", "stale task rev")
        assignee = task.get("assignee")
        if assignee not in (None, agent):
            raise PlanError("claimed_by_other", "claimed")
        if "claim_lamport" in op and op["claim_lamport"] != task.get("claim_lamport"):
            raise PlanError("stale_rev", "stale claim lamport")
        if task.get("state") in ("done", "cancelled"):
            raise PlanError("not_conformant", "cannot release terminal task " + task["id"])
        _retire_task_activity(new, task)
        for micro in task.get("microtasks", []):
            if micro.get("state") == "active":
                _set(new, micro, "state", "pending")
                _set(new, micro, "rev", lamport)
        _set(new, task, "assignee", None)
        _set(new, task, "claim_lamport", None)
        _set(new, task, "claim_ts", None)
        _set(new, task, "rev", lamport)
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    elif kind == "micro.add":
        act = require_active()
        task = _find_task(new, op["task_id"])
        if task is None:
            raise PlanError("not_found", "task")
        if op["base_rev"] != task.get("rev"):
            raise PlanError("stale_rev", "stale task rev")
        micros = task.get("microtasks", [])
        if len(micros) >= 12:
            raise PlanError("limit_exceeded", "micros cap")
        mid = f"{op['task_id']}.M{len(micros)+1:02d}"
        micro = {
            "id": mid,
            "text": op["text"],
            "accept": op.get("accept", ""),
            "state": "pending",
            "outcome": None,
            "took": None,
            "evidence": [],
            "rev": lamport,
        }
        _append(new, micros, micro)
        _set(new, task, "microtasks", micros)
        _set(new, task, "rev", lamport)
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    elif kind == "activity.beat":
        require_active()
        task = _find_task(new, op["task_id"])
        if task is None:
            raise PlanError("not_found", "task")
        if task.get("assignee") != agent:
            raise PlanError("claimed_by_other", "claimed")
        micros = task.get("microtasks", [])
        if "micro_id" in op:
            micros = [m for m in micros if m["id"] == op["micro_id"]]
            if not micros:
                raise PlanError("not_found", "micro")
        run_id = op["run_id"]
        if task.get("state") not in ("blocked", "cancelled") and not _is_retired(new, task["id"], run_id):
            eligible = [m for m in micros if m["state"] == "active" and not _is_retired(new, m["id"], run_id)]
            if eligible:
                # Supersession fences the old task run on every sibling.
                for micro in task.get("microtasks", []):
                    live = micro.get("live")
                    if live is not None and live["run_id"] != run_id:
                        _remember_retired(new, task["id"], live["run_id"])
                        _retire_live(new, micro)
                if _is_retired(new, task["id"], run_id):
                    _retire_task_activity(new, task)
                else:
                    for micro in eligible:
                        if not _is_retired(new, micro["id"], run_id):
                            _set(new, micro, "live", {"agent": agent, "run_id": run_id, "beat_ts": ts, "beat_lamport": lamport})
        # A beat changes only liveness and the journal/replay cursors.
        result = {"kind": kind, "op_id": op_id, "agent": agent, "beat_ts": ts}

    elif kind == "micro.set":
        act = require_active()
        micro_id = op["micro_id"]
        task_id = micro_id.split(".", 1)[0]
        task = _find_task(new, task_id)
        if task is None:
            raise PlanError("not_found", "task")
        micro = None
        for m in task.get("microtasks", []):
            if m.get("id") == micro_id:
                micro = m
                break
        if micro is None:
            raise PlanError("not_found", "micro")
        assignee = task.get("assignee")
        if assignee is None:
            raise PlanError("not_conformant", "claim task " + task_id + " before setting microtasks")
        if assignee != agent:
            raise PlanError("claimed_by_other", "claimed")
        if "claim_lamport" in op and op["claim_lamport"] != task.get("claim_lamport"):
            raise PlanError("stale_rev", "stale claim lamport")
        if op["state"] in ("active", "done"):
            by_id = {t["id"]: t for t in new["tasks"]}
            unsatisfied = [d for d in task.get("deps", [])
                           if d not in by_id or by_id[d].get("state") not in ("done", "cancelled")]
            if unsatisfied:
                raise PlanError("not_conformant", "unsatisfied dependencies: " + ", ".join(unsatisfied))
        _set(new, micro, "state", op["state"])
        if "outcome" in op:
            _set(new, micro, "outcome", op["outcome"])
        if "took" in op:
            _set(new, micro, "took", op["took"])
        if "evidence" in op:
            _set(new, micro, "evidence", copy.deepcopy(op["evidence"]))
        _set(new, micro, "rev", lamport)
        _set(new, task, "rev", lamport)
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    elif kind == "memory.set":
        # No no_plan check
        section = op["section"]
        mem = new.get("memory", {})
        cur_rev = mem.get(section, {}).get("rev", 0) if isinstance(mem.get(section), dict) else 0
        if op["base_rev"] != cur_rev:
            raise PlanError("stale_rev", "stale memory rev")
        if templates is not None:
            tpl = None
            cur_plan = new.get("plan")
            if cur_plan is not None and cur_plan.get("template_id") in templates:
                tpl = templates[cur_plan.get("template_id")]
            else:
                # search any template containing the section
                for cand in templates.values():
                    try:
                        secs = cand.get("memory_sections", []) if isinstance(cand, dict) else []
                        if any(isinstance(s, dict) and s.get("id") == section for s in secs):
                            tpl = cand
                            break
                    except Exception:
                        continue
            if tpl is not None:
                for s in tpl.get("memory_sections", []):
                    if isinstance(s, dict) and s.get("id") == section:
                        max_chars = s.get("max_chars")
                        if isinstance(max_chars, int) and not isinstance(max_chars, bool):
                            if len(op["text"]) > max_chars:
                                raise PlanError("limit_exceeded", "memory chars")
                        break
                # If section not in template, no limit check
        _set(new, mem, section, {"id": section, "text": op["text"], "rev": lamport, "by": agent, "ts": ts})
        _set(new, new, "memory", mem)
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    else:
        raise PlanError("bad_op", "unknown kind")

    # Update last_lamport
    if lamport > new.get("last_lamport", 0):
        _set(new, new, "last_lamport", lamport)
    # Cache replay result
    if op_id is not None:
        replay_key = json.dumps([agent, op_id], separators=(",", ":"))
        _set(new, new["replayed_ops"], replay_key, copy.deepcopy(result))
    if not new["agent_lifecycle"]:
        _pop(new, new, "agent_lifecycle")
    return PlanProjection(new), result


def fold_plan(events: Iterable[dict], *, templates: Mapping[str, dict] | None = None,
              _observe=None) -> dict:
    # Optional read-only observer sees admitted operations at their replay point;
    # it adds no projection fields and leaves legacy serialization unchanged.
    state = _FoldAccumulator(empty_projection())
    raw = list(events)
    # Collect sortable events: dict with str id and valid lamport >=1
    sortable = []
    for e in raw:
        if not isinstance(e, dict):
            continue
        eid = e.get("id")
        lam = e.get("lamport")
        if not isinstance(eid, str):
            continue
        if not (_is_safe_int(lam) and lam >= 1):  # type: ignore[operator]
            continue
        sortable.append(e)
    ordered = sorted(sortable, key=lambda e: (e.get("lamport"), e.get("id")))
    # Deduplicate event ids (first wins)
    seen_ids = set()
    deduped = []
    for e in ordered:
        eid = e.get("id")
        if eid in seen_ids:
            continue
        seen_ids.add(eid)
        deduped.append(e)

    last_by_agent: dict = {}

    def _update_activity(e: dict):
        agent = e.get("agent")
        ts = e.get("ts")
        if isinstance(agent, str) and AGENT_RE.fullmatch(agent) is not None:
            if _is_safe_int(ts) and abs(ts) <= _TS_MAX:
                prev = last_by_agent.get(agent)
                if prev is None or ts > prev:
                    last_by_agent[agent] = ts

    for e in deduped:
        if e.get("act") != "op":
            _update_activity(e)
            if _observe is not None:
                _observe(e, state, None)
            continue
        # eligible op event: attempt apply with prior activity snapshot
        op_obj = e.get("op")
        if isinstance(op_obj, dict) and isinstance(op_obj.get("op_id"), str):
            op_id_for_reject = op_obj.get("op_id")
        else:
            op_id_for_reject = None
        snapshot = dict(last_by_agent)
        try:
            _, disposition = state._apply(e, templates=templates, last_by_agent=snapshot)
            if _observe is not None:
                _observe(e, state, disposition)
        except PlanError as ex:
            # Apply failed: record rejection, update last_lamport
            state["rejected"].append({"id": e.get("id"), "lamport": e.get("lamport"), "op_id": op_id_for_reject, "code": ex.code})
            if e.get("lamport") > state.get("last_lamport", 0):
                state["last_lamport"] = e.get("lamport")
        except Exception as ex:
            # Unexpected errors should still be bad_op? Treat as bad_op to keep fold fail-safe
            code = "bad_op"
            state["rejected"].append({"id": e.get("id"), "lamport": e.get("lamport"), "op_id": op_id_for_reject, "code": code})
            if e.get("lamport") > state.get("last_lamport", 0):
                state["last_lamport"] = e.get("lamport")
        _update_activity(e)

    # Ensure exact top-level keys
    final = PlanProjection(
        {
            "plan": state.get("plan"),
            "tasks": state.get("tasks", []),
            "memory": state.get("memory", {}),
            "agent_lifecycle": state.get("agent_lifecycle", {}),
            "archived_plans": state.get("archived_plans", []),
            "rollup": state.get("rollup"),
            "replayed_ops": state.get("replayed_ops", {}),
            "rejected": state.get("rejected", []),
            "last_lamport": state.get("last_lamport", 0),
        }
    )
    if not final["agent_lifecycle"]:
        final.pop("agent_lifecycle", None)
    # Recompute to be safe (preserves derived)
    _recompute(final)
    # Keep rejected/last as computed (recompute doesn't touch them)
    return final
