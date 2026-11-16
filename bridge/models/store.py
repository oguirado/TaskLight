"""Endpoint/key store under <home>/models/. No network imports here (all network code is transport.py).

load(home) -> {"endpoints": [E...], "keys": {id: key}, "refused": bool}   (refused => both empty)
save_endpoints(home, endpoints)   -> None; raises ValueError on an invalid endpoint list
set_key(home, endpoint_id, key)   -> None; key None clears; unknown id -> KeyError
remove(home, endpoint_id)         -> None; also drops the key; unknown id -> KeyError
validate_endpoint(e)              -> None; raises ValueError
store_dir(home) -> str            (<home>/models)

Directory 0700, files 0600, owned by the current uid, never symlinks; any defect refuses the whole store
(including an unpaired surrogate in any endpoint string: the relay then serves no endpoint and model_hello is empty).
Writes: O_CREAT|O_EXCL|O_NOFOLLOW temp file + fsync + os.replace.
"""
import json
import os
import secrets
import stat

from . import ID_RE, KIND_LOCAL, KIND_REMOTE, KINDS, MAX_ENDPOINTS, MAX_STORE_BYTES
from .common import parse_base_url

ENDPOINTS_FILE = "endpoints.json"
KEYS_FILE = "keys.json"
STORE_VERSION = 1

_REQUIRED = ("id", "kind", "label", "base_url", "model", "allow_private", "enabled")
_ALLOWED = set(_REQUIRED) | {"rung"}
_MAX_KEY_LEN = 4096


class _Refused(Exception):
    pass


def store_dir(home):
    return os.path.join(os.fspath(home), "models")


def _has_surrogate(s):
    return any(0xD800 <= ord(c) <= 0xDFFF for c in s)


def validate_endpoint(e):
    if not isinstance(e, dict):
        raise ValueError("endpoint")
    keys = set(e.keys())
    if not keys <= _ALLOWED or not set(_REQUIRED) <= keys:
        raise ValueError("endpoint keys")
    for k in ("id", "kind", "label", "base_url", "model"):
        if isinstance(e[k], str) and _has_surrogate(e[k]):   # not UTF-8 encodable: never stored or served
            raise ValueError(k)
    i = e["id"]
    if not isinstance(i, str) or not ID_RE.fullmatch(i):
        raise ValueError("id")
    if e["kind"] not in KINDS or not isinstance(e["kind"], str):
        raise ValueError("kind")
    if not isinstance(e["label"], str) or len(e["label"]) > 64:
        raise ValueError("label")
    if not isinstance(e["model"], str) or not (1 <= len(e["model"]) <= 128):
        raise ValueError("model")
    for b in ("allow_private", "enabled"):
        if type(e[b]) is not bool:
            raise ValueError(b)
    if "rung" in e and (type(e["rung"]) is not int or e["rung"] not in (1, 2, 3)):
        raise ValueError("rung")
    scheme, _h, _p, _path = parse_base_url(e["base_url"])
    if e["kind"] == KIND_REMOTE:
        if scheme != "https":
            raise ValueError("remote endpoints are https only")
        if e["allow_private"]:
            raise ValueError("remote endpoints never allow private")
    elif e["kind"] == KIND_LOCAL and scheme not in ("http", "https"):
        raise ValueError("base_url")


def _validate_key(key):
    if not isinstance(key, str) or not (1 <= len(key) <= _MAX_KEY_LEN):
        raise ValueError("key")
    if any(ord(c) < 0x21 or ord(c) == 0x7F for c in key):
        raise ValueError("key")


def _validate_list(endpoints):
    if not isinstance(endpoints, list) or len(endpoints) > MAX_ENDPOINTS:
        raise ValueError("endpoints")
    seen = set()
    for e in endpoints:
        validate_endpoint(e)
        if e["id"] in seen:
            raise ValueError("duplicate id")
        seen.add(e["id"])


def _mode_ok(st):
    return st.st_uid == os.getuid() and not (st.st_mode & 0o077)


def _dir_ok(st):
    return stat.S_ISDIR(st.st_mode) and _mode_ok(st)


