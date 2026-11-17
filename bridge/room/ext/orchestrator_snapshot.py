"""Coherent, read-only orchestrator summaries with a compact JSON byte budget."""
import json
import math
import os
import stat

from bridge.plan.ops import check_arguments
from bridge.plan.fold import fold_plan
from bridge.room import store
from bridge.wall.emit import sanitize_output
from . import register
from .acquire import _select
from .admission import admit_work
from .inventory import SAFE_MAX, derive_inventory


_URGENCY = {"failed": 0, "blocked": 1, "stale": 2,
            "question": 3, "evidence_missing": 4}
_AGENT_FIELDS = ("agent", "state", "parent", "harness", "current", "last_seen_lamport")
_SECTIONS = ("completed_since", "available_work", "attention", "agents")


def _stamp(metadata):
    return (metadata.st_dev, metadata.st_ino, metadata.st_size,
            metadata.st_mtime_ns, metadata.st_ctime_ns)


def _capture(room):
    """Keep parse diagnostics and prove that this read names an existing file.

    The store's compatibility reader treats missing storage as empty. This
    stricter consumer must distinguish a proved empty journal from a failed
    read, and must not create either the journal or its lock file.
    """
    try:
        path = store._events_path(None, room)
        before = os.stat(path)
        if not stat.S_ISREG(before.st_mode):
            raise store.RoomError("snapshot_unavailable")
        with open(path, "rb") as stream:
            opened = os.fstat(stream.fileno())
            data = stream.read()
            after = os.fstat(stream.fileno())
        if not (_stamp(before) == _stamp(opened) == _stamp(after)
                == _stamp(os.stat(path))) or len(data) != after.st_size:
            raise store.RoomError("snapshot_unavailable")
        if data and not data.endswith(b"\n"):
            raise store.RoomError("snapshot_unavailable")
        events, malformed = store._parse_events_bytes(data)
        if malformed or any(e.get("room") != room for e in events):
            raise store.RoomError("snapshot_unavailable")
        ordered, seen = [], set()
        for event in sorted(events, key=lambda e: (e["lamport"], e["id"])):
            if event["id"] in seen:
                continue
            seen.add(event["id"])
            ordered.append(event)
        connected = all(e["lamport"] == index + 1 for index, e in enumerate(ordered))
        return ordered, connected
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise store.RoomError("snapshot_unavailable") from exc


def _entity(kind, generation, identity):
    return "%s:%s:%s" % (kind, generation, identity)


def _projection(events, templates):
    """Observe accepted transitions, including ones later undone or archived."""
    previous, completions = {}, []

    def observe(event, state, disposition):
        nonlocal previous
        generation = (state.get("plan") or {}).get("opened_lamport", 0)
        current = {}
        for task in state["tasks"]:
            entities = [("task", task)] + [("micro", micro) for micro in task["microtasks"]]
            for kind, entity in entities:
                key = _entity(kind, generation, entity["id"])
                current[key] = entity["state"]
                if entity["state"] == "done" and previous.get(key) != "done":
                    row = {"id": key, "lamport": event["lamport"],
                           "assignee": task["assignee"], "task_id": task["id"]}
                    if kind == "micro":
                        row["micro_id"] = entity["id"]
                    completions.append(row)
        previous = current

    projection = fold_plan(events, templates=templates, _observe=observe)
    completions.sort(key=lambda row: (row["lamport"], row["id"]))
    return projection, completions


