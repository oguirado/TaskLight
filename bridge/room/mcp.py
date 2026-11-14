"""stdio MCP server for agent rooms (JSON-RPC 2.0)."""

import json
import math
import sys
import time

from bridge.room import store
from bridge.room.store import RoomError

VERSION = "0.1.0"

TOOLS = [
    {
        "name": "post_status",
        "description": "Post a status event to a room.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "room": {"type": "string"},
                "agent": {"type": "string"},
                "text": {"type": "string"},
                "to": {"type": "string"},
                "re": {"type": "string"},
            },
            "required": ["room", "agent", "text"],
        },
    },
    {
        "name": "post_plan",
        "description": "Post a plan with steps to a room.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "room": {"type": "string"},
                "agent": {"type": "string"},
                "title": {"type": "string"},
                "steps": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["room", "agent", "title", "steps"],
        },
    },
    {
        "name": "post_step",
        "description": "Post a step update to a room.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "room": {"type": "string"},
                "agent": {"type": "string"},
                "index": {"type": "integer"},
                "state": {"type": "string"},
                "outcome": {"type": "string"},
                "took": {"type": "string"},
            },
            "required": ["room", "agent", "index", "state"],
        },
    },
    {
        "name": "read_inbox",
        "description": "Read inbox events for an agent.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "room": {"type": "string"},
                "agent": {"type": "string"},
                "since": {"type": "integer"},
            },
            "required": ["room", "agent"],
        },
    },
    {
        "name": "wait_inbox",
        "description": "Wait for an inbox event for an agent.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "room": {"type": "string"},
                "agent": {"type": "string"},
                "since": {"type": "integer"},
                "timeout_s": {"type": "number"},
            },
            "required": ["room", "agent"],
        },
    },
]

_TOOL_NAMES = {t["name"] for t in TOOLS}


def _wrap(ev):
    e = dict(ev)
    text = e.pop("text", "")
    e["untrusted_text"] = text
    return e


def _send(obj):
    line = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _result(id_, result):
    _send({"jsonrpc": "2.0", "id": id_, "result": result})


def _error(id_, code, message):
    _send({"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}})


def _tool_result(payload, is_error=False):
    return {"content": [{"type": "text", "text": json.dumps(payload, separators=(",", ":"), ensure_ascii=False)}],
            "isError": bool(is_error)}


def _req_str(args, name):
    v = args.get(name)
    if not isinstance(v, str):
        raise RoomError("bad_args", "%s must be string" % name)
    return v


def _handle_call(id_, params):
    if not isinstance(params, dict):
        _error(id_, -32602, "invalid params")
        return
    name = params.get("name")
    args = params.get("arguments")
    if not isinstance(name, str) or args is None:
        _error(id_, -32602, "missing name/arguments")
        return
    if not isinstance(args, dict):
        _error(id_, -32602, "arguments must be object")
        return
    if name not in _TOOL_NAMES:
        _error(id_, -32602, "unknown tool")
        return
    try:
        if name == "post_status":
            room = _req_str(args, "room")
            agent = _req_str(args, "agent")
            text = _req_str(args, "text")
            to = args.get("to")
            re_ = args.get("re")
            if to is not None and not isinstance(to, str):
                raise RoomError("bad_agent", "bad to")
            if re_ is not None and not isinstance(re_, str):
                raise RoomError("bad_re", "bad re")
            ev = store.post(room, agent, "heartbeat", text, re=re_, to=to)
            _result(id_, _tool_result({"event": _wrap(ev)}))
        elif name == "post_plan":
            room = _req_str(args, "room")
            agent = _req_str(args, "agent")
            title = args.get("title")
            steps = args.get("steps")
            if not isinstance(title, str) or not isinstance(steps, list):
                raise RoomError("bad_plan", "title/steps required")
            ev = store.post(room, agent, "plan", title, plan={"title": title, "steps": steps})
            _result(id_, _tool_result({"event": _wrap(ev)}))
        elif name == "post_step":
            room = _req_str(args, "room")
            agent = _req_str(args, "agent")
            if "index" not in args or "state" not in args:
                raise RoomError("bad_step", "index/state required")
            step = {"index": args["index"], "state": args["state"]}
            if "outcome" in args and args["outcome"] is not None:
                step["outcome"] = args["outcome"]
            if "took" in args and args["took"] is not None:
                step["took"] = args["took"]
            text = step.get("outcome") or "step"
            ev = store.post(room, agent, "step", text, step=step)
            _result(id_, _tool_result({"event": _wrap(ev)}))
        elif name == "read_inbox":
            room = _req_str(args, "room")
            agent = _req_str(args, "agent")
            since = args.get("since", 0)
            if not isinstance(since, int) or isinstance(since, bool):
                raise RoomError("bad_args", "since must be int")
            evs = store.inbox(room, agent, since=since)
            _result(id_, _tool_result({"events": [_wrap(e) for e in evs]}))
        elif name == "wait_inbox":
            room = _req_str(args, "room")
            agent = _req_str(args, "agent")
            since = args.get("since", 0)
            if not isinstance(since, int) or isinstance(since, bool):
                raise RoomError("bad_args", "since must be int")
            timeout = args.get("timeout_s", 30.0)
            if not isinstance(timeout, (int, float)) or isinstance(timeout, bool):
                raise RoomError("bad_args", "timeout_s must be number")
            timeout = float(timeout)
            if not math.isfinite(timeout) or timeout < 0:
                raise RoomError("bad_args", "timeout_s must be finite and >= 0")
            if timeout > 60:
                timeout = 60.0
            deadline = time.monotonic() + timeout
            found = None
            while True:
                evs = store.inbox(room, agent, since=since)
                if evs:
                    found = evs[0]
                    break
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.1)
            if found is None:
                _result(id_, _tool_result({"events": []}))
            else:
                _result(id_, _tool_result({"events": [_wrap(found)]}))
    except RoomError as e:
        _result(id_, _tool_result({"ok": False, "code": e.code}, is_error=True))
    except Exception:
        try:
            _result(id_, _tool_result({"ok": False, "code": "internal"}, is_error=True))
        except Exception:
            pass


def _handle(id_, method, params):
    if method == "initialize":
        _result(id_, {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "context-wall", "version": VERSION},
            "capabilities": {"tools": {}},
        })
    elif method == "tools/list":
        _result(id_, {"tools": TOOLS})
    elif method == "tools/call":
        _handle_call(id_, params)
    elif method == "ping":
        _result(id_, {})
    else:
        _error(id_, -32601, "method not found")


def main():
    inp = sys.stdin.buffer
    while True:
        raw = inp.readline()
        if not raw:
            break
        # blank line: skip
        if raw.strip() == b"":
            continue
        try:
            line = raw.decode("utf-8")
        except Exception:
            _error(None, -32700, "parse error")
            continue
        try:
            msg = json.loads(line)
        except Exception:
            _error(None, -32700, "parse error")
            continue
        if not isinstance(msg, dict):
            _error(None, -32600, "invalid request")
            continue
        if "id" not in msg:
            continue  # notification: no reply
        id_ = msg.get("id")
        method = msg.get("method")
        params = msg.get("params")
        if not isinstance(method, str):
            _error(id_, -32601, "method not found")
            continue
        try:
            _handle(id_, method, params)
        except Exception:
            try:
                _error(id_, -32603, "internal error")
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
