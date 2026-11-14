"""U09 emitter: validation, redaction, canonical JSON and durable spool.

Single self-contained stdlib module (B1/B2). Imports nothing from siblings.

The behavioural contract is U09 SPEC B3-B10 plus ORACLE.md.
"""
import hashlib
import json
import math
import os
import re
import threading
import time

try:
    import fcntl
except ImportError:  # Windows: msvcrt is used at lock time.
    fcntl = None

EVENT_TEXT_MAX = 2000
RAW_ENVELOPE_MAX = 16384
MAX_PROJECTS = 12
RATE_PER_SEC = 20

PID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
EXT_ID_RE = re.compile(r"[a-p]{32}")
REDACT_CLASS_ORDER = (
    "PRIVATE_KEY", "BEARER", "JWT", "KEY_ASSIGN",
    "URL_CREDS", "APPCHECK_DEBUG", "EMAIL", "HIGH_ENTROPY",
)
KINDS = {
    "agent": ("output", "waiting_input", "error", "exit"),
    "ci": ("ci_started", "ci_passed", "ci_failed"),
    "git": ("commit", "push"),
    "local": ("file_changed", "proc_started", "proc_exited"),
}
SOURCES = frozenset(KINDS)
MAX_SAFE_INT = 2 ** 53 - 1

_MARKER_RE = re.compile(r"\[REDACTED:[A-Z_]+\]")


# --------------------------------------------------------------------------
# Canonical JSON (U08 B11): sorted keys, no whitespace, non-ASCII preserved.
# --------------------------------------------------------------------------
def canonical_json(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# --------------------------------------------------------------------------
# Config (WallConfig). Invalid -> None; callers map that to rc 7 / rc 2.
# --------------------------------------------------------------------------
def load_config(config):
    try:
        if config is None:
            from pathlib import Path
            path = Path(__file__).resolve().parent.parent / "wall.config.json"
            data = json.loads(path.read_text(encoding="utf-8"))
        elif isinstance(config, dict):
            data = config
        else:
            from pathlib import Path
            data = json.loads(Path(config).read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    v = data.get("v")
    if type(v) is not int or v != 1:
        return None
    ext = data.get("extensionId")
    if not isinstance(ext, str) or not EXT_ID_RE.fullmatch(ext):
        return None
    spool = data.get("spoolDir")
    if not isinstance(spool, str) or not spool:
        return None
    projects = data.get("projects")
    if not isinstance(projects, list) or len(projects) > MAX_PROJECTS:
        return None
    for p in projects:
        if not isinstance(p, dict):
            return None
        pid = p.get("projectId")
        if not isinstance(pid, str) or not PID_RE.fullmatch(pid):
            return None
        if "tier" not in p:
            return None
        tier = p["tier"]
        if tier not in ("private", "standard", "shared"):
            return None
        if "roots" not in p:
            return None
        if not isinstance(p["roots"], list) or any(not isinstance(x, str) for x in p["roots"]):
            return None
        if "transcripts" in p:
            if not isinstance(p["transcripts"], list) or any(not isinstance(x, str) for x in p["transcripts"]):
                return None
        if "pids" in p:
            if not isinstance(p["pids"], list) or any(type(x) is not int for x in p["pids"]):
                return None
        if "logs" in p:
            if not isinstance(p["logs"], list):
                return None
            for entry in p["logs"]:
                if not isinstance(entry, dict):
                    return None
                if "path" in entry and not isinstance(entry["path"], str):
                    return None
                if "passed" in entry and not isinstance(entry["passed"], str):
                    return None
                if "failed" in entry and not isinstance(entry["failed"], str):
                    return None
        if "label" in p and not isinstance(p["label"], str):
            return None
    return data


# --------------------------------------------------------------------------
# Redaction: 8 classes, RedactClass order, marker [REDACTED:<CLASS>].
# Idempotent: every pattern is designed not to match a marker it produced.
# --------------------------------------------------------------------------
_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?"
    r"-----END [A-Z0-9 ]*PRIVATE KEY-----")
_PRIVATE_KEY_TAIL_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$")

_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9\-._~+/=]+")

