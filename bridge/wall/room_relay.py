"""Room relay: room events to the wall over native messaging.

Stdlib only. Reads through bridge.room.store, redacts through
bridge.wall.emit.redact. Never writes to standard streams, never logs.
"""

import copy
import hashlib
import json
import math
import os
import re
import time

from bridge.room import store
from bridge.wall.emit import redact

ROOM_LIMITS = {
    "FRAME_MAX": 65536,
    "TEXT_MAX_BYTES": 4096,
    "REPLAY_MAX": 500,
    "POSTS_PER_SEC": 2,
    "ROOMS_MAX": 12,
}

_RID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
_OP_MAX_DEPTH = 32
_TEMPLATE_HASH_RE = re.compile(r"[0-9a-f]{64}")


def _op_id_surrogate(value):
    return "h-" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]


def _is_int(v):
    return type(v) is int


def load_room_config(cfg):
    """Validate cfg["rooms"] and return the relay config dict, or None."""
    try:
        if not isinstance(cfg, dict):
            return None
        rooms_cfg = cfg.get("rooms")
        if not isinstance(rooms_cfg, dict):
            return None
        if set(rooms_cfg.keys()) - {"allow", "agent", "orchestrator", "home"}:
            return None
        if "allow" not in rooms_cfg or "agent" not in rooms_cfg:
            return None
        allow = rooms_cfg.get("allow")
        agent = rooms_cfg.get("agent")
        if not isinstance(allow, list) or len(allow) == 0:
            return None
        if len(allow) > ROOM_LIMITS["ROOMS_MAX"]:
            return None
        if not isinstance(agent, str) or not store.AGENT_RE.fullmatch(agent):
            return None
        orchestrator = rooms_cfg.get("orchestrator")
        if orchestrator is not None:
            if not isinstance(orchestrator, str):
                return None
            if not store.AGENT_RE.fullmatch(orchestrator):
                return None
        home = rooms_cfg.get("home")
        if home is not None:
            if not isinstance(home, str) or home == "":
                return None
        seen = set()
        rooms_out = []
        for entry in allow:
            if not isinstance(entry, dict):
                return None
            if set(entry.keys()) != {"room", "tier"}:
                return None
            room = entry.get("room")
            tier = entry.get("tier")
            if not isinstance(room, str) or not store.ROOM_RE.fullmatch(room):
                return None
            if tier not in ("private", "standard"):
                return None
            if room in seen:
                return None
            seen.add(room)
            floor = "ONLY_ON_DEVICE" if tier == "private" else "PREFER_ON_DEVICE"
            rooms_out.append({"room": room, "floor": floor})
        return {
            "rooms": rooms_out,
            "agent": agent,
            "orchestrator": orchestrator,
            "home": home,
        }
    except Exception:
        return None


def _redact_str(s):
    """Redact one field value. Return the masked string, or None for residue."""
    try:
        redacted, _count, _classes = redact(s)
    except Exception:
        return None
    if not isinstance(redacted, str):
        return None
    try:
        _again, residue_count, _classes2 = redact(redacted)
    except Exception:
        return None
    if not isinstance(_again, str):
        return None
    if residue_count != 0:
        return None
    return redacted


