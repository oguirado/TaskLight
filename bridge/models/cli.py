"""`python3 -m bridge.models` verbs add/remove/list/probe/set-key. rc 0 ok, 2 usage/refusal, 1 I/O.

Store home: env CW_HOME (non-empty) > ~/.context-wall; store at <home>/models/.
Keys are read from stdin (one line) when it is not a TTY, else via getpass; never from argv, never printed.
Usage errors never echo argv (a mistyped `--key VALUE` must not leak the value).
"""
import getpass
import json
import os
import sys

from . import KIND_LOCAL, KIND_REMOTE, TIMEOUT_PROBE_MS
from . import store
from . import transport
from .common import parse_base_url, probe_state

USAGE = ("usage: python3 -m bridge.models <verb> [options]\n"
         "  add --id ID --kind local|remote --base-url URL --model NAME [--label L] [--allow-private] [--rung N]\n"
         "  remove --id ID\n"
         "  list\n"
         "  probe --id ID\n"
         "  set-key --id ID [--clear]   (key read from stdin or a hidden prompt, never from argv)\n")

# verb -> {option: takes_value}
VERBS = {
    "add": {"--id": True, "--kind": True, "--base-url": True, "--model": True, "--label": True,
            "--allow-private": False, "--rung": True},
    "remove": {"--id": True},
    "list": {},
    "probe": {"--id": True},
    "set-key": {"--id": True, "--clear": False},
}
REQUIRED = {"add": ("--id", "--kind", "--base-url", "--model"), "remove": ("--id",), "probe": ("--id",),
            "set-key": ("--id",)}
_REFUSED_MSG = ("models: store refused: %s/endpoints.json or keys.json (or the directory) has a loose mode, "
                "foreign owner, symlink, non-regular type or invalid content; expected dir 0700, files 0600\n")


class _Usage(Exception):
    pass


def _home():
    env = os.environ.get("CW_HOME")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), ".context-wall")


def _parse(argv):
    if not argv:
        raise _Usage("missing verb")
    verb, rest = argv[0], list(argv[1:])
    if verb not in VERBS:
        raise _Usage("unknown verb")
    spec = VERBS[verb]
    opts = {}
    i = 0
    while i < len(rest):
        a = rest[i]
        name, eq, val = a.partition("=")
        if name not in spec:
            raise _Usage("unknown option or argument")       # never echo: it may be a secret
        if name in opts:
            raise _Usage("repeated option")
        if spec[name]:
            if not eq:
                if i + 1 >= len(rest):
                    raise _Usage("option needs a value")
                val = rest[i + 1]
                i += 1
            opts[name] = val
        else:
            if eq:
                raise _Usage("flag takes no value")
            opts[name] = True
        i += 1
    for r in REQUIRED.get(verb, ()):
        if r not in opts:
            raise _Usage("missing required option")
    return verb, opts


def _out(stream, obj):
    stream.write(json.dumps(obj, ensure_ascii=False) + "\n")
    stream.flush()


def _load_or_refuse(home, stderr):
    st = store.load(home)
    if st["refused"]:
        if store._private_store_supported():
            stderr.write(_REFUSED_MSG % store.store_dir(home))
        else:
            stderr.write("models: " + store._PRIVATE_STORE_UNAVAILABLE + "\n")
        return None
    return st


def _read_key(stdin):
    try:
        tty = stdin.isatty()
    except Exception:
        tty = False
    if tty:
        return getpass.getpass("API key (hidden): ")
    src = getattr(stdin, "buffer", stdin)
    line = src.readline(8193)
    if isinstance(line, bytes):
        line = line.decode("utf-8")
    return line.rstrip("\r\n")


