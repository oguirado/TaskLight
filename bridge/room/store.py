"""U33 agent room storage: append-only JSONL with Lamport order."""

import copy
from collections import OrderedDict, namedtuple
import errno
from . import _lock
from ._lock import _backend as fcntl  # Compatibility for existing backend probes.
import hashlib
import io
import json
import math
import os
import re
import secrets
import stat
import sys
import threading
import time

try:
    from bridge.plan import apply_op_event, check_conformance, fold_plan, validate_op_shape
    from bridge.plan.errors import PlanError
    from bridge.plan.conformance import completion_candidates, has_evidence
    from bridge.plan.fold import _pipeline_current
except Exception:  # pragma: no cover
    apply_op_event = fold_plan = validate_op_shape = check_conformance = None
    PlanError = Exception

CAP = 16 * 1024 * 1024
SEMANTIC_RESERVE_BYTES = 512 * 1024
ROOM_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
AGENT_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,47}")
CRED_RE = re.compile(r"(token|secret|credential|password|\.env|id_rsa|auth\.json)", re.I)
ACTS = {"open", "plan", "step", "question", "answer", "handoff", "ack", "heartbeat", "verdict", "close", "op"}
MESSAGE_ACTS = frozenset({"question", "answer", "handoff", "ack"})
EVIDENCE_MAX_BYTES = 8 * 1024 * 1024
SHA256_RE = re.compile(r"[0-9a-f]{64}")
STEP_STATES = {"done", "active", "blocked", "pending"}
SILENT_AFTER_S = 600
OP_KINDS = frozenset({"plan.open", "plan.close", "plan.phase", "task.add", "task.set", "task.claim", "task.release", "micro.add", "micro.set", "memory.set", "activity.beat"})  # S4 (orchestrator): U90 op kind; validated by bridge/plan/ops.py
OP_ID_RE = re.compile(r"[A-Za-z0-9_-]{8,64}")
OP_MAX_BYTES = 8192

_SAFE_MAX = 9007199254740991
_TS_MAX = 8640000000000000
_UNFENCED = object()


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


def _room_directory_exists(home, room):
    reason = "Room data could not be read."
    try:
        mode = os.lstat(_room_dir(home, room)).st_mode
    except FileNotFoundError:
        return False
    except OSError:
        raise RoomError("room_read_failed", reason) from None
    if not stat.S_ISDIR(mode):
        raise RoomError("room_read_failed", reason)
    return True


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


def _validate_expected_opened_lamport(value):
    if value is not _UNFENCED and (not _is_safe_int(value) or value < 1):
        raise RoomError("bad_op", "expected_opened_lamport must be a positive safe integer")


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


def _message_evidence(evidence):
    """Snapshot typed evidence descriptors without consulting the filesystem."""
    if not isinstance(evidence, list) or len(evidence) > 8:
        raise RoomError("bad_evidence", "evidence must be an array of at most 8 objects")
    out = []
    for item in evidence:
        if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
            raise RoomError("bad_evidence", "evidence needs exactly path and sha256")
        path, digest = item["path"], item["sha256"]
        if (not isinstance(path, str) or not isinstance(digest, str)
                or not SHA256_RE.fullmatch(digest)):
            raise RoomError("bad_evidence", "invalid evidence path or digest")
        try:
            path.encode("utf-8")
        except UnicodeError as exc:
            raise RoomError("bad_evidence", "invalid evidence path") from exc
        if not os.path.isabs(path) or "\0" in path:
            raise RoomError("bad_evidence", "path must be a valid absolute path")
        out.append({"path": path, "sha256": digest})
    return out


def _resolve_message_evidence(evidence, home):
    root = os.path.realpath(_home(home))
    out = []
    for item in evidence:
        path = item["path"]
        try:
            resolved = os.path.realpath(path)
            if os.path.islink(path) or resolved != os.path.abspath(path):
                raise RoomError("bad_evidence", "symlink evidence is not allowed")
            if CRED_RE.search(os.path.basename(resolved)):
                raise RoomError("bad_evidence", "credential basename")
            if os.path.commonpath((root, resolved)) == root:
                raise RoomError("bad_evidence", "evidence under room home")
            info = os.stat(resolved)
            if not stat.S_ISREG(info.st_mode) or info.st_size > EVIDENCE_MAX_BYTES:
                raise RoomError("bad_evidence", "evidence must be a bounded regular file")
        except (OSError, ValueError, UnicodeError) as exc:
            raise RoomError("bad_evidence", "invalid evidence file") from exc
        out.append({"path": resolved, "sha256": item["sha256"]})
    return out


