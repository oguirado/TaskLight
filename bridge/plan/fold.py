import copy
import json
import math
from typing import Iterable, Mapping

from .errors import PlanError
from .limits import AGENT_RE
from .ops import validate_op_shape

_SAFE_MAX = 9007199254740991
_TS_MAX = 8640000000000000


class PlanProjection(dict):
    """Canonical JSON projection; all lifecycle state is serialized."""


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
            if dep.get("state") != "done":
                ready = False
                break
    return state, bool(ready)


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
                t["state"] = s
                t["ready"] = r
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
    state["rollup"] = {
        "tasks_total": tasks_total,
        "tasks_done": tasks_done,
        "tasks_blocked": tasks_blocked,
        "tasks_ready": tasks_ready,
        "micro_total": micro_total,
        "micro_done": micro_done,
        "progress": float(progress),
        "progress_pct": int(progress_pct),
    }


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
    # Envelope + op shape validation (raises bad_op)
    _validate_event_envelope(event)
    if "op" not in event:
        raise PlanError("bad_op", "missing op")
    # validate_op_shape takes the op object; invalid -> bad_op/limit_exceeded
    op = validate_op_shape(event.get("op"))
    # Note: validate_op_shape already deep-copied; use its return

    lamport = event["lamport"]
    ts = event["ts"]
    agent = event["agent"]
    kind = op["kind"]
    op_id = op.get("op_id") if "op_id" in op else None

    # Validated operations and canonical projections are safe to copy.
    new = copy.deepcopy(state)
    # Ensure expected keys exist (in case caller passed empty-like)
    for key in ("plan", "tasks", "memory", "archived_plans", "rollup", "replayed_ops", "rejected", "last_lamport"):
        if key not in new:
            new[key] = empty_projection()[key]

    # Idempotency: same (agent, op_id) returns first result
    if op_id is not None:
        replay_key = json.dumps([agent, op_id], separators=(",", ":"))
        if replay_key in new.get("replayed_ops", {}):
            cached = copy.deepcopy(new["replayed_ops"][replay_key])
            # Update last_lamport for replayed
            if lamport > new.get("last_lamport", 0):
                new["last_lamport"] = lamport
            result = copy.deepcopy(cached)
            if isinstance(result, dict):
                result["replayed"] = True
            else:
                result = {"replayed": True, "value": result}
            return new, result

    plan = new.get("plan")

    def require_active():
        if plan is None or plan.get("state") != "active":
            raise PlanError("no_plan", "no active plan")
        return plan

    result = None

    if kind == "plan.open":
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
        new["tasks"] = []
        new["plan"] = new_plan
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    elif kind == "plan.close":
        act = require_active()
        if op["base_rev"] != act.get("rev"):
            raise PlanError("stale_rev", "stale plan rev")
        act["state"] = "closed"
        act["rev"] = lamport
        act["closed_outcome"] = op.get("outcome") if "outcome" in op else None
        tasks_snapshot = new["tasks"]
        new["archived_plans"].append({
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
        act["phase"] = op["phase"]
        act["rev"] = lamport
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

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
            task["assignee"] = None
        if "estimate" not in op:
            task["estimate"] = None
        tasks.append(task)
        new["tasks"] = tasks
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    elif kind == "task.set":
        act = require_active()
        task = _find_task(new, op["task_id"])
        if task is None:
            raise PlanError("not_found", "task")
        if op["base_rev"] != task.get("rev"):
            raise PlanError("stale_rev", "stale task rev")
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
            task["title"] = op["title"]
        if "type" in op:
            task["type"] = op["type"]
        if "phase" in op:
            task["phase"] = op["phase"]
        if "accept" in op:
            task["accept"] = op["accept"]
        if "deps" in op:
            task["deps"] = list(op["deps"])
        if "estimate" in op:
            task["estimate"] = op["estimate"]
        if "state" in op:
            task["explicit_state"] = op["state"]
            if op["state"] is None and "reason" not in op:
                task["blocked_reason"] = None
        if "reason" in op:
            task["blocked_reason"] = op["reason"]
        task["rev"] = lamport
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
            if last_by_agent is not None:
                v = last_by_agent.get(assignee)
                if v is not None:
                    candidates.append(v)
            if not candidates:
                raise PlanError("claimed_by_other", "no activity")
            last = max(candidates)
            if not (ts - last > 600000):
                raise PlanError("claimed_by_other", "not silent")
        task["assignee"] = agent
        task["claim_lamport"] = lamport
        task["claim_ts"] = ts
        task["rev"] = lamport
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
        task["assignee"] = None
        task["claim_lamport"] = None
        task["claim_ts"] = None
        task["rev"] = lamport
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
        micros.append(micro)
        task["microtasks"] = micros
        task["rev"] = lamport
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

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
        if assignee not in (None, agent):
            raise PlanError("claimed_by_other", "claimed")
        micro["state"] = op["state"]
        if "outcome" in op:
            micro["outcome"] = op["outcome"]
        if "took" in op:
            micro["took"] = op["took"]
        if "evidence" in op:
            micro["evidence"] = copy.deepcopy(op["evidence"])
        micro["rev"] = lamport
        task["rev"] = lamport
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
        mem[section] = {"id": section, "text": op["text"], "rev": lamport, "by": agent, "ts": ts}
        new["memory"] = mem
        result = {"kind": kind, "op_id": op_id}
        _recompute(new)

    else:
        raise PlanError("bad_op", "unknown kind")

    # Update last_lamport
    if lamport > new.get("last_lamport", 0):
        new["last_lamport"] = lamport
    # Cache replay result
    if op_id is not None:
        replay_key = json.dumps([agent, op_id], separators=(",", ":"))
        new["replayed_ops"][replay_key] = copy.deepcopy(result)
    return new, result


def fold_plan(events: Iterable[dict], *, templates: Mapping[str, dict] | None = None) -> dict:
    state = empty_projection()
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
            continue
        # eligible op event: attempt apply with prior activity snapshot
        op_obj = e.get("op")
        if isinstance(op_obj, dict) and isinstance(op_obj.get("op_id"), str):
            op_id_for_reject = op_obj.get("op_id")
        else:
            op_id_for_reject = None
        snapshot = dict(last_by_agent)
        try:
            state, _ = apply_op_event(state, e, templates=templates, last_by_agent=snapshot)
        except PlanError as ex:
            # Apply failed: record rejection, update last_lamport
            state["rejected"] = list(state.get("rejected", [])) + [{"id": e.get("id"), "lamport": e.get("lamport"), "op_id": op_id_for_reject, "code": ex.code}]
            if e.get("lamport") > state.get("last_lamport", 0):
                state["last_lamport"] = e.get("lamport")
        except Exception as ex:
            # Unexpected errors should still be bad_op? Treat as bad_op to keep fold fail-safe
            code = "bad_op"
            state["rejected"] = list(state.get("rejected", [])) + [{"id": e.get("id"), "lamport": e.get("lamport"), "op_id": op_id_for_reject, "code": code}]
            if e.get("lamport") > state.get("last_lamport", 0):
                state["last_lamport"] = e.get("lamport")
        _update_activity(e)

    # Ensure exact top-level keys
    final = PlanProjection(
        {
            "plan": state.get("plan"),
            "tasks": state.get("tasks", []),
            "memory": state.get("memory", {}),
            "archived_plans": state.get("archived_plans", []),
            "rollup": state.get("rollup"),
            "replayed_ops": state.get("replayed_ops", {}),
            "rejected": state.get("rejected", []),
            "last_lamport": state.get("last_lamport", 0),
        }
    )
    # Recompute to be safe (preserves derived)
    _recompute(final)
    # Keep rejected/last as computed (recompute doesn't touch them)
    return final
