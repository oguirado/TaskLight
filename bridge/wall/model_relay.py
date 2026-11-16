"""Model relay: model_* frames between the wall extension and configured model endpoints (U48).

No network code here (bridge/wall is netscan-clean): HTTP lives in bridge.models.transport. One request
(probe or generate) runs at a time on a daemon worker thread; its outcome crosses a queue.Queue and is sent
only from poll() on the caller's thread. handle()/poll() never raise (BrokenPipeError from send excepted, so
the native host can exit). stderr carries one line per request, never prompts, completions, keys or URLs.

Watchdog (repair 1): every probe/generate has a relay-side deadline independent of the transport (budget from
`timeouts` + _GRACE_S, measured on time.monotonic). poll() past that deadline sends exactly one terminal frame
(generate: `model_nack timeout`; probe: `model_health offline`, as every probe failure), frees the lane, sets the
job's cancel event and keeps the still-running worker as "abandoned"; its late outcome is discarded by token.
At most _MAX_ABANDONED abandoned workers may be alive: while that many are, new probe/generate get `busy`, so
abandoned threads never accumulate without bound. Timeouts must be finite positive numbers (ValueError).
"""
import json
import os
import queue
import re
import sys
import threading
import time

from bridge.models import (
    FRAME_CANCEL, FRAME_GENERATE, FRAME_HEALTH, FRAME_HELLO, FRAME_LIST, FRAME_NACK, FRAME_PROBE, FRAME_RESULT,
    ID_RE, KIND_LOCAL, KIND_REMOTE, MAX_FRAME, NACK_CODES, RID_RE, ROLES, TIERS, TIMEOUT_LOCAL_GENERATE_MS,
    TIMEOUT_PROBE_MS, TIMEOUT_REMOTE_GENERATE_MS, V,
)
from bridge.models import store as _store
from bridge.models import transport as _transport
from bridge.models.common import body_too_large, build_body, probe_state

_JOIN_S = 1.0
_GRACE_S = 0.25          # lets the transport report its own (more precise) outcome first
_MAX_ABANDONED = 2
_INBOUND = (FRAME_LIST, FRAME_PROBE, FRAME_GENERATE, FRAME_CANCEL)
_GEN_KEYS = {"t", "v", "rid", "id", "tier", "messages", "max_tokens", "rung"}
ROOM_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
_TIER_ORDER = {"standard": 0, "shared": 1, "private": 2}


def load_model_config(cfg):
    """`models` must be {} or {"home": str}; anything else (or absent) -> None (relay off)."""
    try:
        if not isinstance(cfg, dict) or "models" not in cfg:
            return None
        m = cfg["models"]
        if not isinstance(m, dict) or set(m.keys()) - {"home"}:
            return None
        if "home" in m:
            if not isinstance(m["home"], str) or not m["home"]:
                return None
            return {"home": m["home"]}
        return {}
    except Exception:
        return None


def _resolve_home(mcfg, home):
    if home:
        return os.fspath(home)
    if isinstance(mcfg, dict) and isinstance(mcfg.get("home"), str) and mcfg["home"]:
        return mcfg["home"]
    env = os.environ.get("CW_HOME")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), ".context-wall")


def _is_int(v):
    return type(v) is int


def _rid_ok(v):
    return isinstance(v, str) and RID_RE.fullmatch(v) is not None


def _id_ok(v):
    return isinstance(v, str) and ID_RE.fullmatch(v) is not None


def _messages_ok(msgs):
    if not isinstance(msgs, list) or not (1 <= len(msgs) <= 32):
        return False
    for m in msgs:
        if not isinstance(m, dict) or set(m.keys()) != {"role", "content"}:
            return False
        if not isinstance(m["role"], str) or m["role"] not in ROLES or not isinstance(m["content"], str):
            return False
    return True


