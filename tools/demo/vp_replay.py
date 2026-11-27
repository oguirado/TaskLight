"""Synthetic ViewPoint replay: 4 parallel ViewPoint-like runs written into a TEMP runs root.

Feeds the U40 observer (`python3 -m bridge.viewpoint watch --root <root>`) without any real
ViewPoint/MetaViewer take. One run per capsule (arXiv, GitHub, Gemini, Wikipedia; A-U42b), 3-5 steps each,
interleaved over ~20-30 s with jitter. Files follow the real run schema
(strategy/night/N0_viewpoint_schema.md, SPEC_U40):

  <root>/<run_id>/intent-<pid>.json       goal (verbatim), action{type: click|type|key}, expectation, target{role,name,box}, frame, source
  <root>/<run_id>/dispatch-mw-<pid>.json  liveness only
  <root>/<run_id>/receipt-<pid>.json      action, target, verification{status, ...}, rebound*
  <root>/<run_id>/readback-<pid>.json     extra real file type (observer ignores it)
  <root>/<run_id>/moves.json, report.json {"schema":"metaviewer.mw_run/v1","rc":..,"verdict_code":..}

The arXiv run ends with a BLOCKED step (verification.status "blocked", report rc 1) to show that state.
Every file is written atomically (hidden *.tmp in the same dir, fsync, rename), so the observer never
sees a torn JSON. No secrets: action.text values are harmless sample strings.

  python3 tools/demo/vp_replay.py [--root DIR] [--speed X] [--once] [--seed N] [--quiet]

Default root: $TASKLIGHT_DEMO_DIR/vp_runs (else <tmpdir>/tasklight-demo/vp_runs).
REFUSES any root under /dev/shm/vqa-cu (the real ViewPoint runs) and never reads anything there.
"""
import argparse
import hashlib
import json
import os
import random
import sys
import tempfile
import time

FORBIDDEN = "/dev/shm/vqa-cu"
SCHEMA = "metaviewer.mw_run/v1"

# (capsule slug, goal verbatim, steps). Step = (action, target role, target name, verification status).
CAPSULES = [
    ("arxiv", "Search arXiv for AI agent", [
        ({"type": "click"}, "searchbox", "Search term or terms", "verified"),
        ({"type": "type", "text": "AI agent"}, "searchbox", "Search term or terms", "verified"),
        ({"type": "click"}, "button", "Search", "verified"),
        ({"type": "click"}, "link", "Sort by announcement date", "verified"),
        ({"type": "click"}, "link", "pdf", "blocked"),
    ]),
    ("github", "Search GitHub for context wall", [
        ({"type": "click"}, "button", "Search or jump to", "verified"),
        ({"type": "type", "text": "context wall"}, "combobox", "Search or jump to", "verified"),
        ({"type": "key", "key": "Enter"}, "combobox", "Search or jump to", "verified"),
        ({"type": "click"}, "link", "Repositories", "verified"),
    ]),
    ("gemini", "Open the Gemini models page on deepmind.google", [
        ({"type": "click"}, "link", "Models", "verified"),
        ({"type": "click"}, "link", "Gemini", "verified"),
        ({"type": "click"}, "link", "Learn more", "verified"),
    ]),
    ("wikipedia", "Search Wikipedia for Google DeepMind", [
        ({"type": "click"}, "searchbox", "Search Wikipedia", "verified"),
        ({"type": "type", "text": "Google DeepMind"}, "searchbox", "Search Wikipedia", "verified"),
        ({"type": "key", "key": "Enter"}, "searchbox", "Search Wikipedia", "verified"),
    ]),
]
BLOCK_REASON = "target not visible after scroll (sample)"


def is_forbidden(path):
    """True if `path` is, or lies under, the real ViewPoint runs tree. Pure string check first, then
    realpath (which follows a symlink that might point into it). The string check short-circuits, so a
    root spelled under the forbidden tree is refused without any filesystem call."""
    forbidden = os.path.splitdrive(os.path.normcase(os.path.abspath(FORBIDDEN)))[1]

    def under(p):
        p = os.path.splitdrive(os.path.normcase(p))[1]
        return p == forbidden or p.startswith(forbidden + os.sep)
    return under(os.path.abspath(path)) or under(os.path.realpath(path))


def default_root():
    base = os.environ.get("TASKLIGHT_DEMO_DIR") or os.path.join(tempfile.gettempdir(), "tasklight-demo")
    return os.path.join(base, "vp_runs")


def write_atomic(path, obj, mtime_ns=None):
    d, name = os.path.split(path)
    fd, tmp = tempfile.mkstemp(prefix="." + name + ".", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=1)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        if mtime_ns is not None:
            os.utime(tmp, ns=(mtime_ns, mtime_ns))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _hex(rng, n):
    return "".join(rng.choice("0123456789abcdef") for _ in range(n))