def _sanitize_op(op):
    try:
        if not isinstance(op, dict):
            return None
        new_root = {}
        stack = [[op, new_root, 1, iter(list(op.items())), None]]
        while stack:
            frame = stack[-1]
            old = frame[0]
            new = frame[1]
            depth = frame[2]
            it = frame[3]
            try:
                item = next(it)
            except StopIteration:
                stack.pop()
                continue
            if isinstance(old, dict):
                k, v = item
                if not isinstance(k, str):
                    return None
                rk = _redact_str(k)
                if rk is None:
                    return None
                if rk in new:
                    return None
                # Only direct op evidence-list items share the hash exemption.
                is_hash = (depth == 1 and k == "template_hash") or (
                    frame[4] == "evidence_item" and k == "sha256")
                if is_hash and isinstance(v, str) and _TEMPLATE_HASH_RE.fullmatch(v):
                    try:
                        _r, _c, _classes = redact(v)
                    except Exception:
                        return None
                    try:
                        only_entropy = set(_classes) == {"HIGH_ENTROPY"}
                    except Exception:
                        return None
                    if only_entropy:
                        new[rk] = v
                        continue
                if depth == 1 and k == "op_id" and isinstance(v, str):
                    rv = _redact_str(v)
                    if rv is None:
                        return None
                    new[rk] = rv if rv == v else _op_id_surrogate(v)
                    continue
                if isinstance(v, dict) or isinstance(v, list):
                    if depth + 1 > _OP_MAX_DEPTH:
                        return None
                    if isinstance(v, dict):
                        new_child = {}
                        new[rk] = new_child
                        stack.append([v, new_child, depth + 1, iter(list(v.items())), None])
                    else:
                        new_child = []
                        new[rk] = new_child
                        context = "evidence_list" if depth == 1 and k == "evidence" else None
                        stack.append([v, new_child, depth + 1, iter(list(v)), context])
                elif isinstance(v, str):
                    rv = _redact_str(v)
                    if rv is None:
                        return None
                    new[rk] = rv
                elif v is None or isinstance(v, bool):
                    new[rk] = v
                elif isinstance(v, int):
                    new[rk] = v
                elif isinstance(v, float):
                    if not math.isfinite(v):
                        return None
                    new[rk] = v
                else:
                    return None
            else:
                v = item
                if isinstance(v, dict) or isinstance(v, list):
                    if depth + 1 > _OP_MAX_DEPTH:
                        return None
                    if isinstance(v, dict):
                        new_child = {}
                        new.append(new_child)
                        context = "evidence_item" if frame[4] == "evidence_list" else None
                        stack.append([v, new_child, depth + 1, iter(list(v.items())), context])
                    else:
                        new_child = []
                        new.append(new_child)
                        stack.append([v, new_child, depth + 1, iter(list(v)), None])
                elif isinstance(v, str):
                    rv = _redact_str(v)
                    if rv is None:
                        return None
                    new.append(rv)
                elif v is None or isinstance(v, bool):
                    new.append(v)
                elif isinstance(v, int):
                    new.append(v)
                elif isinstance(v, float):
                    if not math.isfinite(v):
                        return None
                    new.append(v)
                else:
                    return None
        return new_root
    except Exception:
        return None


def sanitize_event(ev):
    """Return a redacted deep copy of an event, or None if unusable."""
    if not isinstance(ev, dict):
        return None
    try:
        out = copy.deepcopy(ev)
    except Exception:
        return None
    out.pop("batch", None)
    if isinstance(out.get("text"), str):
        v = _redact_str(out["text"])
        if v is None:
            return None
        out["text"] = v
    plan = out.get("plan")
    if isinstance(plan, dict):
        if isinstance(plan.get("title"), str):
            v = _redact_str(plan["title"])
            if v is None:
                return None
            plan["title"] = v
        steps = plan.get("steps")
        if isinstance(steps, list):
            for st in steps:
                if not isinstance(st, dict):
                    continue
                for key in ("text", "accept"):
                    if isinstance(st.get(key), str):
                        v = _redact_str(st[key])
                        if v is None:
                            return None
                        st[key] = v
    step = out.get("step")
    if isinstance(step, dict):
        for key in ("outcome", "took"):
            if isinstance(step.get(key), str):
                v = _redact_str(step[key])
                if v is None:
                    return None
                step[key] = v
    evidence = out.get("evidence")
    if isinstance(evidence, list):
        for item in evidence:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("path"), str):
                v = _redact_str(item["path"])
                if v is None:
                    return None
                item["path"] = v
    op_present = "op" in out
    op_val = out.get("op")
    if out.get("act") == "op":
        if not isinstance(op_val, dict):
            return None
    elif op_present and op_val is not None and not isinstance(op_val, dict):
        return None
    if isinstance(op_val, dict):
        redacted_op = _sanitize_op(op_val)
        if redacted_op is None:
            return None
        out["op"] = redacted_op
    return out


