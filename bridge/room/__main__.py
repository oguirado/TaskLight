"""CW CLI: bridge.room __main__.

The session pin prevents accidental cross-agent calls. It is not authentication. Agent identity remains caller-asserted within the same-user CW_HOME boundary.
"""

import argparse
import json
import os
import sys

from bridge.room import app
from bridge.room import store
from bridge.room.store import RoomError
from bridge.wall.emit import sanitize_output


def _home():
    v = os.environ.get("CW_HOME")
    if v:
        return v
    return None


def _emit(obj, *, sanitized=False):
    if not sanitized:
        obj = sanitize_output(obj)
    sys.stdout.write(json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _refuse(code, detail=None):
    payload = {"ok": False, "code": code}
    if detail is not None:
        payload["detail"] = detail
    try:
        _emit(payload)
    except Exception:
        _emit({"ok": False, "code": "internal"}, sanitized=True)
    return 2


def _missing(room):
    h = _home()
    if h is not None:
        base = h
    else:
        base = os.path.join(os.path.expanduser("~"), ".context-wall")
    p = os.path.join(base, "rooms", room, "events.jsonl")
    return not os.path.isfile(p)


class _JsonParser(argparse.ArgumentParser):
    def error(self, message):
        message = sanitize_output(message)
        _emit({"ok": False, "code": "bad_args"})
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: {message}\n")


def main(argv=None):
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    if argv and argv[0] == "run":
        # A supervised command owns its streams and exit status; it must not
        # enter the JSON response/error handling used by the room commands.
        from bridge.room.ext.supervise import main as supervise
        return supervise(argv[1:])
    if argv and argv[0] == "wave":
        from bridge.room.ext.wave import main as wave
        return wave(argv[1:])
    try:
        pin = app.session_pin_from_env()
    except RoomError as e:
        return _refuse(e.code, str(e))
    if not argv:
        _emit({"ok": False, "code": "bad_args"})
        return 2
    verb = argv[0]
    rest = argv[1:]
    try:
        if verb == "post":
            ap = _JsonParser(prog="post")
            ap.add_argument("--room", required=True)
            ap.add_argument("--agent", required=True)
            ap.add_argument("--act", required=True)
            ap.add_argument("--text", required=True)
            ap.add_argument("--re", default=None)
            ap.add_argument("--to", default=None)
            ap.add_argument("--evidence", action="append", default=[])
            ap.add_argument("--plan-file", default=None)
            ap.add_argument("--step-json", default=None)
            args = ap.parse_args(rest)
            app.guard_session(vars(args), pin=pin, agent_required=True)
            plan = None
            if args.plan_file is not None:
                try:
                    with open(args.plan_file, "r", encoding="utf-8") as f:
                        plan = json.loads(f.read())
                except Exception:
                    return _refuse("bad_plan")
            step = None
            if args.step_json is not None:
                try:
                    step = json.loads(args.step_json)
                except Exception:
                    return _refuse("bad_step")
            try:
                ev = store.post(args.room, args.agent, args.act, args.text,
                                re=args.re, to=args.to, evidence=args.evidence or (),
                                plan=plan, step=step, home=_home())
            except RoomError as e:
                return _refuse(e.code)
            _emit({"ok": True, "event": ev})
            return 0
        elif verb == "read":
            ap = _JsonParser(prog="read")
            ap.add_argument("--room", required=True)
            ap.add_argument("--since", type=int, default=0)
            ap.add_argument("--json", action="store_true")
            args = ap.parse_args(rest)
            app.guard_session(vars(args), pin=pin)
            try:
                if _missing(args.room):
                    _emit({"ok": False, "code": "not_found"})
                    return 4
                evs, mal = store.read(args.room, since=args.since, home=_home())
            except RoomError as e:
                return _refuse(e.code)
            _emit({"events": evs, "malformed": mal})
            return 0
        elif verb == "wait":
            ap = _JsonParser(prog="wait")
            ap.add_argument("--room", required=True)
            ap.add_argument("--since", type=int, default=0)
            ap.add_argument("--act", default=None)
            ap.add_argument("--agent", default=None)
            ap.add_argument("--exclude-agent", default=None)
            ap.add_argument("--to", default=None)
            ap.add_argument("--timeout", type=float, default=30.0)
            args = ap.parse_args(rest)
            app.guard_session({"agent": args.agent} if args.agent is not None else {}, pin=pin)
            try:
                if _missing(args.room):
                    _emit({"ok": False, "code": "not_found"})
                    return 4
                ev = store.wait(args.room, args.since, act=args.act, agent=args.agent,
                                exclude_agent=args.exclude_agent, to=args.to,
                                timeout_s=args.timeout, home=_home())
            except RoomError as e:
                return _refuse(e.code)
            if ev is None:
                _emit({"ok": False, "code": "timeout"})
                return 124
            _emit({"ok": True, "event": ev})
            return 0
        elif verb == "status":
            ap = _JsonParser(prog="status")
            ap.add_argument("--room", required=True)
            args = ap.parse_args(rest)
            app.guard_session(vars(args), pin=pin)
            try:
                if _missing(args.room):
                    _emit({"ok": False, "code": "not_found"})
                    return 4
                s = store.status(args.room, home=_home())
            except RoomError as e:
                return _refuse(e.code)
            _emit(s)
            return 0
        elif verb == "export":
            # O-U94c: CLI parity for U94 export (writes PLAN.md, MEMORY.md and INTEGRATION.md under $CW_HOME).
            ap = _JsonParser(prog="export")
            ap.add_argument("--room", required=True)
            ap.add_argument("--out", required=True)
            args = ap.parse_args(rest)
            app.guard_session(vars(args), pin=pin)
            from bridge.room.ext import export as _export
            try:
                result = _export.export_room(args.room, args.out, include_integration=True)
            except RoomError as e:
                if e.code in ("bad_args", "bad_room"):
                    return _refuse(e.code)
                _emit({"ok": False, "code": e.code})
                return 3
            _emit(result)
            return 0
        elif verb == "tools":
            app.guard_session({}, pin=pin)
            if rest:
                _emit({"ok": False, "code": "bad_args"})
                return 2
            _emit({"tools": app.list_tools()})
            return 0
        elif verb == "call":
            if len(rest) != 3 or rest[1] != "--json" or not rest[0] or rest[0].startswith("--"):
                _emit({"ok": False, "code": "bad_args"})
                return 2
            tool_name = rest[0]
            try:
                call_args = json.loads(rest[2])
            except Exception:
                _emit({"ok": False, "code": "bad_args"})
                return 2
            if not isinstance(call_args, dict):
                _emit({"ok": False, "code": "bad_args"})
                return 2
            if tool_name not in app.tool_names():
                _emit({"ok": False, "code": "bad_args"})
                return 2
            try:
                payload = app.dispatch(tool_name, call_args, pin=pin)
            except RoomError as e:
                try:
                    detail = str(e)
                except Exception:
                    detail = ""
                error_payload = {"ok": False, "code": e.code}
                if detail:
                    error_payload["detail"] = detail
                _emit(error_payload)
                return 3
            except Exception:
                _emit({"ok": False, "code": "internal"})
                return 3
            # agents_list shares MCP dispatch and this read-time sanitizer.
            # room_export already redacts before rendering Markdown.
            _emit(payload, sanitized=(tool_name == "room_export"))
            return 0
        else:
            _emit({"ok": False, "code": "bad_args"})
            return 2
    except SystemExit:
        raise
    except RoomError as e:
        return _refuse(e.code, str(e))
    except Exception:
        # Never crash with non-JSON; map to generic refusal.
        try:
            _emit({"ok": False, "code": "bad_args"}, sanitized=True)
        except Exception:
            pass
        return 2


if __name__ == "__main__":
    sys.exit(main())