def _cmd_add(home, o, stdout, stderr):
    kind = {"local": KIND_LOCAL, "remote": KIND_REMOTE}.get(o["--kind"])
    if kind is None:
        stderr.write("models: --kind must be local or remote\n")
        return 2
    e = {"id": o["--id"], "kind": kind, "label": o.get("--label", o["--id"]), "base_url": o["--base-url"],
         "model": o["--model"], "allow_private": bool(o.get("--allow-private", False)), "enabled": True}
    if "--rung" in o:
        r = o["--rung"]
        if r not in ("1", "2", "3"):
            stderr.write("models: --rung must be 1, 2 or 3\n")
            return 2
        e["rung"] = int(r)
    try:
        store.validate_endpoint(e)
    except ValueError:
        stderr.write("models: invalid endpoint (id, label, model, base_url or remote rules: https only, "
                     "no --allow-private)\n")
        return 2
    if kind == KIND_LOCAL:
        _s, host, port, _p = parse_base_url(e["base_url"])
        try:
            transport.check_loopback(host, port)
        except transport.TransportError as exc:
            stderr.write("models: local endpoint host must resolve to loopback only (%s)\n" % exc.code)
            return 2
    st = _load_or_refuse(home, stderr)
    if st is None:
        return 2
    if any(x["id"] == e["id"] for x in st["endpoints"]):
        stderr.write("models: id already exists\n")
        return 2
    try:
        store.save_endpoints(home, st["endpoints"] + [e])
    except ValueError:
        stderr.write("models: refused (at most 16 endpoints, or the store directory is not 0700)\n")
        return 2
    _out(stdout, {"added": e["id"]})
    return 0


def _cmd_remove(home, o, stdout, stderr):
    if _load_or_refuse(home, stderr) is None:
        return 2
    try:
        store.remove(home, o["--id"])
    except KeyError:
        stderr.write("models: unknown id\n")
        return 2
    except ValueError:
        stderr.write(_REFUSED_MSG % store.store_dir(home))
        return 2
    _out(stdout, {"removed": o["--id"]})
    return 0


def _cmd_list(home, o, stdout, stderr):
    st = _load_or_refuse(home, stderr)
    if st is None:
        return 2
    rows = []
    for e in st["endpoints"]:
        row = {k: e[k] for k in ("id", "kind", "label", "base_url", "model", "allow_private", "enabled")}
        if "rung" in e:
            row["rung"] = e["rung"]
        row["has_key"] = bool(st["keys"].get(e["id"]))
        rows.append(row)
    _out(stdout, {"endpoints": rows})
    return 0


def _cmd_probe(home, o, stdout, stderr):
    st = _load_or_refuse(home, stderr)
    if st is None:
        return 2
    e = next((x for x in st["endpoints"] if x["id"] == o["--id"]), None)
    if e is None:
        stderr.write("models: unknown id\n")
        return 2
    key = st["keys"].get(e["id"]) or None
    if not e["enabled"]:
        state = "blocked"
    elif e["kind"] == KIND_REMOTE and not key:
        state = "needs_setup"
    else:
        try:
            transport.probe(e, key, TIMEOUT_PROBE_MS / 1000.0)
            state = "available"
        except transport.TransportError as exc:
            state = probe_state(exc.code)
    rung = e.get("rung", 2)
    _out(stdout, {"id": e["id"], "state": state, "rung": rung})
    return 0


def _cmd_set_key(home, o, stdout, stderr, stdin):
    st = _load_or_refuse(home, stderr)
    if st is None:
        return 2
    if not any(x["id"] == o["--id"] for x in st["endpoints"]):
        stderr.write("models: unknown id\n")
        return 2
    if o.get("--clear"):
        key = None
    else:
        try:
            key = _read_key(stdin)
        except (EOFError, UnicodeDecodeError):
            key = ""
        if not key:
            stderr.write("models: empty key (pipe one line on stdin, or run interactively)\n")
            return 2
    try:
        store.set_key(home, o["--id"], key)
    except KeyError:
        stderr.write("models: unknown id\n")
        return 2
    except ValueError:
        stderr.write("models: key refused (printable, no spaces, <= 4096 chars) or store refused\n")
        return 2
    _out(stdout, {"id": o["--id"], "has_key": key is not None})
    return 0


def main(argv, stdin=None, stdout=None, stderr=None):
    stdin = sys.stdin if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    try:
        verb, opts = _parse(list(argv or []))
    except _Usage as u:
        stderr.write("models: %s\n%s" % (u.args[0], USAGE))
        return 2
    home = _home()
    try:
        if verb == "add":
            return _cmd_add(home, opts, stdout, stderr)
        if verb == "remove":
            return _cmd_remove(home, opts, stdout, stderr)
        if verb == "list":
            return _cmd_list(home, opts, stdout, stderr)
        if verb == "probe":
            return _cmd_probe(home, opts, stdout, stderr)
        return _cmd_set_key(home, opts, stdout, stderr, stdin)
    except RecursionError:                             # belt: never a traceback, never file contents
        stderr.write(_REFUSED_MSG % store.store_dir(home))
        return 2
    except OSError as exc:
        stderr.write("models: I/O error (%s) under %s\n" % (type(exc).__name__, store.store_dir(home)))
        return 1
