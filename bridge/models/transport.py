"""The ONLY module of the models package allowed to import socket/ssl/http (http.client only, never urllib).

TransportError(code, status=None): `code` is one of bridge.models.NACK_CODES.
probe(E, key, timeout_s, *, resolver=None) -> None            (GET <base>/models, 2xx = ok; else raises TransportError)
generate(E, key, body, deadline, cancel, *, resolver=None) -> str   (POST <base>/chat/completions, stream:false;
    body = dict; deadline = absolute time.monotonic() seconds; cancel = object with is_set(); returns
    choices[0].message.content verbatim; else raises TransportError)
check_loopback(host, port, *, resolver=None) -> list[str]     (resolved IPs, all loopback; else TransportError not_loopback)
`resolver` has the signature of socket.getaddrinfo(host, port, type=...) and defaults to it.

Total budget: resolution runs on a helper daemon thread joined with the remaining budget; the socket timeout is
recomputed before every operation; the body is read in <= 16 KiB read1() chunks with a deadline check between
reads; a guard timer shuts the connection down at the deadline so a peer trickling header or body bytes cannot
outlast it. Any overrun raises TransportError("timeout").
At most _MAX_RESOLVERS resolver helpers may be outstanding process-wide (a timed-out helper stays alive until the
resolver returns); when all slots are taken a new request fails fast with TransportError("timeout") without
spawning a thread (its budget cannot be met; "timeout" keeps probe -> health `offline` and generate -> nack
`timeout` mapping unchanged). Each helper releases its slot when the resolver returns or raises.
Resolution happens exactly once per request and the socket connects to the resolved IP (pinned); the Host
header and TLS server_hostname keep the name. 3xx is never followed. Errors carry only a code and a status.
"""
import http.client
import ipaddress
import json
import select
import socket
import ssl
import os
import threading
import time

from . import KIND_LOCAL, KIND_REMOTE, MAX_REPLY_BYTES, MAX_REQUEST_BODY
from .common import encode_body, host_header, parse_base_url

_SLICE_S = 0.05
_CHUNK = 16384
_RESOLVE_DEFAULT_S = 10.0                              # check_loopback (CLI add) has no caller deadline
_MAX_RESOLVERS = 2                                     # outstanding resolver helper threads, process-wide
_resolver_slots = threading.BoundedSemaphore(_MAX_RESOLVERS)


class TransportError(Exception):
    def __init__(self, code, status=None):
        Exception.__init__(self, code)
        self.code = code
        self.status = status


class _NoCancel:
    @staticmethod
    def is_set():
        return False


def _resolve(host, port, resolver, deadline=None):
    """Resolver (injected or getaddrinfo) on a helper daemon thread, bounded by the remaining budget."""
    fn = resolver if resolver is not None else socket.getaddrinfo
    if deadline is None:
        deadline = time.monotonic() + _RESOLVE_DEFAULT_S
    box = {}
    if not _resolver_slots.acquire(blocking=False):
        raise TransportError("timeout")               # every helper slot held by a hung resolver: fail fast

    def run():
        try:
            box["infos"] = fn(host, port, type=socket.SOCK_STREAM)
        except BaseException:                          # noqa: BLE001 - mapped to offline below
            box["err"] = True
        finally:
            _resolver_slots.release()

    th = threading.Thread(target=run, name="model-transport-resolve", daemon=True)
    try:
        th.start()
    except BaseException:
        _resolver_slots.release()
        raise TransportError("offline") from None
    th.join(max(0.0, deadline - time.monotonic()))
    if th.is_alive():
        raise TransportError("timeout")               # abandoned daemon thread; its result is ignored
    if "err" in box or "infos" not in box:
        raise TransportError("offline")
    infos = box["infos"]
    out = []
    try:
        for info in infos or ():
            fam, sa = info[0], info[4]
            if (fam, sa) not in out:
                out.append((fam, sa))
    except Exception:
        raise TransportError("offline") from None
    if not out:
        raise TransportError("offline")
    return out