def _frame_oversize(frame):
    try:
        data = json.dumps(frame, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except Exception:
        return True
    return len(data) > ROOM_LIMITS["FRAME_MAX"]


class RoomRelay:
    """Live poll plus upstream frame handling for allowed rooms."""

    def __init__(self, rcfg, send, *, home=None, clock=None):
        try:
            self._send = send
            self._clock = time.monotonic if clock is None else clock
            if home is not None:
                self._home = home
            elif isinstance(rcfg, dict) and rcfg.get("home") is not None:
                self._home = rcfg.get("home")
            else:
                self._home = None
            rooms = []
            agent = None
            if isinstance(rcfg, dict):
                raw = rcfg.get("rooms")
                agent = rcfg.get("agent")
                if isinstance(raw, list):
                    for r in raw:
                        if isinstance(r, dict) and isinstance(r.get("room"), str) and isinstance(r.get("floor"), str):
                            rooms.append({"room": r["room"], "floor": r["floor"]})
            self._rooms = rooms
            self._floor = {r["room"]: r["floor"] for r in rooms}
            self._agent = agent if isinstance(agent, str) else None
            self._cursors = {r["room"]: 0 for r in rooms}
            self._stats = {
                "events_sent": 0,
                "dropped_residue": 0,
                "dropped_oversize": 0,
                "posts_acked": 0,
                "posts_refused": 0,
                "structural": 0,
            }
            self._post_stamps = []
        except Exception:
            # Constructor must not raise; fall back to empty state.
            try:
                self._send = send
                self._clock = time.monotonic
                self._home = home
                self._rooms = []
                self._floor = {}
                self._agent = None
                self._cursors = {}
                self._stats = {
                    "events_sent": 0,
                    "dropped_residue": 0,
                    "dropped_oversize": 0,
                    "posts_acked": 0,
                    "posts_refused": 0,
                    "structural": 0,
                }
                self._post_stamps = []
            except Exception:
                pass

    def _now(self):
        try:
            raw = self._clock()
            if isinstance(raw, bool):
                return None
            v = float(raw)
        except Exception:
            return None
        if not math.isfinite(v):
            return None
        return v

    def _try_send(self, frame):
        try:
            self._send(frame)
            return True
        except Exception:
            return False

    def _structural(self):
        try:
            self._stats["structural"] += 1
        except Exception:
            pass
        return 2

    def _read_sorted(self, room, since):
        try:
            events, _malformed = store.read(room, since, home=self._home)
        except Exception:
            return []
        out = []
        try:
            if not isinstance(events, list):
                return []
            for e in events:
                if isinstance(e, dict) and _is_int(e.get("lamport")):
                    out.append(e)
            out.sort(key=lambda e: e["lamport"])
        except Exception:
            return []
        return out

    def _room_dir_exists(self, room):
        try:
            home = self._home
            if home is None:
                env = os.environ.get("CW_HOME")
                if env:
                    home = env
                else:
                    home = os.path.join(os.path.expanduser("~"), ".context-wall")
            base = os.fspath(home)
            return os.path.isdir(os.path.join(base, "rooms", room))
        except Exception:
            return False

    def prime(self):
        try:
            for info in self._rooms:
                room = info["room"]
                try:
                    events, _malformed = store.read(room, 0, home=self._home)
                except Exception:
                    self._cursors[room] = 0
                    continue
                mx = 0
                try:
                    if isinstance(events, list):
                        for e in events:
                            if isinstance(e, dict):
                                lam = e.get("lamport")
                                if _is_int(lam) and lam > mx:
                                    mx = lam
                except Exception:
                    mx = mx if _is_int(mx) else 0
                self._cursors[room] = mx
        except Exception:
            pass
        return None

    def poll(self):
        sent = 0
        try:
            for info in self._rooms:
                room = info["room"]
                floor = info["floor"]
                cursor = self._cursors.get(room, 0)
                events = self._read_sorted(room, cursor)
                for e in events:
                    lam = e["lamport"]
                    clean = sanitize_event(e)
                    if clean is None:
                        self._stats["dropped_residue"] += 1
                        cursor = lam
                        self._cursors[room] = cursor
                        continue
                    frame = {"t": "room_event", "v": 1, "room": room, "floor": floor, "event": clean}
                    if _frame_oversize(frame):
                        self._stats["dropped_oversize"] += 1
                        cursor = lam
                        self._cursors[room] = cursor
                        continue
                    if not self._try_send(frame):
                        break
                    self._stats["events_sent"] += 1
                    sent += 1
                    cursor = lam
                    self._cursors[room] = cursor
                try:
                    self._cursors[room] = cursor
                except Exception:
                    pass
        except Exception:
            pass
        return sent

    def _handle_sync(self, frame):
        if set(frame.keys()) != {"t", "v", "rid", "since"}:
            return self._structural()
        v = frame.get("v")
        if not _is_int(v) or v != 1:
            return self._structural()
        rid = frame.get("rid")
        if not isinstance(rid, str) or not _RID_RE.fullmatch(rid):
            return self._structural()
        since = frame.get("since")
        if not isinstance(since, dict):
            return self._structural()
        for k, val in since.items():
            if not isinstance(k, str):
                return self._structural()
            if not _is_int(val) or val < 0:
                return self._structural()
        for room, since_val in since.items():
            if room not in self._floor:
                continue
            floor = self._floor[room]
            evs = self._read_sorted(room, since_val)
            total = len(evs)
            chunk = evs[: ROOM_LIMITS["REPLAY_MAX"]]
            upto = chunk[-1]["lamport"] if chunk else since_val
            more = total > ROOM_LIMITS["REPLAY_MAX"]
            failed = False
            for e in chunk:
                clean = sanitize_event(e)
                if clean is None:
                    self._stats["dropped_residue"] += 1
                    continue
                out_frame = {
                    "t": "room_event",
                    "v": 1,
                    "room": room,
                    "floor": floor,
                    "event": clean,
                    "rid": rid,
                }
                if _frame_oversize(out_frame):
                    self._stats["dropped_oversize"] += 1
                    continue
                if not self._try_send(out_frame):
                    failed = True
                    break
                self._stats["events_sent"] += 1
            if failed:
                return 0
            self._try_send({"t": "room_synced", "v": 1, "rid": rid, "room": room, "upto": upto, "more": more})
        return 0

    def _nack(self, rid, code):
        self._stats["posts_refused"] += 1
        self._try_send({"t": "room_nack", "v": 1, "rid": rid, "code": code})
        return 0

    def _handle_post(self, frame):
        keys = set(frame.keys())
        if not {"t", "v", "rid", "room", "act", "text"}.issubset(keys):
            return self._structural()
        if not keys.issubset({"t", "v", "rid", "room", "act", "text", "to", "re"}):
            return self._structural()
        v = frame.get("v")
        if not _is_int(v) or v != 1:
            return self._structural()
        rid = frame.get("rid")
        if not isinstance(rid, str) or not _RID_RE.fullmatch(rid):
            return self._structural()
        room = frame.get("room")
        if not isinstance(room, str):
            return self._structural()
        text = frame.get("text")
        if not isinstance(text, str):
            return self._structural()
        if frame.get("act") != "question":
            return self._structural()
        if "to" in frame and not isinstance(frame["to"], str):
            return self._structural()
        if "re" in frame and not isinstance(frame["re"], str):
            return self._structural()
        if room not in self._floor:
            return self._nack(rid, "room_not_allowed")
        if not self._room_dir_exists(room):
            return self._nack(rid, "room_not_allowed")
        try:
            nbytes = len(text.encode("utf-8"))
        except Exception:
            return self._nack(rid, "bad_args")
        if nbytes > ROOM_LIMITS["TEXT_MAX_BYTES"]:
            return self._nack(rid, "text_too_long")
        if text == "" or any(ord(c) < 0x20 for c in text):
            return self._nack(rid, "bad_args")
        now = self._now()
        if now is None:
            return self._nack(rid, "rate_limited")
        cutoff = now - 1.0
        self._post_stamps = [t for t in self._post_stamps if t > cutoff]
        if len(self._post_stamps) >= ROOM_LIMITS["POSTS_PER_SEC"]:
            return self._nack(rid, "rate_limited")
        kwargs = {}
        if "to" in frame:
            kwargs["to"] = frame["to"]
        if "re" in frame:
            kwargs["re"] = frame["re"]
        try:
            event = store.post(room, self._agent, "question", text, home=self._home, **kwargs)
        except store.RoomError as exc:
            code = exc.code if isinstance(getattr(exc, "code", None), str) else "bad_args"
            return self._nack(rid, code)
        except Exception:
            return self._nack(rid, "bad_args")
        self._post_stamps.append(now)
        self._stats["posts_acked"] += 1
        ack_id = event.get("id") if isinstance(event, dict) else None
        ack_lam = event.get("lamport") if isinstance(event, dict) else None
        self._try_send({"t": "room_ack", "v": 1, "rid": rid, "id": ack_id, "lamport": ack_lam})
        return 0

    def handle(self, frame):
        try:
            if not isinstance(frame, dict):
                return None
            t = frame.get("t")
            if t == "room_sync":
                return self._handle_sync(frame)
            if t == "room_post":
                return self._handle_post(frame)
            return None
        except Exception:
            try:
                if isinstance(frame, dict) and frame.get("t") in ("room_sync", "room_post"):
                    return 2
            except Exception:
                pass
            return None

    def stats(self):
        try:
            return dict(self._stats)
        except Exception:
            return {
                "events_sent": 0,
                "dropped_residue": 0,
                "dropped_oversize": 0,
                "posts_acked": 0,
                "posts_refused": 0,
                "structural": 0,
            }
