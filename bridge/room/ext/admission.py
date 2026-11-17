"""Shared lifecycle admission and atomic legacy work-operation commits."""
import copy
import json
import os
import secrets

from bridge.room import store


def admit_work(args, projection):
    """Apply the work tools' terminal and registered-run identity contract."""
    record = projection.get("agent_lifecycle", {}).get(args["agent"])
    if record is None:
        return
    if record["lifecycle"] in ("failed", "finished"):
        raise store.RoomError("not_conformant", "terminal agent requires a fresh deployment with a new run_id")
    if "run_id" in args and args["run_id"] != record["run_id"]:
        raise store.RoomError("not_conformant", "run_id does not match the registered deployment")


def _assigns_work(op, agent):
    return (op.get("kind") == "task.claim"
            or (op.get("kind") == "micro.set" and op.get("state") in ("active", "done"))
            or (op.get("kind") == "task.set" and op.get("assignee") == agent))


def post(room, agent, op, *, expected_opened_lamport=store._UNFENCED):
    """Replay, admit and append under the lifecycle writer's journal lock.

    Single-operation posts have no locked admission callback. As with lifecycle
    commits, use the store's validation, replay, folding and durable append
    primitives directly for guarded operations. Other operations keep their
    existing store entry point.
    """
    if not _assigns_work(op, agent):
        return store.post(room, agent, "op", "", op=op,
                          expected_opened_lamport=expected_opened_lamport)
    store._validate_expected_opened_lamport(expected_opened_lamport)
    store._check_room(room)
    store._check_agent(agent)
    store._validate_op_static(op)
    op = copy.deepcopy(op)
    identity = op.get("op_id")
    request = {"act": "op", "text": "", "re": None, "to": None,
               "evidence": [], "op": op}
    if expected_opened_lamport is not store._UNFENCED:
        request["expected_opened_lamport"] = expected_opened_lamport
    digest = store._request_hash(request) if identity is not None else None
    ts = store._resolve_ts(None, True)
    try:
        rdir = store._ensure_dirs(None, room)
        path = os.path.join(rdir, "events.jsonl")
        lockfd = os.open(os.path.join(rdir, "events.lock"), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            try:
                os.chmod(os.path.join(rdir, "events.lock"), 0o600)
            except OSError:
                pass
            try:
                store._lock.lock_exclusive(lockfd)
            except TimeoutError as exc:
                raise store.RoomError("internal", "room lock timeout") from exc
            try:
                try:
                    with open(path, "rb") as stream:
                        data = stream.read()
                except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
                    data = b""
                events, _ = store._parse_events_bytes(data)
                store._check_plan_generation(events, expected_opened_lamport)
                if identity is not None:
                    matched = store._op_identity_index(events, agent, room).get(identity)
                    if matched is not None:
                        return store._single_replay(matched, digest)
                event = {"id": "e-" + secrets.token_hex(8),
                         "lamport": store._max_lamport_from_bytes(data) + 1,
                         "ts": ts, "room": room, "agent": agent,
                         "act": "op", "text": "", "op": op}
                if digest is not None:
                    event["request_sha256"] = digest
                templates = store._tpl_kw(needed=store._plan_template_ids(events))
                try:
                    projection = store.fold_plan(events, **templates)
                    admit_work({"agent": agent}, projection)
                    store.apply_op_event(projection, event,
                                         last_by_agent=store._op_max_activity(events), **templates)
                except store.RoomError:
                    raise
                except Exception as exc:
                    store._raise_op(exc)
                separator = b"\n" if data and not data.endswith(b"\n") else b""
                payload = separator + (json.dumps(event, sort_keys=True, separators=(",", ":"),
                                                  ensure_ascii=False) + "\n").encode("utf-8")
                if len(data) + len(payload) > store._journal_ceiling([event]):
                    raise store.RoomError("room_full", "room file cap exceeded")
                fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
                try:
                    try:
                        os.chmod(path, 0o600)
                    except OSError:
                        pass
                    store._write_all(fd, payload, len(data))
                finally:
                    os.close(fd)
                return event
            finally:
                try:
                    store._lock.unlock(lockfd)
                except OSError:
                    pass
        finally:
            os.close(lockfd)
    except OSError as exc:
        raise store.RoomError("internal", str(exc)) from exc