def _verify_message_evidence(evidence, home):
    """Hash new messages only, after replay lookup under the writer lock."""
    for item in _resolve_message_evidence(evidence, home):
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            with os.fdopen(os.open(item["path"], flags), "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > EVIDENCE_MAX_BYTES:
                    raise RoomError("bad_evidence", "evidence must be a bounded regular file")
                digest = hashlib.sha256()
                total = 0
                while True:
                    chunk = stream.read(65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > EVIDENCE_MAX_BYTES:
                        raise RoomError("bad_evidence", "evidence file too large")
                    digest.update(chunk)
        except (OSError, ValueError) as exc:
            raise RoomError("bad_evidence", "cannot read evidence file") from exc
        if digest.hexdigest() != item["sha256"]:
            raise RoomError("bad_evidence", "evidence digest mismatch")


def _question_root(by_id, reference):
    """Resolve an acyclic, same-room ack chain to its question, if any."""
    seen = set()
    while isinstance(reference, str) and reference not in seen:
        seen.add(reference)
        target = by_id.get(reference)
        if target is None:
            return None
        if target.get("act") == "question":
            return reference
        if target.get("act") != "ack":
            return None
        reference = target.get("re")
    return None


def _check_message_reference(events, room, agent, act, reference):
    if reference is None:
        return
    by_id = {event["id"]: event for event in events if event.get("room") == room}
    target = by_id.get(reference)
    if target is None or target.get("act") not in MESSAGE_ACTS:
        raise RoomError("bad_re", "reference must name a same-room message")
    if act in ("ack", "answer"):
        if target.get("to") is not None and target["to"] != agent:
            raise RoomError("bad_re", "sender is not the target recipient")
        if act == "ack" and target["act"] not in ("question", "handoff"):
            raise RoomError("bad_re", "ack must reference question or handoff")
        if act == "answer" and _question_root(by_id, reference) is None:
            raise RoomError("bad_re", "answer must reference question or its ack chain")


def _message_payload(event):
    return (event.get("to"), event.get("act"), event.get("text"),
            event.get("re"), event.get("evidence") or [])


def _message_replay(events, room, agent, op_id, payload):
    for event in events:
        if event.get("room") != room or event.get("agent") != agent:
            continue
        identities = [event.get("op_id")]
        for key in ("op", "batch"):
            record = event.get(key)
            if isinstance(record, dict):
                identities.append(record.get("op_id"))
        if op_id not in identities:
            continue
        if (event.get("op_id") != op_id or event.get("act") not in MESSAGE_ACTS
                or _message_payload(event) != payload):
            raise RoomError("bad_op", "op_id conflict")
        return copy.deepcopy(event)
    return None


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
        capped_op = op
        if op.get("kind") == "agent.lifecycle" and "result" in op:
            # Terminal result fields have their own bounds in validate_op_shape.
            capped_op = {key: value for key, value in op.items() if key != "result"}
        try:
            data = json.dumps(capped_op, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
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


def _decode_event_line(raw):
    try:
        obj = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    if isinstance(obj, dict) and _is_valid_event(obj):
        return obj
    return None


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
        obj = _decode_event_line(raw)
        if obj is None:
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


# Retain proofs, never journal payloads or an index on disk. A smaller retained
# suffix leaves room for appends within the per-query I/O and parser budgets.
_TAIL_READ_BYTES = 524288
_TAIL_RECORDS = 512
_TAIL_CACHE_SIZE = 16
_TailProof = namedtuple("_TailProof", "stamp offset prefix_head boundary end")
_tail_cache = OrderedDict()
_tail_lock = threading.Lock()


def _view_metadata(st):
    # ctime additionally catches in-place rewrites whose mtime was restored.
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def _journal_stamp(home, room):
    root = os.path.realpath(_home(home))
    try:
        st = os.stat(_events_path(root, room))
    except (FileNotFoundError, NotADirectoryError):
        return root, room, None
    if not stat.S_ISREG(st.st_mode):
        raise RoomError("room_read_failed", "Room data could not be read.")
    return root, room, _view_metadata(st)


def _open_nonblocking(path, flags):
    # The journal can be replaced by a FIFO between stat and open.
    return os.open(path, flags | getattr(os, "O_NONBLOCK", 0))


def _remember_tail(key, proof):
    with _tail_lock:
        _tail_cache.pop(key, None)
        if proof is not None:
            _tail_cache[key] = proof
            if len(_tail_cache) > _TAIL_CACHE_SIZE:
                _tail_cache.popitem(last=False)


def _tail_start(data):
    """Choose a line boundary retaining half of each budget, including bad rows."""
    parts = data.rsplit(b"\n", _TAIL_RECORDS // 2 + 1)
    offset = len(parts[0]) + 1 if len(parts) == _TAIL_RECORDS // 2 + 2 else 0
    floor = max(offset, len(data) - _TAIL_READ_BYTES // 2)
    if floor > offset:
        boundary = data.find(b"\n", floor - 1)
        if boundary < 0:
            return None  # An oversized torn record cannot be a bounded suffix.
        offset = boundary + 1
    return offset


def _boundary_digest(data):
    return hashlib.sha256(data[-64:]).digest()


def _read_event_view(home, room, after=None):
    """Return physical-order events, room head and a coherent metadata stamp.

    A cold full scan proves monotonicity and the omitted prefix's maximum.
    Only cursors covering that prefix may reuse the proof. Historical cursors,
    disorder, oversized suffixes and invalidated proofs take a complete scan.
    Each capture is checked before/after reading and again after parsing, with
    at most three retries. All parsing uses the existing acceptance rules.
    """
    force_full = False
    for _ in range(4):
        stamp = _journal_stamp(home, room)
        key, meta = stamp[:2], stamp[2]
        if meta is None:
            _remember_tail(key, None)
            return [], 0, stamp
        with _tail_lock:
            proof = _tail_cache.get(key)
        offset, prefix_head, boundary = 0, None, b""
        if proof is not None and after is not None and not force_full:
            old = proof.stamp[2]
            unchanged = meta == old
            appended = meta[:2] == old[:2] and meta[2] > old[2]
            if ((unchanged or appended)
                    and (proof.prefix_head is None or after >= proof.prefix_head)
                    and meta[2] - proof.offset <= _TAIL_READ_BYTES - 64):
                offset, prefix_head = proof.offset, proof.prefix_head
            else:
                proof = None
        else:
            proof = None
        try:
            with open(_events_path(stamp[0], room), "rb", opener=_open_nonblocking) as f:
                opened = os.fstat(f.fileno())
                if not stat.S_ISREG(opened.st_mode):
                    raise RoomError("room_read_failed", "Room data could not be read.")
                if _view_metadata(opened) != meta:
                    continue
                if proof is not None:
                    f.seek(max(0, offset - 64))
                    boundary = f.read(min(64, offset))
                    f.seek(offset)
                    data = f.read(meta[2] - offset)
                    old_end = old[2] - offset
                    if (len(data) != meta[2] - offset
                            or _boundary_digest(boundary) != proof.boundary
                            or _boundary_digest(boundary + data[:old_end]) != proof.end
                            or data.count(b"\n") > _TAIL_RECORDS):
                        proof = None
                if proof is None:
                    offset, prefix_head, boundary = 0, None, b""
                    f.seek(0)
                    data = f.read(meta[2])
                stable = (len(data) == meta[2] - offset
                          and _view_metadata(os.fstat(f.fileno())) == meta)
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
            _remember_tail(key, None)
            continue
        if not stable or _journal_stamp(home, room) != stamp:
            _remember_tail(key, None)
            continue

        cut = _tail_start(data)
        front, _ = _parse_events_bytes(data[:cut]) if cut is not None else ([], 0)
        back, _ = _parse_events_bytes(data[cut:]) if cut is not None else _parse_events_bytes(data)
        events = front + back
        previous, monotonic = prefix_head, True
        new_prefix_head = prefix_head
        for e in front:
            if e["room"] == room:
                new_prefix_head = (e["lamport"] if new_prefix_head is None
                                   else max(new_prefix_head, e["lamport"]))
        for e in events:
            if e["room"] != room:
                continue
            lamport = e["lamport"]
            if previous is not None and lamport < previous:
                monotonic = False
            previous = lamport
        values = [e["lamport"] for e in events if e["room"] == room]
        if prefix_head is not None:
            values.append(prefix_head)
        head = max(values, default=0)
        if _journal_stamp(home, room) != stamp:
            # Parsing cannot alter the bytes already captured under stable
            # metadata. Return that coherent view, but never cache its proof.
            _remember_tail(key, None)
            return events, head, stamp
        if proof is not None and not monotonic:
            _remember_tail(key, None)
            force_full = True
            continue
        fresh = None
        if monotonic and cut is not None:
            fresh = _TailProof(stamp, offset + cut, new_prefix_head,
                               _boundary_digest(boundary + data[:cut]),
                               _boundary_digest(boundary + data))
        _remember_tail(key, fresh)
        return events, head, stamp
    raise RoomError("internal", "journal changed during read")


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


def _admit_completion_evidence(before, after, op, *, templates=None, home=None):
    """Check completion authority and evidence under the writer lock, after receipt lookup.

    This is deliberately separate from the reducer: historical completions and
    their receipts keep their original meaning, including invalid evidence.
    """
    if op["kind"] == "micro.set" and op["state"] != "done":
        micro_id = op["micro_id"]
        task_id = micro_id.split(".", 1)[0]
        for task in before["tasks"]:
            if task["id"] != task_id:
                continue
            for step in task.get("pipeline", {}).get("steps", ()):
                if step["micro_id"] == micro_id:
                    attempt = _pipeline_current(step)
                    if attempt is not None and attempt["state"] == "accepted":
                        raise RoomError("bad_op", f"Cannot reopen accepted pipeline step {micro_id}.")

    candidates = completion_candidates(before, after, op)
    if not candidates:
        return
    previously_done = {task["id"] for task in before["tasks"] if task["state"] == "done"}
    for task, micro in candidates:
        asserts_done = op["kind"] == "micro.set" and op["micro_id"] == micro["id"] and op["state"] == "done"
        exposes_done = task["state"] == "done" and task["id"] not in previously_done
        if not (asserts_done or exposes_done):
            continue
        for step in task.get("pipeline", {}).get("steps", ()):
            if step["micro_id"] != micro["id"]:
                continue
            attempt = _pipeline_current(step)
            if asserts_done or attempt is None or attempt["state"] != "accepted":
                raise RoomError("bad_op", f"Complete pipeline step {micro['id']} with unit_decide ADMIT on its bound result.")

    plan = after.get("plan") or {}
    available = _load_templates(home) if templates is None else templates
    template = available.get(plan.get("template_id"))
    if (not isinstance(template, dict)
            or template.get("hash") != plan.get("template_hash")):
        raise RoomError("template_unavailable", "Completion template unavailable.")
    types = {item["id"]: item for item in template.get("task_types", [])}
    for task, micro in candidates:
        definition = types.get(task.get("type"))
        if definition is None:
            raise RoomError("template_unavailable", "Completion task type unavailable.")
        if definition.get("evidence_required") is True and not has_evidence(micro.get("evidence")):
            raise RoomError("missing_evidence", "Evidence required to complete " + micro["id"] + ".")


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


def _check_plan_generation(events, expected_opened_lamport, *, home=None, templates=None):
    """Compare against the committed projection while holding the writer lock."""
    if expected_opened_lamport is _UNFENCED:
        return
    _validate_expected_opened_lamport(expected_opened_lamport)
    if fold_plan is None:
        raise RoomError("bad_op", "plan fold unavailable")
    try:
        state = fold_plan(events, **_tpl_kw(home, templates, _plan_template_ids(events)))
    except RoomError:
        raise
    except Exception as exc:
        _raise_op(exc)
    plan = state.get("plan")
    if not isinstance(plan, dict) or plan.get("opened_lamport") != expected_opened_lamport:
        raise RoomError("stale_rev", "plan generation does not match expected_opened_lamport")


def _validate_op_static(op):
    if not isinstance(op, dict):
        raise RoomError("bad_op", "op must be object")
    if {"request_sha256", "batch"}.intersection(op):
        raise RoomError("bad_op", "server-owned operation metadata")
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


def _request_hash(request):
    """Bind a caller's normalized JSON content before generating event fields."""
    try:
        raw = json.dumps(request, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise RoomError("bad_op", str(exc)) from exc
    return hashlib.sha256(raw).hexdigest()


def _request_evidence(evidence):
    """Snapshot legacy evidence paths without opening or resolving any file."""
    if evidence is None:
        return []
    if isinstance(evidence, str):
        raise RoomError("bad_evidence", "evidence must be list")
    try:
        items = list(evidence)
    except TypeError as exc:
        raise RoomError("bad_evidence", "evidence must be list") from exc
    if len(items) > 8:
        raise RoomError("bad_evidence", "too many evidence")
    for path in items:
        if not isinstance(path, str) or not os.path.isabs(path):
            raise RoomError("bad_evidence", "path must be an absolute string")
        try:
            path.encode("utf-8")
        except UnicodeError as exc:
            raise RoomError("bad_evidence", "invalid evidence path") from exc
    return items


def _journal_ceiling(events):
    for event in events:
        op = event.get("op")
        if (event.get("act") == "heartbeat" or isinstance(op, dict) and (
                op.get("kind") == "activity.beat" or
                op.get("kind") == "agent.lifecycle" and op.get("state") == "alive")):
            return CAP - SEMANTIC_RESERVE_BYTES
    return CAP


def _write_all(fd, payload, original_size):
    # Independently admitted lifecycle records share this append primitive.
    try:
        events = [json.loads(line) for line in payload.splitlines() if line]
    except (ValueError, UnicodeError) as exc:
        raise RoomError("internal", "invalid journal payload") from exc
    if original_size + len(payload) > _journal_ceiling(events):
        raise RoomError("room_full", "room file cap exceeded")
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
        os.fsync(fd)
    except (RoomError, OSError) as exc:
        # Attempt both rollback steps, preserving the original failure even if
        # truncation or the rollback sync itself fails.
        try:
            os.ftruncate(fd, original_size)
        except OSError:
            pass
        try:
            os.fsync(fd)
        except OSError:
            pass
        if isinstance(exc, RoomError):
            raise
        raise RoomError("internal", str(exc)) from exc


def _op_identity_index(events, agent, room=None):
    """Index message, operation, member and batch identities in one namespace."""
    found = {}
    for event in events:
        if event.get("agent") != agent or (room is not None and event.get("room") != room):
            continue
        for record in (event, event.get("batch"), event.get("op")):
            if isinstance(record, dict):
                oid = record.get("op_id")
                if isinstance(oid, str):
                    found.setdefault(oid, event)
    return found


def _single_replay(event, digest, *, typed=False, plan=None, step=None):
    if ("batch" in event or event.get("plan") != plan or event.get("step") != step):
        raise RoomError("bad_op", "op_id conflict")
    if "request_sha256" in event:
        equal = event["request_sha256"] == digest
    else:
        # Historical singles retain their original operation and envelope.
        # Legacy path evidence stored the server digest rather than caller JSON.
        evidence = event.get("evidence") or []
        if not typed:
            if (not isinstance(evidence, list) or
                    any(not isinstance(item, dict) or not isinstance(item.get("path"), str)
                        for item in evidence)):
                raise RoomError("bad_op", "op_id conflict")
            evidence = [item["path"] for item in evidence]
        legacy = {"act": event["act"], "text": event["text"],
                  "re": event.get("re"), "to": event.get("to"),
                  "evidence": evidence, "op": event.get("op")}
        equal = _request_hash(legacy) == digest
    if not equal:
        raise RoomError("bad_op", "op_id conflict")
    return dict(copy.deepcopy(event), replayed=True)


def _replay_batch(events, event, agent, digest=None):
    batch = event["batch"]
    # Receipt consumers may already have verified their own request identity.
    # They still require a complete, content-bound stored batch.
    if digest is None:
        digest = batch.get("request_sha256")
    if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
        raise RoomError("bad_op", "op_id conflict")
    member_ids = batch.get("member_ids")
    if (not isinstance(member_ids, list) or not member_ids
            or any(not isinstance(eid, str) for eid in member_ids)
            or len(set(member_ids)) != len(member_ids)
            or batch.get("request_sha256") != digest):
        raise RoomError("bad_op", "op_id conflict")
    by_id = {ev["id"]: ev for ev in events
             if ev.get("act") == "op" and ev.get("agent") == agent
             and ev.get("room") == event.get("room")
             and isinstance(ev.get("batch"), dict)
             and ev["batch"].get("member_ids") == member_ids}
    for seq, eid in enumerate(member_ids):
        member = by_id.get(eid)
        if member is None:
            raise RoomError("bad_op", "op_id conflict")
        record = member["batch"]
        if (record.get("request_sha256") != digest
                or record.get("op_id") != batch.get("op_id")
                or record.get("count") != len(member_ids) or record.get("seq") != seq):
            raise RoomError("bad_op", "op_id conflict")
    return [dict(copy.deepcopy(by_id[eid]), replayed=True) for eid in member_ids]


def post(room, agent, act, text, *, re=None, to=None, evidence=(), plan=None, step=None,
         op=None, home=None, clock=None, templates=None, op_id=None, _typed_message=False,
         expected_opened_lamport=_UNFENCED):
    _validate_expected_opened_lamport(expected_opened_lamport)
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
    if _typed_message:
        if act not in MESSAGE_ACTS:
            raise RoomError("bad_act", "invalid coordination act")
        if not text.strip():
            raise RoomError("bad_op", "message text must not be blank")
    if op_id is not None and (not isinstance(op_id, str) or not OP_ID_RE.fullmatch(op_id)):
        raise RoomError("bad_op", "invalid op_id")
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
        op = copy.deepcopy(op)
    else:
        ts = None
    request_oid = op.get("op_id") if isinstance(op, dict) else None
    if op_id is not None:
        if request_oid is not None and request_oid != op_id:
            raise RoomError("bad_op", "op_id conflict")
        request_oid = op_id
    rdir = _room_dir(home, room)
    if _typed_message:
        evidence = _message_evidence(evidence)
        if request_oid is None:
            ev_list = _resolve_message_evidence(evidence, home)
        else:
            # Valid writes store the normalized path, which must match realpath.
            ev_list = [dict(item, path=os.path.abspath(item["path"])) for item in evidence]
        request_evidence = ev_list
    else:
        evidence = _request_evidence(evidence)
        request_evidence = evidence
        ev_list = []
    request = {"act": act, "text": text, "re": re, "to": to,
               "evidence": request_evidence, "op": op}
    if expected_opened_lamport is not _UNFENCED:
        request["expected_opened_lamport"] = expected_opened_lamport
    request_sha256 = _request_hash(request) if request_oid is not None else None
    if act == "op":
        ts = _resolve_ts(clock, True)
    # Identified retries compare caller paths before evidence-file I/O.
    if not _typed_message and request_oid is None:
        ev_list = _validate_evidence(evidence, rdir) if evidence else []
    # re existence pre-check (avoids creating room on bad_re)
    if re is not None:
        if not isinstance(re, str):
            raise RoomError("bad_re", "re must be string")
        if _typed_message:
            if not _ID_RE.fullmatch(re):
                raise RoomError("bad_re", "invalid reference id")
        elif request_oid is None:
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
    try:
        lockfd = os.open(lpath, os.O_CREAT | os.O_RDWR, 0o600)
    except OSError as exc:
        raise RoomError("internal", str(exc)) from exc
    try:
        try:
            os.chmod(lpath, 0o600)
        except OSError:
            pass
        try:
            _lock.lock_exclusive(lockfd)
        except TimeoutError as exc:
            raise RoomError("internal", "room lock timeout") from exc
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
            _check_plan_generation(parsed, expected_opened_lamport, home=home, templates=templates)
            if request_oid is not None:
                matched = _op_identity_index(parsed, agent, room).get(request_oid)
                if matched is not None:
                    if _typed_message:
                        payload = (to, act, text, re, ev_list)
                        _message_replay(parsed, room, agent, request_oid, payload)
                    return _single_replay(matched, request_sha256, typed=_typed_message,
                                          plan=plan, step=step)
            if _typed_message:
                _check_message_reference(parsed, room, agent, act, re)
                _verify_message_evidence(evidence, home)
            else:
                if request_oid is not None:
                    ev_list = _validate_evidence(evidence, rdir) if evidence else []
                if re is not None and request_oid is not None:
                    tgt = next((ev for ev in parsed if ev["id"] == re and ev["room"] == room), None)
                    if tgt is None:
                        raise RoomError("bad_re", "re not found")
                    if act == "answer" and tgt.get("act") != "question":
                        raise RoomError("bad_re", "answer must reference question")
                    if act == "ack" and tgt.get("act") != "handoff":
                        raise RoomError("bad_re", "ack must reference handoff")
            event = {
                "id": eid,
                "lamport": lamport,
                "ts": ts,
                "room": room,
                "agent": agent,
                "act": act,
                "text": text,
            }
            if op_id is not None:
                event["op_id"] = op_id
            if request_sha256 is not None:
                event["request_sha256"] = request_sha256
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
                    candidate, _ = apply_op_event(state, event, last_by_agent=last_by, **tpl_kw)
                    _admit_completion_evidence(state, candidate, op,
                                               templates=tpl_kw.get("templates"), home=home)
                except RoomError:
                    raise
                except Exception as e:
                    _raise_op(e)
            line = json.dumps(event, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
            lb = sep + line.encode("utf-8")
            if len(data) + len(lb) > _journal_ceiling([event]):
                raise RoomError("room_full", "room file cap exceeded")
            fd = os.open(epath, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
            try:
                try:
                    os.chmod(epath, 0o600)
                except OSError:
                    pass
                _write_all(fd, lb, len(data))
            finally:
                os.close(fd)
            return event
        finally:
            try:
                _lock.unlock(lockfd)
            except OSError:
                pass
    except OSError as exc:
        raise RoomError("internal", str(exc)) from exc
    finally:
        try:
            os.close(lockfd)
        except OSError:
            pass


def post_ops(room, agent, ops, *, strict=False, home=None, clock=None, templates=None,
             expected_opened_lamport=_UNFENCED, admit=None):
    """Commit a batch, optionally admitting its locked pre-commit projection.

    Exact replays return before admission. New batches run the callback while
    holding events.lock, before simulation or any journal append.
    """
    _validate_expected_opened_lamport(expected_opened_lamport)
    _check_room(room)
    _check_agent(agent)
    if not isinstance(ops, list) or not ops:
        raise RoomError("bad_op", "ops must be non-empty list")
    if not isinstance(strict, bool):
        raise RoomError("bad_op", "strict must be boolean")
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
    request = {"strict": strict, "ops": raw_ops}
    if expected_opened_lamport is not _UNFENCED:
        request["expected_opened_lamport"] = expected_opened_lamport
    request_sha256 = _request_hash(request)
    ts = _resolve_ts(clock, True)
    rdir = _ensure_dirs(home, room)
    epath = os.path.join(rdir, "events.jsonl")
    lpath = os.path.join(rdir, "events.lock")
    try:
        lockfd = os.open(lpath, os.O_CREAT | os.O_RDWR, 0o600)
    except OSError as exc:
        raise RoomError("internal", str(exc)) from exc
    try:
        try:
            os.chmod(lpath, 0o600)
        except OSError:
            pass
        try:
            _lock.lock_exclusive(lockfd)
        except TimeoutError as exc:
            raise RoomError("internal", "room lock timeout") from exc
        try:
            try:
                with open(epath, "rb") as f:
                    data = f.read()
            except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
                data = b""
            sep = b"\n" if (data and not data.endswith(b"\n")) else b""
            mx = _max_lamport_from_bytes(data)
            parsed, _ = _parse_events_bytes(data)
            _check_plan_generation(parsed, expected_opened_lamport, home=home, templates=templates)
            # One namespace for individually posted ops and batch members.
            identities = _op_identity_index(parsed, agent, room)
            member_oids = [o["op_id"] for o in raw_ops if "op_id" in o]
            if len(set(member_oids)) != len(member_oids):
                raise RoomError("bad_op", "op_id conflict")
            _batch_oid = raw_ops[0].get("op_id")
            matched = next((identities[oid] for oid in member_oids if oid in identities), None)
            if matched is not None:
                if (not isinstance(matched.get("batch"), dict)
                        or matched["batch"].get("op_id") != _batch_oid):
                    raise RoomError("bad_op", "op_id conflict")
                return _replay_batch(parsed, matched, agent, request_sha256)
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
            try:
                tpl_kw = _tpl_kw(home, templates, needed, strict=strict)
            except RoomError as exc:
                if not strict or exc.code != "unknown_template":
                    raise
                # Simulate only: a completion must report template_unavailable
                # before strict conformance's generic unknown_template error.
                # Non-completion batches still fail the strict gate below.
                tpl_kw = {}
            prior_state = fold_plan(parsed, **tpl_kw)
            if admit is not None:
                admit(prior_state)
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
            state = prior_state
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
                    candidate, _ = apply_op_event(copy.deepcopy(state), cand_event, last_by_agent=last_by, **tpl_kw)
                    _admit_completion_evidence(state, candidate, cand,
                                               templates=tpl_kw.get("templates"), home=home)
                    state = candidate
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
                     "request_sha256": request_sha256,
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
            if len(data) + len(payload) > _journal_ceiling(new_events):
                raise RoomError("room_full", "room file cap exceeded")
            fd = os.open(epath, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
            try:
                try:
                    os.chmod(epath, 0o600)
                except OSError:
                    pass
                _write_all(fd, payload, len(data))
            finally:
                os.close(fd)
            return new_events
        finally:
            try:
                _lock.unlock(lockfd)
            except OSError:
                pass
    except OSError as exc:
        raise RoomError("internal", str(exc)) from exc
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


_CHECKED_PREFIX_CACHE_SIZE = 16
_CheckedPrefix = namedtuple("_CheckedPrefix", "end digest head")
_checked_prefix_cache = OrderedDict()
_checked_prefix_lock = threading.Lock()


def _checked_validation_rules():
    return (
        _decode_event_line, json.loads, _is_valid_event, validate_op_shape,
        _validate_plan, _validate_step, _is_int, _is_safe_int, _is_safe_ts,
        _ID_RE, ROOM_RE, AGENT_RE, frozenset(ACTS), frozenset(STEP_STATES),
        _SAFE_MAX, _TS_MAX, OP_MAX_BYTES, sys.getrecursionlimit(),
        getattr(sys, "get_int_max_str_digits", lambda: None)(),
    )


def _read_checked_capture(data, path, room, since, reason):
    rules = _checked_validation_rules()
    key = (os.path.abspath(path), room, rules)
    with _checked_prefix_lock:
        proof = _checked_prefix_cache.get(key)
        if proof is not None:
            _checked_prefix_cache.move_to_end(key)

    start = hashed_end = 0
    head = None
    view = memoryview(data)
    digest = hashlib.sha256()
    if (proof is not None and proof.end <= len(data)
            and (proof.head is None or proof.head <= since)):
        hashed_end = proof.end
        digest.update(view[:hashed_end])
        if digest.digest() == proof.digest:
            start, head = proof.end, proof.head

    # A proof ends on a newline. Decode the remaining complete lines from
    # the same capture, including any formerly torn line now complete.
    captured = io.BytesIO(data)
    captured.seek(start)
    end = prefix_end = start
    prefix_head = head
    events = []
    invalid = False
    for raw in captured:
        if not raw.endswith(b"\n"):
            break
        end += len(raw)
        if raw.strip():
            event = _decode_event_line(raw[:-1])
            if event is None or event["room"] != room:
                invalid = True
                continue
            lamport = event["lamport"]
            if head is None or lamport > head:
                head = lamport
            if lamport > since:
                events.append(event)
        if not events:
            prefix_end, prefix_head = end, head
    if invalid:
        raise RoomError("room_read_failed", reason)

    # Retain the complete prefix before the first returned row. If that row
    # came first, a whole-capture proof still helps a later cursor at its head.
    if not prefix_end:
        prefix_end, prefix_head = end, head
    if prefix_end > start and rules == _checked_validation_rules():
        if prefix_end < hashed_end:
            digest = hashlib.sha256()
            hashed_end = 0
        digest.update(view[hashed_end:prefix_end])
        with _checked_prefix_lock:
            _checked_prefix_cache[key] = _CheckedPrefix(prefix_end, digest.digest(), prefix_head)
            _checked_prefix_cache.move_to_end(key)
            if len(_checked_prefix_cache) > _CHECKED_PREFIX_CACHE_SIZE:
                _checked_prefix_cache.popitem(last=False)
    return events, 0


def read_checked(room, since=0, *, home=None):
    """Read an existing journal without hiding broken committed records.

    Keep the legacy parser's blank-line and torn-tail rules, event order and
    duplicates. Validate the whole journal before applying the cursor filter.
    This reader never initializes storage or acquires a writer lock.
    """
    _check_room(room)
    if not _is_int(since) or since < 0:
        raise RoomError("bad_args", "since must be a non-negative integer")
    reason = "Room data could not be read."

    path = _events_path(home, room)
    try:
        if not stat.S_ISREG(os.stat(path).st_mode):
            raise RoomError("room_read_failed", reason)
        with open(path, "rb", opener=_open_nonblocking) as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise RoomError("room_read_failed", reason)
            data = stream.read()
    except OSError:
        raise RoomError("room_read_failed", reason) from None
    return _read_checked_capture(data, path, room, since, reason)


def wait(room, since, *, act=None, agent=None, exclude_agent=None, to=None, timeout_s=30.0,
         poll_s=0.2, home=None):
    timeout_s = _check_timing(timeout_s, "timeout_s")
    poll_s = _check_timing(poll_s, "poll_s")
    _check_room(room)
    deadline = time.monotonic() + timeout_s
    version = None
    while True:
        if _journal_stamp(home, room) != version:
            events, _head, version = _read_event_view(home, room)
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
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        time.sleep(min(poll_s if poll_s > 0 else 0.05, remaining))


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
    by_id = {e["id"]: e for e in evs if e.get("room") == room}
    for e in evs:
        r = e.get("re")
        if isinstance(r, str):
            if e.get("act") == "answer":
                answered.add(r)
                root = _question_root(by_id, r)
                if root is not None:
                    answered.add(root)
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
