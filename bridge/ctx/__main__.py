import hashlib
import sys

from .envelope import canonical, respond
from .page import page
from .find import find
from .census import census
from .tail import tail
from .state import state
from .check import check
from .paths import Roots

VERBS = ("page", "find", "census", "tail", "state", "check")

_ALLOWED = {
    "page": {"--path", "--from-line", "--expect-sha256"},
    "find": {"--root", "--k", "--deadline-ms"},
    "census": {"--dir"},
    "tail": {"--path", "--n"},
    "state": {"--target", "--proc-root", "--now-s"},
    "check": {"--obj-json"},
}
_REQUIRED = {
    "page": ("--path", "--from-line"),
    "find": ("--root", "--k"),
    "census": ("--dir",),
    "tail": ("--path", "--n"),
    "state": ("--target",),
    "check": ("--obj-json",),
}
_INT_FLAGS = {"--from-line", "--k", "--deadline-ms", "--n", "--now-s"}


def _usage_data(verb: str, flags: dict) -> dict:
    if verb == "page":
        path = flags.get("--path", "")
        try:
            frm = int(flags["--from-line"])
        except (ValueError, TypeError, KeyError):
            frm = 0
        return {"path": path, "from": frm, "lines": [], "total_lines": 0,
                "next": None, "sha256": hashlib.sha256(b"").hexdigest(),
                "line_cut": False, "lossy": False}
    if verb == "find":
        return {"hits": [], "complete": False, "scanned": 0, "skipped": 0,
                "binary": 0}
    if verb == "census":
        return {"files": 0, "bytes": 0, "by_ext": {}, "largest": [],
                "complete": False}
    if verb == "tail":
        return {"path": flags.get("--path", ""), "lines": [], "line_count": 0,
                "byte_count": 0, "sha256": hashlib.sha256(b"").hexdigest(),
                "cut": False}
    if verb == "state":
        return {"facts": {}}
    return {"valid": False, "errors": []}


def _write_response(response) -> int:
    line = canonical(response) + "\n"
    output = getattr(sys.stdout, "buffer", None)
    if output is None:
        sys.stdout.write(line)
    else:
        output.write(line.encode("utf-8"))
    return response["rc"]


def _emit_usage(verb: str, flags: dict) -> int:
    return _write_response(respond(verb, 2, _usage_data(verb, flags)))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in VERBS:
        return 2
    verb = argv[0]
    rest = argv[1:]
    allow: list = []
    flags: dict = {}
    terms: list = []
    seen_single: set = set()
    i = 0
    while i < len(rest):
        flag = rest[i]
        if not flag.startswith("--") or i + 1 >= len(rest):
            return _emit_usage(verb, flags)
        value = rest[i + 1]
        if flag == "--allow-root":
            allow.append(value)
        elif flag == "--term":
            if verb != "find":
                return _emit_usage(verb, flags)
            terms.append(value)
        else:
            if flag not in _ALLOWED.get(verb, set()):
                return _emit_usage(verb, flags)
            if flag in seen_single:
                return _emit_usage(verb, flags)
            seen_single.add(flag)
            if flag in _INT_FLAGS:
                try:
                    int(value)
                except (ValueError, TypeError):
                    return _emit_usage(verb, flags)
            flags[flag] = value
        i += 2
    for required in _REQUIRED[verb]:
        if required not in flags:
            return _emit_usage(verb, flags)
    roots = Roots(tuple(allow))
    try:
        if verb == "page":
            r = page(flags["--path"], int(flags["--from-line"]), roots,
                     flags.get("--expect-sha256"))
        elif verb == "find":
            deadline = (int(flags["--deadline-ms"])
                        if "--deadline-ms" in flags else 2000)
            r = find(terms, flags["--root"], int(flags["--k"]), roots,
                     deadline_ms=deadline)
        elif verb == "census":
            r = census(flags["--dir"], roots)
        elif verb == "tail":
            r = tail(flags["--path"], int(flags["--n"]), roots)
        elif verb == "state":
            now = int(flags["--now-s"]) if "--now-s" in flags else None
            r = state(flags["--target"], roots,
                      proc_root=flags.get("--proc-root", "/proc"), now_s=now)
        else:
            r = check(flags["--obj-json"])
    except (ValueError, TypeError):
        return _emit_usage(verb, flags)
    return _write_response(r)


if __name__ == "__main__":
    sys.exit(main())
