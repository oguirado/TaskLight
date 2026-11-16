"""U09 native host: Native Messaging framing, origin check, spool tail.

SPEC B13-B15. Framing is a 4-byte little-endian length prefix plus
UTF-8 JSON (S5 measured). Outbound frames stay <= 65536 bytes.
Stdout carries frames only; diagnostics go to stderr.
"""
import json
import os
import select
import struct
import sys
import threading
import time

from .emit import (
    EVENT_TEXT_MAX, KINDS, MAX_SAFE_INT, RAW_ENVELOPE_MAX, _valid_spool_text,
    load_config, redact,
)

try:
    from .room_relay import RoomRelay, load_room_config
except Exception:  # room relay unit not present yet
    RoomRelay = None
    load_room_config = None

try:
    from .model_relay import ModelRelay, load_model_config
except Exception:  # model relay absent, or bridge.models not importable (package run as top-level `wall`)
    ModelRelay = None
    load_model_config = None

MAX_FRAME = 65536
SIX_KEYS = {"source", "projectId", "sourceSeq", "ts", "kind", "text"}
_CHUNK = 65536
_POLL_S = 0.05
_FRAME_GRACE_S = 2.0  # a started frame that stalls longer is truncated


def _utf16_len(s):
    return sum(2 if ord(c) > 0xFFFF else 1 for c in s)


def _valid_envelope(obj, file_project):
    if not isinstance(obj, dict) or set(obj.keys()) != SIX_KEYS:
        return False
    src = obj.get("source")
    if not isinstance(src, str) or src not in KINDS:
        return False
    kind = obj.get("kind")
    if not isinstance(kind, str) or kind not in KINDS[src]:
        return False
    pid = obj.get("projectId")
    if not isinstance(pid, str) or pid != file_project:
        return False
    for key in ("sourceSeq", "ts"):
        v = obj.get(key)
        if type(v) is not int or v < 0 or v > MAX_SAFE_INT:
            return False
    if not _valid_spool_text(obj.get("text")):
        return False
    return True


def _parse_host_args(args):
    config = None
    pos = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--config":
            if i + 1 >= len(args):
                return None, None
            config = args[i + 1]
            i += 2
            continue
        if a.startswith("--config="):
            config = a[len("--config="):]
            i += 1
            continue
        if a.startswith("--"):
            return None, None
        pos.append(a)
        i += 1
    origin = pos[-1] if pos else None
    return config, origin


class _Host:
    def __init__(self, cfg, stdout, stderr):
        self._cfg = cfg
        self._stdout = stdout
        self._stderr = stderr
        self._spool = cfg["spoolDir"]
        self._projects = [p["projectId"] for p in cfg["projects"]]
        self._tiers = {}
        for p in cfg["projects"]:
            self._tiers.setdefault(p["projectId"], p.get("tier", "standard"))
        self._offsets = {pid: 0 for pid in self._projects}
        self._carry = {pid: b"" for pid in self._projects}
        self._skip = {pid: False for pid in self._projects}
        self._latest = {}
        self._send_lock = threading.Lock()

    def _log(self, msg):
        try:
            self._stderr.write(str(msg) + "\n")
            self._stderr.flush()
        except Exception:
            pass

    def _send(self, obj):
        try:
            try:
                body = json.dumps(obj, separators=(",", ":"),
                                  ensure_ascii=False).encode("utf-8")
            except UnicodeEncodeError:             # lone surrogate: send escaped ASCII JSON instead
                body = json.dumps(obj, separators=(",", ":"),
                                  ensure_ascii=True).encode("ascii")
        except (UnicodeEncodeError, ValueError, TypeError):
            self._log("dropping unencodable outbound frame")
            return False
        if len(body) > MAX_FRAME:
            self._log("dropping oversize outbound frame")
            return False
        with self._send_lock:
            self._stdout.write(struct.pack("<I", len(body)) + body)
            self._stdout.flush()
        return True

    def _floor(self, pid):
        return "ONLY_ON_DEVICE" if self._tiers.get(pid) == "private" \
            else "PREFER_ON_DEVICE"

    def _offer_line(self, pid, raw_line, line_offset):
        if len(raw_line) > RAW_ENVELOPE_MAX:
            return
        try:
            text = raw_line.decode("utf-8")
            obj = json.loads(text)
        except Exception:
            return
        if not _valid_envelope(obj, pid):
            return
        # Never forward an unredacted secret smuggled via direct spool
        # write: residue re-scan must be clean (F4).
        try:
            _txt, residue_n, _cls = redact(obj["text"])
        except Exception:
            return
        if residue_n:
            return
        self._latest[pid] = (obj, line_offset)
        self._send({"t": "event", "v": 1, "projectId": pid, "payload": obj,
                    "floor": self._floor(pid), "spoolOffset": line_offset})

    def poll_spool(self, pid):
        path = os.path.join(self._spool, pid + ".jsonl")
        try:
            size = os.path.getsize(path)
        except OSError:
            return
        off = self._offsets.get(pid, 0)
        if size < off:
            off = 0
            self._carry[pid] = b""
            self._skip[pid] = False
        if size == off:
            self._offsets[pid] = off
            return
        carry = bytearray(self._carry.get(pid, b""))
        skip = bool(self._skip.get(pid, False))
        # Byte offset of the first byte of the incomplete line held in
        # carry (meaningful only while skip is False).
        line_start = off - len(carry) if not skip else off
        file_pos = off
        try:
            fh = open(path, "rb")
        except OSError:
            return
        with fh:
            try:
                fh.seek(off)
            except OSError:
                return
            # Stream in bounded chunks so a multi-MiB newline-free record
            # (spool growth with Chrome closed) never materialises at
            # once. An incomplete line that already exceeds the envelope
            # cap is known-oversize: drop its bytes and discard until the
            # newline, so _carry stays bounded by RAW_ENVELOPE_MAX.
            while file_pos < size:
                want = min(_CHUNK, size - file_pos)
                try:
                    data = fh.read(want)
                except OSError:
                    break
                if not data:
                    break
                data_start = file_pos
                file_pos += len(data)
                pos = 0
                while pos < len(data):
                    nl = data.find(b"\n", pos)
                    if nl < 0:
                        if not skip:
                            carry.extend(data[pos:])
                            if len(carry) > RAW_ENVELOPE_MAX:
                                carry = bytearray()
                                skip = True
                        break
                    if not skip:
                        seg = data[pos:nl]
                        if len(carry) + len(seg) <= RAW_ENVELOPE_MAX:
                            self._offer_line(
                                pid, bytes(carry) + seg, line_start)
                    carry = bytearray()
                    skip = False
                    pos = nl + 1
                    line_start = data_start + pos
        self._carry[pid] = bytes(carry)
        self._skip[pid] = skip
        self._offsets[pid] = file_pos

    def poll_all(self):
        for pid in self._projects:
            self.poll_spool(pid)

    def resync(self):
        for pid in self._projects:
            if pid in self._latest:
                obj, off = self._latest[pid]
                self._send({"t": "event", "v": 1, "projectId": pid,
                            "payload": obj, "floor": self._floor(pid),
                            "spoolOffset": off})