def build_timeline(rng, stamp):
    """Return (runs, events). events = [(t_seconds, run_id, filename, obj)] for all 4 runs interleaved."""
    runs, events = [], []
    for slug, goal, steps in CAPSULES:
        run_id = "%s-%s" % (slug, stamp)
        runs.append({"run_id": run_id, "capsule": slug, "goal": goal, "steps": len(steps)})
        t = rng.uniform(0.0, 2.5)  # staggered start
        moves, attempts, rc = [], [], 0
        for i, (action, role, name, status) in enumerate(steps):
            pid = "%02d%s" % (i + 1, _hex(rng, 6))
            box = [rng.randint(80, 900), rng.randint(80, 700), rng.randint(120, 480), rng.randint(24, 48)]
            target = {"role": role, "name": name, "box": box}
            frame = {"w": 1280, "h": 800, "sha256": hashlib.sha256(("%s/%d" % (run_id, i)).encode()).hexdigest()}
            intent = {
                "goal": goal,
                "action": dict(action),
                "expectation": {"visible": name, "role": role},
                "target": target,
                "frame": frame,
                "source": {"kind": "replay", "capsule": slug},
            }
            events.append((t, run_id, "intent-%s.json" % pid, intent))
            t += rng.uniform(0.25, 0.6)
            events.append((t, run_id, "dispatch-mw-%s.json" % pid, {"pid": pid, "dispatched": True}))
            t += rng.uniform(1.6, 3.4)
            if status == "verified":
                verification = {
                    "status": "verified", "receipt": "rcpt-" + _hex(rng, 12), "focus_verified": True,
                    "input_mono_ns": int(t * 1e9), "frame_sha256": frame["sha256"],
                    "receipt_binding_negative_control": True,
                }
            else:
                verification = {"status": status, "reason": BLOCK_REASON, "focus_verified": False,
                                "frame_sha256": frame["sha256"]}
                rc = 1
            receipt = {"action": dict(action), "target": target, "verification": verification,
                       "rebound": False, "rebound_old_id": None, "rebound_new_id": None}
            events.append((t, run_id, "receipt-%s.json" % pid, receipt))
            events.append((t + 0.05, run_id, "readback-%s.json" % pid, {"pid": pid, "ok": status == "verified"}))
            moves.append({"index": i, "pid": pid, "action": action["type"], "role": role, "name": name,
                          "status": status})
            attempts.append({"pid": pid, "n": 1, "status": status})
            if status != "verified":
                break
            t += rng.uniform(0.7, 1.5)
        t += rng.uniform(0.4, 1.0)
        events.append((t, run_id, "moves.json", moves))
        verdict = "BROWSER_BOUNDED_ACTIONS_VERIFIED" if rc == 0 else "BROWSER_STEP_BLOCKED"
        report = {"schema": SCHEMA, "rc": rc, "verdict_code": verdict, "goal_completed": rc == 0,
                  "message": "synthetic replay run (%s)" % slug, "moves": moves, "attempts": attempts}
        events.append((t + 0.3, run_id, "report.json", report))
        runs[-1]["rc"] = rc
    events.sort(key=lambda e: (e[0], e[1], e[2]))
    return runs, events


def main(argv=None):
    ap = argparse.ArgumentParser(description="Write 4 synthetic ViewPoint-like runs into a temp runs root.")
    ap.add_argument("--root", default=None, help="runs root (default $TASKLIGHT_DEMO_DIR/vp_runs)")
    ap.add_argument("--speed", type=float, default=1.0, help="time scale: 2 = twice as fast (default 1, ~20-30 s)")
    ap.add_argument("--once", action="store_true", help="write everything immediately and exit")
    ap.add_argument("--seed", type=int, default=None, help="jitter seed (default: random)")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    if not (a.speed > 0):
        print("vp_replay: --speed must be > 0", file=sys.stderr)
        return 2
    root = a.root or default_root()
    if is_forbidden(root):
        print("vp_replay: REFUSED root under %s (real ViewPoint runs are read-only)" % FORBIDDEN, file=sys.stderr)
        return 3
    os.makedirs(root, mode=0o700, exist_ok=True)
    if is_forbidden(root):  # re-check after creation (symlink race)
        print("vp_replay: REFUSED root under %s" % FORBIDDEN, file=sys.stderr)
        return 3

    rng = random.Random(a.seed)
    stamp = time.strftime("%Y%m%dT%H%M%S") + "-" + _hex(rng, 4)
    runs, events = build_timeline(rng, stamp)
    for r in runs:
        os.makedirs(os.path.join(root, r["run_id"]), mode=0o700, exist_ok=True)
    info = {"root": os.path.abspath(root), "runs": runs, "files": len(events),
            "duration_s": round(events[-1][0] / a.speed, 1) if not a.once else 0}
    if not a.quiet:
        print(json.dumps({"event": "start", **info}), flush=True)

    t0 = time.monotonic()
    base_ns = time.time_ns()
    last_ns = 0
    for t, run_id, fname, obj in events:
        if not a.once:
            delay = t / a.speed - (time.monotonic() - t0)
            if delay > 0:
                time.sleep(delay)
        # strictly increasing mtimes: the observer orders by mtime then name
        mt = max(base_ns + int(t / a.speed * 1e9), last_ns + 1000)
        last_ns = mt
        write_atomic(os.path.join(root, run_id, fname), obj, mtime_ns=mt if a.once else None)
        if not a.quiet and (fname.startswith(("intent-", "receipt-")) or fname == "report.json"):
            print(json.dumps({"event": "write", "t": round(time.monotonic() - t0, 2), "run": run_id, "file": fname}),
                  flush=True)
    if not a.quiet:
        print(json.dumps({"event": "done", "root": info["root"], "runs": [r["run_id"] for r in runs],
                          "elapsed_s": round(time.monotonic() - t0, 1)}), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
