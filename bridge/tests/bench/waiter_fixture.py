"""Generate the pinned R52WF replacement for the lost waiter cap fixture."""
import argparse
import json
from pathlib import Path
from random import Random

from .fixtures import BASE_TS, SEED, encoded, event, journal, sha


ROOM = "synthetic-waiter"
HEAD = 4315
HEARTBEATS = 50
WRITES_PER_SECOND = 5
# Leave space for the suffix below the heartbeat admission ceiling.
JOURNAL_BYTES = 16 * 1024**2 - 512 * 1024 - 16 * 1024
FIXTURE_SHA256 = "ce06132779256b4cf35d8f06cdaf3bf20ed9e103574e30a24bd12481678def14"


def _lifecycle(lamport, state, run_id, **fields):
    return event(lamport, room=ROOM, agent="worker", act="op",
                 op={"kind": "agent.lifecycle", "state": state, "run_id": run_id,
                     "op_id": f"{run_id}-{state}", **fields})


def scheduled_writes():
    """Yield the virtual publication time in seconds and the complete event."""
    for index in range(1, HEARTBEATS + 2):
        when = index / WRITES_PER_SECOND
        lamport = HEAD + index
        if index <= HEARTBEATS:
            row = event(lamport, room=ROOM)
        else:
            row = _lifecycle(lamport, "finished", "scheduled-run")
        row["ts"] = BASE_TS + HEAD + index * (1000 // WRITES_PER_SECOND)
        yield when, row


def build_journal():
    """Return the canonical near-cap prefix with an active deployment."""
    operations = []
    for index in range(5):
        run_id = f"historical-run-{index}"
        operations.extend((_lifecycle(2 * index + 1, "deployed", run_id),
                           _lifecycle(2 * index + 2, "finished", run_id)))
    operations.append(_lifecycle(len(operations) + 1, "deployed", "scheduled-run",
                                 parent_agent="coordinator"))

    rng = Random(SEED)
    messages = []
    for lamport in range(len(operations) + 1, HEAD + 1):
        token = int(rng.random() * 2**32)
        act = "question" if token % 3 == 0 else "heartbeat"
        messages.append(event(lamport, room=ROOM, act=act, text=f"synthetic:{token:08x}"))

    rows = operations + messages
    # ASCII padding adds one byte per character inside each JSON string.
    bare_size = sum(len(encoded(row)) + 1 for row in rows)
    padding, remainder = divmod(JOURNAL_BYTES - bare_size, len(messages))
    for index, row in enumerate(messages):
        row["text"] += "x" * (padding + (index < remainder))
    return journal(rows)


def write_fixture(path):
    data = build_journal()
    digest = sha(data)
    if len(data) != JOURNAL_BYTES or digest != FIXTURE_SHA256:
        raise ValueError("replacement waiter fixture does not match its pinned length and SHA-256")
    path.write_bytes(data)
    return {"sha256": digest, "bytes": len(data)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(write_fixture(args.out)))


if __name__ == "__main__":
    main()