_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_\-]*\.eyJ[A-Za-z0-9_\-]*\.[A-Za-z0-9_\-]{4,}")

_KEY_ASSIGN_RE = re.compile(
    r"(?i)([A-Za-z0-9_\-]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|"
    r"ACCESS[_-]?KEY|CREDENTIAL|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET)"
    r"[A-Za-z0-9_\-]*)(\s*(?:=|:)\s*)(\"[^\"]*\"|'[^']*'|[^\s,\[\]]+)")

_URL_CREDS_RE = re.compile(
    r"://([A-Za-z0-9_\-.~%!$\&'()*+,;=]+):([^\s:@\[\]/]+)@")

_APPCHECK_RE = re.compile(
    r"(?i)\b(AppCheck debug token\s*:\s*)(\"[^\"]+\"|[^\s,\[\]]+)")

_EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+@\-/.:])[A-Za-z0-9._%+\-]+@"
    r"[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")

_HIGH_ENTROPY_RE = re.compile(r"[A-Za-z0-9+/=]{32,}")
_ENTROPY_MIN_LEN = 32
_ENTROPY_MIN_BITS = 3.5  # U08 INGEST_LIMITS


def _shannon_bits(s):
    counts = {}
    for c in s:
        counts[c] = counts.get(c, 0) + 1
    n = len(s)
    bits = 0.0
    for c in counts.values():
        p = c / n
        bits -= p * math.log2(p)
    return bits


def _redact_private_key(text):
    text, n1 = _PRIVATE_KEY_RE.subn("[REDACTED:PRIVATE_KEY]", text)
    text, n2 = _PRIVATE_KEY_TAIL_RE.subn("[REDACTED:PRIVATE_KEY]", text)
    return text, n1 + n2


def _redact_bearer(text):
    return _BEARER_RE.subn("Bearer [REDACTED:BEARER]", text)


def _redact_jwt(text):
    return _JWT_RE.subn("[REDACTED:JWT]", text)


def _redact_key_assign(text):
    return _KEY_ASSIGN_RE.subn(
        lambda m: m.group(1) + m.group(2) + "[REDACTED:KEY_ASSIGN]", text)


def _redact_url_creds(text):
    return _URL_CREDS_RE.subn(r"://\1:[REDACTED:URL_CREDS]@", text)


def _redact_appcheck(text):
    return _APPCHECK_RE.subn(r"\1[REDACTED:APPCHECK_DEBUG]", text)


def _redact_email(text):
    return _EMAIL_RE.subn("[REDACTED:EMAIL]", text)


def _redact_high_entropy(text):
    out = []
    total = 0
    last = 0
    for m in _HIGH_ENTROPY_RE.finditer(text):
        tok = m.group(0)
        if len(tok) < _ENTROPY_MIN_LEN:
            continue
        classes = 0
        if any("a" <= c <= "z" for c in tok):
            classes += 1
        if any("A" <= c <= "Z" for c in tok):
            classes += 1
        if any("0" <= c <= "9" for c in tok):
            classes += 1
        if classes < 2 or len(set(tok)) < 8:
            continue
        if _shannon_bits(tok) < _ENTROPY_MIN_BITS:
            continue
        out.append(text[last:m.start()])
        out.append("[REDACTED:HIGH_ENTROPY]")
        last = m.end()
        total += 1
    if not total:
        return text, 0
    out.append(text[last:])
    return "".join(out), total


_REDACTORS = (
    ("PRIVATE_KEY", _redact_private_key),
    ("BEARER", _redact_bearer),
    ("JWT", _redact_jwt),
    ("KEY_ASSIGN", _redact_key_assign),
    ("URL_CREDS", _redact_url_creds),
    ("APPCHECK_DEBUG", _redact_appcheck),
    ("EMAIL", _redact_email),
    ("HIGH_ENTROPY", _redact_high_entropy),
)


