"""U94: room export and memory history tools plus fd-safe file exporter."""
import errno
import json
import os
import secrets
import stat
from bridge.plan.ops import check_arguments
from collections import deque
from contextlib import contextmanager

from bridge.plan.fold import fold_plan
from bridge.plan.markdown import render_memory_md, render_plan_md
from bridge.room import store
from bridge.room.ext import register
from bridge.wall.emit import sanitize_output

_EXPORT_ALLOWED = {"room", "agent", "what", "opened_lamport"}
_HISTORY_ALLOWED = {"room", "agent", "section", "limit"}
_OUTPUTS = ("PLAN.md", "MEMORY.md")


def _bad(message):
    raise store.RoomError("bad_args", message)


def _check_keys(args, allowed, required):
    if not isinstance(args, dict):
        _bad("args must be object")
    for key in required:
        if key not in args:
            _bad("%s is required" % key)
    check_arguments(args, allowed, error=store.RoomError)


def _check_room_agent(args):
    store._check_room(args.get("room"))
    store._check_agent(args.get("agent"))


def _legacy_result_event(event):
    # Read compatibility is confined to an export snapshot; neither admission
    # nor the owner journal changes when an old optional summary is discarded.
    op = event.get("op") if isinstance(event, dict) else None
    result = op.get("result") if isinstance(op, dict) else None
    if (isinstance(op, dict) and op.get("kind") == "agent.lifecycle"
            and op.get("state") in ("finished", "failed")
            and isinstance(result, dict) and "summary" in result
            and not isinstance(result["summary"], str)):
        result = {key: value for key, value in result.items() if key != "summary"}
        return {**event, "op": {**op, "result": result}}
    return event


def _read_snapshot(room, *, legacy_results=False):
    try:
        events, malformed = store.read(room)
        if not (legacy_results and malformed):
            return events, events
        # Revalidate legacy summaries while retaining the other validation
        # and torn-tail rules. Render all CLI outputs from the same bytes.
        with open(store._events_path(None, room), "rb") as stream:
            data = stream.read()
        events, _ = store._parse_events_bytes(data)
        compatible = []
        for raw in data.split(b"\n")[:-1]:
            try:
                event = _legacy_result_event(json.loads(raw.decode("utf-8")))
            except (UnicodeError, ValueError, RecursionError):
                continue
            if isinstance(event, dict) and store._is_valid_event(event):
                compatible.append(event)
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
        return [], []
    except OSError as exc:
        _fail(exc)
    return events, compatible


def _read_events(room, *, legacy_results=False):
    return _read_snapshot(room, legacy_results=legacy_results)[1]


