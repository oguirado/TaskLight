"""Stateless lifecycle waits over the journal's caller-owned Lamport cursor."""
import hashlib
import io
import math
import os
import stat
import time

from bridge.plan.ops import check_arguments
from bridge.plan.fold import fold_plan
from bridge.plan.ops import LIFECYCLE_STATES
from bridge.room import store
from bridge.wall.emit import sanitize_output
from . import register

SAFE_MAX = 2**53 - 1
_READ_FAILED = "Room data could not be read."
_HASH_BLOCK_BYTES = 256 * 1024


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


def _template_stamp():
    # Track both tiers in the loader's resolution order. Directory identities
    # catch additions and replacements, and file ctimes catch in-place edits.
    project = os.path.dirname(os.path.dirname(os.path.abspath(store.__file__)))
    directories = (os.path.join(project, "templates", "planning"),
                   os.path.join(store._home(None), "templates"))
    entries = []
    try:
        for directory in directories:
            try:
                identity = store._view_metadata(os.stat(directory))
            except FileNotFoundError:
                entries.append(None)
                continue
            entries.append(identity)
            with os.scandir(directory) as listing:
                files = sorted((entry for entry in listing if entry.name.endswith(".json")),
                               key=lambda entry: entry.name)
                entries.extend((entry.name, store._view_metadata(entry.stat())) for entry in files)
    except OSError:
        return None
    return tuple(entries)


def _heartbeat_growth(stream, room, size, old_size, prefix_digest, cursor):
    # Probe the suffix first. Any relevant or invalid row takes the full
    # checked path without an unnecessary read of the old prefix.
    stream.seek(old_size)
    suffix = stream.read(size - old_size)
    if len(suffix) != size - old_size or not suffix.endswith(b"\n"):
        return None
    for raw in io.BytesIO(suffix):
        if not raw.strip():
            continue
        event = store._decode_event_line(raw[:-1])
        # Later heartbeats cannot change an earlier disposition. A full
        # replay still sees them in physical order, including duplicates.
        if (event is None or event["room"] != room or event["act"] != "heartbeat"
                or event["lamport"] <= cursor):
            return None
        cursor = event["lamport"]

    stream.seek(0)
    digest = hashlib.sha256()
    buffer = memoryview(bytearray(min(old_size, _HASH_BLOCK_BYTES)))
    remaining = old_size
    while remaining:
        count = stream.readinto(buffer[:remaining])
        if not count:
            return None
        digest.update(buffer[:count])
        remaining -= count
    if digest.digest() != prefix_digest:
        return None
    digest.update(suffix)
    return digest.digest(), cursor


def _checked_snapshot(stream, room, size):
    """Validate a bounded capture with the store's committed-line rules."""
    events = []
    digest = hashlib.sha256()
    invalid = False
    while size:
        raw = stream.readline(size)
        if not raw:
            return None
        size -= len(raw)
        if not raw.endswith(b"\n"):
            # A torn tail is uncommitted, but cannot seed a growth proof.
            return (events, None, invalid) if not size else None
        digest.update(raw)
        if not raw.strip():
            continue
        event = store._decode_event_line(raw[:-1])
        if event is None or event["room"] != room:
            invalid = True
        elif event["lamport"] > 0:
            events.append(event)
    return events, digest.digest(), invalid


def _read_journal_suffix(stamp, previous, prefix_digest, cursor):
    """Read a stable full capture or prove ordered heartbeat-only growth."""
    home, room, metadata = stamp
    if metadata is None or metadata[2] > store.CAP:
        return None
    size = metadata[2]

    def open_readonly(path, flags):
        return os.open(path, flags | getattr(os, "O_NONBLOCK", 0))

    try:
        with open(store._events_path(home, room), "rb",
                  buffering=_HASH_BLOCK_BYTES, opener=open_readonly) as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or store._view_metadata(before) != metadata:
                return None
            growth = capture = None
            if prefix_digest is not None:
                old = previous[2]
                if stamp[:2] == previous[:2] and metadata[:2] == old[:2] and size > old[2]:
                    growth = _heartbeat_growth(stream, room, size, old[2], prefix_digest, cursor)
            if growth is None:
                stream.seek(0)
                capture = _checked_snapshot(stream, room, size)
                if capture is None:
                    return None
            if store._view_metadata(os.fstat(stream.fileno())) != metadata:
                return None
        if store._journal_stamp(None, room) == stamp:
            if capture is not None and capture[2]:
                raise store.RoomError("room_read_failed", _READ_FAILED)
            return capture, growth
    except OSError:
        pass
    return None


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
    template_version = None
    prefix_digest = validation_version = None
    cursor = since
    room_seen = False
    while True:
        stamp = templates = None
        if store._room_directory_exists(None, room):
            room_seen = True
            try:
                stamp = store._journal_stamp(None, room)
            except OSError:
                raise store.RoomError("room_read_failed", _READ_FAILED) from None
            templates = _template_stamp()
        elif room_seen:
            raise store.RoomError("room_read_failed", _READ_FAILED)

        templates_unchanged = templates is not None and templates == template_version
        rules = store._checked_validation_rules() if stamp is not None else None
        rules_unchanged = rules == validation_version
        # A missing journal stamp for an existing room still needs a checked read.
        if stamp != version or (stamp is not None and
                                (stamp[2] is None or not templates_unchanged or not rules_unchanged)):
            capture = growth = None
            if templates is not None:
                proof = prefix_digest if templates_unchanged and rules_unchanged else None
                capture, growth = _read_journal_suffix(stamp, version, proof, cursor) or (None, None)
            if (growth is not None and _template_stamp() == templates
                    and store._checked_validation_rules() == rules):
                prefix_digest, cursor = growth
            else:
                digest = None
                if capture is not None:
                    events, digest, _ = capture
                    del capture
                else:
                    events, _ = store.read_checked(room) if room_seen else ([], 0)
                cursor = max((event["lamport"] for event in events), default=0)
                if since > cursor:
                    error = store.RoomError("bad_args")
                    # Both adapters use the exception text as the detail field.
                    error.args = (f"since_lamport is ahead of the room head ({cursor})",)
                    raise error
                rows = _matches(room, events, since, agents, parent, states) if room_seen else []
                del events
                if rows:
                    output = {"events": rows, "cursor": cursor}
                    break
                if templates is not None and _template_stamp() != templates:
                    templates = None
                prefix_digest = (digest if templates is not None
                                 and store._checked_validation_rules() == rules else None)
            version = stamp
            template_version = templates
            validation_version = rules
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
