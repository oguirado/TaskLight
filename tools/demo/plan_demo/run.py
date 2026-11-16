"""Scripted TaskLight planning demo (stdlib only, deterministic).

Replays a 3-agent project plan built from the ``web-app`` starter template
through the room store, including one heartbeat event.  Running this demo
populates a room under a caller-supplied home directory so the wall can
show phases, tasks, microtasks, a dependency wait and memory sections
without external services or live sessions.

Deterministic and idempotent: a fixed clock, fixed op identifiers and a
fixed evidence payload make the scenario reproducible across fresh homes.
Store-generated event identities and absolute evidence paths vary by run;
compare normalized events for cross-home determinism. Re-running against
a populated room is a no-op.
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

_HERE = Path(__file__).resolve()
REPO_ROOT = _HERE.parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from bridge.plan import fold_plan, load_template  # noqa: E402
from bridge.room import store  # noqa: E402

TS_BASE = 1700000000000
DEFAULT_ROOM = "demo-webapp"
TEMPLATE_ID = "web-app"

EVIDENCE_BODY = (
    "demo evidence: build notes for the vertical slice\n"
    "status: recorded locally in the room\n"
).encode("utf-8")


def _clock():
    return TS_BASE


def _events_path(home_path: Path, room: str) -> Path:
    return home_path / "rooms" / room / "events.jsonl"


def _read_rows(path: Path):
    try:
        data = path.read_bytes()
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
        return []
    rows = []
    for line in data.split(b"\n"):
        if line.strip() == b"":
            continue
        rows.append(json.loads(line.decode("utf-8")))
    return rows


def _template():
    return load_template(str(REPO_ROOT / "templates" / "planning" / "web-app.json"))


def _validate_home(home) -> Path:
    if home is None:
        raise ValueError("home is required")
    if isinstance(home, str) and home.strip() == "":
        raise ValueError("home must be a non-empty path")
    if not isinstance(home, (str, os.PathLike)):
        raise ValueError("home must be a path")
    return Path(home).resolve()


def _validate_room(room: str) -> str:
    if not isinstance(room, str) or store.ROOM_RE.fullmatch(room) is None:
        raise ValueError("invalid room slug")
    return room


def _assert_contained(path: Path, home_resolved: Path) -> None:
    if path.is_symlink():
        raise OSError("refusing symlink path")
    if path.exists() or os.path.lexists(str(path)):
        resolved = path.resolve()
        if not resolved.is_relative_to(home_resolved):
            raise OSError("path escapes home directory")


def _write_evidence(home_path: Path, room: str) -> str:
    artifacts = home_path / "rooms" / room / "artifacts"
    target = artifacts / "evidence.txt"
    with open(target, "wb") as fh:
        fh.write(EVIDENCE_BODY)
    return hashlib.sha256(EVIDENCE_BODY).hexdigest()


def _summary(home_path: Path, room: str, tpl: dict, events_written: int) -> dict:
    rows = _read_rows(_events_path(home_path, room))
    projection = fold_plan(rows, templates={TEMPLATE_ID: tpl})
    plan = projection.get("plan") or {}
    tasks = projection.get("tasks") or []
    waiting = None
    for task in sorted(tasks, key=lambda t: t.get("id", "")):
        if task.get("deps") and task.get("ready") is False:
            waiting = task.get("id")
            break
    drift = None
    for task in sorted(tasks, key=lambda t: t.get("id", "")):
        hit = False
        for micro in task.get("microtasks", []):
            if (
                micro.get("state") == "done"
                and micro.get("accept")
                and micro.get("outcome")
                and micro.get("accept") != micro.get("outcome")
            ):
                hit = True
                break
        if hit:
            drift = task.get("id")
            break
    memory = projection.get("memory") or {}
    return {
        "room": room,
        "plan_id": plan.get("id"),
        "rev": plan.get("rev"),
        "last_lamport": projection.get("last_lamport"),
        "tasks": [t.get("id") for t in tasks],
        "waiting_task": waiting,
        "drift_task": drift,
        "memory_sections": sorted(memory.keys()),
        "events_written": events_written,
    }


def _micro(text: str, accept: str) -> dict:
    return {"text": text, "accept": accept}


def _plan_batch(tpl: dict) -> list:
    return [
        {
            "kind": "plan.open",
            "op_id": "demo-0001",
            "title": "Demo web app",
            "template_id": TEMPLATE_ID,
            "template_hash": tpl["hash"],
            "brief": {
                "goal": "Demo task",
                "users": "Operators",
                "stack": "Stdlib python",
                "constraints": "Local only",
                "deploy-target": "Local",
            },
            "phase": "discovery",
        },
        {
            "kind": "task.add",
            "op_id": "demo-0002",
            "title": "Capture scope and workflows",
            "type": "feature",
            "phase": "discovery",
            "accept": "Scope and workflows written down",
            "deps": [],
            "estimate": "2d",
            "microtasks": [
                _micro("Draft scope notes", "Draft notes cover workflows"),
                _micro("List open constraints", "Constraints listed and dated"),
            ],
        },
        {
            "kind": "task.add",
            "op_id": "demo-0003",
            "title": "Design data and API shape",
            "type": "api",
            "phase": "design",
            "accept": "Contracts reviewed by operators",
            "deps": [],
            "estimate": "1d",
            "microtasks": [
                _micro("Sketch storage layout", "Layout sketched and saved"),
                _micro("Finalize error shapes", "Error shapes agreed with tests"),
            ],
        },
        {
            "kind": "task.add",
            "op_id": "demo-0004",
            "title": "Build working vertical slice",
            "type": "feature",
            "phase": "build",
            "accept": "Slice runs end to end locally",
            "deps": ["T01"],
            "estimate": "3d",
            "microtasks": [
                _micro("Wire request flow", "Flow runs from CLI to storage"),
                _micro("Add progress reporting", "Progress output visible in room"),
            ],
        },
        {
            "kind": "task.add",
            "op_id": "demo-0005",
            "title": "Verify build and edge cases",
            "type": "test",
            "phase": "verify",
            "accept": "Checks pass and are recorded",
            "deps": [],
            "estimate": "1d",
            "microtasks": [
                _micro("Run unit checks", "Unit checks pass"),
                _micro("Record check output", "Output saved as evidence"),
            ],
        },
    ]


def run_demo(home: Path, room: str = DEFAULT_ROOM) -> dict:
    home_path = _validate_home(home)
    _validate_room(room)
    tpl = _template()
    events_path = _events_path(home_path, room)

    if events_path.is_file() and events_path.read_bytes():
        return _summary(home_path, room, tpl, 0)

    room_dir = home_path / "rooms" / room
    artifacts = room_dir / "artifacts"
    for component in (home_path / "rooms", room_dir, artifacts):
        if os.path.lexists(str(component)):
            _assert_contained(component, home_path)
    _assert_contained(artifacts / "evidence.txt", home_path)

    room_dir.mkdir(parents=True, exist_ok=True)
    artifacts.mkdir(parents=True, exist_ok=True)
    evidence_sha = _write_evidence(home_path, room)
    evidence_path = str(artifacts / "evidence.txt")

    store.post_ops(room, "planner", _plan_batch(tpl), home=home_path, clock=_clock)

    memory_ops = [
        ("demo-0010", "architecture", "Demo layout: room log plus template plan plus memory."),
        ("demo-0011", "decisions", "Decisions: stdlib only, on-device storage, fixed clock."),
        ("demo-0012", "constraints", "Constraints: single-user local room, bounded log."),
        ("demo-0013", "glossary", "Glossary: room, plan, task and microtask."),
        ("demo-0014", "risks", "Risks: drift between outcome text and acceptance."),
    ]
    store.post_ops(
        room,
        "planner",
        [
            {"kind": "memory.set", "op_id": oid, "section": sec, "text": text, "base_rev": 0}
            for oid, sec, text in memory_ops
        ],
        home=home_path,
        clock=_clock,
    )

    store.post_ops(
        room,
        "builder-a",
        [
            {"kind": "task.claim", "op_id": "demo-0020", "task_id": "T01"},
            {
                "kind": "micro.set",
                "op_id": "demo-0021",
                "micro_id": "T01.M01",
                "state": "done",
                "outcome": "Draft notes cover workflows",
                "took": "1h",
                "evidence": [{"path": evidence_path, "sha256": evidence_sha}],
            },
            {"kind": "micro.set", "op_id": "demo-0022", "micro_id": "T01.M02", "state": "active"},
        ],
        home=home_path,
        clock=_clock,
    )
    store.post_ops(
        room,
        "builder-b",
        [
            {"kind": "task.claim", "op_id": "demo-0030", "task_id": "T02"},
            {
                "kind": "micro.set",
                "op_id": "demo-0031",
                "micro_id": "T02.M01",
                "state": "done",
                "outcome": "Checks run locally, remote checks skipped",
                "took": "2h",
            },
            {
                "kind": "micro.set",
                "op_id": "demo-0032",
                "micro_id": "T02.M02",
                "state": "done",
                "outcome": "Error shapes agreed with tests",
                "took": "1h",
            },
        ],
        home=home_path,
        clock=_clock,
    )

    current = _summary(home_path, room, tpl, 0)
    store.post_ops(
        room,
        "planner",
        [{"kind": "plan.phase", "op_id": "demo-0040", "base_rev": current["rev"], "phase": "design"}],
        home=home_path,
        clock=_clock,
    )

    store.post(room, "builder-a", "heartbeat", "Demo build started", home=home_path, clock=_clock)

    final_rows = _read_rows(events_path)
    return _summary(home_path, room, tpl, len(final_rows))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="plan_demo", description="Scripted TaskLight planning demo")
    parser.add_argument("--home", default=None, help="Required CW_HOME directory")
    parser.add_argument("--room", default=DEFAULT_ROOM, help="Room slug")
    args = parser.parse_args(argv)
    home = args.home or os.environ.get("CW_HOME") or ""
    if not str(home).strip():
        print("error: a home directory is required (--home or CW_HOME)", file=sys.stderr)
        return 2
    try:
        summary = run_demo(Path(home), args.room)
    except (ValueError, OSError, RuntimeError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
