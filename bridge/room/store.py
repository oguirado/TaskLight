"""U33 agent room storage: append-only JSONL with Lamport order."""

import errno
import fcntl
import hashlib
import json
import math
import os
import re
import secrets
import time

CAP = 8 * 1024 * 1024
ROOM_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
AGENT_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,47}")
CRED_RE = re.compile(r"(token|secret|credential|password|\.env|id_rsa|auth\.json)", re.I)
ACTS = {"open", "plan", "step", "question", "answer", "handoff", "ack", "heartbeat", "verdict", "close"}
STEP_STATES = {"done", "active", "blocked", "pending"}
SILENT_AFTER_S = 600


class RoomError(Exception):
    def __init__(self, code, message=""):
        super().__init__(code if not message else "%s: %s" % (code, message))
        self.code = code


def _home(home):
    if home is not None:
        return os.fspath(home)
    v = os.environ.get("CW_HOME")
    if v:
        return v
    return os.path.join(os.path.expanduser("~"), ".context-wall")


def _room_dir(home, room):
    return os.path.join(_home(home), "rooms", room)


def _events_path(home, room):
    return os.path.join(_room_dir(home, room), "events.jsonl")


def _check_room(room):
    if not isinstance(room, str) or not ROOM_RE.fullmatch(room):
        raise RoomError("bad_room", "invalid room %r" % (room,))


def _check_agent(agent, code="bad_agent"):
    if not isinstance(agent, str) or not AGENT_RE.fullmatch(agent):
        raise RoomError(code, "invalid agent %r" % (agent,))