def _attention(room, events, projection, inventory, templates):
    rows = []
    plan = projection.get("plan") or {}
    generation = plan.get("opened_lamport", 0)
    tasks = projection["tasks"]
    by_task = {task["id"]: task for task in tasks}

    for agent in inventory["agents"]:
        identity = agent["agent"]
        record = projection.get("agent_lifecycle", {}).get(identity, {})
        if agent["state"] == "failed":
            rows.append({"kind": "failed", "id": "failed:" + identity,
                         "agent": identity, "lamport": record["lamport"],
                         "detail": record.get("reason")})
        elif agent["state"] == "unknown" and agent["current"] is not None:
            rows.append({"kind": "stale", "id": "stale:" + identity,
                         "agent": identity, "lamport": agent["last_seen_lamport"],
                         **agent["current"]})

    template = templates.get(plan.get("template_id"), {})
    types = {definition["id"]: definition for definition in template.get("task_types", [])}
    for task in tasks:
        identity = _entity("task", generation, task["id"])
        if task["state"] not in ("done", "cancelled"):
            deps = [dep for dep in sorted(task["deps"])
                    if dep not in by_task or by_task[dep]["state"] not in ("done", "cancelled")]
            micros = [micro for micro in task["microtasks"] if micro["state"] == "blocked"]
            if task["state"] == "blocked" or deps:
                row = {"kind": "blocked", "id": "blocked:" + identity,
                       "task_id": task["id"], "assignee": task["assignee"],
                       "lamport": max([task["rev"]] + [by_task[d]["rev"] for d in deps if d in by_task]),
                       "blockers": [{"task_id": dep, "assignee": by_task.get(dep, {}).get("assignee")}
                                    for dep in deps]}
                if task.get("blocked_reason") is not None:
                    row["detail"] = task["blocked_reason"]
                if micros:
                    row["microtasks"] = [{"micro_id": micro["id"]}
                                         for micro in sorted(micros, key=lambda m: m["id"])]
                rows.append(row)
        if types.get(task["type"], {}).get("evidence_required") is True:
            for micro in task["microtasks"]:
                if micro["state"] == "done" and not micro.get("evidence"):
                    rows.append({"kind": "evidence_missing",
                                 "id": "evidence:" + _entity("micro", generation, micro["id"]),
                                 "task_id": task["id"], "micro_id": micro["id"],
                                 "assignee": task["assignee"], "lamport": micro["rev"]})

    # Resolve answers over this capture only; acknowledging is not answering.
    by_event = {event["id"]: event for event in events if event.get("room") == room}
    answered = {store._question_root(by_event, event.get("re"))
                for event in events if event.get("act") == "answer"}
    for event in events:
        if event.get("act") == "question" and event["id"] not in answered:
            rows.append({"kind": "question", "id": event["id"],
                         "agent": event["agent"], "to": event.get("to"),
                         "lamport": event["lamport"], "detail": event.get("text", "")})
    rows.sort(key=lambda row: (_URGENCY[row["kind"]], row["lamport"] is None,
                               row["lamport"], row["id"]))
    return rows


def _available(projection):
    if not projection.get("plan") or projection["plan"]["state"] != "active":
        return []
    rows = []
    for task in sorted(projection["tasks"], key=lambda task: task["id"]):
        owner = task["assignee"]
        # Use the acquisition tool's eligibility and lifecycle admission without
        # making a claim. An unassigned task can be taken by a new live agent.
        if _select([task], owner or "", None) is None:
            continue
        if owner is not None:
            try:
                admit_work({"agent": owner}, projection)
            except store.RoomError:
                continue
        rows.append({"task_id": task["id"], "assignee": owner,
                     "rev": task["rev"], "title": task["title"]})
    return rows


def _size(snapshot):
    return len(json.dumps({"untrusted": snapshot}, ensure_ascii=False,
                          sort_keys=True, separators=(",", ":"),
                          allow_nan=False).encode("utf-8"))


def _pack(snapshot, budget):
    """Drop whole tail rows in policy order; never shorten protected records."""
    for section in _SECTIONS:
        while _size(snapshot) > budget:
            rows = snapshot["agents"]["rows"] if section == "agents" else snapshot[section]
            if section == "agents":
                eligible = [index for index, row in enumerate(rows) if row["state"] == "finished"]
            elif section == "attention":
                eligible = [index for index, row in enumerate(rows)
                            if row["kind"] not in ("failed", "blocked")]
            else:
                eligible = list(range(len(rows)))
            if not eligible:
                break
            rows.pop(eligible[-1])
            snapshot["omitted"][section] += 1
            snapshot["complete"] = False
    if _size(snapshot) > budget:
        raise store.RoomError("budget_too_small")
    return snapshot


