"""U33 agent room storage: append-only JSONL with Lamport order."""

import copy
import errno
import fcntl
import hashlib
import json
import math
import os
import re
import secrets
import time

try:
    from bridge.plan import apply_op_event, check_conformance, fold_plan, validate_op_shape
    from bridge.plan.errors import PlanError
except Exception:  # pragma: no cover
    apply_op_event = fold_plan = validate_op_shape = check_conformance = None
    PlanError = Exception

CAP = 8 * 1024 * 1024
ROOM_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
AGENT_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,47}")
CRED_RE = re.compile(r"(token|secret|credential|password|\.env|id_rsa|auth\.json)", re.I)
ACTS = {"open", "plan", "step", "question", "answer", "handoff", "ack", "heartbeat", "verdict", "close", "op"}
STEP_STATES = {"done", "active", "blocked", "pending"}
SILENT_AFTER_S = 600
OP_KINDS = frozenset({"plan.open", "plan.close", "plan.phase", "task.add", "task.set", "task.claim", "task.release", "micro.add", "micro.set", "memory.set"})
OP_ID_RE = re.compile(r"[A-Za-z0-9_-]{8,64}")
OP_MAX_BYTES = 8192

_SAFE_MAX = 9007199254740991
_TS_MAX = 8640000000000000


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


def _is_safe_int(v):
    return _is_int(v) and abs(v) <= _SAFE_MAX


