"""Shared, network-free helpers for bridge.models (URL parsing, request body, probe state mapping).

No network imports here: all network code lives in transport.py.
"""
import ipaddress
import json
import re

from . import KIND_REMOTE, MAX_REQUEST_BODY

_HOST_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})")
_DEFAULT_PORT = {"http": 80, "https": 443}


def parse_base_url(url):
    """Return (scheme, host, port, path) or raise ValueError.

    Accepts only `http(s)://host[:port][/path]`: no userinfo, query, fragment, whitespace or
    non-ASCII. `path` has no trailing slash ("" for the root)."""
    if not isinstance(url, str) or not url or len(url) > 2048:
        raise ValueError("base_url")
    if any(ord(c) < 0x21 or ord(c) > 0x7E for c in url) or any(c in url for c in "?#@\\"):
        raise ValueError("base_url")
    scheme, sep, rest = url.partition("://")
    if not sep or scheme not in _DEFAULT_PORT:
        raise ValueError("base_url")
    hostport, slash, path = rest.partition("/")
    path = ("/" + path) if slash else ""
    path = path.rstrip("/")
    if hostport.startswith("["):
        end = hostport.find("]")
        if end < 0:
            raise ValueError("base_url")
        host, after = hostport[1:end], hostport[end + 1:]
        try:
            ipaddress.IPv6Address(host)
        except ValueError:
            raise ValueError("base_url") from None
        if after and not after.startswith(":"):
            raise ValueError("base_url")
        port_s = after[1:] if after else None
    else:
        if hostport.count(":") > 1:
            raise ValueError("base_url")
        host, colon, port_s = hostport.partition(":")
        if not colon:
            port_s = None
        if not host or not _HOST_RE.fullmatch(host) or ".." in host:
            raise ValueError("base_url")
    if port_s is None:
        port = _DEFAULT_PORT[scheme]
    else:
        if not port_s.isdigit() or not (1 <= int(port_s) <= 65535) or len(port_s) > 5:
            raise ValueError("base_url")
        port = int(port_s)
    return scheme, host, port, path


def host_header(scheme, host, port):
    h = "[%s]" % host if ":" in host else host
    return h if port == _DEFAULT_PORT[scheme] else "%s:%d" % (h, port)


def build_body(endpoint, frame):
    """OpenAI-compatible chat body for a validated model_generate frame (ladder rung from the frame)."""
    body = {
        "model": endpoint["model"],
        "messages": [{"role": m["role"], "content": m["content"]} for m in frame["messages"]],
        "max_tokens": frame["max_tokens"],
        "stream": False,
    }
    rung = frame["rung"]
    if rung == 1:
        body["response_format"] = {"type": "json_schema",
                                   "json_schema": {"name": "out", "schema": frame["schema"], "strict": True}}
    elif rung == 2:
        body["response_format"] = {"type": "json_object"}
    return body


def encode_body(body):
    """Serialized HTTP request body (the bytes the cap is measured on)."""
    try:
        return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except UnicodeEncodeError:
        return json.dumps(body, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def body_too_large(body):
    return len(encode_body(body)) > MAX_REQUEST_BODY


def is_remote(endpoint):
    return endpoint.get("kind") == KIND_REMOTE


def probe_state(code):
    """Map a probe failure code to a model_health state (spec: only 'not available' is asserted)."""
    if code in ("auth", "needs_setup"):
        return "needs_setup"
    if code == "policy":
        return "blocked"
    return "offline"