def _integration(events, opened_lamport=None):
    compatible = [_legacy_result_event(event) for event in events]
    rows = []
    deployments = {}

    def observe(event, state, disposition):
        if (event.get("act") != "op" or disposition is None
                or any(disposition.get(key) for key in ("replayed", "noop", "ignored"))):
            return
        op = event["op"]
        plan = state.get("plan")
        opening = plan["opened_lamport"] if plan else None
        if op["kind"] == "agent.lifecycle":
            run = (event["agent"], op["run_id"])
            if op["state"] == "deployed":
                if opened_lamport is not None:
                    deployments[run] = opening
                return
            if op["state"] not in ("finished", "failed") or "result" not in op:
                return
            if opened_lamport is not None and (opening != opened_lamport
                                                or deployments.get(run) != opened_lamport):
                return
            result = op["result"]
            rows.append({"kind": "Result", "lamport": event["lamport"],
                         "agent": event["agent"], "run_id": op["run_id"], "state": op["state"],
                         "verdict": result["verdict"],
                         "summary": result.get("summary") if isinstance(result.get("summary"), str) else "",
                         "receipt": result.get("receipt", "")})
        elif op["kind"] == "unit.decision":
            if opened_lamport is not None and opening != opened_lamport:
                return
            task = next(task for task in state["tasks"] if task["id"] == op["task_id"])
            micro = next((m["text"] for m in task["microtasks"] if m["id"] == op.get("micro_id")), "")
            rows.append({"kind": "Decision", "lamport": event["lamport"],
                         "title": task["title"], "micro": micro, "verdict": op["verdict"],
                         "reason": op["reason"], "evidence_count": len(op.get("evidence", [])),
                         "agent": op.get("result_agent", op.get("agent", "")),
                         "run_id": op.get("result_run_id", op.get("run_id", ""))})

    projection = fold_plan(compatible, _observe=observe)
    # Sanitize structured fields before Markdown assembly so protocol pointers
    # keep the same treatment as lifecycle results. Failures propagate here,
    # outside the fold observer's rejection handling.
    rows = sanitize_output(rows)
    lines = ["# Integration log", ""]
    for row in rows:
        # Redact complete fields before truncation can hide a secret suffix.
        if row["kind"] == "Result":
            row["summary"] = row["summary"][:200]
        # Each admitted record occupies one line with escaped cell delimiters.
        values = (" ".join(str(value).splitlines()).replace("\\", "\\\\").replace("|", "\\|")
                  for value in row.values())
        lines.append("- " + " | ".join(values))
    if not rows:
        lines.append("No results or decisions yet.")
    return {"format": "markdown", "text": "\n".join(lines) + "\n",
            "rev": projection["last_lamport"]}


def room_export(args: dict) -> dict:
    if isinstance(args, dict):
        for key in ("room", "agent", "what"):
            if key not in args:
                _bad("%s is required" % key)
        _check_room_agent(args)
    _check_keys(args, _EXPORT_ALLOWED, ("room", "agent", "what"))
    what = args["what"]
    if what not in ("plan", "memory", "integration"):
        _bad("what must be plan, memory or integration")
    opened_lamport = args.get("opened_lamport")
    if "opened_lamport" in args:
        if type(opened_lamport) is not int:
            _bad("opened_lamport must be an integer")
        if what != "integration":
            _bad("opened_lamport requires what=integration")
    events = _read_events(args["room"], legacy_results=what == "integration")
    if what == "integration":
        return _integration(events, opened_lamport)
    projection = sanitize_output(fold_plan(events))
    if what == "plan":
        text = render_plan_md(projection)
    else:
        text = render_memory_md(projection)
    return {"format": "markdown", "text": text, "rev": projection["last_lamport"]}


def _history_versions(events, section, limit):
    # Fold once to establish canonical rejection decisions. Event identity,
    # rather than a section's final revision, determines accepted metadata.
    projection = fold_plan(events)
    rejected = {entry["id"] for entry in projection["rejected"]}
    ordered = sorted(
        (e for e in events if isinstance(e, dict)
         and isinstance(e.get("id"), str)
         and isinstance(e.get("lamport"), int)
         and not isinstance(e.get("lamport"), bool)
         # No accepted op can lie beyond the canonical fold's last Lamport.
         and 1 <= e["lamport"] <= projection["last_lamport"]),
        key=lambda e: (e["lamport"], e["id"]),
    )
    seen_ids = set()
    seen_ops = set()
    versions = deque(maxlen=limit)
    for event in ordered:
        eid = event["id"]
        if eid in seen_ids:
            continue
        seen_ids.add(eid)
        if eid in rejected or event.get("act") != "op":
            continue
        op = event["op"]
        op_id = op.get("op_id")
        if op_id is not None:
            replay_key = (event["agent"], op_id)
            if replay_key in seen_ops:
                continue
            seen_ops.add(replay_key)
        if op["kind"] == "memory.set" and op["section"] == section:
            versions.append({"rev": event["lamport"], "by": event["agent"],
                             "ts": event["ts"], "text": op["text"]})
    return list(reversed(versions))