def _build_relay(cfg, send):
    """Build RoomRelay+rcfg from cfg. Returns (relay, rcfg) or (None, None). Never raises."""
    loader = load_room_config
    ctor = RoomRelay
    if loader is None or ctor is None:
        try:
            from . import room_relay as _rr_mod
            if loader is None:
                loader = getattr(_rr_mod, "load_room_config", None)
            if ctor is None:
                ctor = getattr(_rr_mod, "RoomRelay", None)
        except Exception:
            return None, None
    if loader is None or ctor is None:
        return None, None
    try:
        rcfg = loader(cfg)
    except BrokenPipeError:
        raise
    except Exception:
        return None, None
    if rcfg is None or not isinstance(rcfg, dict):
        return None, None
    try:
        relay = ctor(rcfg, send)
    except BrokenPipeError:
        raise
    except Exception:
        return None, None
    try:
        relay.prime()
    except BrokenPipeError:
        raise
    except Exception:
        pass
    return relay, rcfg


def _room_hello_frame(rcfg):
    rooms = rcfg.get("rooms", []) if isinstance(rcfg, dict) else []
    agent = rcfg.get("agent", "wall-user") if isinstance(rcfg, dict) else "wall-user"
    frame = {"t": "room_hello", "v": 1, "rooms": rooms, "agent": agent}
    orch = rcfg.get("orchestrator") if isinstance(rcfg, dict) else None
    if orch is not None:
        frame["orchestrator"] = orch
    return frame


def _relay_poll(relay):
    if relay is None:
        return
    try:
        relay.poll()
    except BrokenPipeError:
        raise
    except Exception:
        pass


def _build_model_relay(cfg, send):
    """ModelRelay when wall.config.json has a valid "models" object, else None. Never raises."""
    loader = load_model_config
    ctor = ModelRelay
    if loader is None or ctor is None:
        return None
    try:
        mcfg = loader(cfg)
    except BrokenPipeError:
        raise
    except Exception:
        return None
    if mcfg is None or not isinstance(mcfg, dict):
        return None
    # U80: pass room floors from the same allow-list the room relay uses
    floors: dict = {}
    try:
        rooms_cfg = cfg.get("rooms") if isinstance(cfg, dict) else None
        if isinstance(rooms_cfg, dict):
            allow = rooms_cfg.get("allow")
            if isinstance(allow, list):
                for entry in allow:
                    if not isinstance(entry, dict):
                        continue
                    room = entry.get("room")
                    tier = entry.get("tier")
                    if not isinstance(room, str) or not isinstance(tier, str):
                        continue
                    # Map room tier to floor vocabulary understood by ModelRelay
                    if tier == "private":
                        floors[room] = "private"
                    elif tier == "standard":
                        floors[room] = "standard"
                    elif tier == "shared":
                        floors[room] = "shared"
                    elif tier == "ONLY_ON_DEVICE":
                        floors[room] = "private"
                    elif tier == "PREFER_ON_DEVICE":
                        floors[room] = "standard"
    except Exception:
        floors = {}
    try:
        return ctor(mcfg, send, room_floors=floors)
    except BrokenPipeError:
        raise
    except TypeError:
        # Fallback for legacy ModelRelay without room_floors kwarg
        try:
            return ctor(mcfg, send)
        except BrokenPipeError:
            raise
        except Exception:
            return None
    except Exception:
        return None
    except BrokenPipeError:
        raise
    except Exception:
        return None