def _is_safe_ts(v):
    return _is_safe_int(v) and abs(v) <= _TS_MAX


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
    try:
        text_len = len(text.encode("utf-8"))
    except UnicodeError:
        return False
    if text_len > 4096:
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
    if act != "op" and "op" in o:
        return False
    if act == "op":
        if "op" not in o:
            return False
        op = o["op"]
        if not isinstance(op, dict):
            return False
        if "plan" in o or "step" in o:
            return False
        if not _is_safe_int(lam) or not _is_safe_ts(ts):
            return False
        if validate_op_shape is None:
            return False
        try:
            data = json.dumps(op, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
            raw = data.encode("utf-8")
        except (ValueError, TypeError, UnicodeError, RecursionError):
            return False
        if len(raw) > OP_MAX_BYTES:
            return False
        try:
            validate_op_shape(copy.deepcopy(op))
        except Exception:
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


def _raise_op(exc):
    code = getattr(exc, "code", None)
    if isinstance(code, str) and code:
        raise RoomError(code, str(exc))
    raise RoomError("bad_op", str(exc))


def _load_templates(home=None):
    """Load runtime templates from templates/planning/*.json plus user
    templates in <home>/templates/*.json (validated, invalid skipped)."""
    templates = {}
    try:
        from bridge.plan.template import load_template
    except Exception:
        return templates
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    planning = os.path.join(repo, "templates", "planning")
    for path in _template_files(planning):
        try:
            tpl = load_template(path)
            templates[tpl["id"]] = tpl
        except Exception:
            continue
    user = os.path.join(_home(home), "templates")
    for path in _template_files(user):
        try:
            tpl = load_template(path)
            templates[tpl["id"]] = tpl
        except Exception:
            continue
    return templates


def _template_files(directory):
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    return [os.path.join(directory, n) for n in names if n.endswith(".json")]


def _tpl_kw(home=None, templates=None, needed=(), *, strict=False):
    if not strict and templates is not None:
        return {"templates": templates}
    runtime = _load_templates(home)
    if strict:
        runtime = dict(runtime)
        if templates is not None:
            runtime.update(templates)
        if any(tid not in runtime for tid in needed):
            raise RoomError("unknown_template", "strict template unavailable")
        if check_conformance is None:
            raise RoomError("unknown_template", "conformance check unavailable")
        return {"templates": runtime}
    if not runtime or any(tid not in runtime for tid in needed):
        return {}
    return {"templates": runtime}


def _plan_template_ids(events):
    ids = []
    for e in events or []:
        if not isinstance(e, dict) or e.get("act") != "op":
            continue
        op = e.get("op")
        if isinstance(op, dict) and op.get("kind") == "plan.open":
            tid = op.get("template_id")
            if isinstance(tid, str) and tid:
                ids.append(tid)
    return ids


def _validate_op_static(op):
    if not isinstance(op, dict):
        raise RoomError("bad_op", "op must be object")
    try:
        data = json.dumps(op, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        raw = data.encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError) as e:
        raise RoomError("bad_op", str(e))
    if len(raw) > OP_MAX_BYTES:
        raise RoomError("limit_exceeded", "op payload cap exceeded")
    kind = op.get("kind")
    if not isinstance(kind, str) or kind not in OP_KINDS:
        raise RoomError("bad_op", "invalid kind")
    if validate_op_shape is None:
        raise RoomError("bad_op", "plan validator unavailable")
    try:
        validate_op_shape(copy.deepcopy(op))
    except RoomError:
        raise
    except Exception as e:
        _raise_op(e)


def _resolve_ts(clock, op_mode):
    if clock is None:
        return int(time.time() * 1000)
    raw = clock()
    if op_mode:
        if not _is_safe_ts(raw):
            raise RoomError("bad_op", "invalid clock")
        return raw
    return int(raw)


def _op_max_activity(events):
    last = {}
    for e in events:
        agent = e.get("agent")
        ts = e.get("ts")
        if isinstance(agent, str) and _is_safe_ts(ts):
            prev = last.get(agent)
            if prev is None or ts > prev:
                last[agent] = ts
    return last


def _has_cycle(graph):
    color = {}
    def dfs(u, stack):
        color[u] = 1
        for v in graph.get(u, []):
            if v not in graph:
                continue
            if color.get(v, 0) == 1:
                return True
            if color.get(v, 0) == 0 and dfs(v, stack | {v}):
                return True
        color[u] = 2
        return False
    for u in list(graph.keys()):
        if color.get(u, 0) == 0:
            if dfs(u, {u}):
                return True
    return False


def _write_all(fd, payload, original_size):
    view = memoryview(payload)
    total = 0
    try:
        while total < len(payload):
            try:
                n = os.write(fd, view[total:])
            except InterruptedError:
                continue
            if n is None or n <= 0:
                raise RoomError("internal", "short write")
            total += n
    except RoomError:
        try:
            os.ftruncate(fd, original_size)
            try:
                os.fsync(fd)
            except OSError:
                pass
        except OSError:
            pass
        raise
    except OSError as e:
        try:
            os.ftruncate(fd, original_size)
            try:
                os.fsync(fd)
            except OSError:
                pass
        except OSError:
            pass
        raise RoomError("internal", str(e)) from e



def _op_identity_index(events, agent):
    """Index both member and batch identities, preserving first stored matches."""
    found = {}
    for event in events:
        if event.get("act") != "op" or event.get("agent") != agent:
            continue
        for record in (event.get("batch"), event.get("op")):
            if isinstance(record, dict):
                oid = record.get("op_id")
                if isinstance(oid, str):
                    found.setdefault(oid, event)
    return found


def _replay_batch(events, event, agent):
    member_ids = event["batch"].get("member_ids")
    if not isinstance(member_ids, list) or not member_ids:
        raise RoomError("bad_op", "op_id conflict")
    by_id = {ev["id"]: ev for ev in events
             if ev.get("act") == "op" and ev.get("agent") == agent
             and isinstance(ev.get("batch"), dict)
             and ev["batch"].get("member_ids") == member_ids}
    if any(eid not in by_id for eid in member_ids):
        raise RoomError("bad_op", "op_id conflict")
    return [dict(copy.deepcopy(by_id[eid]), replayed=True) for eid in member_ids]


def post(room, agent, act, text, *, re=None, to=None, evidence=(), plan=None, step=None,
         op=None, home=None, clock=None, templates=None):
    _check_room(room)
    _check_agent(agent)
    if to is not None:
        _check_agent(to)
    if not isinstance(act, str) or act not in ACTS:
        raise RoomError("bad_act", "invalid act %r" % (act,))
    if not isinstance(text, str):
        raise RoomError("text_too_long", "text must be string")
    try:
        text_bytes = text.encode("utf-8")
    except UnicodeEncodeError:
        raise RoomError("bad_op", "text must be valid UTF-8") from None
    if len(text_bytes) > 4096:
        raise RoomError("text_too_long", "text too long")
    # op contamination / exclusivity (frozen legacy semantics above it)
    if op is not None and act != "op":
        raise RoomError("bad_op", "op only for act op")
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
    # Pre-lock op static validation and clock (never reach dirs/lock on failure)
    if act == "op":
        if op is None:
            raise RoomError("bad_op", "op required for act op")
        _validate_op_static(op)
        ts = _resolve_ts(clock, True)
    else:
        ts = None
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
    # ts for legacy acts
    if act != "op":
        ts = _resolve_ts(clock, False)
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
            parsed, _ = _parse_events_bytes(data)
            if act == "op" and isinstance(op, dict) and op.get("op_id") is not None:
                matched = _op_identity_index(parsed, agent).get(op["op_id"])
                if matched is not None:
                    if isinstance(matched.get("batch"), dict):
                        raise RoomError("bad_op", "op_id conflict")
                    replay = copy.deepcopy(matched)
                    replay["replayed"] = True
                    return replay
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
            if act == "op":
                event["op"] = copy.deepcopy(op)
                if fold_plan is None or apply_op_event is None:
                    raise RoomError("bad_op", "plan fold unavailable")
                needed = _plan_template_ids(parsed)
                if isinstance(op, dict) and op.get("kind") == "plan.open":
                    tid = op.get("template_id")
                    if isinstance(tid, str) and tid:
                        needed.append(tid)
                tpl_kw = _tpl_kw(home, templates, needed)
                try:
                    state = fold_plan(parsed, **tpl_kw)
                    last_by = _op_max_activity(parsed)
                    apply_op_event(state, event, last_by_agent=last_by, **tpl_kw)
                except RoomError:
                    raise
                except Exception as e:
                    _raise_op(e)
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
                _write_all(fd, lb, len(data))
                try:
                    os.fsync(fd)
                except OSError as e:
                    try:
                        os.ftruncate(fd, len(data))
                    except OSError:
                        pass
                    raise RoomError("internal", str(e)) from e
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


def post_ops(room, agent, ops, *, strict=False, home=None, clock=None, templates=None):
    _check_room(room)
    _check_agent(agent)
    if not isinstance(ops, list) or not ops:
        raise RoomError("bad_op", "ops must be non-empty list")
    try:
        raw_ops = [copy.deepcopy(o) for o in ops]
    except RecursionError as e:
        raise RoomError("bad_op", str(e))
    # Batch-local keys: task.add members may carry _local_key/key which is
    # stripped before persistence. Deps/task refs may use those keys.
    local_to_prov = {}
    _seen_local = set()
    _add_enum = 0
    for o in raw_ops:
        if isinstance(o, dict) and o.get("kind") == "task.add":
            _add_enum += 1
            lk = o.get("_local_key") if "_local_key" in o else (o.get("key") if "key" in o else None)
            if lk is not None:
                if not isinstance(lk, str) or not lk:
                    raise RoomError("bad_op", "bad local key")
                if lk in _seen_local:
                    raise RoomError("bad_op", "duplicate local key")
                _seen_local.add(lk)
                local_to_prov[lk] = "T%02d" % _add_enum

    def _prov_remap(val):
        if isinstance(val, str) and val in local_to_prov:
            return local_to_prov[val]
        return val

    val_ops = []
    try:
        for o in raw_ops:
            v = copy.deepcopy(o)
            if isinstance(v, dict) and v.get("kind") == "task.add":
                v.pop("_local_key", None)
                v.pop("key", None)
            if isinstance(v, dict):
                if isinstance(v.get("deps"), list):
                    v["deps"] = [_prov_remap(d) for d in v["deps"]]
                if isinstance(v.get("task_id"), str):
                    v["task_id"] = _prov_remap(v["task_id"])
                if isinstance(v.get("micro_id"), str) and "." in v["micro_id"]:
                    pre, rest = v["micro_id"].split(".", 1)
                    v["micro_id"] = _prov_remap(pre) + "." + rest
            val_ops.append(v)
    except RecursionError as e:
        raise RoomError("bad_op", str(e))
    for item in val_ops:
        _validate_op_static(item)
    ts = _resolve_ts(clock, True)
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
            parsed, _ = _parse_events_bytes(data)
            # One namespace for individually posted ops and batch members.
            identities = _op_identity_index(parsed, agent)
            member_oids = [o["op_id"] for o in raw_ops if "op_id" in o]
            if len(set(member_oids)) != len(member_oids):
                raise RoomError("bad_op", "op_id conflict")
            _batch_oid = raw_ops[0].get("op_id")
            matched = identities.get(_batch_oid)
            if matched is not None:
                if not isinstance(matched.get("batch"), dict):
                    raise RoomError("bad_op", "op_id conflict")
                return _replay_batch(parsed, matched, agent)
            if any(o.get("op_id") in identities for o in raw_ops[1:]):
                raise RoomError("bad_op", "op_id conflict")
            # Rewrite batch so the persisted sequence is exactly the validated
            # sequence: allocate task ids, reorder creators before referrers,
            # remap every task reference, then simulate wire ops verbatim.
            # Keep local keys for final resolution; strip them before persist.
            try:
                ops = [copy.deepcopy(o) if isinstance(o, dict) else o for o in raw_ops]
            except RecursionError as e:
                raise RoomError("bad_op", str(e))
            _local_of_pos = {}
            for _i, _o in enumerate(ops):
                if isinstance(_o, dict) and _o.get("kind") == "task.add":
                    _lk = _o.get("_local_key") if "_local_key" in _o else (_o.get("key") if "key" in _o else None)
                    if _lk is not None:
                        _local_of_pos[_i] = _lk
            needed = _plan_template_ids(parsed)
            for o in ops:
                if o.get("kind") == "plan.open" and isinstance(o.get("template_id"), str):
                    needed.append(o["template_id"])
            tpl_kw = _tpl_kw(home, templates, needed, strict=strict)
            prior_state = fold_plan(parsed, **tpl_kw)
            prior_tasks = prior_state.get("tasks", []) if isinstance(prior_state, dict) else []
            has_open = any(isinstance(o, dict) and o.get("kind") == "plan.open" for o in ops)
            prior_count = 0 if has_open else len(prior_tasks)
            prior_ids = set()
            for t in prior_tasks:
                if isinstance(t, dict) and isinstance(t.get("id"), str):
                    prior_ids.add(t["id"])
            add_positions = [i for i, o in enumerate(ops) if o.get("kind") == "task.add"]
            creator = {}
            for k, pos in enumerate(add_positions):
                creator["T%02d" % (prior_count + 1 + k)] = pos
            local_creator = {}
            for _pos, _lk in _local_of_pos.items():
                local_creator[_lk] = _pos
            created_ids = set(creator)
            n = len(ops)
            edges = [[] for _ in range(n)]
            indeg = [0] * n
            edge_set = set()
            def add_edge(before, after):
                if before == after:
                    return
                if (before, after) in edge_set:
                    return
                edge_set.add((before, after))
                edges[before].append(after)
                indeg[after] += 1
            def refs_of(op):
                refs = []
                kind = op.get("kind")
                if kind == "task.add":
                    deps = op.get("deps")
                    if isinstance(deps, list):
                        refs.extend(d for d in deps if isinstance(d, str))
                elif kind == "task.set":
                    tid = op.get("task_id")
                    if isinstance(tid, str):
                        refs.append(tid)
                    deps = op.get("deps")
                    if isinstance(deps, list):
                        refs.extend(d for d in deps if isinstance(d, str))
                elif kind in ("task.claim", "task.release", "micro.add"):
                    tid = op.get("task_id")
                    if isinstance(tid, str):
                        refs.append(tid)
                elif kind == "micro.set":
                    mid = op.get("micro_id")
                    if isinstance(mid, str) and "." in mid:
                        refs.append(mid.split(".")[0])
                return refs
            for i, op in enumerate(ops):
                for r in refs_of(op):
                    if r in local_creator:
                        add_edge(local_creator[r], i)
                    elif r in creator:
                        add_edge(creator[r], i)
            # plan.open must precede plan-dependent ops; memory stays flexible.
            open_pos = [i for i, o in enumerate(ops) if o.get("kind") == "plan.open"]
            for op_i in open_pos:
                for i, op in enumerate(ops):
                    if op.get("kind") in ("plan.open", "memory.set"):
                        continue
                    add_edge(op_i, i)
            # Stable Kahn topological order.
            order = []
            indeg_work = list(indeg)
            remaining = set(range(n))
            while remaining:
                ready = [i for i in remaining if indeg_work[i] == 0]
                if not ready:
                    raise RoomError("dep_cycle", "dependency cycle")
                nxt = min(ready)
                order.append(nxt)
                remaining.remove(nxt)
                for j in edges[nxt]:
                    indeg_work[j] -= 1
            ops = [ops[i] for i in order]
            # Re-allocate ids in persisted task.add order and remap references.
            new_creator = {}
            for k, pos in enumerate([i for i, o in enumerate(ops) if o.get("kind") == "task.add"]):
                new_creator[pos] = "T%02d" % (prior_count + 1 + k)
            old_id_of_new_pos = {}
            # order holds original indices in new sequence; rebuild:
            # new sequence index -> original index
            for new_idx, old_idx in enumerate(order):
                if old_idx in add_positions:
                    old_k = add_positions.index(old_idx)
                    old_id_of_new_pos[new_idx] = "T%02d" % (prior_count + 1 + old_k)
            id_map = {}
            for new_idx, old_id in old_id_of_new_pos.items():
                id_map[old_id] = new_creator[new_idx]
            # Local-key -> final id, tracked through reordering.
            local_to_final = {}
            for _new_idx, _old_idx in enumerate(order):
                if _old_idx in _local_of_pos:
                    local_to_final[_local_of_pos[_old_idx]] = new_creator[_new_idx]
            def remap_task_id(tid):
                if not isinstance(tid, str):
                    return tid
                if tid in local_to_final:
                    return local_to_final[tid]
                return id_map.get(tid, tid)
            for op in ops:
                if not isinstance(op, dict):
                    continue
                if op.get("kind") == "task.add":
                    op.pop("_local_key", None)
                    op.pop("key", None)
                kind = op.get("kind")
                if kind in ("task.add", "task.set") and isinstance(op.get("deps"), list):
                    op["deps"] = [remap_task_id(d) if isinstance(d, str) else d for d in op["deps"]]
                if kind in ("task.set", "task.claim", "task.release", "micro.add"):
                    tid = op.get("task_id")
                    if isinstance(tid, str):
                        op["task_id"] = remap_task_id(tid)
                if kind == "micro.set":
                    mid = op.get("micro_id")
                    if isinstance(mid, str) and "." in mid:
                        pre, rest = mid.split(".", 1)
                        op["micro_id"] = remap_task_id(pre) + "." + rest
            # Final task graph from wire ops must be acyclic and complete.
            final_graph = {}
            if not has_open:
                for t in prior_tasks:
                    if isinstance(t, dict) and isinstance(t.get("id"), str):
                        final_graph[t["id"]] = list(t.get("deps", []))
            nxt = prior_count + 1
            for op in ops:
                if op.get("kind") == "task.add":
                    tid = "T%02d" % nxt
                    deps = op.get("deps", [])
                    final_graph[tid] = list(deps) if isinstance(deps, list) else []
                    nxt += 1
                elif op.get("kind") == "task.set" and "deps" in op:
                    deps = op["deps"]
                    final_graph[op.get("task_id")] = list(deps) if isinstance(deps, list) else []
            for src, deps in final_graph.items():
                for d in deps:
                    if d not in final_graph:
                        raise RoomError("not_found", "missing dep %s" % d)
            if _has_cycle(final_graph):
                raise RoomError("dep_cycle", "dependency cycle")
            batch_oid = _batch_oid
            if fold_plan is None or apply_op_event is None:
                raise RoomError("bad_op", "plan fold unavailable")
            state = fold_plan(parsed, **tpl_kw)
            last_by = _op_max_activity(parsed)
            new_events = []
            lamport = mx
            # Batch-internal revision healing: ops targeting tasks created in
            # this batch resolve base_rev to the simulated rev under the
            # exclusive lock, so concurrent heartbeats cannot race creation.
            _batch_task_ids = set()
            _touched_secs = set()
            _plan_new_in_batch = False

            def _cur_task_rev(tid):
                for _t in (state.get("tasks") or []):
                    if isinstance(_t, dict) and _t.get("id") == tid:
                        return _t.get("rev")
                return None

            for o in ops:
                lamport += 1
                cand = copy.deepcopy(o)
                _kind = cand.get("kind") if isinstance(cand, dict) else None
                if _kind in ("task.set", "task.claim", "task.release", "micro.add"):
                    _tid = cand.get("task_id")
                    if isinstance(_tid, str) and _tid in _batch_task_ids and "base_rev" in cand:
                        _cur = _cur_task_rev(_tid)
                        if _cur is not None:
                            cand["base_rev"] = _cur
                            o["base_rev"] = _cur
                elif _kind == "task.add" and "base_rev" in cand and _plan_new_in_batch:
                    _plan = state.get("plan")
                    if _plan is not None and isinstance(_plan, dict):
                        cand["base_rev"] = _plan.get("rev")
                        o["base_rev"] = _plan.get("rev")
                elif _kind == "memory.set" and "base_rev" in cand:
                    _sec = cand.get("section")
                    _mem = state.get("memory") or {}
                    _cur = _mem.get(_sec, {}).get("rev", 0) if isinstance(_mem.get(_sec), dict) else 0
                    # Only heal when this section was written earlier in-batch.
                    if _sec in _touched_secs:
                        cand["base_rev"] = _cur
                        o["base_rev"] = _cur
                cand_event = {
                    "id": "e-" + secrets.token_hex(8),
                    "lamport": lamport,
                    "ts": ts,
                    "room": room,
                    "agent": agent,
                    "act": "op",
                    "text": "",
                    "op": cand,
                }
                try:
                    state, _ = apply_op_event(state, cand_event, last_by_agent=last_by, **tpl_kw)
                except RoomError:
                    raise
                except Exception as e:
                    _raise_op(e)
                if _kind == "plan.open":
                    _plan_new_in_batch = True
                    _batch_task_ids = set()
                if _kind == "task.add":
                    _st_tasks = state.get("tasks") or []
                    _new_id = _st_tasks[-1].get("id") if _st_tasks else None
                    if isinstance(_new_id, str):
                        _batch_task_ids.add(_new_id)
                if _kind == "memory.set":
                    _touched_secs.add(cand.get("section"))
                # Align simulation identity with persisted events below.
                new_events.append(cand_event)
            if strict:
                plan = state.get("plan")
                if plan is not None:
                    tpls = tpl_kw.get("templates")
                    tpl = tpls.get(plan.get("template_id")) if tpls is not None else None
                    if tpl is None:
                        raise RoomError("unknown_template", "strict conformance template unavailable")
                    if check_conformance is None:
                        raise RoomError("unknown_template", "conformance check unavailable")
                    report = check_conformance(state, tpl)
                    if not report.get("ok"):
                        raise RoomError("not_conformant", "strict conformance findings")
            # Persisted events are the simulated ones (single identity).
            batch_conformance = None
            _cplan = state.get("plan")
            if _cplan is not None and check_conformance is not None:
                tpls = tpl_kw.get("templates")
                if tpls is not None:
                    _ctpl = tpls.get(_cplan.get("template_id"))
                    if _ctpl is not None:
                        try:
                            batch_conformance = check_conformance(state, _ctpl)
                        except Exception:
                            batch_conformance = None
            # Always persist the batch record (op_id may be null &mdash;
            # replay lookup requires a non-null id, but key_map/conformance
            # still serve the immediate result and MCP plan_create).
            _member_ids = [e.get("id") for e in new_events]
            _plan_rev = None
            _pr = state.get("plan")
            if isinstance(_pr, dict):
                _plan_rev = _pr.get("rev")
            _base = {"op_id": batch_oid, "count": len(new_events),
                     "member_ids": list(_member_ids),
                     "key_map": dict(local_to_final)}
            if _plan_rev is not None:
                _base["rev"] = _plan_rev
            if batch_conformance is not None:
                _base["conformance"] = batch_conformance
            for _seq, _ev in enumerate(new_events):
                _b = dict(_base)
                _b["seq"] = _seq
                _ev["batch"] = _b
                _ev["op"] = copy.deepcopy(ops[_seq])
            # Build wire bytes
            line_bytes = []
            for ev in new_events:
                line_bytes.append((json.dumps(ev, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8"))
            payload = sep + b"".join(line_bytes)
            if len(data) + len(payload) > CAP:
                raise RoomError("room_full", "room file cap exceeded")
            fd = os.open(epath, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
            try:
                try:
                    os.chmod(epath, 0o600)
                except OSError:
                    pass
                _write_all(fd, payload, len(data))
                try:
                    os.fsync(fd)
                except OSError as e:
                    try:
                        os.ftruncate(fd, len(data))
                    except OSError:
                        pass
                    raise RoomError("internal", str(e)) from e
            finally:
                os.close(fd)
            return new_events
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
