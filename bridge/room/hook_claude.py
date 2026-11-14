"""Claude Code PostToolUse hook helper: mirrors todos into room plan/step."""

import contextlib
import fcntl
import json
import os
import re
import sys

STATUS_MAP = {"pending": "pending", "in_progress": "active", "completed": "done"}
LOG_CAP = 256 * 1024


def _slug(s):
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s


def _home():
    return os.environ.get("CW_HOME")


def _room_agent(payload):
    room = os.environ.get("CW_ROOM") or ""
    if not room:
        cwd = None
        if isinstance(payload, dict):
            cwd = payload.get("cwd")
        if not isinstance(cwd, str) or not cwd:
            cwd = os.getcwd()
        base = os.path.basename(os.path.normpath(cwd))
        room = _slug(base) or "room"
    agent = os.environ.get("CW_AGENT") or "claude-code"
    return room, agent


def _ensure_private_dirs(home, room):
    rooms = os.path.join(home, "rooms")
    rdir = os.path.join(rooms, room)
    for d in (home, rooms, rdir):
        try:
            os.makedirs(d, mode=0o700, exist_ok=True)
        except OSError:
            pass
        try:
            os.chmod(d, 0o700)
        except OSError:
            pass
    return rdir


def _log(room, msg):
    try:
        home = _home()
        if home is None:
            home = os.path.join(os.path.expanduser("~"), ".context-wall")
        rdir = _ensure_private_dirs(home, room)
        logp = os.path.join(rdir, "hook.log")
        entry = (str(msg) + "\n").encode("utf-8", errors="replace")
        if len(entry) > LOG_CAP:
            entry = entry[-LOG_CAP:]
        try:
            size = os.path.getsize(logp)
        except OSError:
            size = 0
        if size + len(entry) > LOG_CAP:
            keep = LOG_CAP - len(entry)
            if keep < 0:
                keep = 0
            try:
                with open(logp, "rb") as f:
                    f.seek(size - keep if keep else size)
                    tail = f.read()
            except OSError:
                tail = b""
            try:
                fd = os.open(logp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                try:
                    os.write(fd, tail)
                finally:
                    os.close(fd)
                try:
                    os.chmod(logp, 0o600)
                except OSError:
                    pass
            except OSError:
                pass
        try:
            fd = os.open(logp, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(fd, entry)
            finally:
                os.close(fd)
            try:
                os.chmod(logp, 0o600)
            except OSError:
                pass
        except OSError:
            pass
    except Exception:
        pass


def _state_path(room):
    home = _home()
    if home is None:
        home = os.path.join(os.path.expanduser("~"), ".context-wall")
    return os.path.join(home, "rooms", room, "hook_state.json")


def _load_state(room):
    try:
        with open(_state_path(room), "r", encoding="utf-8") as f:
            data = json.loads(f.read())
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def _save_state(room, state):
    p = _state_path(room)
    tmp = "%s.%d.tmp" % (p, os.getpid())
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, json.dumps(state, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
            try:
                os.fsync(fd)
            except OSError:
                pass
        finally:
            os.close(fd)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, p)
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


@contextlib.contextmanager
def _state_lock(room):
    """Room-level exclusive lock serializing hook state load/post/save."""
    home = _home()
    if home is None:
        home = os.path.join(os.path.expanduser("~"), ".context-wall")
    rdir = _ensure_private_dirs(home, room)
    lpath = os.path.join(rdir, "hook_state.lock")
    try:
        fd = os.open(lpath, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            os.chmod(lpath, 0o600)
        except OSError:
            pass
    except OSError:
        yield
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass


def _extract_items(payload):
    if not isinstance(payload, dict):
        return None
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    for key in ("todos", "items"):
        v = tool_input.get(key)
        if isinstance(v, list):
            return v
    return None


def _parse_items(raw):
    items = []
    for it in raw:
        if not isinstance(it, dict):
            return None
        txt = it.get("content")
        if txt is None:
            txt = it.get("text")
        status = it.get("status")
        if not isinstance(txt, str) or not isinstance(status, str):
            return None
        items.append((txt, status))
    return items


def main():
    room = None
    try:
        data = sys.stdin.buffer.read()
    except Exception:
        return 0
    try:
        if not data or not data.strip():
            return 0
        payload = json.loads(data.decode("utf-8"))
    except Exception:
        return 0
    try:
        if not isinstance(payload, dict):
            return 0
        raw = _extract_items(payload)
        if raw is None:
            return 0
        items = _parse_items(raw)
        if items is None or len(items) == 0:
            return 0
        room, agent = _room_agent(payload)
        # import here so hook works standalone
        from bridge.room import store
        from bridge.room.store import RoomError
        sid = payload.get("session_id")
        sid = sid if isinstance(sid, str) else ""
        texts = [t for (t, _s) in items]
        mapped = []
        for (_t, s) in items:
            m = STATUS_MAP.get(s)
            if m is None:
                m = s if s in ("done", "active", "blocked", "pending") else "pending"
            mapped.append(m)
        home = _home()
        with _state_lock(room):
            state = _load_state(room)
            prev = state.get(sid)
            if prev is None:
                # first time per session: plan only
                title = "Plan"
                steps = [{"text": t} for t in texts]
                store.post(room, agent, "plan", title, plan={"title": title, "steps": steps}, home=home)
                state[sid] = {"statuses": mapped, "texts": texts}
                _save_state(room, state)
            else:
                prev_statuses = prev.get("statuses") if isinstance(prev, dict) else None
                if not isinstance(prev_statuses, list):
                    prev_statuses = []
                # texts changed? treat as still step updates; if length changed, emit accordingly
                for i, m in enumerate(mapped):
                    prev_m = prev_statuses[i] if i < len(prev_statuses) else None
                    if prev_m != m:
                        store.post(room, agent, "step", texts[i], step={"index": i, "state": m}, home=home)
                state[sid] = {"statuses": mapped, "texts": texts}
                _save_state(room, state)
    except Exception as e:
        try:
            if room is None:
                # best effort: derive room for log
                room2, _a = _room_agent(payload if isinstance(payload, dict) else {})
                room = room2
            _log(room, "hook error: %r" % (e,))
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
