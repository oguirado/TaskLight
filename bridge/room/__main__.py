"""CW CLI: bridge.room __main__."""

import argparse
import json
import os
import sys

from bridge.room import store
from bridge.room.store import RoomError


def _home():
    v = os.environ.get("CW_HOME")
    if v:
        return v
    return None


def _emit(obj):
    sys.stdout.write(json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _refuse(code):
    _emit({"ok": False, "code": code})
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
        _emit({"ok": False, "code": "bad_args"})
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: {message}\n")


def main(argv=None):
    argv = list(sys.argv[1:]) if argv is None else argv
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
            try:
                if _missing(args.room):
                    _emit({"ok": False, "code": "not_found"})
                    return 4
                s = store.status(args.room, home=_home())
            except RoomError as e:
                return _refuse(e.code)
            _emit(s)
            return 0
        else:
            _emit({"ok": False, "code": "bad_args"})
            return 2
    except SystemExit:
        raise
    except Exception:
        # Never crash with non-JSON; map to generic refusal.
        try:
            _emit({"ok": False, "code": "bad_args"})
        except Exception:
            pass
        return 2


if __name__ == "__main__":
    sys.exit(main())