def memory_history(args: dict) -> dict:
    if isinstance(args, dict):
        for key in ("room", "agent", "section"):
            if key not in args:
                _bad("%s is required" % key)
        _check_room_agent(args)
    _check_keys(args, _HISTORY_ALLOWED, ("room", "agent", "section"))
    section = args["section"]
    if not isinstance(section, str) or store.ROOM_RE.fullmatch(section) is None:
        _bad("section must be 1-48 chars of a-z 0-9 -; first char a-z or 0-9")
    if "limit" in args:
        limit = args["limit"]
        if isinstance(limit, bool) or not isinstance(limit, int) or not (1 <= limit <= 500):
            _bad("limit must be an integer in 1-500")
    else:
        limit = 100
    events = _read_events(args["room"])
    versions = _history_versions(events, section, limit)
    return {"section": section, "versions": versions}


def _segments_for_out(out, canonical):
    if not isinstance(out, str):
        _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
    if out == "" or "\x00" in out:
        _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
    if ".." in out.split("/"):
        _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
    if os.path.isabs(out):
        norm = os.path.normpath(out)
        try:
            common = os.path.commonpath([canonical, norm])
        except ValueError:
            _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
        if common != canonical:
            _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
        rel = os.path.relpath(norm, canonical)
        if rel == ".":
            return []
        if rel.startswith(".." + os.sep) or rel == "..":
            _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
        return rel.split(os.sep)
    norm = os.path.normpath(out)
    if norm == ".":
        return []
    if norm == ".." or norm.startswith(".." + os.sep):
        _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
    joined = os.path.normpath(os.path.join(canonical, norm))
    try:
        common = os.path.commonpath([canonical, joined])
    except ValueError:
        _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
    if common != canonical:
        _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
    return norm.split(os.sep)


def _is_path_error(exc):
    return isinstance(exc, OSError) and exc.errno in (errno.ELOOP, errno.ENOTDIR, errno.EINVAL)


def _fail(exc, code="export_failed"):
    raise store.RoomError(code, str(exc))


@contextmanager
def _closing(fd):
    """Report successful-path close failures without masking earlier errors."""
    try:
        yield fd
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    else:
        try:
            os.close(fd)
        except OSError as exc:
            _fail(exc)


def _open_dir(name, parent_fd, create):
    try:
        return os.open(name, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY, dir_fd=parent_fd)
    except FileNotFoundError:
        if not create:
            raise
    except OSError as exc:
        if _is_path_error(exc):
            _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
        _fail(exc)
    try:
        os.mkdir(name, 0o755, dir_fd=parent_fd)
    except FileExistsError:
        pass
    except OSError as exc:
        if _is_path_error(exc):
            _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
        _fail(exc)
    try:
        return os.open(name, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY, dir_fd=parent_fd)
    except OSError as exc:
        if _is_path_error(exc):
            _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
        _fail(exc)


def _stat_output(name, dir_fd):
    try:
        result = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError as exc:
        if _is_path_error(exc):
            _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
        _fail(exc)
    if stat.S_ISLNK(result.st_mode) or not stat.S_ISREG(result.st_mode):
        _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
    return result


def _read_output(name, dir_fd):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=dir_fd)
    except FileNotFoundError:
        return None
    except OSError as exc:
        if _is_path_error(exc):
            _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
        _fail(exc)
    try:
        with _closing(fd):
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
            chunks = []
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                chunks.append(chunk)
            return b"".join(chunks)
    except OSError as exc:
        _fail(exc)


def _stage(dir_fd, data):
    for _attempt in range(5):
        name = ".u94-%s.tmp" % secrets.token_hex(4)
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dir_fd)
        except FileExistsError:
            continue
        except OSError as exc:
            _fail(exc)
        try:
            with _closing(fd):
                view = memoryview(data)
                while view:
                    written = os.write(fd, view)
                    if written <= 0:
                        raise OSError(errno.EIO, "short write")
                    view = view[written:]
                os.fsync(fd)
        except BaseException as exc:
            try:
                os.unlink(name, dir_fd=dir_fd)
            except OSError:
                pass
            if isinstance(exc, OSError):
                _fail(exc)
            raise
        return name
    _fail(OSError(errno.EEXIST, "cannot stage"))