def orchestrator_snapshot(args):
    check_arguments(args, {"room", "now", "since", "max_bytes"}, ("room",), error=store.RoomError)
    room = args["room"]
    store._check_room(room)
    now = args["now"] if "now" in args else int(store.time.time() * 1000)
    if (type(now) not in (int, float) or not 0 <= now <= SAFE_MAX
            or not math.isfinite(now)):
        raise store.RoomError("bad_args", "now must be finite epoch milliseconds in 0-9007199254740991")
    since = args.get("since", 0)
    if type(since) is not int or not 0 <= since <= SAFE_MAX:
        raise store.RoomError("bad_args", "since must be an integer in 0-9007199254740991")
    budget = args.get("max_bytes", 16384)
    if type(budget) is not int or not 1024 <= budget <= 65536:
        raise store.RoomError("bad_args", "max_bytes must be an integer in 1024-65536")

    events, connected = _capture(room)
    head = max((event["lamport"] for event in events), default=0)
    if since > head:
        raise store.RoomError("bad_args", "since must not exceed the current room head Lamport cursor")
    try:
        templates = store._tpl_kw(needed=store._plan_template_ids(events), strict=True)["templates"]
        projection, completions = _projection(events, templates)
        inventory = derive_inventory(room, events, now, templates=templates, connected=connected)
        attention = _attention(room, events, projection, inventory, templates)
        if "since" in args:
            prefix = [event for event in events if event["lamport"] <= since]
            prior = fold_plan(prefix, templates=templates)
            prefix_connected = all(event["lamport"] == index + 1
                                   for index, event in enumerate(prefix))
            old_inventory = derive_inventory(room, prefix, now, templates=templates,
                                             connected=prefix_connected)
            old = {row["id"]: row for row in _attention(room, prefix, prior, old_inventory, templates)}
            attention = [row for row in attention if old.get(row["id"]) != row]
        snapshot = {
            "room": room, "head_lamport": head, "generated_at": now,
            "freshness": "stale" if not connected or inventory["totals"]["unknown"] else "current",
            "complete": connected,
            "agents": {"totals": inventory["totals"],
                       "rows": [{field: agent[field] for field in _AGENT_FIELDS}
                                for agent in inventory["agents"]]},
            "attention": attention, "available_work": _available(projection),
            "completed_since": [row for row in completions if row["lamport"] > since],
            "omitted": {section: 0 for section in _SECTIONS}, "cursor": head,
        }
    except store.RoomError:
        raise store.RoomError("snapshot_unavailable") from None
    except (ValueError, TypeError, KeyError, OSError, RecursionError) as exc:
        raise store.RoomError("snapshot_unavailable") from exc
    try:
        snapshot = sanitize_output(snapshot)
    except Exception:
        # The adapters' generic error path emits a constant safe payload. A
        # domain error would ask them to sanitize its details a second time.
        raise RuntimeError("redaction_failed") from None
    return _pack(snapshot, budget)


register({
    "name": "orchestrator_snapshot",
    "description": "Read current agents, attention, available work and accepted completions in one byte-bounded snapshot.",
    "inputSchema": {"type": "object", "properties": {
        "room": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,47}$"},
        "now": {"type": "number", "minimum": 0, "maximum": SAFE_MAX},
        "since": {"type": "integer", "minimum": 0, "maximum": SAFE_MAX},
        "max_bytes": {"type": "integer", "minimum": 1024, "maximum": 65536, "default": 16384},
    }, "required": ["room"], "additionalProperties": False},
}, orchestrator_snapshot)
