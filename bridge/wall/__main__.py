"""U09 CLI: emit, export, observe, host. Stdlib only."""
import hashlib
import json
import os
import sys
import time

from .emit import (
    KINDS, MAX_SAFE_INT, RAW_ENVELOPE_MAX, _valid_spool_text, canonical_json,
    emit as emit_fn, load_config, redact,
)
from .native_host import main as host_main
from .observers import POLL_MS, build_observers

_SIX_KEYS = {"source", "projectId", "sourceSeq", "ts", "kind", "text"}
_MARKER_CHARS = "[REDACTED:"


def _parse(args, with_value=(), boolean=()):
    flags = {}
    pos = []
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith("--") and "=" in a:
            k, v = a[2:].split("=", 1)
            if k in with_value:
                flags[k] = v
                i += 1
                continue
            if k in boolean:
                flags[k] = True
                i += 1
                continue
            return None
        if a.startswith("--") and a[2:] in with_value:
            if i + 1 >= len(args):
                return None
            flags[a[2:]] = args[i + 1]
            i += 2
            continue
        if a.startswith("--") and a[2:] in boolean:
            flags[a[2:]] = True
            i += 1
            continue
        if a.startswith("--"):
            return None
        pos.append(a)
        i += 1
    return flags, pos


def _bad_args():
    sys.stdout.write(json.dumps({"ok": False, "rc": 2, "code": "BAD_ARGS"}) + "\n")
    return 2


def _cmd_emit(args):
    parsed = _parse(args, with_value=("config", "source"))
    if parsed is None:
        return _bad_args()
    flags, pos = parsed
    if len(pos) != 3:
        return _bad_args()
    project, kind, text = pos
    res = emit_fn(project, kind, text, flags.get("source", "agent"),
                  config=flags.get("config"))
    sys.stdout.write(json.dumps(res) + "\n")
    return int(res.get("rc", 2))


def _valid_spool_obj(obj):
    if not isinstance(obj, dict) or set(obj.keys()) != _SIX_KEYS:
        return False
    src = obj.get("source")
    if not isinstance(src, str) or src not in KINDS:
        return False
    kind = obj.get("kind")
    if not isinstance(kind, str) or kind not in KINDS[src]:
        return False
    for key in ("sourceSeq", "ts"):
        v = obj.get(key)
        if type(v) is not int or v < 0 or v > MAX_SAFE_INT:
            return False
    if not _valid_spool_text(obj.get("text")):
        return False
    if not isinstance(obj.get("projectId"), str):
        return False
    return True


def _cmd_export(args):
    parsed = _parse(args, with_value=("config", "spool", "out"))
    if parsed is None:
        return 2
    flags, pos = parsed
    config = flags.get("config")
    spool = flags.get("spool")
    out = flags.get("out")
    if pos or not spool or not out:
        return 2
    cfg = load_config(config)
    if cfg is None:
        return 2
    tiers = {}
    labels = {}
    for p in cfg["projects"]:
        tiers.setdefault(p["projectId"], p.get("tier", "standard"))
        labels.setdefault(p["projectId"], p.get("label") or p["projectId"])
    try:
        with open(spool, "rb") as fh:
            raw = fh.read()
    except OSError:
        return 2
    lines = raw.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    events = []
    order = []
    for seg in lines:
        if not seg:
            return 2
        if len(seg) > RAW_ENVELOPE_MAX:
            return 2
        try:
            obj = json.loads(seg.decode("utf-8"))
        except Exception:
            return 2
        if not _valid_spool_obj(obj):
            return 2
        pid = obj["projectId"]
        if pid not in tiers:
            return 2
        _, residue_n, _ = redact(obj["text"])
        if residue_n:
            return 2
        redactions = obj["text"].count(_MARKER_CHARS)
        base = {
            "projectId": pid, "source": obj["source"], "kind": obj["kind"],
            "sourceSeq": obj["sourceSeq"], "ts": obj["ts"],
            "text": obj["text"], "redactions": redactions,
            "truncated": obj["text"].endswith("…"), "tier": tiers[pid],
        }
        try:
            event_id = hashlib.sha256(
                canonical_json(base).encode("utf-8")).hexdigest()
            event = dict(base)
            event["eventId"] = event_id
            events.append(event)
        except (UnicodeEncodeError, ValueError, TypeError):
            return 2
        if pid not in order:
            order.append(pid)
    try:
        events_bytes = "".join(canonical_json(e) + "\n" for e in events)
        digest = hashlib.sha256(events_bytes.encode("utf-8")).hexdigest()
    except (UnicodeEncodeError, ValueError, TypeError):
        return 2
    manifest = {
        "version": "v1",
        "projects": [{"projectId": pid, "tier": tiers[pid],
                      "label": labels[pid]} for pid in order],
        "eventCount": len(events),
        "digest": digest,
    }
    try:
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, "events.jsonl"), "w",
                  encoding="utf-8") as fh:
            fh.write(events_bytes)
        with open(os.path.join(out, "manifest.json"), "w",
                  encoding="utf-8") as fh:
            fh.write(canonical_json(manifest) + "\n")
    except OSError:
        return 1
    sys.stdout.write(json.dumps(
        {"ok": True, "rc": 0, "eventCount": len(events),
         "digest": digest}) + "\n")
    return 0


def _cmd_observe(args):
    parsed = _parse(args, with_value=("config",), boolean=("once",))
    if parsed is None:
        return 2
    flags, pos = parsed
    if pos:
        return 2
    config = flags.get("config")
    cfg = load_config(config)
    if cfg is None:
        return 2

    def emit_bound(project, kind, text, source="agent", **kw):
        return emit_fn(project, kind, text, source, config=config, **kw)

    observers = []
    try:
        for proj in cfg["projects"]:
            observers.extend(build_observers(proj, emit_fn=emit_bound))
    except Exception:
        return 2
    try:
        if flags.get("once"):
            for ob in observers:
                ob.poll()
            return 0
        while True:
            for ob in observers:
                ob.poll()
            time.sleep(POLL_MS / 1000.0)
    except KeyboardInterrupt:
        return 0


def _cmd_host(args):
    return host_main(args, sys.stdin.buffer, sys.stdout.buffer, sys.stderr)


def main(argv=None):
    args = list(sys.argv[1:]) if argv is None else list(argv)
    if not args:
        return 2
    cmd, rest = args[0], args[1:]
    if cmd == "emit":
        return _cmd_emit(rest)
    if cmd == "export":
        return _cmd_export(rest)
    if cmd == "observe":
        return _cmd_observe(rest)
    if cmd == "host":
        return _cmd_host(rest)
    return 2


if __name__ == "__main__":
    sys.exit(main())