def _model_poll(mrelay):
    if mrelay is None:
        return
    try:
        mrelay.poll()
    except BrokenPipeError:
        raise
    except Exception:
        pass


def _model_close(mrelay):
    if mrelay is None:
        return
    try:
        mrelay.close()
    except Exception:
        pass


def _handle_frame(host, body, relay=None, model_relay=None):
    """Process one inbound body. Returns 0 (bye), 2 (fatal) or None."""
    try:
        text = body.decode("utf-8")
        obj = json.loads(text)
    except Exception:
        return 2
    if relay is not None and isinstance(obj, dict):
        t0 = obj.get("t")
        if isinstance(t0, str) and t0.startswith("room_"):
            try:
                r = relay.handle(obj)
            except BrokenPipeError:
                raise
            except Exception:
                return None
            if r is None:
                pass  # fall through to strict check
            elif r == 2:
                return 2
            else:
                return None  # handled; the relay's 0 is not a bye
    if model_relay is not None and isinstance(obj, dict):
        t1 = obj.get("t")
        if isinstance(t1, str) and t1.startswith("model_"):
            try:
                r = model_relay.handle(obj)
            except BrokenPipeError:
                raise
            except Exception:
                return None
            if r is None:
                pass  # fall through to strict check
            elif r == 2:
                return 2
            else:
                return None  # handled; the relay's 0 is not a bye
    if not isinstance(obj, dict) or set(obj.keys()) != {"t", "v"}:
        return 2
    if type(obj.get("v")) is not int or obj.get("v") != 1:
        return 2
    t = obj.get("t")
    if t == "ping":
        return None
    if t == "bye":
        return 0
    if t == "resync":
        host.resync()
        return None
    return 2


def _process_buffer(host, buf, relay=None, model_relay=None):
    """Drain complete frames from buf. Returns 0/2 or None."""
    while len(buf) >= 4:
        (n,) = struct.unpack("<I", bytes(buf[:4]))
        if n == 0 or n > MAX_FRAME:
            return 2
        if len(buf) < 4 + n:
            break
        body = bytes(buf[4:4 + n])
        del buf[:4 + n]
        rc = _handle_frame(host, body, relay, model_relay)
        if rc is not None:
            return rc
    return None


def main(argv, stdin=None, stdout=None, stderr=None):
    args = list(argv) if argv is not None else []
    if stdin is None:
        stdin = sys.stdin.buffer
    if stdout is None:
        stdout = sys.stdout.buffer
    if stderr is None:
        stderr = sys.stderr
    config_arg, origin = _parse_host_args(args)
    cfg = load_config(config_arg)
    if cfg is None or origin is None:
        return 2
    expected = "chrome-extension://" + cfg["extensionId"] + "/"
    if origin != expected:
        return 2
    host = _Host(cfg, stdout, stderr)
    mrelay = None
    try:
        host._send({"t": "hello", "v": 1, "projects": host._projects})
        relay, rcfg = _build_relay(cfg, host._send)
        if relay is not None:
            try:
                host._send(_room_hello_frame(rcfg))
            except BrokenPipeError:
                raise
            except Exception:
                pass
        mrelay = _build_model_relay(cfg, host._send)
        if mrelay is not None:
            try:
                host._send(mrelay.hello_frame())
            except BrokenPipeError:
                raise
            except Exception:
                pass
        host.poll_all()
        _relay_poll(relay)
        _model_poll(mrelay)
        fd = stdin.fileno()
        try:
            os.set_blocking(fd, False)
        except (AttributeError, OSError):
            pass
        inbuf = bytearray()
        eof = False
        partial_since = None
        while True:
            # Buffered inbound frames are validated before any spool
            # polling: a fatal frame must exit with no event after it
            # (B14), even when a spool append races the stdin bytes.
            rc = _process_buffer(host, inbuf, relay, mrelay)
            if rc is not None:
                return rc
            host.poll_all()
            _relay_poll(relay)
            _model_poll(mrelay)
            if inbuf:
                now = time.monotonic()
                if partial_since is None:
                    partial_since = now
                elif now - partial_since > _FRAME_GRACE_S:
                    return 2
            else:
                partial_since = None
            if eof:
                return 2 if inbuf else 0
            try:
                r, _, _ = select.select([fd], [], [], _POLL_S)
            except (OSError, ValueError):
                r = []
            if r:
                try:
                    chunk = os.read(fd, 65536)
                except BlockingIOError:
                    chunk = None
                except OSError:
                    chunk = b""
                if chunk == b"":
                    eof = True
                elif chunk:
                    inbuf.extend(chunk)
    except BrokenPipeError:
        return 0
    except OSError:
        return 0
    finally:
        _model_close(mrelay)


__all__ = ["MAX_FRAME", "main"]
