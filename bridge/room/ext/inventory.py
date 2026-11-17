"""Read-only agent inventory, independent of the presence of a plan."""
import math
import re

from bridge.plan.fold import fold_plan
from bridge.plan.limits import AGENT_RE
from bridge.room import store
from . import register

FRESHNESS_MS = 90_000
STATES = ("working", "waiting", "idle", "registered", "finished", "failed", "unknown")
RUN_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
SAFE_MAX = 2**53 - 1


def _number(value):
    return (type(value) in (int, float) and math.isfinite(value)
            and 0 <= value <= SAFE_MAX)


def _finished(task):
    return task["state"] in ("done", "cancelled")


def _valid_live(live, agent, run_id, now):
    return (isinstance(live, dict) and live.get("agent") == agent
            and isinstance(live.get("run_id"), str)
            and RUN_RE.fullmatch(live["run_id"]) is not None
            and (run_id is None or live["run_id"] == run_id)
            and _number(live.get("beat_ts")) and live["beat_ts"] <= now
            and type(live.get("beat_lamport")) is int
            and 0 < live["beat_lamport"] <= SAFE_MAX)


def derive_inventory(room, events, now, *, templates=None, connected=True):
    """Replay once, observing effective evidence without persisting a registry.

    Observing each commit distinguishes accepted beats from successful no-ops,
    including after later releases, completions, or deployments erase live data.
    """
    seen_ids = set()
    ordered = []
    candidates = [event for event in events if event.get("room") == room
                  and isinstance(event.get("id"), str)
                  and type(event.get("lamport")) is int
                  and 0 < event["lamport"] <= SAFE_MAX]
    for event in sorted(candidates, key=lambda e: (e["lamport"], e["id"])):
        if event["id"] not in seen_ids:
            seen_ids.add(event["id"])
            ordered.append(event)
    synced = connected and all(e["lamport"] == i + 1 for i, e in enumerate(ordered))
    first, last, deployments, beats, results = {}, {}, {}, {}, {}

    def member(agent, lamport):
        if isinstance(agent, str) and AGENT_RE.fullmatch(agent) is not None:
            first.setdefault(agent, lamport)

    def observe(event, state, disposition):
        agent, lamport = event.get("agent"), event["lamport"]
        # A-C2a: only folded lifecycle records and current/past assignees
        # establish membership. Observe assignments before releases erase them.
        for registered in state.get("agent_lifecycle", {}):
            member(registered, lamport)
        for task in state["tasks"]:
            member(task.get("assignee"), lamport)
        if not isinstance(agent, str) or AGENT_RE.fullmatch(agent) is None:
            return
        op = event.get("op") if isinstance(event.get("op"), dict) else {}  # C2q: null/non-object op never crashes
        if disposition and (disposition.get("replayed") or disposition.get("noop")
                            or disposition.get("ignored")):
            return
        if op.get("kind") == "activity.beat":
            if not any(micro.get("live", {}).get("beat_lamport") == lamport
                       and micro["live"].get("agent") == agent
                       for task in state["tasks"] for micro in task["microtasks"]):
                return
            beats[agent] = {"run_id": op["run_id"], "ts": event["ts"]}
        if op.get("kind") == "agent.lifecycle" and op["state"] == "deployed":
            deployments[agent] = lamport
        if op.get("kind") == "agent.lifecycle":
            if op["state"] == "deployed":
                results.pop(agent, None)
            elif op["state"] in ("finished", "failed") and "result" in op:
                results[agent] = (op["run_id"], op["result"])
        last[agent] = (lamport, event.get("ts"))

    projection = fold_plan(ordered, templates=templates, _observe=observe)
    records = projection.get("agent_lifecycle", {})
    tasks = projection["tasks"]
    by_id = {task["id"]: task for task in tasks}
    for agent, record in records.items():
        member(agent, record.get("lamport", SAFE_MAX))
    for task in tasks:
        member(task.get("assignee"), SAFE_MAX)

    def fresh(ts):
        return _number(ts) and 0 <= now - ts <= FRESHNESS_MS

    rows = {}
    for agent in first:
        record = records.get(agent, {})
        run_id = record.get("run_id", beats.get(agent, {}).get("run_id"))
        owned = sorted((task for task in tasks if task["assignee"] == agent), key=lambda t: t["id"])
        unfinished = [task for task in owned if not _finished(task)]
        selected = next((task for task in unfinished
                         if any(m["state"] == "active" for m in task["microtasks"])),
                        unfinished[0] if unfinished else None)
        active = next((m for m in sorted(selected["microtasks"], key=lambda m: m["id"])
                       if m["state"] == "active"), None) if selected else None
        lives = [m["live"] for task in unfinished for m in task["microtasks"]
                 if m["state"] == "active" and _valid_live(m.get("live"), agent, run_id, now)]
        latest_beat = max(lives, key=lambda live: live["beat_lamport"], default=None)
        if run_id is None and latest_beat is not None:
            run_id = latest_beat["run_id"]
        beat_fresh = any(live["run_id"] == run_id and fresh(live["beat_ts"]) for live in lives)
        alive_beat = beats.get(agent, {})
        alive_fresh = alive_beat.get("run_id") == run_id and fresh(alive_beat.get("ts"))
        lamport, ts = last.get(agent, (record.get("lamport"), record.get("ts")))
        blocked = any(any(dep not in by_id or not _finished(by_id[dep]) for dep in task["deps"])
                      for task in unfinished)
        deployed_at = deployments.get(agent, record.get("lamport", SAFE_MAX))
        new_work = any(max([task["rev"], task.get("claim_lamport") or 0]
                           + [m["rev"] for m in task["microtasks"]]) > deployed_at
                       for task in unfinished)
        lifecycle = record.get("lifecycle")
        if lifecycle in ("finished", "failed"):
            state = lifecycle
        elif (not synced or run_id is None or not fresh(ts)
              or not (fresh(record.get("ts")) or alive_fresh)):
            state = "unknown"
        elif lifecycle == "deployed" and not new_work and not alive_fresh:
            state = "registered"
        elif blocked:
            state = "waiting"
        elif beat_fresh:
            state = "working"
        elif any(task["state"] == "active" for task in unfinished):
            state = "unknown"
        elif lifecycle == "alive" or alive_fresh:
            state = "idle"
        elif lifecycle == "deployed":
            state = "registered"
        else:
            state = "unknown"
        result_run, result = results.get(agent, (None, None))
        # C6q: A-C6b makes summary and receipt optional.
        summary = result.get("summary") if result is not None else None
        last_result = ({"verdict": result["verdict"],
                        "summary": summary[:200] if isinstance(summary, str) else None,
                        "receipt": result.get("receipt")}
                       if result is not None and result_run == run_id else None)
        rows[agent] = {
            "agent": agent, "state": state, "run_id": run_id,
            "harness": record.get("harness"), "last_result": last_result,
            "parent": ({"agent": record["parent_agent"], "run_id": record.get("parent_run_id")}
                       if "parent_agent" in record else None),
            "children": [], "last_seen_lamport": lamport, "last_seen_ts": ts,
            "current": ({"task_id": selected["id"], "micro_id": active["id"] if active else None}
                        if selected else None),
            "counts": {"tasks_owned": len(owned),
                       "micros_done": sum(m["state"] == "done" for t in owned for m in t["microtasks"]),
                       "micros_total": sum(len(t["microtasks"]) for t in owned)},
        }
    for agent, row in rows.items():
        parent = row["parent"]
        if parent is not None and parent["agent"] in rows:
            rows[parent["agent"]]["children"].append(agent)
    for row in rows.values():
        row["children"].sort()
    order = lambda agent: (first[agent], agent)
    roots = sorted((agent for agent, row in rows.items()
                    if row["parent"] is None or row["parent"]["agent"] not in rows), key=order)
    agents, visited = [], set()
    # Iteration bounds nesting independently of the interpreter's recursion cap.
    stack = list(reversed(roots))
    while stack:
        agent = stack.pop()
        if agent in visited:
            continue
        visited.add(agent)
        agents.append(rows[agent])
        stack.extend(reversed(sorted(rows[agent]["children"], key=order)))
    # A malformed compatibility projection must not hide members in a cycle.
    agents.extend(rows[a] for a in sorted(rows, key=order) if a not in visited)
    totals = {state: sum(row["state"] == state for row in agents) for state in STATES}
    totals["total"] = len(agents)
    return {"agents": agents, "totals": totals}


def agents_list(args):
    if (not isinstance(args, dict) or "room" not in args
            or set(args) - {"room", "now"}):
        raise store.RoomError("bad_args", "room and optional now required")
    store._check_room(args["room"])
    now = args.get("now", store.time.time() * 1000)
    if not _number(now):
        raise store.RoomError("bad_args", "now must be finite nonnegative epoch milliseconds")
    events, malformed = store.read(args["room"])
    return derive_inventory(args["room"], events, now, connected=not malformed,
                            **store._tpl_kw(needed=store._plan_template_ids(events)))


register({
    "name": "agents_list",
    "description": "List all room agents, their parent tree, current work and explicit freshness states.",
    "inputSchema": {"type": "object", "properties": {
        "room": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,47}$"},
        "now": {"type": "number", "minimum": 0, "maximum": SAFE_MAX},
    }, "required": ["room"], "additionalProperties": False},
}, agents_list)