def _is_loopback(ip):
    try:
        a = ipaddress.ip_address(str(ip).split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped is not None:
        a = a.ipv4_mapped
    return a.is_loopback


def _require_loopback(addrs):
    if not all(_is_loopback(sa[0]) for _fam, sa in addrs):
        raise TransportError("not_loopback")


def check_loopback(host, port, *, resolver=None):
    addrs = _resolve(host, port, resolver)
    _require_loopback(addrs)
    return [sa[0] for _fam, sa in addrs]


def _check(deadline, cancel):
    if cancel.is_set():
        raise TransportError("cancelled")
    if time.monotonic() >= deadline:
        raise TransportError("timeout")


def _remaining(deadline):
    return max(0.001, deadline - time.monotonic())


def _connect(addrs, deadline, cancel):
    for fam, sa in addrs:
        _check(deadline, cancel)
        s = socket.socket(fam, socket.SOCK_STREAM)
        s.settimeout(_remaining(deadline))
        try:
            s.connect(sa)
            return s
        except TimeoutError:
            s.close()
            raise TransportError("timeout") from None
        except OSError:
            s.close()
    raise TransportError("offline")


def _status_error(status):
    if 300 <= status < 400:
        return TransportError("redirect", status)
    if status in (401, 403):
        return TransportError("auth", status)
    if status == 429:
        return TransportError("rate_limited", status)
    return TransportError("http_error", status)


def _content(raw):
    try:
        obj = json.loads(raw)
        content = obj["choices"][0]["message"]["content"]
    except Exception:
        raise TransportError("bad_reply") from None
    if not isinstance(content, str) or not isinstance(obj, dict) or not isinstance(obj["choices"], list):
        raise TransportError("bad_reply")
    return content


def _exchange(endpoint, key, method, sub, data, deadline, cancel, resolver):
    kind = endpoint.get("kind")
    try:
        scheme, host, port, path = parse_base_url(endpoint.get("base_url"))
    except ValueError:
        raise TransportError("policy") from None
    if kind not in (KIND_LOCAL, KIND_REMOTE) or (kind == KIND_REMOTE and scheme != "https"):
        raise TransportError("policy")
    _check(deadline, cancel)
    addrs = _resolve(host, port, resolver, deadline)
    if kind == KIND_LOCAL:
        _require_loopback(addrs)
    _check(deadline, cancel)
    sock = _connect(addrs, deadline, cancel)
    conn = None
    guard = timer = None
    try:
        guard = _Guard(sock, deadline)
        if scheme == "https":
            sock.settimeout(_remaining(deadline))
            try:
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
            except Exception:
                raise TransportError("offline") from None
        conn = http.client.HTTPConnection(host, port, timeout=_remaining(deadline))
        conn.sock = sock
        conn.putrequest(method, (path or "") + sub, skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", host_header(scheme, host, port))
        conn.putheader("Accept", "application/json")
        conn.putheader("Connection", "close")
        if key:
            conn.putheader("Authorization", "Bearer " + key)
        if data is not None:
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", str(len(data)))
        sock.settimeout(_remaining(deadline))
        conn.endheaders(data)
        while True:                                    # wait for the reply, honouring cancel and deadline
            _check(deadline, cancel)
            r, _w, _x = select.select([sock], [], [], min(_SLICE_S, _remaining(deadline)))
            if r:
                break
        _check(deadline, cancel)
        sock.settimeout(_remaining(deadline))
        resp = conn.getresponse()                      # header trickle: bounded by the guard shutdown
        _check(deadline, cancel)
        if not (200 <= resp.status < 300):
            raise _status_error(resp.status)
        if method == "GET":
            return None
        cl = resp.getheader("Content-Length")
        if cl is not None and cl.strip().isdigit() and int(cl) > MAX_REPLY_BYTES:
            raise TransportError("bad_reply")
        chunks, total = [], 0
        while True:
            if resp.isclosed():                        # Content-Length consumed: http.client released the socket
                break
            _check(deadline, cancel)
            sock.settimeout(_remaining(deadline))      # recomputed before every read
            b = resp.read1(min(_CHUNK, MAX_REPLY_BYTES + 1 - total))
            if not b:
                break
            total += len(b)
            if total > MAX_REPLY_BYTES:
                raise TransportError("bad_reply")
            chunks.append(b)
        return _content(b"".join(chunks))
    except TransportError:
        if guard is not None and guard.fired and not cancel.is_set():
            raise TransportError("timeout") from None
        raise
    except TimeoutError:
        raise TransportError("timeout") from None
    except Exception:
        if cancel.is_set():
            raise TransportError("cancelled") from None
        if (guard is not None and guard.fired) or time.monotonic() >= deadline:
            raise TransportError("timeout") from None
        _raise_mapped()
    finally:
        if guard is not None:
            guard.cancel()
        try:
            if conn is not None:
                conn.close()
            sock.close()
        except Exception:
            pass


def _raise_mapped():
    """Map the exception being handled (not a deadline overrun) to a code."""
    try:
        raise
    except ssl.SSLError:
        raise TransportError("offline") from None
    except ConnectionError:
        raise TransportError("offline") from None
    except http.client.HTTPException:
        raise TransportError("bad_reply") from None
    except OSError:
        raise TransportError("offline") from None
    except Exception:
        raise TransportError("bad_reply") from None


class _Guard:
    """Shuts the connection down at the deadline (dup'd fd, so it also works after the TLS wrap)."""

    def __init__(self, sock, deadline):
        self.fired = False
        self._dup = socket.socket(fileno=os.dup(sock.fileno()))
        self._lock = threading.Lock()
        self._done = False
        self._t = threading.Timer(max(0.0, deadline - time.monotonic()), self._fire)
        self._t.daemon = True
        self._t.name = "model-transport-guard"
        self._t.start()

    def _fire(self):
        with self._lock:
            if self._done:
                return
            self.fired = True
            try:
                self._dup.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def cancel(self):
        self._t.cancel()
        with self._lock:
            self._done = True
            try:
                self._dup.close()
            except OSError:
                pass


def probe(endpoint, key, timeout_s, *, resolver=None):
    deadline = time.monotonic() + float(timeout_s)
    _exchange(endpoint, key, "GET", "/models", None, deadline, _NoCancel(), resolver)
    return None


def generate(endpoint, key, body, deadline, cancel, *, resolver=None):
    body = dict(body)
    body["stream"] = False                             # never streamed
    data = encode_body(body)
    if len(data) > MAX_REQUEST_BODY:
        raise TransportError("too_large")
    if cancel is None:
        cancel = _NoCancel()
    return _exchange(endpoint, key, "POST", "/chat/completions", data, deadline, cancel, resolver)