def redact(text, _disable=frozenset()):
    """Return (text, count, classes); classes unique, RedactClass order."""
    if not isinstance(text, str):
        return text, 0, []
    disabled = set(_disable) if _disable else set()
    total = 0
    hit = set()
    out = text
    for cls, fn in _REDACTORS:
        if cls in disabled:
            continue
        out2, n = fn(out)
        if n:
            total += n
            hit.add(cls)
            out = out2
    classes = [c for c in REDACT_CLASS_ORDER if c in hit]
    return out, total, classes


# --------------------------------------------------------------------------
# Cap (B7): 2000 UTF-16 code units, cut at limit-1 + "…".
# The cut never splits a surrogate pair or a redaction marker.
# --------------------------------------------------------------------------
def _utf16_len(s):
    return sum(2 if ord(c) > 0xFFFF else 1 for c in s)


def _apply_cap(text):
    if _utf16_len(text) <= EVENT_TEXT_MAX:
        return text
    budget = EVENT_TEXT_MAX - 1
    markers = [m.span() for m in _MARKER_RE.finditer(text)]
    n = len(text)
    used = 0
    k = 0
    while k < n:
        w = 2 if ord(text[k]) > 0xFFFF else 1
        if used + w > budget:
            break
        used += w
        k += 1
    cut = text[:k]
    for (s, e) in markers:
        if s < k < e:
            cut = text[:s]
            break
    return cut + "…"


def _has_control(text):
    for c in text:
        o = ord(c)
        if (o < 0x20 and c not in ("\n", "\t")) or o == 0x7F:
            return True
    return False


def _valid_spool_text(text):
    """Shared B3/B7 spool-text check: encodable, no controls, <= cap."""
    if not isinstance(text, str):
        return False
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    if _has_control(text):
        return False
    if _utf16_len(text) > EVENT_TEXT_MAX:
        return False
    return True


# --------------------------------------------------------------------------
# Rate limiter (B10): 20/s per project across processes; excess waits.
# Shared state lives in <spoolDir>/.rate.json under the spool lock.
# --------------------------------------------------------------------------
_RATE_FILE = ".rate.json"


def _rate_wait(spool_dir, project):
    while True:
        with _LockedSpool(spool_dir):
            rate_path = os.path.join(spool_dir, _RATE_FILE)
            try:
                with open(rate_path, encoding="utf-8") as fh:
                    data = json.loads(fh.read())
                if not isinstance(data, dict):
                    data = {}
            except Exception:
                data = {}
            stamps = data.get(project)
            if not isinstance(stamps, list):
                stamps = []
            cleaned = []
            for x in stamps:
                if isinstance(x, (int, float)) and not isinstance(x, bool):
                    cleaned.append(float(x))
            stamps = cleaned
            now = time.time()
            cutoff = now - 1.0
            stamps = [t for t in stamps if t > cutoff]
            if len(stamps) < RATE_PER_SEC:
                stamps.append(now)
                data[project] = stamps
                tmp = "%s.tmp.%d" % (rate_path, os.getpid())
                with open(tmp, "w", encoding="utf-8") as fh:
                    fh.write(canonical_json(data))
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp, rate_path)
                return
            wait = stamps[0] + 1.0 - now
        if wait > 0:
            time.sleep(wait)


# --------------------------------------------------------------------------
# Spool persistence (B8): exclusive lock, seq.json atomic replace.
# --------------------------------------------------------------------------
def _read_seq_file(path):
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.loads(fh.read())
        if not isinstance(d, dict):
            return {}
        out = {}
        for pk, mp in d.items():
            if isinstance(mp, dict):
                inner = {}
                for sk, sv in mp.items():
                    if type(sv) is int and sv >= 0:
                        inner[str(sk)] = sv
                if inner:
                    out[str(pk)] = inner
        return out
    except Exception:
        return {}


def _write_seq_file(path, data):
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(canonical_json(data))
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    try:
        dfd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


