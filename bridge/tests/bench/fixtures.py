"""Seeded, byte-stable synthetic fixtures and independent semantic expectations."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
from contextlib import contextmanager

from bridge.plan.limits import TASKS_MAX, MICRO_MAX

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "tests" / "bench" / "oracle.json"
SEED = 115
BASE_TS = 1_700_000_000_000
ROOM = "synthetic-bench"
FIXTURE_CAP_BYTES = 8 * 1024 * 1024  # A-C4m: 16 MiB cap


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def journal(events):
    return b"".join(encoded(e) + b"\n" for e in events)


def admit(data):
    if len(data) > FIXTURE_CAP_BYTES:
        raise ValueError("fixture exceeds CAP before measurement")
    return data


def event(n, *, room=ROOM, agent="alice", act="heartbeat", text="", **extra):
    return {"id": f"e-{n:016x}", "room": room, "agent": agent, "act": act,
            "text": text, "ts": BASE_TS + n, "lamport": n, **extra}


def oracle():
    return json.loads(DATA.read_text(encoding="utf-8"))


def mixed(seed=SEED, size=10_000, payload="synthetic"):
    if size < 13:
        raise ValueError("mixed fixture requires its complete semantic prefix")
    source = oracle()
    events = copy.deepcopy(source["events"])
    # Explicit integer PRNG, independent of Python's random implementation.
    state = seed & 0xffffffff
    while len(events) < size:
        i = len(events)
        state = (1664525 * state + 1013904223) & 0xffffffff
        if i % 101 == 0:
            events.append(copy.deepcopy(source["events"][8]))
        else:
            addressed = i % 3 == 0
            events.append(event(100 + i, act="question" if addressed else "heartbeat",
                                text=f"{payload}:{state:08x}",
                                **({"to": "bob"} if addressed else {})))
    # Accepted earlier events arrive late. Full folds must restore Lamport order.
    events = events[4:] + events[:4]
    data = admit(journal(events))
    ids = {e["id"] for e in events}
    expected = copy.deepcopy(source["expected"])
    expected["ingestion"] = {"accepted": len(ids), "duplicate": size-len(ids), "invalid": 0}
    return {"events": events, "template": source["template"], "expected": expected,
            "manifest": {"seed": seed, "fixture_sha256": sha(data), "journal_bytes": len(data),
                         "event_count": size, "unique_events": len(ids), "cap_bytes": FIXTURE_CAP_BYTES,
                         "expected": expected}}


def near_cap(seed=SEED):
    target = FIXTURE_CAP_BYTES - 256
    room = "synthetic-tail"
    events, pieces, used, n = [], [], 0, 1
    while True:
        e = event(n, room=room, act="question" if n % 11 == 0 else "heartbeat",
                  text=f"{seed}:" + "x" * 3990)
        piece = encoded(e) + b"\n"
        if used + len(piece) > target:
            break
        events.append(e)
        pieces.append(piece)
        used += len(piece)
        n += 1
    tail = event(n, room=room, act="question", text="")
    overhead = len(encoded(tail)) + 1
    if target-used >= overhead:
        tail["text"] = "x" * (target-used-overhead)
        assert len(tail["text"].encode()) <= 4096
        events.append(tail)
        pieces.append(encoded(tail) + b"\n")
    data = admit(b"".join(pieces))
    assert len(data) == target
    return {"events": events, "template": oracle()["template"],
            "manifest": {"seed": seed, "fixture_sha256": sha(data), "journal_bytes": len(data),
                         "event_count": len(events), "cap_bytes": FIXTURE_CAP_BYTES}}


def stream_chunks(seed=SEED, count=100_000, chunk_size=512, kind="history"):
    """Client-only stream: no oversized room is ever materialized or persisted."""
    if chunk_size < 1 or chunk_size > 4096:
        raise ValueError("unbounded chunk size")
    revision = 6
    for start in range(0, count, chunk_size):
        chunk = []
        for i in range(start, min(start+chunk_size, count)):
            e = event(20_000+i, text=f"synthetic:{seed}:{i}",
                      agent="alice" if i % 2 == 0 else "bob")
            if kind == "burst" and i % 32 == 0:
                e.update(act="op", text="", op={"kind": "memory.set", "section": "goal",
                         "base_rev": revision, "text": f"Synthetic burst {i}"})
                revision = 20_000+i
            chunk.append(e)
        yield chunk


def client_fixture(fixture, kind):
    """Hash the entire synthetic workload without retaining or persisting its stream."""
    value = copy.deepcopy(fixture)
    digest = hashlib.sha256(journal(value["events"]))
    count = 100_000 if kind == "history" else 512
    client_bytes = 0
    stream_digest = hashlib.sha256()
    for chunk in stream_chunks(value["manifest"]["seed"], count=count, kind=kind):
        data = journal(chunk)
        digest.update(data)
        stream_digest.update(data)
        client_bytes += len(data)
    value["manifest"].update(journal_sha256=value["manifest"]["fixture_sha256"],
                             fixture_sha256=digest.hexdigest(), client_stream_sha256=stream_digest.hexdigest(),
                             client_stream_bytes=client_bytes, client_event_count=count,
                             fixture_kind="bounded-client-stream-with-seed-journal")
    return value


def concurrency_fixture(seed=SEED):
    source = oracle()
    events = [copy.deepcopy(source["events"][0])]
    writers = [{"room": ROOM, "agent": f"writer-{i}", "act": "op", "text": "",
                "ts": BASE_TS+1000+i, "op": {"kind": "task.add", "title": f"Synthetic writer {i}",
                    "type": "action", "phase": "start", "accept": "Exactly once", "op_id": f"writer_{i:08d}"}}
               for i in range(8)]
    data = admit(journal(events))
    return {"events": events, "template": source["template"], "writers": writers,
            "manifest": {"seed": seed, "fixture_sha256": sha(data+encoded(writers)),
                         "journal_sha256": sha(data), "journal_bytes": len(data), "event_count": 1,
                         "writer_count": 8, "fixture_kind": "seed-journal-and-writer-arguments"}}


def reservations(seed=SEED):
    """Future contracts are inert fixture data, never replacement implementations."""
    agents = [f"agent-{i:02d}" for i in range(15)]
    tasks = [{"id": f"T{i+1:02d}", "assignee": agents[i % 15],
              "deps": [] if i == 0 else [f"T{i:02d}"],
              "microtasks": [{"id": f"T{i+1:02d}.M{j+1:02d}", "state": "pending"}
                             for j in range(MICRO_MAX)]} for i in range(TASKS_MAX)]
    attempts, schedule = [], []
    for i, agent in enumerate(agents):
        lifecycle = []
        for state in ("deployed", "alive", "finished" if i % 2 == 0 else "failed"):
            lifecycle.append({"room": ROOM, "agent": agent, "state": state,
                              "run_id": f"synthetic-run-{seed}-{i}", "swarm": "synthetic",
                              "harness": "fixture", "op_id": f"life_{i:02d}_{state}"})
        throttled = {**lifecycle[1], "op_id": f"life_{i:02d}_throttle"}
        calls = lifecycle[:2] + [throttled, lifecycle[2]] + copy.deepcopy(lifecycle)
        attempts.extend(calls)
        schedule.extend([0, 1000, 1010, 2000, 3000, 3001, 3002])
    return {"seed": seed, "swarm": {"agents": agents, "tasks": tasks, "now_ms": BASE_TS+700_000,
            "liveness": {a: {"last_beat_ms": BASE_TS, "expired": True} for a in agents},
            "expected_cards": [{"agent": a, "task_ids": [t["id"] for t in tasks if t["assignee"] == a],
                                 "liveness": "Liveness unknown"} for a in agents]},
            "lifecycle": {"tool": "agent_lifecycle", "arguments": attempts, "invoke_offsets_ms": schedule,
                          "counts": {"attempted": 105, "distinct_transitions": 45,
                                     "replayed": 45, "throttled_attempts": 15, "committed": None},
                          "bytes_per_committed_event": None},
            "diary": [{"kind": "microtask", "day": "Synthetic day", "at": "12:00", "title": f"Synthetic entry {i}",
                       "outcome": "<img src=x onerror=alert(1)>", "took": "1m", "author": "alice",
                       "evidence": []} for i in range(10_000)]}


@contextmanager
def isolated(fixture=None):
    """Only scratch beneath the benchmark directories; restore CW_HOME exactly."""
    scratch = ROOT / "tests" / "bench" / ".scratch"
    scratch.mkdir(exist_ok=True)
    before = os.environ.get("CW_HOME")
    with tempfile.TemporaryDirectory(prefix="run-", dir=scratch) as home:
        os.environ["CW_HOME"] = home
        try:
            if fixture is not None:
                data = admit(journal(fixture["events"]))
                room = fixture["events"][0]["room"]
                # Room names are data, never path components without validation.
                from bridge.room.store import _check_room
                _check_room(room)
                path = Path(home) / "rooms" / room / "events.jsonl"
                path.parent.mkdir(parents=True)
                path.write_bytes(data)
            yield Path(home)
        finally:
            if before is None:
                os.environ.pop("CW_HOME", None)
            else:
                os.environ["CW_HOME"] = before


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=("mixed", "tail", "reserved"), default="mixed")
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--size", type=int, default=10_000)
    args = parser.parse_args()
    value = reservations(args.seed) if args.kind == "reserved" else (near_cap(args.seed) if args.kind == "tail" else mixed(args.seed, args.size))
    print(encoded(value).decode())


if __name__ == "__main__":
    main()