def _valid(obj):
    """Structural check of an inbound model frame. Returns True or False."""
    t = obj.get("t")
    if t not in _INBOUND or not _is_int(obj.get("v")) or obj.get("v") != V:
        return False
    keys = set(obj.keys())
    if t in (FRAME_LIST, FRAME_CANCEL):
        return keys == {"t", "v", "rid"} and _rid_ok(obj["rid"])
    if t == FRAME_PROBE:
        return keys == {"t", "v", "rid", "id"} and _rid_ok(obj["rid"]) and _id_ok(obj["id"])
    _allowed = _GEN_KEYS | {"schema", "room"}
    if not keys <= _allowed:
        return False
    if not _GEN_KEYS.issubset(keys):
        return False
    if not (_rid_ok(obj["rid"]) and _id_ok(obj["id"])):
        return False
    if not isinstance(obj["tier"], str) or obj["tier"] not in TIERS:
        return False
    if not _messages_ok(obj["messages"]):
        return False
    mt = obj["max_tokens"]
    if not _is_int(mt) or not (1 <= mt <= 8192):
        return False
    rung = obj["rung"]
    if not _is_int(rung) or rung not in (1, 2, 3):
        return False
    if "schema" in obj and not isinstance(obj["schema"], dict):
        return False
    if rung == 1 and "schema" not in obj:
        return False
    if "room" in obj:
        room = obj["room"]
        if not isinstance(room, str) or not ROOM_RE.fullmatch(room):
            return False
    return True