def _scan_spool_max(path, source):
    mx = 0
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return 0
    for line in raw.split(b"\n"):
        if not line:
            continue
        try:
            o = json.loads(line.decode("utf-8", "strict"))
        except Exception:
            continue
        if (isinstance(o, dict) and o.get("source") == source
                and type(o.get("sourceSeq")) is int and o["sourceSeq"] > mx):
            mx = o["sourceSeq"]
    return mx


def _scan_spool_count(path, kind):
    n = 0
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return 0
    for line in raw.split(b"\n"):
        if not line:
            continue
        try:
            o = json.loads(line.decode("utf-8", "strict"))
        except Exception:
            continue
        if isinstance(o, dict) and o.get("kind") == kind:
            n += 1
    return n


class _LockedSpool:
    def __init__(self, spool_dir):
        self._path = os.path.join(spool_dir, ".lock")
        self._fh = None

    def __enter__(self):
        self._fh = open(self._path, "a+b")
        if fcntl is not None:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX)
        else:
            import msvcrt
            self._fh.seek(0)
            msvcrt.locking(self._fh.fileno(), msvcrt.LK_LOCK, 1)
        return self

    def __exit__(self, *exc):
        try:
            if fcntl is not None:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
        except Exception:
            pass
        try:
            self._fh.close()
        except Exception:
            pass
        return False


# --------------------------------------------------------------------------
# emit()
# --------------------------------------------------------------------------
def _fail(rc, code):
    return {"ok": False, "rc": rc, "code": code}


