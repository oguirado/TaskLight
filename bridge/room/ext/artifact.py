"""Read bounded pages of artifacts recorded by terminal workers."""
import hashlib
import os
import re
import stat
from contextlib import ExitStack

from bridge.plan.fold import fold_plan
from bridge.plan.ops import check_arguments
from bridge.room import store
from bridge.wall.emit import sanitize_output
from . import register
from .export import _read_events

_FILE_LIMIT = 4 * 1024 * 1024
_DEFAULT_PAGE = 16384
_PAGE_LIMIT = 65536
_HASH_PATTERN = r"^[0-9a-f]{64}$"


def _recorded_hashes(room, path):
    found = False
    hashes = set()

    def observe(event, _state, disposition):
        nonlocal found
        # C7bq: only admitted ops authorize a path (same guard as export.py).
        if (event.get("act") != "op" or not disposition
                or any(disposition.get(key) for key in ("replayed", "noop", "ignored"))):
            return
        op = event.get("op")
        if (not isinstance(op, dict) or op.get("kind") != "agent.lifecycle"
                or op.get("state") not in ("finished", "failed")):
            return
        result = op.get("result")
        if not isinstance(result, dict):
            return
        if result.get("receipt") == path:
            found = True
        evidence = result.get("evidence")
        for pointer in evidence if isinstance(evidence, list) else ():
            if isinstance(pointer, dict) and pointer.get("path") == path:
                found = True
                if isinstance(pointer.get("sha256"), str):
                    hashes.add(pointer["sha256"])

    events = _read_events(room, legacy_results=True)
    fold_plan((event for event in events if event["room"] == room), _observe=observe)
    if not found:
        raise store.RoomError("bad_args", "path is not a recorded receipt or evidence path")
    return hashes


def _read_artifact(path):
    try:
        # Rooms currently have no project binding. Anchor relative paths to
        # the bridge's working directory.
        root = os.getcwd()
        if os.name == "nt":
            from bridge.ctx.paths import Roots, open_file_confined

            roots = Roots((root,))
            resolved = roots.resolve(os.path.join(root, path))
            if resolved is None:
                raise store.RoomError("bad_args", "path escapes the project root or contains a link")
            with ExitStack() as stack:
                fd = open_file_confined(resolved, roots)
                stack.callback(os.close, fd)
                return _read_artifact_fd(fd)
        target = os.path.realpath(os.path.join(root, path))
        if os.path.commonpath((root, target)) != root:
            raise store.RoomError("bad_args", "path escapes the project root")
        segments = os.path.relpath(target, root).split(os.sep)

        # Resolve in-root symlinks above, then open only canonical components.
        # A replacement symlink cannot redirect a descriptor-based open.
        dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        with ExitStack() as stack:
            parent = os.open(".", dir_flags)
            stack.callback(os.close, parent)
            for segment in segments[:-1]:
                parent = os.open(segment, dir_flags, dir_fd=parent)
                stack.callback(os.close, parent)
            name = segments[-1]
            if not stat.S_ISREG(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode):
                raise store.RoomError("bad_args", "artifact must be a regular file")
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            stack.callback(os.close, fd)
            return _read_artifact_fd(fd)
    except (OSError, ValueError):
        raise store.RoomError("bad_args", "artifact could not be read") from None


def _read_artifact_fd(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise store.RoomError("bad_args", "artifact must be a regular file")
    if info.st_size > _FILE_LIMIT:
        raise store.RoomError("limit_exceeded", "artifact exceeds the file size limit")
    with os.fdopen(fd, "rb", closefd=False) as stream:
        data = stream.read(_FILE_LIMIT + 1)
    if len(data) > _FILE_LIMIT:
        raise store.RoomError("limit_exceeded", "artifact exceeds the file size limit")
    return data


def _page_text(data, offset, end):
    page = data[offset:end].decode("utf-8", errors="replace")
    text = sanitize_output(page)
    if page and (offset or end < len(data)):
        # Redacting pages in isolation can miss a credential split across a
        # page boundary. Suppress this page if splitting changes redaction.
        prefix = data[:offset].decode("utf-8", errors="replace")
        suffix = data[end:].decode("utf-8", errors="replace")
        if sanitize_output(prefix + page + suffix) != sanitize_output(prefix) + text + sanitize_output(suffix):
            return "[REDACTED]"
    return text


def artifact_read(args: dict) -> dict:
    check_arguments(args, {"room", "agent", "path", "sha256", "offset", "limit"},
                    ("room", "agent", "path"), error=store.RoomError)
    room, path = args["room"], args["path"]
    store._check_room(room)
    store._check_agent(args["agent"])
    if not isinstance(path, str) or not path or "\x00" in path:
        raise store.RoomError("bad_args", "path must be a nonempty file path")
    if "sha256" in args and (not isinstance(args["sha256"], str)
                             or re.fullmatch(_HASH_PATTERN, args["sha256"]) is None):
        raise store.RoomError("bad_args", "sha256 must be lowercase hexadecimal")
    offset = args.get("offset", 0)
    if type(offset) is not int or offset < 0:
        raise store.RoomError("bad_args", "offset must be a non-negative integer")
    limit = args.get("limit", _DEFAULT_PAGE)
    if type(limit) is not int or not 1 <= limit <= _PAGE_LIMIT:
        raise store.RoomError("bad_args", "limit must be an integer in 1-65536")

    expected = _recorded_hashes(room, path)
    if "sha256" in args:
        expected.add(args["sha256"])
    data = _read_artifact(path)
    actual = hashlib.sha256(data).hexdigest()
    if expected and expected != {actual}:
        raise store.RoomError("bad_op", "sha256 mismatch")
    end = min(len(data), offset + limit)
    return {"sha256": actual, "size": len(data), "offset": offset,
            "next_offset": end if end < len(data) else None,
            "text": _page_text(data, offset, end)}


register({
    "name": "artifact_read",
    "description": "Read a redacted page of a terminal worker's recorded receipt or evidence.",
    "inputSchema": {
        "type": "object", "additionalProperties": False,
        "required": ["room", "agent", "path"],
        "properties": {
            "room": {"type": "string"},
            "agent": {"type": "string"},
            "path": {"type": "string"},
            "sha256": {"type": "string", "pattern": _HASH_PATTERN},
            "offset": {"type": "integer", "minimum": 0, "default": 0},
            "limit": {"type": "integer", "minimum": 1, "maximum": _PAGE_LIMIT,
                      "default": _DEFAULT_PAGE},
        },
    },
}, artifact_read)