def _open_dir(d):
    """lstat + O_NOFOLLOW open + fstat. Returns fd, None when absent; raises _Refused."""
    try:
        st = os.lstat(d)
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError:
        raise _Refused()
    if not _dir_ok(st):
        raise _Refused()
    try:
        fd = os.open(d, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise _Refused()
    try:
        if not _dir_ok(os.fstat(fd)):
            raise _Refused()
    except BaseException:
        os.close(fd)
        raise
    return fd


def _read(dfd, name):
    """Bytes of a checked regular file, None when absent; raises _Refused."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dfd)
    except FileNotFoundError:
        return None
    except OSError:
        raise _Refused()
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or not _mode_ok(st) or st.st_size > MAX_STORE_BYTES:
            raise _Refused()
        chunks, total = [], 0
        while True:
            b = os.read(fd, 65536)
            if not b:
                break
            total += len(b)
            if total > MAX_STORE_BYTES:
                raise _Refused()
            chunks.append(b)
        return b"".join(chunks)
    except OSError:
        raise _Refused()
    finally:
        os.close(fd)


def _parse(raw, field):
    obj = json.loads(raw.decode("utf-8"))
    if not isinstance(obj, dict) or set(obj.keys()) != {"v", field}:
        raise ValueError("shape")
    if type(obj["v"]) is not int or obj["v"] != STORE_VERSION:
        raise ValueError("version")
    return obj[field]


def _load_strict(home):
    """Returns (endpoints, keys, existed). Raises _Refused on any defect."""
    dfd = _open_dir(store_dir(home))
    if dfd is None:
        return [], {}, False
    try:
        eraw = _read(dfd, ENDPOINTS_FILE)
        kraw = _read(dfd, KEYS_FILE)
    finally:
        os.close(dfd)
    try:
        endpoints = [] if eraw is None else _parse(eraw, "endpoints")
        _validate_list(endpoints)
        keys = {} if kraw is None else _parse(kraw, "keys")
        if not isinstance(keys, dict):
            raise ValueError("keys")
        for k, v in keys.items():
            if not isinstance(k, str) or not ID_RE.fullmatch(k):
                raise ValueError("key id")
            _validate_key(v)
    except (ValueError, KeyError, TypeError, RecursionError, MemoryError):   # deep nesting refuses the store
        raise _Refused() from None
    ids = {e["id"] for e in endpoints}
    keys = {k: v for k, v in keys.items() if k in ids}
    return endpoints, keys, True


def load(home):
    try:
        endpoints, keys, _ = _load_strict(home)
    except _Refused:
        return {"endpoints": [], "keys": {}, "refused": True}
    return {"endpoints": endpoints, "keys": keys, "refused": False}


# ---------------------------------------------------------------- writes
def _ensure_dir(home):
    d = store_dir(home)
    try:
        os.lstat(d)
    except FileNotFoundError:
        os.makedirs(os.fspath(home), mode=0o700, exist_ok=True)
        try:
            os.mkdir(d, 0o700)
        except FileExistsError:
            pass
        else:
            os.chmod(d, 0o700, follow_symlinks=False)
    try:
        fd = _open_dir(d)
    except _Refused:
        raise ValueError("models directory refused (mode, owner or symlink)") from None
    if fd is None:
        raise OSError("models directory missing")
    return fd


def _write(home, name, obj):
    data = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_STORE_BYTES:
        raise ValueError("store too large")
    dfd = _ensure_dir(home)
    tmp = ".%s.%s.tmp" % (name, secrets.token_hex(8))
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
        try:
            os.fchmod(fd, 0o600)
            view = memoryview(data)
            while view:
                n = os.write(fd, view)
                view = view[n:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
        tmp = None
        try:
            os.fsync(dfd)
        except OSError:
            pass
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp, dir_fd=dfd)
            except OSError:
                pass
        os.close(dfd)


def _current(home):
    try:
        return _load_strict(home)
    except _Refused:
        raise ValueError("store refused (endpoints.json/keys.json mode, owner, type or content)") from None


def save_endpoints(home, endpoints):
    _validate_list(endpoints)
    _write(home, ENDPOINTS_FILE, {"v": STORE_VERSION, "endpoints": [dict(e) for e in endpoints]})


def set_key(home, endpoint_id, key):
    endpoints, keys, _ = _current(home)
    if endpoint_id not in {e["id"] for e in endpoints}:
        raise KeyError(endpoint_id)
    keys = dict(keys)
    if key is None:
        keys.pop(endpoint_id, None)
    else:
        _validate_key(key)
        keys[endpoint_id] = key
    _write(home, KEYS_FILE, {"v": STORE_VERSION, "keys": keys})


def remove(home, endpoint_id):
    endpoints, keys, _ = _current(home)
    if endpoint_id not in {e["id"] for e in endpoints}:
        raise KeyError(endpoint_id)
    save_endpoints(home, [e for e in endpoints if e["id"] != endpoint_id])
    if endpoint_id in keys:
        keys = {k: v for k, v in keys.items() if k != endpoint_id}
        _write(home, KEYS_FILE, {"v": STORE_VERSION, "keys": keys})