def _frame_bytes(obj):
    return len(json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def _timeout_s(t, name, default_ms):
    v = t.get(name, default_ms)
    if type(v) not in (int, float) or v != v or v in (float("inf"), float("-inf")) or v <= 0:
        raise ValueError("timeouts.%s must be a finite positive number of ms" % name)
    return float(v) / 1000.0


class _Job:
    __slots__ = ("token", "kind", "rid", "endpoint", "key", "frame", "body", "cancel", "cancelled", "thread", "t0",
                 "budget", "deadline", "watchdog")

    def __init__(self, token, kind, rid, endpoint, key, frame, body, t0):
        self.token, self.kind, self.rid = token, kind, rid
        self.endpoint, self.key, self.frame, self.body = endpoint, key, frame, body
        self.cancel, self.cancelled, self.thread, self.t0 = threading.Event(), False, None, t0
        self.budget = self.deadline = self.watchdog = None


class ModelRelay:
    def __init__(self, mcfg, send, *, home=None, clock=None, transport=None, timeouts=None, room_floors=None):
        self._send_fn = send
        self._home = _resolve_home(mcfg, home)
        self._clock = clock if callable(clock) else time.monotonic
        self._transport = transport if transport is not None else _transport
        if timeouts is not None and not isinstance(timeouts, dict):
            raise ValueError("timeouts must be a dict")
        t = timeouts or {}
        self._probe_s = _timeout_s(t, "probe_ms", TIMEOUT_PROBE_MS)
        self._local_s = _timeout_s(t, "local_generate_ms", TIMEOUT_LOCAL_GENERATE_MS)
        self._remote_s = _timeout_s(t, "remote_generate_ms", TIMEOUT_REMOTE_GENERATE_MS)
        self._abandoned = []
        self._q = queue.Queue()
        self._job = None
        self._token = 0
        self._rungs = {}
        self._closed = False
        self._stats = {"store_refused": 0, "structural": 0, "requests": 0, "results": 0, "health": 0,
                       "nacks": 0, "busy": 0, "cancelled": 0, "late_discarded": 0, "watchdog": 0}
        # Normalize room floors: map room slug -> tier (private/shared/standard)
        self._room_floors: dict = {}
        self._invalid_room_floors = room_floors is not None and not isinstance(room_floors, dict)
        if isinstance(room_floors, dict):
            for k, v in room_floors.items():
                if not isinstance(k, str):
                    continue
                if v == "ONLY_ON_DEVICE":
                    tier = "private"
                elif v == "PREFER_ON_DEVICE":
                    tier = "standard"
                elif isinstance(v, str) and v in _TIER_ORDER:
                    tier = v
                else:
                    tier = "private"
                self._room_floors[k] = tier

    # ------------------------------------------------------------ helpers
    def _bump(self, k, n=1):
        try:
            self._stats[k] = self._stats.get(k, 0) + n
        except Exception:
            pass

    def _try_send(self, frame):
        try:
            self._send_fn(frame)
            return True
        except BrokenPipeError:
            raise
        except Exception:
            return False

    def _log(self, frame_t, eid, status, t0):
        try:
            ms = max(0, int(round((self._clock() - t0) * 1000)))
            sys.stderr.write("models %s id=%s status=%s ms=%d\n" % (frame_t, eid, status, ms))
            sys.stderr.flush()
        except Exception:
            pass

    def _load(self):
        try:
            st = _store.load(self._home)
        except Exception:
            st = {"endpoints": [], "keys": {}, "refused": True}
        if st.get("refused"):
            self._bump("store_refused")
        return st

    def _nack(self, rid, code):
        self._bump("nacks")
        self._try_send({"t": FRAME_NACK, "v": V, "rid": rid, "code": code})

    def _health(self, rid, eid, state, endpoint):
        self._bump("health")
        self._try_send({"t": FRAME_HEALTH, "v": V, "rid": rid, "id": eid, "state": state,
                        "rung": self._rung_for(eid, endpoint)})

    def _rung_for(self, eid, endpoint):
        r = self._rungs.get(eid)
        if r in (1, 2, 3):
            return r
        r = endpoint.get("rung") if isinstance(endpoint, dict) else None
        return r if _is_int(r) and r in (1, 2, 3) else 2

    def _hello(self, rid=None):
        st = self._load()
        keys = st.get("keys") or {}
        eps = []
        for e in st.get("endpoints") or []:
            eps.append({"id": e["id"], "kind": e["kind"], "label": e["label"], "model": e["model"],
                        "loopback": e["kind"] == KIND_LOCAL, "has_key": bool(keys.get(e["id"])),
                        "allow_private": bool(e["allow_private"])})
        f = {"t": FRAME_HELLO, "v": V, "endpoints": eps}
        if rid is not None:
            f["rid"] = rid
        return f

    # ------------------------------------------------------------ public surface
    def hello_frame(self):
        try:
            return self._hello()
        except Exception:
            return {"t": FRAME_HELLO, "v": V, "endpoints": []}

    def stats(self):
        try:
            return {k: int(v) for k, v in self._stats.items()}
        except Exception:
            return {"store_refused": 0}

    def handle(self, frame):
        try:
            return self._handle(frame)
        except BrokenPipeError:
            raise
        except Exception:
            return 2

    def _handle(self, obj):
        if not isinstance(obj, dict):
            return None
        t = obj.get("t")
        if not isinstance(t, str) or not t.startswith("model_"):
            return None
        if not _valid(obj):
            self._bump("structural")
            return 2
        rid = obj["rid"]
        if t == FRAME_LIST:
            self._try_send(self._hello(rid))
            return 0
        if t == FRAME_CANCEL:
            job = self._job
            if job is not None and job.rid == rid and not job.cancelled:
                job.cancelled = True
                job.cancel.set()
                self._bump("cancelled")
                self._log(FRAME_GENERATE if job.kind == "generate" else FRAME_PROBE, job.endpoint["id"],
                          "cancelled", job.t0)
                self._nack(rid, "cancelled")
            return 0
        t0 = self._clock()
        eid = obj["id"]
        self._bump("requests")
        if self._job is not None or self._abandoned_alive() >= _MAX_ABANDONED:
            self._bump("busy")
            self._log(t, eid, "busy", t0)
            self._nack(rid, "busy")
            return 0
        st = self._load()
        endpoint = next((e for e in st.get("endpoints") or [] if e.get("id") == eid), None)
        if endpoint is None:
            self._log(t, eid, "unknown_endpoint", t0)
            self._nack(rid, "unknown_endpoint")
            return 0
        key = (st.get("keys") or {}).get(eid) or None
        remote = endpoint["kind"] == KIND_REMOTE
        if t == FRAME_PROBE:
            if not endpoint.get("enabled", True):
                self._log(t, eid, "blocked", t0)
                self._health(rid, eid, "blocked", endpoint)
                return 0
            if remote and not key:
                self._log(t, eid, "needs_setup", t0)
                self._health(rid, eid, "needs_setup", endpoint)
                return 0
            self._start(_Job(self._next(), "probe", rid, endpoint, key, obj, None, t0))
            return 0
        # model_generate: policy second gate (§2.3, R22), then key, then body cap
        # U80: effective tier = stricter(declared, room floor); unknown room -> policy; missing room -> strictest floor
        declared = obj["tier"]
        effective: str | None = None
        if self._invalid_room_floors:
            effective = "private"
        elif "room" in obj:
            room_name = obj["room"]
            if room_name not in self._room_floors:
                code_policy = "policy"
                self._log(t, eid, code_policy, t0)
                self._nack(rid, code_policy)
                return 0
            floor_tier = self._room_floors[room_name]
            effective = declared if _TIER_ORDER[declared] >= _TIER_ORDER[floor_tier] else floor_tier
        else:
            if not self._room_floors:
                effective = declared
            else:
                strictest = "standard"
                for v in self._room_floors.values():
                    if _TIER_ORDER[v] > _TIER_ORDER[strictest]:
                        strictest = v
                effective = declared if _TIER_ORDER[declared] >= _TIER_ORDER[strictest] else strictest
        tier = effective  # type: ignore[assignment]
        code = None
        if not endpoint.get("enabled", True):
            code = "policy"
        elif remote and tier in ("private", "shared"):
            code = "policy"
        elif not remote and tier == "private" and not endpoint.get("allow_private"):
            code = "policy"
        elif remote and not key:
            code = "needs_setup"
        body = None
        if code is None:
            body = build_body(endpoint, obj)
            if body_too_large(body):
                code = "too_large"
        if code is not None:
            self._log(t, eid, code, t0)
            self._nack(rid, code)
            return 0
        self._start(_Job(self._next(), "generate", rid, endpoint, key, obj, body, t0))
        return 0

    def _next(self):
        self._token += 1
        return self._token

    def _abandoned_alive(self):
        self._abandoned = [th for th in self._abandoned if th.is_alive()]
        return len(self._abandoned)

    def _start(self, job):
        if job.kind == "probe":
            job.budget = self._probe_s
        else:
            job.budget = self._remote_s if job.endpoint["kind"] == KIND_REMOTE else self._local_s
        now = time.monotonic()
        job.deadline = now + job.budget
        job.watchdog = job.deadline + _GRACE_S
        self._job = job
        th = threading.Thread(target=self._work, args=(job,), name="model-relay-worker", daemon=True)
        job.thread = th
        th.start()

    def _work(self, job):
        try:
            if job.kind == "probe":
                self._transport.probe(job.endpoint, job.key, job.budget)
                out = ("ok", None, None)
            else:
                text = self._transport.generate(job.endpoint, job.key, job.body, job.deadline, job.cancel)
                out = ("ok", text, None)
        except _transport.TransportError as e:
            code = e.code if isinstance(e.code, str) and e.code in NACK_CODES else "bad_reply"
            status = e.status if _is_int(e.status) else None
            out = ("err", code, status)
        except OSError:
            out = ("err", "offline", None)
        except Exception:
            out = ("err", "bad_reply", None)
        self._q.put((job.token, out))

    def poll(self):
        try:
            self._poll()
        except BrokenPipeError:
            raise
        except Exception:
            pass

    def _poll(self):
        while True:
            try:
                token, out = self._q.get_nowait()
            except queue.Empty:
                break
            job = self._job
            if job is None or job.token != token:
                self._bump("late_discarded")
                continue
            self._job = None
            if job.cancelled:
                self._bump("late_discarded")
                continue
            self._finish(job, out)
        self._watchdog()

    def _watchdog(self):
        job = self._job
        if job is None or job.watchdog is None or time.monotonic() < job.watchdog:
            return
        self._job = None                                # lane freed; the worker's late outcome is discarded
        job.cancel.set()
        th = job.thread
        if th is not None and th.is_alive():
            self._abandoned.append(th)
        self._bump("watchdog")
        if job.cancelled:                               # its terminal `cancelled` nack was already sent
            return
        self._finish(job, ("err", "timeout", None))

    def _finish(self, job, out):
        eid = job.endpoint["id"]
        status, val, http_status = out
        if job.kind == "probe":
            state = "available" if status == "ok" else probe_state(val)
            self._log(FRAME_PROBE, eid, "ok" if status == "ok" else val, job.t0)
            self._health(job.rid, eid, state, job.endpoint)
            return
        if status == "ok":
            if not isinstance(val, str):
                code = "bad_reply"
            else:
                frame = {"t": FRAME_RESULT, "v": V, "rid": job.rid, "text": val}
                try:
                    size = _frame_bytes(frame)
                except Exception:
                    size = None
                if size is None:
                    code = "bad_reply"
                elif size > MAX_FRAME:
                    code = "reply_too_large"
                else:
                    self._log(FRAME_GENERATE, eid, "ok", job.t0)
                    self._bump("results")
                    self._try_send(frame)
                    return
        else:
            code = val
            rung1 = job.frame.get("rung") == 1
            if code in ("http_error", "rung_unsupported") and http_status in (400, 422) and rung1:
                code = "rung_unsupported"
                self._rungs[eid] = 2
            elif code == "rung_unsupported":
                code = "http_error"
        self._log(FRAME_GENERATE, eid, code, job.t0)
        self._nack(job.rid, code)

    def close(self):
        try:
            self._closed = True
            job = self._job
            if job is not None:
                job.cancel.set()
                if job.thread is not None and job.thread is not threading.current_thread():
                    job.thread.join(_JOIN_S)
        except Exception:
            pass


__all__ = ["ModelRelay", "load_model_config"]
