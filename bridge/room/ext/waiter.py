"""Stateless lifecycle waits over the journal's caller-owned Lamport cursor."""
import math
import time

from bridge.plan.ops import check_arguments
from bridge.plan.fold import fold_plan
from bridge.plan.ops import LIFECYCLE_STATES
from bridge.room import store
from bridge.wall.emit import sanitize_output
from . import register

SAFE_MAX = 2**53 - 1


def _matches(room, events, since, agents, parent, states):
    rows = []

    def observe(event, projection, disposition):
        op = event.get("op")
        if (not isinstance(op, dict) or op.get("kind") != "agent.lifecycle"
                or event.get("room") != room or event["lamport"] <= since
                or op["state"] not in states
                or not disposition or disposition.get("noop") or disposition.get("replayed")
                or disposition.get("ignored")
                or (agents is not None and event["agent"] not in agents)):
            return
        record = projection.get("agent_lifecycle", {}).get(event["agent"], {})
        if parent is not None and record.get("parent_agent") != parent:
            return
        row = {"agent": event["agent"], "run_id": op["run_id"], "state": op["state"],
               "parent": ({"agent": record["parent_agent"], "run_id": record.get("parent_run_id")}
                          if "parent_agent" in record else None),
               "lamport": event["lamport"]}
        if "result" in op:
            row["result"] = op["result"]
        rows.append(row)

    fold_plan(events, _observe=observe,
              **store._tpl_kw(needed=store._plan_template_ids(events)))
    return sorted(rows, key=lambda row: row["lamport"])


def wait_agents(args):
    allowed = {"room", "agents", "parent", "states", "since_lamport", "timeout_s"}
    check_arguments(args, allowed, ("room",), error=store.RoomError)
    room = args["room"]
    store._check_room(room)
    agents = None
    if "agents" in args:
        if not isinstance(args["agents"], list) or not args["agents"]:
            raise store.RoomError("bad_args", "agents must be a nonempty array of agent slugs")
        for agent in args["agents"]:
            try:
                store._check_agent(agent)
            except store.RoomError:
                raise store.RoomError("bad_args", "agents entries must be 1-48 chars of a-z 0-9 . _ -; first char a-z or 0-9") from None
        agents = set(args["agents"])
    parent = args.get("parent")
    if "parent" in args:
        try:
            store._check_agent(parent)
        except store.RoomError:
            raise store.RoomError("bad_args", "parent must be 1-48 chars of a-z 0-9 . _ -; first char a-z or 0-9") from None
    states = args.get("states", ["finished", "failed"])
    if (not isinstance(states, list) or not states
            or any(not isinstance(state, str) or state not in LIFECYCLE_STATES for state in states)):
        raise store.RoomError("bad_args", "states must be a nonempty array containing only deployed, alive, finished or failed")
    states = set(states)
    since = args.get("since_lamport", 0)
    if type(since) is not int or not 0 <= since <= SAFE_MAX:
        raise store.RoomError("bad_args", "since_lamport must be an integer in 0-9007199254740991")
    timeout = args.get("timeout_s", 60)
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 1 <= timeout <= 600:
        raise store.RoomError("bad_args", "timeout_s must be a finite number in 1-600 seconds")

    deadline = time.monotonic() + timeout
    version = object()
    cursor = since
    while True:
        stamp = store._journal_stamp(None, room)
        if stamp != version:
            events, malformed = store.read(room)
            if malformed:
                raise store.RoomError("internal", "lifecycle journal is malformed")
            cursor = max([since] + [event["lamport"] for event in events])
            rows = _matches(room, events, since, agents, parent, states)
            version = stamp
            if rows:
                output = {"events": rows, "cursor": cursor}
                break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            output = {"events": [], "cursor": cursor, "timed_out": True}
            break
        time.sleep(min(0.1, remaining))
    try:
        return sanitize_output(output)
    except Exception:
        raise RuntimeError("redaction_failed") from None


register({
    "name": "wait_agents",
    "description": "Wait for every matching lifecycle event after a caller-owned Lamport cursor.",
    "inputSchema": {"type": "object", "additionalProperties": False, "required": ["room"],
        "properties": {
            "room": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,47}$"},
            "agents": {"type": "array", "minItems": 1, "items": {
                "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,47}$"}},
            "parent": {"type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,47}$"},
            "states": {"type": "array", "minItems": 1, "items": {"type": "string", "enum": sorted(LIFECYCLE_STATES)},
                       "default": ["finished", "failed"]},
            "since_lamport": {"type": "integer", "minimum": 0, "maximum": SAFE_MAX, "default": 0},
            "timeout_s": {"type": "number", "minimum": 1, "maximum": 600, "default": 60},
        }},
}, wait_agents)