def _emit_inner(project, kind, text, source, config, _clock, _disable):
    for v in (project, kind, text, source):
        if not isinstance(v, str):
            return _fail(2, "WRONG_TYPE")
    if not PID_RE.fullmatch(project):
        return _fail(2, "BAD_PROJECT_ID")
    if source not in KINDS:
        return _fail(2, "BAD_SOURCE")
    if kind not in KINDS[source]:
        return _fail(2, "BAD_KIND")
    if _has_control(text):
        return _fail(2, "CONTROL_CHAR")
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return _fail(2, "CONTROL_CHAR")
    if _clock is not None:
        try:
            ts = _clock()
        except Exception:
            return _fail(2, "BAD_INT")
    else:
        ts = int(time.time() * 1000)
    if type(ts) is not int or ts < 0 or ts > MAX_SAFE_INT:
        return _fail(2, "BAD_INT")
    cfg = load_config(config)
    if cfg is None:
        return _fail(7, "UNKNOWN_PROJECT")
    known = {p["projectId"] for p in cfg["projects"]}
    if project not in known:
        return _fail(7, "UNKNOWN_PROJECT")
    spool_dir = cfg["spoolDir"]
    redacted, _n, _classes = redact(text, _disable)
    _rescan, residue_count, _ = redact(redacted)
    if residue_count:
        return _fail(9, "REDACT_RESIDUE")
    capped = _apply_cap(redacted)
    # Unlocked overflow pre-check: no files created so rejected emits
    # leave the spool dir byte-identical (F2 + W5 tree-equality).
    try:
        pre_seq = os.path.join(str(spool_dir), "seq.json")
        pre_spool = os.path.join(str(spool_dir), project + ".jsonl")
        pre_data = _read_seq_file(pre_seq)
        pre_cur = pre_data.get(project, {}).get(source)
        if pre_cur is None:
            pre_cur = _scan_spool_max(pre_spool, source)
        if pre_cur + 1 > MAX_SAFE_INT:
            return _fail(2, "BAD_INT")
    except Exception:
        pass
    try:
        os.makedirs(spool_dir, exist_ok=True)
    except OSError:
        return _fail(1, "WRITE_FAILED")
    # Atomic admission+append (B10): rate timestamp and spool append share
    # one lock hold. The loop re-acquires the lock after sleeping so the
    # last admission check and the append are one critical section.
    while True:
        wait = 0.0
        try:
            with _LockedSpool(spool_dir):
                rate_path = os.path.join(spool_dir, _RATE_FILE)
                try:
                    with open(rate_path, encoding="utf-8") as fh:
                        rdata = json.loads(fh.read())
                    if not isinstance(rdata, dict):
                        rdata = {}
                except Exception:
                    rdata = {}
                stamps = rdata.get(project)
                if not isinstance(stamps, list):
                    stamps = []
                cleaned = []
                for x in stamps:
                    if isinstance(x, (int, float)) and not isinstance(x, bool):
                        cleaned.append(float(x))
                stamps = cleaned
                now = time.time()
                stamps = [t for t in stamps if t > now - 1.0]
                if len(stamps) >= RATE_PER_SEC:
                    wait = stamps[0] + 1.0 - now
                else:
                    stamps.append(now)
                    rdata[project] = stamps
                    tmp = "%s.tmp.%d" % (rate_path, os.getpid())
                    with open(tmp, "w", encoding="utf-8") as fh:
                        fh.write(canonical_json(rdata))
                        fh.flush()
                        os.fsync(fh.fileno())
                    os.replace(tmp, rate_path)
                    seq_path = os.path.join(spool_dir, "seq.json")
                    spool_path = os.path.join(spool_dir, project + ".jsonl")
                    data = _read_seq_file(seq_path)
                    cur = data.get(project, {}).get(source)
                    if cur is None:
                        cur = _scan_spool_max(spool_path, source)
                    new_seq = cur + 1
                    if new_seq > MAX_SAFE_INT:
                        return _fail(2, "BAD_INT")
                    envelope = {
                        "source": source, "projectId": project,
                        "sourceSeq": new_seq, "ts": ts, "kind": kind, "text": capped,
                    }
                    line = canonical_json(envelope)
                    line_bytes = (line + "\n").encode("utf-8")
                    digest = hashlib.sha256(line.encode("utf-8")).hexdigest()
                    if len(line_bytes) - 1 > RAW_ENVELOPE_MAX:
                        return _fail(1, "WRITE_FAILED")
                    try:
                        orig_size = 0
                        if os.path.exists(spool_path):
                            try:
                                orig_size = os.path.getsize(spool_path)
                            except OSError:
                                orig_size = 0
                        seq_backup = None
                        if os.path.exists(seq_path):
                            with open(seq_path, "rb") as bf:
                                seq_backup = bf.read()
                        data.setdefault(project, {})[source] = new_seq
                        _write_seq_file(seq_path, data)
                        try:
                            with open(spool_path, "ab") as out:
                                out.write(line_bytes)
                                out.flush()
                                os.fsync(out.fileno())
                        except OSError:
                            try:
                                with open(spool_path, "r+b") as rb:
                                    rb.truncate(orig_size)
                                    rb.flush()
                                    try:
                                        os.fsync(rb.fileno())
                                    except OSError:
                                        pass
                            except OSError:
                                pass
                            if seq_backup is not None:
                                tmp2 = "%s.tmp.%d" % (seq_path, os.getpid())
                                with open(tmp2, "wb") as bf:
                                    bf.write(seq_backup)
                                    bf.flush()
                                    try:
                                        os.fsync(bf.fileno())
                                    except OSError:
                                        pass
                                os.replace(tmp2, seq_path)
                            else:
                                try:
                                    os.unlink(seq_path)
                                except OSError:
                                    pass
                            raise
                    except OSError:
                        return _fail(1, "WRITE_FAILED")
                    return {"ok": True, "rc": 0, "seq": new_seq, "sha256": digest}
        except OSError:
            return _fail(1, "WRITE_FAILED")
        if wait > 0:
            time.sleep(wait)


def emit(project, kind, text, source="agent", *, config=None, _clock=None,
         _disable=frozenset()):
    """Append one redacted envelope to the spool. Never raises."""
    try:
        return _emit_inner(project, kind, text, source, config, _clock, _disable)
    except SystemExit:
        raise
    except Exception:
        return {"ok": False, "rc": 1, "code": "IO_ERROR"}


__all__ = [
    "emit", "redact", "canonical_json", "load_config",
    "EVENT_TEXT_MAX", "RAW_ENVELOPE_MAX", "MAX_PROJECTS", "RATE_PER_SEC",
]