def export_room(room: str, out: str, *, include_integration=False) -> dict:
    store._check_room(room)
    canonical = os.path.realpath(store._home(None))
    segments = _segments_for_out(out, canonical)
    events, integration_events = _read_snapshot(room, legacy_results=include_integration)
    # Sanitize the complete snapshot before rendering or staging outputs.
    projection = sanitize_output(fold_plan(events))
    texts = {
        "PLAN.md": render_plan_md(projection).encode("utf-8"),
        "MEMORY.md": render_memory_md(projection).encode("utf-8"),
    }
    outputs = _OUTPUTS
    if include_integration:
        texts["INTEGRATION.md"] = _integration(integration_events)["text"].encode("utf-8")
        outputs += ("INTEGRATION.md",)
    fds = []
    staged = {}
    close_error = None
    try:
        if not os.path.isdir(canonical):
            try:
                os.makedirs(canonical, exist_ok=True)
            except OSError as exc:
                _fail(exc)
        try:
            home_fd = os.open(canonical, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY)
        except OSError as exc:
            if _is_path_error(exc):
                _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
            _fail(exc)
        fds.append(home_fd)
        current = home_fd
        for segment in segments:
            if segment in ("", "."):
                continue
            if segment == "..":
                _bad("out must name a directory beneath root without parent traversal, NUL or symlink components")
            current = _open_dir(segment, current, True)
            fds.append(current)
        target_fd = current
        old = {}
        for name in outputs:
            _stat_output(name, target_fd)
            old[name] = _read_output(name, target_fd)
        for name in outputs:
            staged[name] = _stage(target_fd, texts[name])
        replaced = []
        try:
            for name in outputs:
                try:
                    os.replace(staged[name], name, src_dir_fd=target_fd, dst_dir_fd=target_fd)
                except OSError as exc:
                    _fail(exc)
                replaced.append(name)
        except store.RoomError:
            for name in reversed(replaced):
                try:
                    if old[name] is None:
                        os.unlink(name, dir_fd=target_fd)
                    else:
                        backup = _stage(target_fd, old[name])
                        try:
                            os.replace(backup, name, src_dir_fd=target_fd, dst_dir_fd=target_fd)
                        except OSError:
                            try:
                                os.unlink(backup, dir_fd=target_fd)
                            except OSError:
                                pass
                except Exception:
                    pass
            raise
    except OSError as exc:
        _fail(exc)
    finally:
        for name, tmp in list(staged.items()):
            try:
                os.unlink(tmp, dir_fd=fds[-1] if fds else None)
            except Exception:
                pass
        for fd in reversed(fds):
            try:
                os.close(fd)
            except OSError as exc:
                if close_error is None:
                    close_error = exc
    if close_error is not None:
        _fail(close_error)
    return {"ok": True, "room": room, "rev": projection["last_lamport"]}


register({
    "name": "room_export",
    "description": "Read the captured plan or memory projection as Markdown.",
    "inputSchema": {
        "type": "object", "additionalProperties": False,
        "properties": {"room": {"type": "string"}, "agent": {"type": "string"},
                       "what": {"type": "string", "enum": ["plan", "memory", "integration"]},
                       "opened_lamport": {"type": "integer"}},
        "required": ["room", "agent", "what"],
    },
}, room_export)

register({
    "name": "memory_history",
    "description": "Read accepted updates of one memory section, newest first.",
    "inputSchema": {
        "type": "object", "additionalProperties": False,
        "properties": {"room": {"type": "string"}, "agent": {"type": "string"},
                       "section": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,47}$"},
                       "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 100}},
        "required": ["room", "agent", "section"],
    },
}, memory_history)