def _check_timing(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RoomError("bad_args", "invalid %s %r" % (name, value))
    v = float(value)
    if not math.isfinite(v) or v < 0:
        raise RoomError("bad_args", "invalid %s %r" % (name, value))
    return v


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _validate_plan(plan):
    if not isinstance(plan, dict):
        raise RoomError("bad_plan", "plan must be object")
    title = plan.get("title")
    if not isinstance(title, str) or len(title) > 120:
        raise RoomError("bad_plan", "bad title")
    steps = plan.get("steps")
    if not isinstance(steps, list) or not (1 <= len(steps) <= 12):
        raise RoomError("bad_plan", "bad steps")
    for st in steps:
        if not isinstance(st, dict):
            raise RoomError("bad_plan", "step must be object")
        if set(st) - {"text", "accept"}:
            raise RoomError("bad_plan", "unknown step keys: %r" % (sorted(set(st) - {"text", "accept"}),))
        txt = st.get("text")
        if not isinstance(txt, str) or len(txt) > 80:
            raise RoomError("bad_plan", "bad step text")
        if "accept" in st:
            acc = st["accept"]
            if not isinstance(acc, str) or len(acc) > 160:
                raise RoomError("bad_plan", "bad accept")


def _validate_step(step):
    if not isinstance(step, dict):
        raise RoomError("bad_step", "step must be object")
    idx = step.get("index")
    if not _is_int(idx) or idx < 0:
        raise RoomError("bad_step", "bad index")
    state = step.get("state")
    if not isinstance(state, str) or state not in STEP_STATES:
        raise RoomError("bad_step", "bad state")
    if "outcome" in step:
        out = step["outcome"]
        if not isinstance(out, str) or len(out) > 240:
            raise RoomError("bad_step", "bad outcome")
    if "took" in step:
        took = step["took"]
        if not isinstance(took, str) or len(took) > 32:
            raise RoomError("bad_step", "bad took")


def _validate_evidence(evidence, room_dir):
    if evidence is None:
        evidence = ()
    if isinstance(evidence, str):
        raise RoomError("bad_evidence", "evidence must be list")
    try:
        items = list(evidence)
    except TypeError:
        raise RoomError("bad_evidence", "evidence must be list")
    if len(items) > 8:
        raise RoomError("bad_evidence", "too many evidence")
    out = []
    room_abs = os.path.realpath(room_dir)
    for p in items:
        if not isinstance(p, str):
            raise RoomError("bad_evidence", "path must be string")
        if not os.path.isabs(p):
            raise RoomError("bad_evidence", "path must be absolute: %r" % p)
        resolved = os.path.realpath(p)
        base = os.path.basename(resolved)
        if CRED_RE.search(base):
            raise RoomError("bad_evidence", "credential basename: %r" % p)
        if resolved == room_abs or resolved.startswith(room_abs + os.sep):
            raise RoomError("bad_evidence", "under room root: %r" % p)
        if not os.path.lexists(resolved) or not os.path.isfile(resolved):
            raise RoomError("bad_evidence", "not a regular file: %r" % p)
        h = hashlib.sha256()
        with open(resolved, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                h.update(chunk)
        out.append({"path": resolved, "sha256": h.hexdigest()})
    return out


_ID_RE = re.compile(r"e-[0-9a-f]{16}")

def _is_valid_event(o):
    if not isinstance(o, dict):
        return False
    iid = o.get("id")
    if not isinstance(iid, str) or not _ID_RE.fullmatch(iid):
        return False
    lam = o.get("lamport")
    if not _is_int(lam):
        return False
    ts = o.get("ts")
    if not _is_int(ts):
        return False
    room = o.get("room")
    if not isinstance(room, str) or not ROOM_RE.fullmatch(room):
        return False
    agent = o.get("agent")
    if not isinstance(agent, str) or not AGENT_RE.fullmatch(agent):
        return False
    act = o.get("act")
    if not isinstance(act, str) or act not in ACTS:
        return False
    text = o.get("text")
    if not isinstance(text, str):
        return False
    if len(text.encode("utf-8")) > 4096:
        return False
    if "re" in o and o["re"] is not None:
        if not isinstance(o["re"], str):
            return False
    if "to" in o and o["to"] is not None:
        if not isinstance(o["to"], str) or not AGENT_RE.fullmatch(o["to"]):
            return False
    if "evidence" in o and o["evidence"] is not None:
        ev = o["evidence"]
        if not isinstance(ev, list) or len(ev) > 8:
            return False
        for item in ev:
            if not isinstance(item, dict):
                return False
            if not isinstance(item.get("path"), str):
                return False
            if not isinstance(item.get("sha256"), str):
                return False
    if act == "plan":
        if "plan" not in o:
            return False
        try:
            _validate_plan(o["plan"])
        except RoomError:
            return False
        if "step" in o:
            return False
    else:
        if "plan" in o:
            return False
    if act == "step":
        if "step" not in o:
            return False
        try:
            _validate_step(o["step"])
        except RoomError:
            return False
    else:
        if "step" in o:
            return False
    if act in ("answer", "ack") and "re" not in o:
        return False
    return True


def _parse_events_bytes(data):
    """Return (events, malformed). Torn last line skipped without counting."""
    if not data:
        return [], 0
    ends = data.endswith(b"\n")
    parts = data.split(b"\n")
    events = []
    malformed = 0
    for i, raw in enumerate(parts):
        is_last = i == len(parts) - 1
        if ends and is_last:
            continue  # trailing empty after final newline
        if not ends and is_last:
            continue  # torn tail
        if raw.strip() == b"":
            continue  # blank not malformed
        try:
            line = raw.decode("utf-8")
        except Exception:
            malformed += 1
            continue
        try:
            obj = json.loads(line)
        except Exception:
            malformed += 1
            continue
        if not isinstance(obj, dict):
            malformed += 1
            continue
        if not _is_valid_event(obj):
            malformed += 1
            continue
        events.append(obj)
    return events, malformed


def _read_all(home, room):
    path = _events_path(home, room)
    try:
        with open(path, "rb") as f:
            data = f.read()
    except (FileNotFoundError, NotADirectoryError):
        return [], 0
    except IsADirectoryError:
        return [], 0
    return _parse_events_bytes(data)


def _max_lamport_from_bytes(data):
    """Max top-level integer lamport over complete lines plus a parseable torn tail."""
    if not data:
        return 0
    ends = data.endswith(b"\n")
    parts = data.split(b"\n")
    mx = 0
    for i, raw in enumerate(parts):
        is_last = i == len(parts) - 1
        if ends and is_last:
            continue
        if not ends and is_last:
            if raw.strip() == b"":
                continue
            try:
                obj = json.loads(raw.decode("utf-8"))
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            v = obj.get("lamport")
            if _is_int(v) and v > mx:
                mx = v
            continue
        if raw.strip() == b"":
            continue
        try:
            obj = json.loads(raw.decode("utf-8"))
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        v = obj.get("lamport")
        if _is_int(v) and v > mx:
            mx = v
    return mx


def _max_lamport_fast(path):
    try:
        if not os.path.exists(path):
            return 0
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return 0
    return _max_lamport_from_bytes(data)


def _find_by_id(home, room, rid):
    events, _ = _read_all(home, room)
    for e in events:
        if e.get("id") == rid:
            return e
    return None


def _ensure_dirs(home, room):
    h = _home(home)
    rooms = os.path.join(h, "rooms")
    rdir = os.path.join(rooms, room)
    for d in (h, rooms, rdir):
        try:
            os.makedirs(d, mode=0o700, exist_ok=True)
        except OSError:
            try:
                os.makedirs(d, exist_ok=True)
            except OSError:
                pass
        try:
            os.chmod(d, 0o700)
        except OSError:
            pass
    return rdir


def post(room, agent, act, text, *, re=None, to=None, evidence=(), plan=None, step=None,
         home=None, clock=None):
    _check_room(room)
    _check_agent(agent)
    if to is not None:
        _check_agent(to)
    if not isinstance(act, str) or act not in ACTS:
        raise RoomError("bad_act", "invalid act %r" % (act,))
    if not isinstance(text, str):
        raise RoomError("text_too_long", "text must be string")
    if len(text.encode("utf-8")) > 4096:
        raise RoomError("text_too_long", "text too long")
    # plan / step occupancy rules
    if act == "plan":
        _validate_plan(plan)
    else:
        if plan is not None:
            raise RoomError("bad_plan", "plan only for act plan")
    if act == "step":
        _validate_step(step)
    else:
        if step is not None:
            raise RoomError("bad_step", "step only for act step")
    # re required checks
    if act in ("answer", "ack"):
        if re is None:
            raise RoomError("bad_re", "re required for %s" % act)
    # evidence validation (before creating anything)
    rdir = _room_dir(home, room)
    ev_list = _validate_evidence(evidence, rdir) if evidence else []
    if evidence is not None and len(list(evidence)) == 0:
        ev_list = []
    # re existence pre-check (avoids creating room on bad_re)
    if re is not None:
        if not isinstance(re, str):
            raise RoomError("bad_re", "re must be string")
        tgt = _find_by_id(home, room, re)
        if tgt is None:
            raise RoomError("bad_re", "re not found")
        if act == "answer" and tgt.get("act") != "question":
            raise RoomError("bad_re", "answer must reference question")
        if act == "ack" and tgt.get("act") != "handoff":
            raise RoomError("bad_re", "ack must reference handoff")
    # ts
    if clock is None:
        ts = int(time.time() * 1000)
    else:
        ts = int(clock())
    eid = "e-" + secrets.token_hex(8)
    # ensure dirs and append under lock
    rdir = _ensure_dirs(home, room)
    epath = os.path.join(rdir, "events.jsonl")
    lpath = os.path.join(rdir, "events.lock")
    lockfd = os.open(lpath, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            os.chmod(lpath, 0o600)
        except OSError:
            pass
        fcntl.flock(lockfd, fcntl.LOCK_EX)
        try:
            try:
                with open(epath, "rb") as f:
                    data = f.read()
            except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
                data = b""
            sep = b"\n" if (data and not data.endswith(b"\n")) else b""
            mx = _max_lamport_from_bytes(data)
            lamport = mx + 1
            event = {
                "id": eid,
                "lamport": lamport,
                "ts": ts,
                "room": room,
                "agent": agent,
                "act": act,
                "text": text,
            }
            if re is not None:
                event["re"] = re
            if to is not None:
                event["to"] = to
            if ev_list:
                event["evidence"] = ev_list
            if act == "plan":
                event["plan"] = plan
            if act == "step":
                event["step"] = step
            line = json.dumps(event, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
            lb = sep + line.encode("utf-8")
            if len(data) + len(lb) > CAP:
                raise RoomError("room_full", "room file cap exceeded")
            fd = os.open(epath, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
            try:
                try:
                    os.chmod(epath, 0o600)
                except OSError:
                    pass
                os.write(fd, lb)
                try:
                    os.fsync(fd)
                except OSError:
                    pass
            finally:
                os.close(fd)
            return event
        finally:
            try:
                fcntl.flock(lockfd, fcntl.LOCK_UN)
            except OSError:
                pass
    finally:
        try:
            os.close(lockfd)
        except OSError:
            pass


def read(room, since=0, *, home=None):
    _check_room(room)
    events, malformed = _read_all(home, room)
    out = []
    for e in events:
        lam = e.get("lamport")
        if not _is_int(lam):
            malformed += 1
            continue
        if lam > since:
            out.append(e)
    return out, malformed


def wait(room, since, *, act=None, agent=None, exclude_agent=None, to=None, timeout_s=30.0,
         poll_s=0.2, home=None):
    timeout_s = _check_timing(timeout_s, "timeout_s")
    poll_s = _check_timing(poll_s, "poll_s")
    _check_room(room)
    deadline = time.monotonic() + timeout_s
    while True:
        events, _ = _read_all(home, room)
        for e in events:
            lam = e.get("lamport")
            if not _is_int(lam) or lam <= since:
                continue
            if act is not None and e.get("act") != act:
                continue
            if agent is not None and e.get("agent") != agent:
                continue
            if exclude_agent is not None and e.get("agent") == exclude_agent:
                continue
            if to is not None and e.get("to") != to:
                continue
            return e
        if time.monotonic() >= deadline:
            return None
        time.sleep(poll_s if poll_s > 0 else 0.05)


def inbox(room, agent, since=0, *, home=None):
    events, _ = read(room, since=since, home=home)
    out = []
    for e in events:
        to = e.get("to")
        if to is not None and to == agent:
            out.append(e)
        elif to is None and e.get("act") in ("question", "handoff"):
            out.append(e)
    return out


def status(room, *, home=None):
    _check_room(room)
    events, _ = _read_all(home, room)
    # only valid entries with int lamport
    evs = [e for e in events if _is_int(e.get("lamport"))]
    answered = set()
    acked = set()
    for e in evs:
        r = e.get("re")
        if isinstance(r, str):
            if e.get("act") == "answer":
                answered.add(r)
            elif e.get("act") == "ack":
                acked.add(r)
    open_q = [e for e in evs if e.get("act") == "question" and e.get("id") not in answered]
    open_h = [e for e in evs if e.get("act") == "handoff" and e.get("id") not in acked]
    last = {}
    for e in evs:
        a = e.get("agent")
        if isinstance(a, str):
            last[a] = e
    now = int(time.time() * 1000)
    silent = []
    for a, e in last.items():
        ts = e.get("ts")
        if not _is_int(ts):
            continue
        if now - ts > SILENT_AFTER_S * 1000:
            silent.append(a)
    silent.sort()
    return {
        "open_questions": open_q,
        "handoffs_without_ack": open_h,
        "last_by_agent": last,
        "silent": silent,
    }
